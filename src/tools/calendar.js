import { cfg } from "../config.js";
import { addEvent, getEvents, eventsOn, updateEvent, removeEvent } from "./events.js";
import { getTodaySummary as gcalToday, freeBusy as gcalFreeBusy, bookOrMove as gcalBookOrMove } from "./google-calendar.js";
import { getTodaySummary as oauthToday, freeBusy as oauthFreeBusy, bookOrMove as oauthBookOrMove, listCalendars as oauthListCalendars } from "./google-calendar-oauth.js";
import { zonedToday, zonedWeekdayName } from "./zoned-time.js";
import { markProviderOk, markProviderFail } from "./provider-health.js";

function todayISO() {
  return zonedToday(cfg.bossTimezone ?? "America/New_York");
}

function buildDayItems(date) {
  // "Done" should follow the boss's clock, not the server's (UTC on Vercel).
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.bossTimezone ?? "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
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
  const tz = cfg.bossTimezone ?? "America/New_York";
  const date = req?.date ?? todayISO();
  const name = zonedWeekdayName(date, tz);
  return { id: "day", date, day: name, title: `${name} — ${date}`, items: buildDayItems(date), stub: true };
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

/**
 * Real events the assistant booked, read straight from the store. Independent
 * of any calendar provider, so they stay visible even when the provider is
 * down — unlike the synthetic `buildDayItems` schedule, they actually happened.
 */
function localOnlyItems(date) {
  return eventsOn(date)
    .map((e) => ({
      time: String(e.when ?? "").slice(11, 16),
      title: e.summary,
      attendees: e.attendees ?? [],
      done: Boolean(e.done),
      calendar: "Booked via assistant",
      calendarId: "local",
    }))
    .filter((i) => i.time);
}

/**
 * A provider is configured but every attempt failed.
 *
 * Falling through to `stubToday` here would be the calendar twin of the email
 * bug: the boss would open their day and see "Standup — Q3 ops / Vendor review
 * — Acme Cloud" as though they were real meetings. So we show the events that
 * genuinely exist (locally booked) and say plainly that the live calendar
 * could not be read.
 */
function degradedDay(req, reason) {
  const tz = cfg.bossTimezone ?? "America/New_York";
  const date = req?.date ?? todayISO();
  const name = zonedWeekdayName(date, tz);
  return {
    id: "day",
    date,
    day: name,
    title: `${name} — ${date}`,
    items: localOnlyItems(date),
    calendars: [],
    degraded: true,
    error: reason,
  };
}

function degradedFreeBusy(req, reason) {
  const date = req?.date ?? todayISO();
  return { date, free: [], busy: [], degraded: true, error: reason };
}

/** Try each configured provider in order; return the first success or why all failed. */
async function viaProviders(real, stub, req) {
  const attempts = [];
  if (useServiceAccount()) attempts.push(["service-account", real.sa]);
  if (useOAuth2()) attempts.push(["oauth2", real.oauth]);

  let lastError = null;
  for (const [name, fn] of attempts) {
    try {
      const out = await fn(req);
      markProviderOk("calendar");
      return out;
    } catch (e) {
      lastError = e;
      console.warn(`[calendar] ${name} failed: ${e.message}`);
      markProviderFail("calendar", e);
    }
  }
  // Nothing configured = deliberate demo mode, so the synthetic day is correct.
  if (attempts.length === 0) return stub(req);
  return lastError;
}

export async function listCalendars() {
  if (useOAuth2()) {
    try {
      const list = await oauthListCalendars();
      markProviderOk("calendar");
      return list;
    } catch (e) {
      console.warn("[calendar] OAuth2 list failed:", e.message);
      markProviderFail("calendar", e);
    }
  }
  return [];
}

export async function getTodaySummary(req) {
  const result = await viaProviders({ sa: gcalToday, oauth: oauthToday }, stubToday, req);
  return result instanceof Error ? degradedDay(req, result.message) : result;
}

export async function freeBusy(req) {
  const result = await viaProviders({ sa: gcalFreeBusy, oauth: oauthFreeBusy }, stubFreeBusy, req);
  return result instanceof Error ? degradedFreeBusy(req, result.message) : result;
}

export async function bookOrMove(req) {
  if (useServiceAccount() || useOAuth2()) {
    try {
      const out = useServiceAccount() ? await gcalBookOrMove(req) : await oauthBookOrMove(req);
      markProviderOk("calendar");
      return out;
    } catch (e) {
      // Do NOT fall back to the store here: the boss asked the assistant to put
      // something on their real calendar. Silently "succeeding" locally would
      // mean no invite is sent and no one else sees it.
      console.warn("[calendar] book/move failed:", e.message);
      markProviderFail("calendar", e);
      return { ok: false, action: req?.action ?? "book", error: `Calendar write failed: ${e.message}` };
    }
  }
  return stubBookOrMove(req);
}