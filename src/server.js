import express from "express";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg, brainConfigured } from "./config.js";
import { handleMessage } from "./agent.js";
import { normalizeInbound, sendText, verifyWebhook } from "./photon.js";
import { viewItinerary } from "./tools/itinerary.js";
import { getTodaySummary, freeBusy } from "./tools/calendar.js";
import { getEvents } from "./tools/events.js";
import { inboxSummary } from "./tools/email.js";
import { getPrefs, setPrefs } from "./prefs.js";
import { getReminders, getTrends, suggestTime, addReminder, updateReminder, deleteReminder } from "./tools/reminders.js";
import { searchLaw, findTemplates } from "./tools/legal.js";

/**
 * Phase 2: the always-on webhook the WhatsApp channel (Photon/Spectrum) calls.
 * Also serves the PA Dashboard (static + API).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

export const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// Per-sender conversation state (pending confirmations, etc.). In-memory is fine
// for the hackathon; swap for Redis/Firestore when we need survivable restarts.
const sessions = new Map();
function sessionFor(from) {
  const key = from || "unknown";
  if (!sessions.has(key)) sessions.set(key, {});
  return sessions.get(key);
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
  };
}
app.get("/healthz", (_req, res) => res.json(healthStatus()));
// Alias so the Vercel catch-all function can serve the health check too.
app.get("/api/healthz", (_req, res) => res.json(healthStatus()));

// --- Dashboard API ---

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
    console.error("[api/day] error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/week", async (req, res) => {
  try {
    const start = req.query.start ? new Date(req.query.start) : new Date();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      const summary = await getTodaySummary({ date });
      days.push({ date, summary: summary?.items ?? [] });
    }
    res.json({ days });
  } catch (e) {
    console.error("[api/week] error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/inbox", async (_req, res) => {
  try {
    res.json(await inboxSummary({}));
  } catch (e) {
    console.error("[api/inbox] error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/prefs", (_req, res) => res.json(getPrefs()));
app.patch("/api/prefs", (req, res) => res.json(setPrefs(req.body)));

app.get("/api/reminders", (_req, res) => res.json({ reminders: getReminders(), trends: getTrends() }));
app.post("/api/reminders", (req, res) => {
  const { text, due, recurring } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });
  const suggested = due || suggestTime(text);
  const rem = addReminder({ text, due: suggested, recurring: recurring ?? null });
  res.json(rem);
});
// Mutations are addressed as /api/reminders?id=… on purpose. In the Vercel
// catch-all configuration only *single-segment* /api/* paths are routed to the
// function — a nested path like /api/reminders/rem_1 never reaches it and 404s
// at the edge. Both shapes are registered so local dev and nested callers work.
const reminderId = (req) => req.params.id || req.query.id || null;

function patchReminder(req, res) {
  const id = reminderId(req);
  if (!id) return res.status(400).json({ error: "id required" });
  const updated = updateReminder(id, req.body);
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
}

function removeReminder(req, res) {
  const id = reminderId(req);
  if (!id) return res.status(400).json({ error: "id required" });
  const ok = deleteReminder(id);
  if (!ok) return res.status(404).json({ error: "not found" });
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
    const reply = await handleMessage(text, { session: sessionFor("dashboard"), degraded });
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
    const reply = await handleMessage(text, { session: sessionFor(from) });
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
