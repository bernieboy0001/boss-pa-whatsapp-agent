import { google } from "googleapis";
import { cfg } from "../config.js";
import { addEvent, getEvents, eventsOn, updateEvent, removeEvent } from "./events.js";
import { zonedISOString, zonedTimeStr, zonedToday } from "./zoned-time.js";
import { availabilityFromItems, minutesOf } from "./availability.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

let calendarClient = null;

function getCalendarClient() {
  if (calendarClient) return calendarClient;

  if (!cfg.saKeyPath || !cfg.bossCalendarEmail) {
    throw new Error("Missing GOOGLE_SA_KEY_PATH or BOSS_CALENDAR_EMAIL in config");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.saKeyPath,
    scopes: SCOPES,
    subject: cfg.bossCalendarEmail,
  });

  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

function todayISO() {
  return zonedToday(cfg.bossTimezone ?? "Africa/Lagos");
}

/**
 * Start/end for a `"YYYY-MM-DD HH:MM"` booking string as offset-aware RFC3339
 * in the boss's zone. Mirrors google-calendar-oauth.js: a naive start paired
 * with a server-zone end produced an end-before-start 400 on a UTC host.
 */
function eventWindow(when, tz, minutes = 60) {
  const parts = String(when ?? "").trim().split(/\s+/);
  const dateStr = parts[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? "")) return null;
  const timeStr = parts[1];
  return {
    start: zonedISOString(dateStr, timeStr, tz),
    end: zonedISOString(dateStr, timeStr, tz, minutes),
    local: zonedISOString(dateStr, timeStr, tz),
  };
}

export async function getTodaySummary(req) {
  const date = req?.date ?? todayISO();
  const cal = getCalendarClient();
  const tz = cfg.bossTimezone ?? "Africa/Lagos";

  const start = `${date}T00:00:00`;
  const end = `${date}T23:59:59`;

  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: start,
    timeMax: end,
    timeZone: tz,
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = (res.data.items ?? []).map((e) => {
    const startTime = e.start?.dateTime;
    if (!startTime) {
      return { time: "All day", startMin: 0, endMin: 0, allDay: true, title: e.summary ?? "(no title)", attendees: [], done: false };
    }
    const startMin = minutesOf(zonedTimeStr(new Date(startTime), tz)) ?? 0;
    const endMin = e.end?.dateTime ? minutesOf(zonedTimeStr(new Date(e.end.dateTime), tz)) ?? startMin + 60 : startMin + 60;
    return {
      time: zonedTimeStr(new Date(startTime), tz),
      startMin,
      endMin: endMin > startMin ? endMin : startMin + 60,
      allDay: false,
      title: e.summary ?? "(no title)",
      attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
      done: false,
    };
  });

  const stored = eventsOn(date).map((e) => {
    const time = String(e.when ?? "").slice(11, 16);
    const startMin = minutesOf(time) ?? 0;
    return {
      time,
      startMin,
      endMin: startMin + 60,
      allDay: false,
      title: e.summary,
      attendees: e.attendees ?? [],
      done: Boolean(e.done),
    };
  });

  const all = [...items, ...stored]
    .filter((i) => i.time)
    .sort((a, b) => a.time.localeCompare(b.time));

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const name = dayNames[new Date(`${date}T12:00:00`).getDay()];

  return {
    id: "day",
    date,
    day: name,
    title: `${name} — ${date}`,
    items: all,
  };
}

export async function freeBusy(req) {
  const date = req?.date ?? todayISO();
  const summary = await getTodaySummary({ date });
  return { date, ...availabilityFromItems(summary.items) };
}

export async function bookOrMove(req) {
  const { action, summary, when } = req ?? {};
  const cal = getCalendarClient();
  const tz = cfg.bossTimezone ?? "Africa/Lagos";

  if (action === "cancel") {
    const target = summary
      ? getEvents().find((e) => e.summary.toLowerCase() === String(summary).toLowerCase())
      : null;
    if (!target) return { ok: false, error: `No event matching "${summary}" found to cancel.` };

    if (target.gcalId) {
      await cal.events.delete({ calendarId: "primary", eventId: target.gcalId });
    }
    removeEvent(target.id);
    return { ok: true, action, id: target.id, summary: target.summary, when: target.when, note: "cancelled from calendar" };
  }

  if (action === "move") {
    const target = summary
      ? getEvents().find((e) => e.summary.toLowerCase() === String(summary).toLowerCase())
      : null;
    if (!target) return { ok: false, error: `No event matching "${summary}" found to move.` };

    const window = eventWindow(when, tz);
    if (!window) return { ok: false, error: "I need a date and time like 2026-09-29 09:30 to reschedule." };

    if (target.gcalId) {
      await cal.events.patch({
        calendarId: "primary",
        eventId: target.gcalId,
        requestBody: {
          start: { dateTime: window.start, timeZone: tz },
          end: { dateTime: window.end, timeZone: tz },
        },
      });
    }
    const moved = updateEvent(target.id, { when: window.local });
    return { ok: true, action, id: target.id, summary: moved.summary, when: moved.when, note: "rescheduled on calendar" };
  }

  const window = eventWindow(when, tz);
  if (!window) return { ok: false, error: "I need a date and time like 2026-09-29 09:30 to book." };

  const event = {
    summary,
    start: { dateTime: window.start, timeZone: tz },
    end: { dateTime: window.end, timeZone: tz },
    attendees: [],
  };

  const created = await cal.events.insert({
    calendarId: "primary",
    requestBody: event,
    sendUpdates: "all",
  });

  const record = addEvent({ summary, when: window.local, gcalId: created.data.id, attendees: [] });
  return {
    ok: true,
    action: "book",
    id: record.id,
    summary: record.summary,
    when: record.when,
    note: "on the calendar — invites sent",
  };
}