import { google } from "googleapis";
import { cfg } from "../config.js";
import { addEvent, getEvents, eventsOn, updateEvent, removeEvent } from "./events.js";
import { getOAuth2Client } from "./oauth2-client.js";

let calendarClient = null;

function getCalendarClient() {
  if (calendarClient) return calendarClient;

  const auth = getOAuth2Client();
  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toISO(dateStr, timeStr) {
  if (!dateStr) return null;
  if (!timeStr) return `${dateStr}T00:00:00`;
  return `${dateStr}T${timeStr}:00`;
}

function fromISO(iso) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { date, time };
}

export async function getTodaySummary(req) {
  const date = req?.date ?? todayISO();
  const cal = getCalendarClient();
  const tz = cfg.bossTimezone ?? "America/New_York";

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
    const startTime = e.start?.dateTime ?? e.start?.date ?? "";
    const { time } = fromISO(startTime);
    return {
      time: time || "All day",
      title: e.summary ?? "(no title)",
      attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
      done: false,
    };
  });

  const stored = eventsOn(date).map((e) => ({
    time: String(e.when ?? "").slice(11, 16),
    title: e.summary,
    attendees: e.attendees ?? [],
    done: Boolean(e.done),
  }));

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

const OPEN_HOURS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];

export async function freeBusy(req) {
  const date = req?.date ?? todayISO();
  const summary = await getTodaySummary({ date });
  const taken = new Set(summary.items.map((i) => i.time.slice(0, 2)));
  const free = OPEN_HOURS.filter((h) => !taken.has(h.slice(0, 2))).slice(0, 6);
  const busy = summary.items.map((i) => `${i.time} ${i.title}`);
  return { date, free, busy };
}

export async function bookOrMove(req) {
  const { action, summary, when } = req ?? {};
  const cal = getCalendarClient();
  const tz = cfg.bossTimezone ?? "America/New_York";

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

    const start = toISO(...(when?.split(" ") ?? []));
    const end = start ? new Date(start).getTime() + 60 * 60 * 1000 : null;
    const endISO = end ? new Date(end).toISOString() : null;

    if (target.gcalId) {
      await cal.events.patch({
        calendarId: "primary",
        eventId: target.gcalId,
        requestBody: {
          start: { dateTime: start, timeZone: tz },
          end: { dateTime: endISO, timeZone: tz },
        },
      });
    }
    const moved = updateEvent(target.id, { when: start });
    return { ok: true, action, id: target.id, summary: moved.summary, when: moved.when, note: "rescheduled on calendar" };
  }

  const start = toISO(...(when?.split(" ") ?? []));
  const end = start ? new Date(start).getTime() + 60 * 60 * 1000 : null;
  const endISO = end ? new Date(end).toISOString() : null;

  const event = {
    summary,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: endISO, timeZone: tz },
    attendees: [],
  };

  const created = await cal.events.insert({
    calendarId: "primary",
    requestBody: event,
    sendUpdates: "all",
  });

  const record = addEvent({ summary, when: start, gcalId: created.data.id, attendees: [] });
  return {
    ok: true,
    action: "book",
    id: record.id,
    summary: record.summary,
    when: record.when,
    note: "on the calendar — invites sent",
  };
}