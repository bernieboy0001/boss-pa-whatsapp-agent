import express from "express";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cfg, brainConfigured } from "./config.js";
import { handleMessage } from "./agent.js";
import { normalizeInbound, sendText, verifyWebhook } from "./photon.js";
import { viewItinerary } from "./tools/itinerary.js";
import { getTodaySummary, freeBusy, listCalendars } from "./tools/calendar.js";
import { getEvents } from "./tools/events.js";
import { inboxSummary, readMail, mailboxStatsSafe } from "./tools/email.js";
import { getPrefs, setPrefs } from "./prefs.js";
import { getReminders, getTrends, suggestTime, addReminder, updateReminder, deleteReminder } from "./tools/reminders.js";
import { searchLaw, findTemplates } from "./tools/legal.js";
import { ensureHydrated, flush, storeKind, getSession, putSession, clearSession } from "./store.js";
import { zonedDateStr, zonedToday, addDays } from "./tools/zoned-time.js";
import { getProviderHealth } from "./tools/provider-health.js";
import { generateAuthUrl, exchangeCodeForTokens, setStoredRefreshToken } from "./tools/oauth2-client.js";

/**
 * Phase 2: the always-on webhook the WhatsApp channel (Photon/Spectrum) calls.
 * Also serves the PA Dashboard (static + API).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

export const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// Everything downstream reads state through synchronous getters, so the store
// must be warm before the first route body runs. Hydration is idempotent and
// resolves once per cold start.
app.use((_req, _res, next) => {
  ensureHydrated().then(next, (err) => {
    console.error("[store] hydration rejected:", err.message);
    next();
  });
});

// Per-sender conversation state (pending confirmations, turn history), now
// durable so "confirm"/"book f1" survives a cold start and works no matter
// which instance serves the next request.
function sessionFor(from) {
  const key = from || "unknown";
  return getSession(key) ?? {};
}
function saveSession(from, session) {
  putSession(from || "unknown", session);
}

// Reports what is genuinely live vs. simulated, so the dashboard can label
// stubbed providers instead of presenting mock data as real results.
function healthStatus() {
  return {
    ok: true,
    provider: cfg.channelProvider,
    flights: cfg.flightProvider,
    flightsSimulated: cfg.flightProvider === "stub",
    brain: brainConfigured(),
    brainModel: brainConfigured() ? cfg.llmModel : null,
    // "kv" is durable; "memory" means state is lost on cold start and is not
    // shared across instances. Surfaced so the dashboard never implies
    // durability it does not have.
    store: storeKind,
    storeDurable: storeKind === "kv",
    // Last observed outcome of each external provider. A dead OAuth token shows
    // up here instead of hiding behind a synthetic calendar.
    providers: getProviderHealth(),
  };
}
app.get("/healthz", (_req, res) => res.json(healthStatus()));
// Alias so the Vercel catch-all function can serve the health check too.
app.get("/api/healthz", (_req, res) => res.json(healthStatus()));

// --- Dashboard API ---

app.get("/api/calendars", async (_req, res) => {
  try {
    res.json({ calendars: await listCalendars() });
  } catch (e) {
    console.error("[api/calendars] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/itinerary", (_req, res) => res.json({ text: viewItinerary() }));

// The calendar + email tools are async (Google OAuth), so every route that
// touches them must await. Skipping the await serialises a Promise to `{}`.
app.get("/api/day", async (req, res) => {
  try {
    const date = req.query.date || undefined;
    const summary = await getTodaySummary({ date });
    const fb = await freeBusy({ date: summary?.date || date });
    res.json({ summary, freeBusy: fb });
  } catch (e) {
    console.error("[api/day] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/week", async (req, res) => {
  try {
    // Walk calendar days in the boss's zone, not the server's. `new Date()` +
    // setDate() steps in server-local time, so on a UTC instance the week
    // either started a day early/late or rolled over at 20:00 ET.
    const tz = cfg.bossTimezone ?? "America/New_York";
    const first = req.query.start ? zonedDateStr(new Date(req.query.start), tz) : zonedToday(tz);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(first, i);
      const summary = await getTodaySummary({ date });
      days.push({
        date,
        day: summary?.day,
        summary: summary?.items ?? [],
        degraded: Boolean(summary?.degraded),
        ...(summary?.error ? { error: summary.error } : {}),
      });
    }
    res.json({ days });
  } catch (e) {
    console.error("[api/week] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/inbox", async (_req, res) => {
  try {
    res.json(await inboxSummary({}));
  } catch (e) {
    console.error("[api/inbox] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Real message read. `query` takes Gmail search syntax, so the dashboard can
// page the mailbox without a bespoke API per filter.
app.get("/api/mail", async (req, res) => {
  try {
    const max = req.query.max ? Number(req.query.max) : 25;
    const result = await readMail({
      query: req.query.q || undefined,
      max: Number.isFinite(max) ? max : 25,
      fullBody: req.query.body !== "0",
    });
    res.json(result);
  } catch (e) {
    // `.message` only: the raw gaxios error carries `config.data`, which
    // includes the OAuth refresh_token. Logging the object would write the
    // token to the platform logs in plaintext.
    console.error("[api/mail] error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/mail-stats", async (_req, res) => {
  try {
    res.json(await mailboxStatsSafe());
  } catch (e) {
    console.error("[api/mail-stats] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/prefs", (_req, res) => res.json(getPrefs()));
// A serverless instance can be frozen the instant the response is sent, so the
// write has to be awaited before responding — not fire-and-forget.
app.patch("/api/prefs", async (req, res) => {
  const next = setPrefs(req.body);
  await flush();
  res.json(next);
});

app.get("/api/reminders", (_req, res) => res.json({ reminders: getReminders(), trends: getTrends() }));
app.post("/api/reminders", async (req, res) => {
  const { text, due, recurring } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });
  const suggested = due || suggestTime(text);
  const rem = addReminder({ text, due: suggested, recurring: recurring ?? null });
  await flush();
  res.json(rem);
});
// Mutations are addressed as /api/reminders?id=… on purpose. In the Vercel
// catch-all configuration only *single-segment* /api/* paths are routed to the
// function — a nested path like /api/reminders/rem_1 never reaches it and 404s
// at the edge. Both shapes are registered so local dev and nested callers work.
const reminderId = (req) => req.params.id || req.query.id || null;

async function patchReminder(req, res) {
  const id = reminderId(req);
  if (!id) return res.status(400).json({ error: "id required" });
  const updated = updateReminder(id, req.body);
  if (!updated) return res.status(404).json({ error: "not found" });
  await flush();
  res.json(updated);
}

async function removeReminder(req, res) {
  const id = reminderId(req);
  if (!id) return res.status(400).json({ error: "id required" });
  const ok = deleteReminder(id);
  if (!ok) return res.status(404).json({ error: "not found" });
  await flush();
  res.json({ ok: true });
}

app.patch("/api/reminders/:id", patchReminder);
app.patch("/api/reminders", patchReminder);
app.delete("/api/reminders/:id", removeReminder);
app.delete("/api/reminders", removeReminder);

// Single-segment aliases (/api/legal-search, /api/legal-templates) are what the
// Vercel catch-all can actually route; the nested paths are kept for local use.
async function legalSearch(req, res) {
  const q = req.query.q || "";
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchLaw(q);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function legalTemplates(req, res) {
  const { category, jurisdiction } = req.query;
  try {
    const results = await findTemplates({ category, jurisdiction });
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/api/legal/search", legalSearch);
app.get("/api/legal-search", legalSearch);
app.get("/api/legal/templates", legalTemplates);
app.get("/api/legal-templates", legalTemplates);

// --- Chat API (dashboard) ---

app.post("/api/chat", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text required" });
  // Mutable bag the agent fills in when it could not use the brain, so the UI
  // can say "running in fallback mode" instead of showing a generic HELP reply
  // that is indistinguishable from the assistant misunderstanding the user.
  const degraded = {};
  try {
    const session = sessionFor("dashboard");
    const reply = await handleMessage(text, { session, degraded });
    // Persist the mutated session (pending confirmations, turn history) before
    // responding, so the follow-up "confirm" can land on any instance.
    saveSession("dashboard", session);
    await flush();
    res.json({ text: reply, degraded: Object.keys(degraded).length ? degraded : null });
  } catch (err) {
    console.error("[chat] agent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- WhatsApp Webhook ---

async function photonWebhook(req, res) {
  if (!verifyWebhook(req)) return res.status(401).json({ error: "bad webhook secret" });

  const { from, text } = normalizeInbound(req.body);
  if (!text) return res.status(204).end();

  // Ack fast so WhatsApp doesn't retry, then process.
  res.status(200).json({ ok: true });

  try {
    const session = sessionFor(from);
    const reply = await handleMessage(text, { session });
    saveSession(from, session);
    await flush();
    await sendText(from, reply);
  } catch (err) {
    console.error("[webhook] agent error:", err.message);
    await sendText(from, "Sorry — something went wrong handling that. Try again?").catch(() => {});
  }
}

// /webhook/photon is two segments and won't reach the Vercel catch-all, so the
// single-segment alias is registered too (see the rewrite in vercel.json).
app.post("/webhook/photon", photonWebhook);
app.post("/api/webhook-photon", photonWebhook);

// --- Google OAuth re-authorization ---
//
// The refresh token is the single point of failure for calendar + mail: when
// Google expires or revokes it (`invalid_grant`) both go dark, and a serverless
// deployment cannot rewrite its own env. These routes let an operator
// re-authorise from the deployment itself instead of hand-rolling a token in
// the OAuth Playground. Gated by OAUTH_SETUP_KEY; the OAuth `state` is
// generated and verified server-side (CSRF).

const OAUTH_SETUP_KEY = process.env.OAUTH_SETUP_KEY || "";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// The OAuth `state` is signed, not stored: a serverless deployment may answer
// the callback on a different instance (and region) than the start request, so
// an in-memory map would falsely reject every round-trip. HMAC over a
// timestamp proves the callback came from a start we issued and bounds its age.
function signOAuthState(now = Date.now()) {
  const mac = createHmac("sha256", OAUTH_SETUP_KEY).update(String(now)).digest("hex");
  return `${now}.${mac}`;
}

function verifyOAuthState(state) {
  if (!state || !String(state).includes(".")) return false;
  const [tsStr, mac] = String(state).split(".");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Date.now() - ts > OAUTH_STATE_TTL_MS) return false;
  const expected = createHmac("sha256", OAUTH_SETUP_KEY).update(tsStr).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function oauthPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<body style="font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:8vh auto;padding:0 20px;color:#111">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>${body}</body>`;
}

function oauthStart(req, res) {
  if (!OAUTH_SETUP_KEY) {
    return res.status(503).type("html").send(oauthPage(
      "Re-authorization disabled",
      "<p>Set <code>OAUTH_SETUP_KEY</code> in the environment to enable this flow.</p>"
    ));
  }
  if (req.query.key !== OAUTH_SETUP_KEY) {
    return res.status(403).type("html").send(oauthPage("Forbidden", "<p>Invalid setup key.</p>"));
  }
  try {
    const state = signOAuthState();
    res.redirect(generateAuthUrl(state));
  } catch (e) {
    res.status(503).type("html").send(oauthPage("OAuth not configured", `<p>${escapeHtml(e.message)}</p>`));
  }
}

async function oauthCallback(req, res) {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).type("html").send(oauthPage("Authorization failed", `<p>${escapeHtml(String(error))}</p>`));
  }
  if (!verifyOAuthState(state)) {
    return res.status(400).type("html").send(oauthPage("Invalid state", "<p>Start again from <code>/oauth-start</code>.</p>"));
  }
  if (!code) {
    return res.status(400).type("html").send(oauthPage("Missing code", "<p>Google returned no authorization code.</p>"));
  }
  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      return res.type("html").send(oauthPage(
        "No refresh token returned",
        "<p>Google only issues one at consent. Revoke prior access at " +
        "<a href='https://myaccount.google.com/permissions'>myaccount.google.com/permissions</a> " +
        "then retry <code>/oauth-start</code>.</p>"
      ));
    }
    setStoredRefreshToken(tokens.refresh_token);
    await flush();
    const durable = storeKind === "kv";
    console.log(`[oauth] refresh token rotated (storeKind=${storeKind})`);
    res.type("html").send(oauthPage("Re-authorized", `
      <p>Calendar and mail access restored.</p>
      <p>${durable
        ? "The new token was saved durably — no redeploy needed."
        : "<strong>Storage is in-memory on this instance</strong>, so also set a Vercel env var and redeploy:<br>" +
          `<code style="display:block;word-break:break-all;background:#f4f4f4;padding:8px;margin:8px 0">GOOGLE_OAUTH_REFRESH_TOKEN=${escapeHtml(tokens.refresh_token)}</code>`}</p>
      <p><a href="/">Back to the dashboard</a></p>
    `));
  } catch (e) {
    console.error("[oauth] token exchange failed:", e.message);
    res.status(500).type("html").send(oauthPage("Token exchange failed", `<p>${escapeHtml(e.message)}</p>`));
  }
}

// Google redirects to the public `/oauth2callback`; each public path needs a
// vercel.json rewrite to the single-segment /api/ alias it is registered under
// here (Vercel's catch-all only covers one path segment). The /api/ paths are
// also probed by the smoke suite, which talks to the Express app directly.
app.get("/oauth-start", oauthStart);
app.get("/api/oauth-start", oauthStart);
app.get("/oauth2callback", oauthCallback);
app.get("/api/oauth2callback", oauthCallback);

// Unknown API routes must 404 as JSON, never fall through to the SPA shell.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// SPA fallback. On Vercel the static assets are served from outputDirectory, so
// this only matters for local `npm run dev`.
app.get("*", (req, res) => {
  const indexPath = join(PUBLIC_DIR, "index.html");
  if (existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).json({ error: "Not found" });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(cfg.port, () => console.log(`🧑‍💼 BOSS PA server on :${cfg.port} (dashboard + webhook)`));
}
