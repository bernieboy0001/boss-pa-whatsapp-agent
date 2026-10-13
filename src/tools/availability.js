/**
 * Real availability maths.
 *
 * The old free/busy reported whole-hour slots, capped at six
 * (`OPEN_HOURS.filter(...).slice(0, 6)`) against a hardcoded 11-hour day, which
 * is where "OPEN TIME 6h · 55% of your day is flexible" came from — a number
 * invented from a slot count, not measured from the boss's actual meetings.
 *
 * Here we measure from each timed event's real start/end (minutes from
 * midnight in the boss's zone), clamp to the working window, merge overlaps and
 * subtract. All-day and reference (holiday/birthday) entries never consume
 * meeting time.
 */

export const WORK_START = 9 * 60;
export const WORK_END = 18 * 60;

/** "09:30" -> 570. Null when the string isn't a wall-clock time. */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 570 -> "09:30". */
export function hm(min) {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(Number(min) || 0)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Availability for a day from raw calendar items. Items are expected to carry
 * `startMin`/`endMin` (minutes from midnight) and optional `allDay`/`reference`.
 */
export function availabilityFromItems(items, opts = {}) {
  const start = opts.start ?? WORK_START;
  const end = opts.end ?? WORK_END;
  const window = Math.max(1, end - start);

  const timed = (items ?? []).filter(
    (i) => i && !i.allDay && !i.reference && i.startMin != null && i.endMin != null && i.endMin > i.startMin,
  );

  const busy = timed
    .map((i) => ({
      start: hm(Math.max(start, i.startMin)),
      end: hm(Math.min(end, i.endMin)),
      title: i.title ?? "(no title)",
      calendar: i.calendar ?? "",
    }))
    .map((b) => ({ ...b, minutes: minutesOf(b.end) - minutesOf(b.start) }))
    .filter((b) => b.minutes > 0)
    .sort((a, b) => a.start.localeCompare(b.start));

  const merged = mergeIntervals(busy.map((b) => [minutesOf(b.start), minutesOf(b.end)]));

  const free = [];
  let cursor = start;
  for (const [s, e] of merged) {
    if (s > cursor) free.push({ start: hm(cursor), end: hm(s), minutes: s - cursor });
    cursor = Math.max(cursor, e);
  }
  if (cursor < end) free.push({ start: hm(cursor), end: hm(end), minutes: end - cursor });

  const busyMinutes = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  const freeMinutes = window - busyMinutes;

  return {
    workday: { start: hm(start), end: hm(end), minutes: window },
    freeMinutes,
    busyMinutes,
    freePct: Math.round((freeMinutes / window) * 100),
    busyPct: Math.round((busyMinutes / window) * 100),
    free,
    busy,
  };
}

/** "5h 20m" / "45m" — for the hero and chat answers. */
export function humanDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h && rem) return `${h}h ${rem}m`;
  if (h) return `${h}h`;
  return `${rem}m`;
}
