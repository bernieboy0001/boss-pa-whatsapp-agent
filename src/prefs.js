import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "data");
const PATH = join(DIR, "preferences.json");

const DEFAULT = {
  bossZone: "America/New_York",
  airline: "",
  seat: "aisle",
  cabin: "economy",
  noMeetingsBefore: "09:00",
  homeAirport: "JFK",
  standingRules: ["block 1h buffer after international arrivals"],
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : { ...DEFAULT };
  } catch {
    cache = { ...DEFAULT };
  }
  return cache;
}

export function getPrefs() {
  return { ...load() };
}

export function setPrefs(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  cache = next;
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    console.warn("[prefs] could not persist (read-only storage):", err.message);
  }
  return { ...next };
}
