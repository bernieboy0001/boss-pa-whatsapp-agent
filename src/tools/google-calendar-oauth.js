import { google } from "googleapis";
import { cfg } from "../config.js";
import { addEvent, getEvents, eventsOn, updateEvent, removeEvent } from "./events.js";
import { getOAuth2Client } from "./oauth2-client.js";
import { zonedDayBounds, zonedDateStr, zonedTimeStr, zonedToday, zonedWeekdayName } from "./zoned-time.js";

let calendarClient = null;

function getCalendarClient() {
  if (calendarClient) return calendarClient;
  const auth = getOAuth2Client();
  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

function bossZone() {
  return cfg.bossTimezone ?? "America/New_York";
}

function todayISO() {
  return zonedToday(bossZone());
}

function toISO(dateStr, timeStr) {
  if (!dateStr) return null;
  if (!timeStr) return `${dateStr}T00:00:00`;
  return `${dateStr}T${timeStr}:00`;
}

/**
 * Every calendar the token can read.
 *
 * The agenda used to hardcode calendarId:"primary", which silently hid the
 * shared family calendar even though the token can see it. Cached briefly
 * because this is a round trip on every agenda render.
 */
let calendarCache = { at: 0, list: [] };
const CALENDAR_TTL_MS = 5 * 60 * 1000;

async function readableCalendars() {
  if (Date.now() - calendarCache.at < CALENDAR_TTL_MS && calendarCache.list.length) {
    return calendarCache.list;
  }
  const cal = getCalendarClient();
  const res = await cal.calendarList.list({ minAccessRole: "reader" });
  const list = (res.data.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary ?? c.id,
    primary: Boolean(c.primary),
    accessRole: c.accessRole ?? "reader",
    // Reference calendars (holidays, birthdays) are labelled rather than
    // hidden: the boss asked to see everything the token can read.
    reference: /holiday|birthday|week.?number/i.test(c.summary ?? c.id),
  }));
  list.sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
  calendarCache = { at: Date.now(), list };
  return list;
}

export async function listCalendars() {
  return readableCalendars();
}

/** The calendar new events are written to. */
function writeCalendarId() {
  return cfg.calendarWriteId || "primary";
}

/** One calendar's events across a window, following pagination. */
async function listWindow(cal, calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function getTodaySummary(req) {
  const tz = bossZone();
  const date = req?.date ?? todayISO();
  const cal = getCalendarClient();
  const { start, end } = zonedDayBounds(date, tz);

  const calendars = await readableCalendars();
  const warnings = [];
  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      try {
        const found = await listWindow(cal, c.id, start, end);
        return found.map((e) => ({ e, c }));
      } catch (err) {
        // Losing access to one shared calendar must not blank the whole agenda.
        console.warn(`[calendar] skipping ${c.summary} (${c.id}): ${err.message}`);
        warnings.push(`${c.summary}: ${err.message}`);
        return [];
      }
    }),
  );

  const items = [];
  for (const { e, c } of perCalendar.flat()) {
    const dateTime = e.start?.dateTime;
    const allDayDate = e.start?.date;
    const raw = dateTime ?? allDayDate;
    if (!raw) continue;

    if (dateTime) {
      const eventTz = e.start?.timeZone || tz;
      const instant = new Date(dateTime);
      // A timed event can fall on a different local date than the day queried
      // (an evening event already tomorrow in the boss's zone).
      if (zonedDateStr(instant, eventTz) !== date) continue;
      items.push({
        time: zonedTimeStr(instant, eventTz),
        sortKey: zonedTimeStr(instant, eventTz),
        title: e.summary ?? "(no title)",
        location: e.location ?? "",
        attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
        done: false,
        calendar: c.summary,
        calendarId: c.id,
        gcalId: e.id,
      });
    } else {
      // Recurring all-day events expand to one instance per day.
      if (!String(allDayDate).startsWith(date)) continue;
      items.push({
        time: "All day",
        sortKey: "00:00",
        title: e.summary ?? "(no title)",
        location: e.location ?? "",
        attendees: [],
        done: false,
        calendar: c.summary,
        calendarId: c.id,
        gcalId: e.id,
      });
    }
  }

  const stored = eventsOn(date).map((e) => ({
    time: String(e.when ?? "").slice(11, 16),
    sortKey: String(e.when ?? "").slice(11, 16),
    title: e.summary,
    location: "",
    attendees: e.attendees ?? [],
    done: Boolean(e.done),
    calendar: "Booked via assistant",
    calendarId: "local",
  }));

  const all = [...items, ...stored]
    .filter((i) => i.time)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const name = zonedWeekdayName(date, tz);
  return {
    id: "day",
    date,
    day: name,
    title: `${name} — ${date}`,
    items: all.map(({ sortKey, ...rest }) => rest),
    calendars: calendars.map((c) => ({
      id: c.id,
      summary: c.summary,
      primary: c.primary,
      reference: c.reference,
    })),
    ...(warnings.length ? { warnings } : {}),
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
  const tz = bossZone();
  const calId = writeCalendarId();

  if (action === "cancel") {
    const target = summary
      ? getEvents().find((e) => e.summary.toLowerCase() === String(summary).toLowerCase())
      : null;
    if (!target) return { ok: false, error: `No event matching "${summary}" found to cancel.` };

    if (target.gcalId) {
      await cal.events.delete({ calendarId: target.calendarId || calId, eventId: target.gcalId });
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
        calendarId: target.calendarId || calId,
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
    calendarId: calId,
    requestBody: event,
    sendUpdates: "all",
  });

  const record = addEvent({
    summary,
    when: start,
    gcalId: created.data.id,
    calendarId: calId,
    attendees: [],
  });
  return {
    ok: true,
    action: "book",
    id: record.id,
    summary: record.summary,
    when: record.when,
    note: "on the calendar — invites sent",
  };
}
