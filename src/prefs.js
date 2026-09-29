import { getDoc, setDoc } from "./store.js";

/**
 * Boss preferences (timezone, travel defaults, standing rules).
 *
 * Backed by the shared store so preferences survive a serverless cold start and
 * are consistent across concurrent instances. Records are mirrored into memory
 * by `ensureHydrated()` before any route runs, so these reads stay synchronous.
 */

const DEFAULT = {
  bossZone: "America/New_York",
  airline: "",
  seat: "aisle",
  cabin: "economy",
  noMeetingsBefore: "09:00",
  homeAirport: "JFK",
  standingRules: ["block 1h buffer after international arrivals"],
};

export function getPrefs() {
  return { ...DEFAULT, ...(getDoc("prefs") ?? {}) };
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  setDoc("prefs", next);
  return { ...next };
}
