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

import { scopeId } from "./context.js";

const PREFIX = "flexagent";
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h
const SCAN_COUNT = 250;

// Namespaces scoped per user (owner uses the original unscoped keys).
const SCOPED_NS = ["prefs", "reminders", "events", "itinerary", "secrets", "sessions", "meta"];

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

/** Collect every key belonging to `ns` within `scope`, following the cursor. */
async function kvKeys(ns, scope) {
  const match = `${PREFIX}:${scope ? scope + ":" : ""}${ns}:*`;
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

// Namespaces that are deliberately global — never scoped to a user.
const GLOBAL_NS = new Set(["users"]);

/** The scope a namespace resolves to for the active identity. */
function scopeFor(ns) {
  return GLOBAL_NS.has(ns) ? "" : scopeId();
}

function scopedKeyFor(ns, id, scope) {
  return `${PREFIX}:${scope ? scope + ":" : ""}${ns}:${id}`;
}

function keyFor(ns, id) {
  return scopedKeyFor(ns, id, scopeFor(ns));
}

/** Memory-bucket name for a namespace within a scope. */
function bucketName(ns, scope) {
  return `${scope ? scope + ":" : ""}${ns}`;
}

function bucketFor(ns, scope) {
  const key = bucketName(ns, scope);
  let bucket = memory.get(key);
  if (!bucket) {
    bucket = new Map();
    memory.set(key, bucket);
  }
  return bucket;
}

function nsFor(ns) {
  return bucketFor(ns, scopeFor(ns));
}

function track(promise) {
  inFlight.add(promise);
  promise
    .catch(() => {})
    .finally(() => inFlight.delete(promise));
  return promise;
}

/* ── hydration ──────────────────────────────────────────────────────────── */

function hydrateFromMemoryOnly(ns, scope) {
  // Nothing to do: records written by putRecord() are already in the Map.
  hydrated.add(bucketName(ns, scope));
}

async function hydrateNamespace(ns, scope) {
  const marker = bucketName(ns, scope);
  if (hydrated.has(marker)) return;
  if (storeKind !== "kv") {
    hydrateFromMemoryOnly(ns, scope);
    return;
  }

  const keys = await kvKeys(ns, scope);
  if (keys.length === 0) {
    hydrated.add(marker);
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

  const bucket = bucketFor(ns, scope);
  const keyPrefix = `${PREFIX}:${scope ? scope + ":" : ""}${ns}:`;
  keys.forEach((key, i) => {
    const row = rows[i];
    const raw = row && row.result;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const id = key.slice(keyPrefix.length);
      bucket.set(id, { id, ...parsed });
    } catch {
      // A malformed record should not take the whole namespace offline.
    }
  });
  hydrated.add(marker);
}

/** Load one scope (owner/legacy = ""). Idempotent, concurrent-safe enough. */
async function hydrateScope(scope) {
  for (const ns of SCOPED_NS) {
    try {
      await hydrateNamespace(ns, scope);
    } catch (err) {
      // Degrade to memory rather than 500 every request on a bad token.
      console.warn(`[store] KV hydration of ${bucketName(ns, scope)} failed: ${err.message}`);
    }
  }
}

/**
 * Load the global namespaces plus the owner/legacy key space into memory.
 * Awaited from request middleware so synchronous readers never observe a cold,
 * empty store. Safe to call repeatedly and concurrently.
 */
export async function ensureHydrated() {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    await hydrateScope("");
    if (storeKind === "kv") {
      try {
        await hydrateNamespace("users", "");
      } catch (err) {
        console.warn(`[store] KV hydration of users failed: ${err.message}`);
      }
    }
  })();
  return hydrationPromise;
}

/**
 * Warm a signed-in user's namespaces before their request runs. Keyed off the
 * unscoped-owner space, this is a no-op; for a real user it loads `u:<id>:*`.
 */
export async function ensureHydratedScope(scope) {
  if (!scope) return ensureHydrated();
  await hydrateScope(scope);
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
