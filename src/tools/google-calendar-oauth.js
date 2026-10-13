import { google } from "googleapis";
import { cfg } from "../config.js";
import { addEvent, getEvents, eventsOn, updateEvent, removeEvent } from "./events.js";
import { getOAuth2Client } from "./oauth2-client.js";
import { zonedDayBounds, zonedDateStr, zonedTimeStr, zonedToday, zonedWeekdayName, zonedISOString, addDays } from "./zoned-time.js";
import { availabilityFromItems, minutesOf } from "./availability.js";

let calendarClient = null;

function getCalendarClient() {
  if (calendarClient) return calendarClient;
  const auth = getOAuth2Client();
  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

function bossZone() {
  return cfg.bossTimezone ?? "Africa/Lagos";
}

function todayISO() {
  return zonedToday(bossZone());
}

/**
 * Start/end for a `"YYYY-MM-DD HH:MM"` booking string, as offset-aware
 * RFC3339 in the boss's zone. Both ends come from the same instant maths so
 * they can never land in different reference frames.
 */
function eventWindow(when, tz, minutes = 60) {
  const parts = String(when ?? "").trim().split(/\s+/);
  const dateStr = parts[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? "")) return null;
  const timeStr = parts[1];
  return {
    start: zonedISOString(dateStr, timeStr, tz),
    end: zonedISOString(dateStr, timeStr, tz, minutes),
    // Stored locally for display; `.slice(11,16)` still yields the wall clock.
    local: zonedISOString(dateStr, timeStr, tz),
  };
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
      // Always render in the boss's zone, not the event's own: the boss reads
      // their day in GMT+1 regardless of where a meeting was authored.
      const instant = new Date(dateTime);
      // A timed event can fall on a different local date than the day queried
      // (an evening event already tomorrow in the boss's zone).
      if (zonedDateStr(instant, tz) !== date) continue;
      const startMin = minutesOf(zonedTimeStr(instant, tz)) ?? 0;
      const endInstant = e.end?.dateTime ? new Date(e.end.dateTime) : null;
      let endMin = endInstant ? minutesOf(zonedTimeStr(endInstant, tz)) : null;
      // No end, or an end that doesn't parse/advance: assume a 1-hour meeting.
      if (endMin == null || endMin <= startMin) endMin = startMin + 60;
      items.push({
        time: zonedTimeStr(instant, tz),
        sortKey: zonedTimeStr(instant, tz),
        startMin,
        endMin,
        allDay: false,
        title: e.summary ?? "(no title)",
        location: e.location ?? "",
        attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
        done: false,
        calendar: c.summary,
        calendarId: c.id,
        reference: c.reference,
        gcalId: e.id,
      });
    } else {
      // Recurring all-day events expand to one instance per day.
      if (!String(allDayDate).startsWith(date)) continue;
      items.push({
        time: "All day",
        sortKey: "00:00",
        startMin: 0,
        endMin: 0,
        allDay: true,
        title: e.summary ?? "(no title)",
        location: e.location ?? "",
        attendees: [],
        done: false,
        calendar: c.summary,
        calendarId: c.id,
        reference: c.reference,
        gcalId: e.id,
      });
    }
  }

  const stored = eventsOn(date).map((e) => {
    const time = String(e.when ?? "").slice(11, 16);
    const startMin = minutesOf(time) ?? 0;
    return {
      time,
      sortKey: time,
      startMin,
      endMin: startMin + 60,
      allDay: false,
      title: e.summary,
      location: "",
      attendees: e.attendees ?? [],
      done: Boolean(e.done),
      calendar: "Booked via assistant",
      calendarId: "local",
      reference: false,
    };
  });

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

export async function freeBusy(req) {
  const date = req?.date ?? todayISO();
  const summary = await getTodaySummary({ date });
  return { date, ...availabilityFromItems(summary.items) };
}

/**
 * Every event across `days` calendar days starting at `start`, from every
 * calendar, batched as one `events.list` per calendar — not one per day. The
 * old week view invoked `getTodaySummary` seven times (7 × N calendars of round
 * trips) and could only ever reflect the default single-calendar read.
 */
export async function getRangeSummary({ start, days = 7 } = {}) {
  const tz = bossZone();
  const first = start ?? todayISO();
  const { start: timeMin } = zonedDayBounds(first, tz);
  const { end: timeMax } = zonedDayBounds(addDays(first, days - 1), tz);

  const cal = getCalendarClient();
  const calendars = await readableCalendars();
  const warnings = [];

  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      try {
        return (await listWindow(cal, c.id, timeMin, timeMax)).map((e) => ({ e, c }));
      } catch (err) {
        console.warn(`[calendar] week: skipping ${c.summary} (${c.id}): ${err.message}`);
        warnings.push(`${c.summary}: ${err.message}`);
        return [];
      }
    }),
  );

  const byDate = new Map();
  for (let i = 0; i < days; i += 1) byDate.set(addDays(first, i), []);

  for (const { e, c } of perCalendar.flat()) {
    const dateTime = e.start?.dateTime;
    const allDayDate = e.start?.date;
    if (dateTime) {
      // Render (and bucket) in the boss's zone so the week reads in GMT+1.
      const instant = new Date(dateTime);
      const date = zonedDateStr(instant, tz);
      if (!byDate.has(date)) continue;
      byDate.get(date).push({
        time: zonedTimeStr(instant, tz),
        sortKey: zonedTimeStr(instant, tz),
        title: e.summary ?? "(no title)",
        location: e.location ?? "",
        attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
        done: false,
        allDay: false,
        calendar: c.summary,
        calendarId: c.id,
        reference: c.reference,
        gcalId: e.id,
      });
    } else if (allDayDate && byDate.has(allDayDate)) {
      byDate.get(allDayDate).push({
        time: "All day",
        sortKey: "00:00",
        title: e.summary ?? "(no title)",
        location: e.location ?? "",
        attendees: [],
        done: false,
        allDay: true,
        calendar: c.summary,
        calendarId: c.id,
        reference: c.reference,
        gcalId: e.id,
      });
    }
  }

  for (const [date, items] of byDate) {
    for (const e of eventsOn(date)) {
      const time = String(e.when ?? "").slice(11, 16);
      items.push({
        time,
        sortKey: time,
        title: e.summary,
        location: "",
        attendees: e.attendees ?? [],
        done: Boolean(e.done),
        allDay: false,
        calendar: "Booked via assistant",
        calendarId: "local",
        reference: false,
      });
    }
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }

  const out = [];
  for (const [date, items] of byDate) {
    out.push({
      date,
      day: zonedWeekdayName(date, tz),
      summary: items.map(({ sortKey, ...rest }) => rest),
    });
  }

  return {
    start: first,
    days: out,
    calendars: calendars.map((c) => ({ id: c.id, summary: c.summary, primary: c.primary, reference: c.reference })),
    ...(warnings.length ? { warnings } : {}),
  };
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

    const window = eventWindow(when, tz);
    if (!window) return { ok: false, error: "I need a date and time like 2026-09-29 09:30 to reschedule." };

    if (target.gcalId) {
      await cal.events.patch({
        calendarId: target.calendarId || calId,
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
    calendarId: calId,
    requestBody: event,
    sendUpdates: "all",
  });

  const record = addEvent({
    summary,
    when: window.local,
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
