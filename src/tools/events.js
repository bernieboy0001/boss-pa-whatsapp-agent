import { listRecords, getRecord, putRecord, deleteRecord } from "../store.js";

/**
 * Persistence for confirmed calendar events.
 *
 * This is the "live" half of the calendar tool: when a human confirms a
 * proposed book/move/cancel, the mutation lands here so a later "what's my
 * day?" actually reflects it. Swapping in a real Google Calendar service
 * account later means changing bookOrMove() in calendar.js, not this store.
 *
 * Now backed by the shared store, so a confirmed booking survives a cold start
 * and is visible from every concurrent instance.
 */

export function getEvents() {
  return listRecords("events");
}

/** All events whose "YYYY-MM-DD" prefix matches the given date. */
export function eventsOn(date) {
  const d = String(date ?? "");
  return listRecords("events").filter((e) => String(e.when ?? "").startsWith(d));
}

export function addEvent(ev) {
  return putRecord("events", `evt_${Date.now().toString(36)}`, ev);
}

export function updateEvent(id, patch) {
  const existing = getRecord("events", id);
  if (!existing) return null;
  return putRecord("events", id, { ...existing, ...patch });
}

export function removeEvent(id) {
  return deleteRecord("events", id);
}