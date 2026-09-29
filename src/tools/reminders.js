import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrefs } from "../prefs.js";
import { eventsOn } from "./events.js";

/**
 * Smart Reminders — flexible input → optimal time placement.
 * Considers: existing calendar, prefs.noMeetingsBefore, travel buffers, work hours.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "data");
const REMINDER_PATH = join(DIR, "reminders.json");

const DEFAULT_REMINDERS = [
  { id: "rem_1", text: "Review Q3 board deck", due: null, recurring: null, status: "pending", created: new Date().toISOString() },
  { id: "rem_2", text: "Call Sarah re: M&A timeline", due: null, recurring: null, status: "pending", created: new Date().toISOString() },
];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(REMINDER_PATH) ? JSON.parse(readFileSync(REMINDER_PATH, "utf8")) : [...DEFAULT_REMINDERS];
  } catch {
    cache = [...DEFAULT_REMINDERS];
  }
  return cache;
}

function persist(list) {
  cache = list;
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(REMINDER_PATH, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.warn("[reminders] could not persist (read-only storage):", err.message);
  }
}

export function getReminders() { return [...load()]; }

export function addReminder(reminder) {
  const list = load();
  const rec = { id: `rem_${Date.now().toString(36)}`, ...reminder, status: "pending", created: new Date().toISOString() };
  list.push(rec);
  persist(list);
  return rec;
}

export function updateReminder(id, patch) {
  const list = load();
  const i = list.findIndex((r) => r.id === id);
  if (i === -1) return null;
  list[i] = { ...list[i], ...patch };
  persist(list);
  return list[i];
}

export function deleteReminder(id) {
  const list = load();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  persist(next);
  return true;
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