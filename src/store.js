/**
 * Durable record store.
 *
 * Why this shape
 * ──────────────
 * Every consumer of app state (prefs, reminders, events, itinerary, chat
 * sessions) was written against a synchronous, file-backed API: `getPrefs()`,
 * `getReminders()`, `eventsOn()` are all sync and are called from deep inside
 * tool logic and the agent's tool loop. Converting that whole surface to
 * async/await would ripple through most of the codebase for no user-visible
 * benefit.
 *
 * So reads stay synchronous and cheap: every record is mirrored in a
 * per-instance Map, and `ensureHydrated()` (awaited by middleware before any
 * route runs) pulls the backing store into that Map once per cold start.
 * Writes update the Map synchronously so a caller always reads its own write
 * immediately, and are mirrored to the backend as tracked promises that
 * `flush()` awaits — a serverless instance can be frozen the moment a response
 * is sent, so we must not leave durability to chance.
 *
 * Backends
 * ────────
 * - `kv`    Vercel KV / Upstash Redis, over the plain REST API. Chosen over a
 *           socket client because a bundled serverless function cannot open
 *           TCP, and over the official SDK because it would add a dependency
 *           that esbuild then has to trace into the function bundle.
 * - `memory` In-process fallback. Preserves today's behaviour exactly, but is
 *           EPHEMERAL: state is lost on cold start and is not shared between
 *           concurrent instances. We log loudly rather than fail loudly,
 *           because a degraded dashboard beats a 500 on every page load.
 *
 * Environment (Vercel KV's standard names, injected by
 * `vercel integration add upstash/upstash-kv`):
 *   KV_REST_API_URL, KV_REST_API_TOKEN
 */

const PREFIX = "flexagent";
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h
const SCAN_COUNT = 250;

const KV_URL = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

/** "kv" when durable storage is wired, otherwise "memory". */
export const storeKind = KV_URL && KV_TOKEN ? "kv" : "memory";

/** namespace -> Map<id, record> */
const memory = new Map();
/** namespace -> hydrated? */
const hydrated = new Set();
/** namespaces that legitimately hold a single document rather than records */
const docNamespaces = new Set(["prefs", "itinerary"]);

let hydrationPromise = null;
const inFlight = new Set();

/* ── backend primitives ─────────────────────────────────────────────────── */

async function kvCommand(args) {
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([args]),
  });
  if (!res.ok) throw new Error(`kv ${args[0]} failed: HTTP ${res.status}`);
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : null;
  if (!entry) throw new Error(`kv ${args[0]} returned no result`);
  if (entry.error) throw new Error(`kv ${args[0]}: ${entry.error}`);
  return entry.result;
}

/** Collect every key under `ns`, following the SCAN cursor to exhaustion. */
async function kvKeys(ns) {
  const match = `${PREFIX}:${ns}:*`;
  const found = [];
  let cursor = "0";
  // Bounded to avoid a pathological loop if the backend misbehaves.
  for (let i = 0; i < 50; i += 1) {
    const result = await kvCommand(["SCAN", cursor, "MATCH", match, "COUNT", String(SCAN_COUNT)]);
    if (!Array.isArray(result)) break;
    const [next, keys] = result;
    if (Array.isArray(keys)) found.push(...keys);
    cursor = next ?? "0";
    if (cursor === "0") break;
  }
  return found;
}

function keyFor(ns, id) {
  return `${PREFIX}:${ns}:${id}`;
}

function nsFor(ns) {
  let bucket = memory.get(ns);
  if (!bucket) {
    bucket = new Map();
    memory.set(ns, bucket);
  }
  return bucket;
}

function track(promise) {
  inFlight.add(promise);
  promise
    .catch(() => {})
    .finally(() => inFlight.delete(promise));
  return promise;
}

/* ── hydration ──────────────────────────────────────────────────────────── */

function hydrateFromMemoryOnly(ns) {
  // Nothing to do: records written by putRecord() are already in the Map.
  hydrated.add(ns);
}

async function hydrateNamespace(ns) {
  if (hydrated.has(ns)) return;
  if (storeKind !== "kv") {
    hydrateFromMemoryOnly(ns);
    return;
  }

  const keys = await kvKeys(ns);
  if (keys.length === 0) {
    hydrated.add(ns);
    return;
  }

  // One round trip for the whole namespace.
  const pipeline = keys.map((k) => ["GET", k]);
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(pipeline),
  });
  if (!res.ok) throw new Error(`kv MGET failed: HTTP ${res.status}`);
  const rows = await res.json();

  const bucket = nsFor(ns);
  keys.forEach((key, i) => {
    const row = rows[i];
    const raw = row && row.result;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const id = key.slice(`${PREFIX}:${ns}:`.length);
      bucket.set(id, { id, ...parsed });
    } catch {
      // A malformed record should not take the whole namespace offline.
    }
  });
  hydrated.add(ns);
}

/**
 * Load every namespace into memory. Awaited from request middleware so that
 * synchronous readers below never observe a cold, empty store in production.
 * Safe to call repeatedly and concurrently.
 */
export async function ensureHydrated() {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    if (storeKind !== "kv") {
      for (const ns of ["prefs", "reminders", "events", "itinerary"]) hydrateFromMemoryOnly(ns);
      return;
    }
    try {
      for (const ns of ["prefs", "reminders", "events", "itinerary"]) {
        await hydrateNamespace(ns);
      }
    } catch (err) {
      // Degrade to memory rather than 500 every request on a bad token.
      console.warn(`[store] KV hydration failed, serving from memory this instance: ${err.message}`);
    }
  })();
  return hydrationPromise;
}

/* ── reads (synchronous) ────────────────────────────────────────────────── */

/** All records in a namespace, sorted by creation time where available. */
export function listRecords(ns) {
  const bucket = nsFor(ns);
  const out = [...bucket.values()];
  return out.sort((a, b) => String(a.created ?? "").localeCompare(String(b.created ?? "")));
}

export function getRecord(ns, id) {
  return nsFor(ns).get(id) ?? null;
}

export function hasRecord(ns, id) {
  return nsFor(ns).has(id);
}

/** Single-document namespace (prefs, itinerary). */
export function getDoc(ns) {
  return getRecord(ns, "doc");
}

export function setDoc(ns, value) {
  return putRecord(ns, "doc", value);
}

/* ── writes (sync mirror + async durability) ────────────────────────────── */

export function putRecord(ns, id, value) {
  const record = { id, ...value };
  nsFor(ns).set(id, record);

  if (storeKind === "kv") {
    const ttl = ns === "sessions" ? SESSION_TTL_SECONDS : undefined;
    const args = ["SET", keyFor(ns, id), JSON.stringify(record)];
    if (ttl) args.push("EX", String(ttl));
    track(kvCommand(args).catch((err) => console.warn(`[store] SET ${ns}/${id} failed: ${err.message}`)));
  }
  return record;
}

export function deleteRecord(ns, id) {
  const existed = nsFor(ns).delete(id);
  if (existed && storeKind === "kv") {
    track(kvCommand(["DEL", keyFor(ns, id)]).catch((err) => console.warn(`[store] DEL ${ns}/${id} failed: ${err.message}`)));
  }
  return existed;
}

/** Replace a whole namespace's contents (used by list-shaped updates). */
export function replaceAll(ns, records) {
  const bucket = nsFor(ns);
  const keep = new Set();

  for (const rec of records) {
    const id = rec.id ?? `rec_${Math.random().toString(36).slice(2, 10)}`;
    keep.add(id);
    putRecord(ns, id, rec);
  }

  for (const id of [...bucket.keys()]) {
    if (!keep.has(id)) deleteRecord(ns, id);
  }
  return listRecords(ns);
}

export { docNamespaces };

/**
 * Await every queued write. Must be called BEFORE responding on any mutating
 * route, otherwise a serverless freeze can drop the write.
 */
export async function flush() {
  if (inFlight.size === 0) return;
  await Promise.allSettled([...inFlight]);
}

/* ── chat sessions ──────────────────────────────────────────────────────── */

const SESSION_MAX = 40;

export function getSession(id) {
  const rec = getRecord("sessions", id);
  return rec ? rec.data : null;
}

export function putSession(id, data) {
  const existing = getRecord("sessions", id);
  const turns = [...(existing?.data?.turns ?? []), ...(data?.turns ?? [])].slice(-SESSION_MAX);
  putRecord("sessions", id, {
    data: { ...data, turns, updated: new Date().toISOString() },
    created: existing?.created ?? new Date().toISOString(),
  });
}

export function clearSession(id) {
  return deleteRecord("sessions", id);
}
