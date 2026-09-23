import express from "express";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
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

app.get("/healthz", (_req, res) => res.json({ ok: true, provider: cfg.channelProvider, flights: cfg.flightProvider }));

// --- Dashboard API ---

app.get("/api/itinerary", (_req, res) => res.json({ text: viewItinerary() }));

app.get("/api/day", (req, res) => {
  const date = req.query.date || undefined;
  const summary = getTodaySummary({ date });
  const fb = freeBusy({ date: summary.date });
  res.json({ summary, freeBusy: fb });
});

app.get("/api/week", (req, res) => {
  const start = req.query.start ? new Date(req.query.start) : new Date();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);
    const summary = getTodaySummary({ date });
    days.push({ date, summary: summary.items });
  }
  res.json({ days });
});

app.get("/api/inbox", (_req, res) => res.json(inboxSummary({})));

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
app.patch("/api/reminders/:id", (req, res) => {
  const updated = updateReminder(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});
app.delete("/api/reminders/:id", (req, res) => {
  const ok = deleteReminder(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.get("/api/legal/search", async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchLaw(q);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/legal/templates", async (req, res) => {
  const { category, jurisdiction } = req.query;
  try {
    const results = await findTemplates({ category, jurisdiction });
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Chat API (dashboard) ---

app.post("/api/chat", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const reply = await handleMessage(text, { session: sessionFor("dashboard") });
    res.json({ text: reply });
  } catch (err) {
    console.error("[chat] agent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- WhatsApp Webhook ---

app.post("/webhook/photon", async (req, res) => {
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
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "index.html"));
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(cfg.port, () => console.log(`🧑‍💼 BOSS PA server on :${cfg.port} (dashboard + webhook)`));
}
