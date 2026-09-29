import { listRecords, getRecord, putRecord, deleteRecord, hasRecord } from "../store.js";
import { getPrefs } from "../prefs.js";
import { eventsOn } from "./events.js";

/**
 * Smart Reminders — flexible input → optimal time placement.
 * Considers: existing calendar, prefs.noMeetingsBefore, travel buffers, work hours.
 *
 * Backed by the shared store so a checked-off or deleted reminder stays that
 * way across a cold start. Previously this was a JSON file that silently
 * reverted to seed data whenever the instance was recycled.
 */

const SEED_FLAG = "reminders_seeded";

const DEFAULT_REMINDERS = [
  { id: "rem_1", text: "Review Q3 board deck", due: null, recurring: null, status: "pending", created: new Date().toISOString() },
  { id: "rem_2", text: "Call Sarah re: M&A timeline", due: null, recurring: null, status: "pending", created: new Date().toISOString() },
];

/**
 * Seed on a genuinely fresh store only. A "meta" record marks that seeding has
 * happened, so a user who deletes every reminder does not get them back.
 */
function seed() {
  if (hasRecord("meta", SEED_FLAG)) return;
  if (listRecords("reminders").length === 0) {
    for (const rec of DEFAULT_REMINDERS) putRecord("reminders", rec.id, rec);
  }
  putRecord("meta", SEED_FLAG, { at: new Date().toISOString() });
}

export function getReminders() {
  seed();
  return listRecords("reminders");
}

export function addReminder(reminder) {
  seed();
  return putRecord("reminders", `rem_${Date.now().toString(36)}`, {
    ...reminder,
    status: "pending",
    created: new Date().toISOString(),
  });
}

export function updateReminder(id, patch) {
  const existing = getRecord("reminders", id);
  if (!existing) return null;
  return putRecord("reminders", id, { ...existing, ...patch });
}

export function deleteReminder(id) {
  return deleteRecord("reminders", id);
}

/**
 * Smart placement: given a reminder text and optional preferred window,
 * suggest the best time slot today or tomorrow.
 * Rules:
 * - Respect prefs.noMeetingsBefore (default 09:00)
 * - Avoid existing calendar blocks (eventsOn)
 * - Prefer 30-min slots between 09:00–18:00
 * - If "urgent" in text → earliest available
 * - If "end of day" / "before I leave" → latest available
 */
export function suggestTime(reminderText, preferredDate = null) {
  const prefs = getPrefs();
  const date = preferredDate ?? new Date().toISOString().slice(0, 10);
  const busy = eventsOn(date).map((e) => e.when.slice(11, 16)); // HH:MM
  const startHour = Number(prefs.noMeetingsBefore?.split(":")[0] ?? 9);
  const endHour = 18;
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m of [0, 30]) {
      const slot = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (!busy.includes(slot)) slots.push(slot);
    }
  }
  const text = reminderText.toLowerCase();
  if (/urgent|asap|right now|immediately/.test(text)) return slots[0] ?? `${String(startHour).padStart(2, "0")}:00`;
  if (/end of day|before i leave|late afternoon|evening/.test(text)) return slots[slots.length - 1] ?? `${String(endHour - 1).padStart(2, "0")}:30`;
  // Default: first available mid-morning
  return slots.find((s) => Number(s.split(":")[0]) >= 10) ?? slots[0] ?? `${String(startHour).padStart(2, "0")}:00`;
}

/**
 * Trends / AI suggestions — analyze patterns and suggest slots.
 * Returns array of { type, title, description, suggestedTime, confidence }
 */
export function getTrends() {
  const prefs = getPrefs();
  const reminders = getReminders().filter((r) => r.status === "pending");
  const today = new Date().toISOString().slice(0, 10);
  const busy = eventsOn(today).map((e) => e.when.slice(11, 16));
  const suggestions = [];

  // 1. Unscheduled reminders → suggest slots
  for (const r of reminders.slice(0, 3)) {
    const slot = suggestTime(r.text, today);
    suggestions.push({
      type: "reminder",
      title: `Schedule: ${r.text}`,
      description: `No time set — ${slot} is open today`,
      suggestedTime: slot,
      confidence: 0.8,
    });
  }

  // 2. Travel buffer (if flight today)
  const flightToday = eventsOn(today).some((e) => /flight|travel/i.test(e.summary));
  if (flightToday) {
    suggestions.push({
      type: "travel",
      title: "Travel buffer",
      description: "Block 90 min before airport departure",
      suggestedTime: "auto",
      confidence: 0.9,
    });
  }

  // 3. Prep time before first meeting
  const firstMeeting = busy.find((t) => Number(t.split(":")[0]) >= Number(prefs.noMeetingsBefore?.split(":")[0] ?? 9));
  if (firstMeeting) {
    const h = Number(firstMeeting.split(":")[0]);
    if (h >= 10) {
      suggestions.push({
        type: "prep",
        title: "Pre-meeting prep",
        description: `30 min before ${firstMeeting} meeting`,
        suggestedTime: `${String(h - 1).padStart(2, "0")}:${firstMeeting.split(":")[1]}`,
        confidence: 0.7,
      });
    }
  }

  // 4. Recurring pattern detection (simplified)
  const weeklyReminders = reminders.filter((r) => r.recurring === "weekly");
  if (weeklyReminders.length > 0) {
    suggestions.push({
      type: "recurring",
      title: "Weekly reminders due",
      description: `${weeklyReminders.length} recurring items — batch at 09:30?`,
      suggestedTime: "09:30",
      confidence: 0.6,
    });
  }

  return suggestions;
}