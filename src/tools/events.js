import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local persistence for confirmed calendar events.
 *
 * This is the "live" half of the calendar tool: when a human confirms a
 * proposed book/move/cancel, the mutation lands here so a later "what's my
 * day?" actually reflects it. Swapping in a real Google Calendar service
 * account later means changing bookOrMove() in calendar.js, not this store.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "data");
const PATH = join(DIR, "events.json");

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(list) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.warn("[events] could not persist (read-only storage):", err.message);
  }
}

export function getEvents() {
  return [...load()];
}

/** All events whose "YYYY-MM-DD" prefix matches the given date. */
export function eventsOn(date) {
  const d = String(date ?? "");
  return load().filter((e) => String(e.when ?? "").startsWith(d));
}

export function addEvent(ev) {
  const list = load();
  const record = { id: `evt_${Date.now().toString(36)}`, ...ev };
  list.push(record);
  cache = list;
  persist(list);
  return record;
}

export function updateEvent(id, patch) {
  const list = load();
  const i = list.findIndex((e) => e.id === id);
  if (i === -1) return null;
  list[i] = { ...list[i], ...patch };
  cache = list;
  persist(list);
  return list[i];
}

export function removeEvent(id) {
  const list = load();
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  cache = next;
  persist(next);
  return true;
}