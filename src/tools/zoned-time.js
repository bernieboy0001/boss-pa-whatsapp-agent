/**
 * Timezone helpers.
 *
 * Why this exists
 * ───────────────
 * The calendar layer used to compute "today" and event times with the
 * *server's* local zone (`new Date().getTimezoneOffset()`, `.getHours()`).
 * Locally that accidentally matched the boss's zone; on Vercel the instance
 * runs UTC, so a 09:30 New York meeting was queried for the wrong day and
 * rendered as 13:30. `getTZOffset(tz)` even accepted a `tz` argument and
 * ignored it.
 *
 * `Intl.DateTimeFormat` is in the Node runtime and knows about DST and IANA
 * zone history, so we lean on it rather than hand-rolling offset maths or
 * pulling in a date library that esbuild would have to trace into the bundle.
 */

const partsFormatterCache = new Map();

function formatter(tz) {
  let f = partsFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatterCache.set(tz, f);
  }
  return f;
}

function partsAt(instant, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // Intl emits hour 24 for midnight under hour12:false in some ICU versions.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Offset of `tz` from UTC, in ms, at the given instant (DST-aware). */
export function zoneOffsetMs(instant, tz) {
  const p = partsAt(instant, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - instant.getTime();
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

/**
 * The UTC instants bounding a local calendar day in `tz`.
 * Handles DST correctly, including the 23h/25h days.
 */
export function zonedDayBounds(dateStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  // First guess: treat local midnight as if it were UTC, then subtract the
  // offset that actually applies at that moment. One refinement pass settles
  // the rare case where the offset differs across the boundary.
  let instant = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  for (let i = 0; i < 2; i += 1) {
    instant = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - zoneOffsetMs(instant, tz));
  }
  const start = instant;
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  let end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  for (let i = 0; i < 2; i += 1) {
    end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - zoneOffsetMs(end, tz));
  }
  return { start: start.toISOString(), end: end.toISOString(), nextDay: nextDay };
}

/** Local `YYYY-MM-DD` in `tz` for an instant. */
export function zonedDateStr(instant, tz) {
  const p = partsAt(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local `HH:MM` in `tz` for an instant. */
export function zonedTimeStr(instant, tz) {
  const p = partsAt(instant, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Today's date string in `tz` (not the server's date). */
export function zonedToday(tz) {
  return zonedDateStr(new Date(), tz);
}

/** Weekday name for a `YYYY-MM-DD` string, evaluated at local noon in `tz`. */
export function zonedWeekdayName(dateStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) - zoneOffsetMs(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), tz));
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(noon);
}

/** Shift a `YYYY-MM-DD` string by whole days, staying in calendar terms. */
export function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
