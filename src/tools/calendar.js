import { cfg } from "../config.js";
import { addEvent, getEvents, eventsOn, updateEvent, removeEvent } from "./events.js";
import { getTodaySummary as gcalToday, freeBusy as gcalFreeBusy, bookOrMove as gcalBookOrMove } from "./google-calendar.js";
import { getTodaySummary as oauthToday, freeBusy as oauthFreeBusy, bookOrMove as oauthBookOrMove } from "./google-calendar-oauth.js";

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildDayItems(date) {
  const hour = new Date().getHours();
  const defaults = [
    { time: "09:00", title: "Standup — Q3 ops", attendees: ["boss", "head-of-ops"], done: hour >= 9 },
    { time: "10:30", title: "Vendor review — Acme Cloud", attendees: ["boss", "cf", "procurement"], done: hour >= 10 },
    { time: "13:00", title: "Lunch — Sarah (M&A)", attendees: ["boss"], done: hour >= 13 },
    { time: "15:00", title: "Buffer / deep work", attendees: [], done: hour >= 15 },
    { time: "16:00", title: "1:1 — engineering TL (recap Q3 report)", attendees: ["boss", "eng-lead"], done: hour >= 16 },
    { time: "17:30", title: "Flight to counterparty office", attendees: [], done: false },
  ];
  const stored = eventsOn(date).map((e) => ({
    time: String(e.when ?? "").slice(11),
    title: e.summary,
    attendees: e.attendees ?? [],
    done: Boolean(e.done),
  }));
  return [...defaults, ...stored]
    .filter((i) => i.time)
    .sort((a, b) => a.time.localeCompare(b.time));
}

const OPEN_HOURS = [
  "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00",
];

function stubToday(req) {
  const date = req?.date ?? todayISO();
  const name = dayNames[new Date(`${date}T12:00:00`).getDay()];
  return { id: "day", date, day: name, title: `${name} — ${date}`, items: buildDayItems(date) };
}

function stubFreeBusy(req) {
  const date = req?.date ?? todayISO();
  const items = buildDayItems(date);
  const busyText = items.map((i) => `${i.time} ${i.title}`);
  const taken = new Set(items.map((i) => i.time.slice(0, 2)));
  const free = OPEN_HOURS.filter((h) => !taken.has(h.slice(0, 2))).slice(0, 6);
  return { date, free, busy: busyText };
}

function stubBookOrMove(req) {
  const { action, summary, when } = req ?? {};
  if (action === "cancel") {
    const target = summary ? getEvents().find((e) => e.summary.toLowerCase() === String(summary).toLowerCase()) : null;
    if (!target) return { ok: false, error: `No event matching "${summary}" found to cancel.` };
    removeEvent(target.id);
    return { ok: true, action, id: target.id, summary: target.summary, when: target.when, note: "cancelled from calendar (stub)" };
  }
  if (action === "move") {
    const target = summary ? getEvents().find((e) => e.summary.toLowerCase() === String(summary).toLowerCase()) : null;
    if (!target) return { ok: false, error: `No event matching "${summary}" found to move.` };
    const moved = updateEvent(target.id, { when });
    return { ok: true, action, id: target.id, summary: moved.summary, when: moved.when, note: "rescheduled on calendar (stub)" };
  }
  const record = addEvent({ summary, when, attendees: [] });
  return { ok: true, action: "book", id: record.id, summary: record.summary, when: record.when, note: "on the calendar — real GCal service account would send invites here (stub)" };
}

const useServiceAccount = () => Boolean(cfg.saKeyPath && cfg.bossCalendarEmail);
const useOAuth2 = () => Boolean(cfg.googleOauthClientId && cfg.googleOauthClientSecret && cfg.googleOauthRefreshToken && cfg.bossCalendarEmail);

export async function getTodaySummary(req) {
  if (useServiceAccount()) {
    try { return await gcalToday(req); } catch (e) { console.warn("[calendar] Service Account failed, falling back:", e.message); }
  }
  if (useOAuth2()) {
    try { return await oauthToday(req); } catch (e) { console.warn("[calendar] OAuth2 failed, falling back to stub:", e.message); }
  }
  return stubToday(req);
}

export async function freeBusy(req) {
  if (useServiceAccount()) {
    try { return await gcalFreeBusy(req); } catch (e) { console.warn("[calendar] Service Account failed, falling back:", e.message); }
  }
  if (useOAuth2()) {
    try { return await oauthFreeBusy(req); } catch (e) { console.warn("[calendar] OAuth2 failed, falling back to stub:", e.message); }
  }
  return stubFreeBusy(req);
}

export async function bookOrMove(req) {
  if (useServiceAccount()) {
    try { return await gcalBookOrMove(req); } catch (e) { console.warn("[calendar] Service Account failed, falling back:", e.message); }
  }
  if (useOAuth2()) {
    try { return await oauthBookOrMove(req); } catch (e) { console.warn("[calendar] OAuth2 failed, falling back to stub:", e.message); }
  }
  return stubBookOrMove(req);
}