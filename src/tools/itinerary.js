import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getEvents } from "./events.js";

/**
 * Itinerary builder.
 *
 * Every confirmed booking (flight, later hotels/cars) is appended to a trip in
 * this store, and confirmed calendar events are folded in by date, so the
 * boss can ask "itinerary" and get the whole trip on screen. Tier-1 capability:
 * search → present → confirm → book → itinerary, all in one chat thread.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "data");
const PATH = join(DIR, "itinerary.json");

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : { trips: [] };
  } catch {
    cache = { trips: [] };
  }
  return cache;
}

function persist(data) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn("[itinerary] could not persist (read-only storage):", err.message);
  }
}

export function getItinerary() {
  return { trips: [...load().trips] };
}

/** Attach a confirmed flight to the matching trip, creating one if needed. */
export function addFlightToItinerary(flight) {
  const data = load();
  const origin = flight.origin ?? "";
  const destination = flight.destination ?? "";
  const date = flight.date ?? "";
  const key = `${origin}→${destination}`;

  let trip = data.trips.find((t) => t.key === key && (!date || t.outbound === date));
  if (!trip) {
    trip = { key, origin, destination, outbound: date, flights: [] };
    data.trips.push(trip);
  }
  trip.flights.push({
    id: flight.ticketId ?? flight.id,
    airline: flight.airline,
    flightNo: flight.flightNo,
    departTime: flight.departTime ?? "",
    price: flight.price,
    currency: flight.currency ?? "USD",
  });
  cache = data;
  persist(data);
  return trip;
}

/** Friendly, chat-ready rendering of flights + confirmed calendar events by date. */
export function viewItinerary() {
  const data = load();
  const events = getEvents();
  if (!data.trips.length && !events.length) {
    return "🧳 No trips or events yet — book a flight or schedule a meeting and it shows up here.";
  }

  const byDate = new Map();
  for (const trip of data.trips) {
    for (const f of trip.flights) {
      const date = trip.outbound || "unscheduled";
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(
        `✈️ ${trip.origin} → ${trip.destination} · ${f.airline} ${f.flightNo} · ${f.departTime || date} · ${f.price} ${f.currency}`,
      );
    }
  }
  for (const e of events) {
    const date = String(e.when ?? "").slice(0, 10) || "unscheduled";
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(`📅 ${e.summary} · ${e.when}`);
  }

  const lines = ["🧳 Itinerary"];
  for (const [date, items] of [...byDate.entries()].sort()) {
    lines.push("", `— ${date} —`);
    lines.push(...items);
  }
  return lines.join("\n");
}