import { getDoc, setDoc } from "../store.js";
import { getEvents } from "./events.js";

/**
 * Itinerary builder.
 *
 * Every confirmed booking (flight, later hotels/cars) is appended to a trip in
 * this store, and confirmed calendar events are folded in by date, so the
 * boss can ask "itinerary" and get the whole trip on screen. Tier-1 capability:
 * search → present → confirm → book → itinerary, all in one chat thread.
 *
 * Backed by the shared store, so a booked flight is still on the itinerary
 * after a cold start instead of silently vanishing.
 */

export function getItinerary() {
  return { trips: [...(getDoc("itinerary")?.trips ?? [])] };
}

/** Attach a confirmed flight to the matching trip, creating one if needed. */
export function addFlightToItinerary(flight) {
  const data = { trips: [...(getDoc("itinerary")?.trips ?? [])] };
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
  setDoc("itinerary", data);
  return trip;
}

/** Friendly, chat-ready rendering of flights + confirmed calendar events by date. */
export function viewItinerary() {
  const { trips } = getItinerary();
  const events = getEvents();
  if (!trips.length && !events.length) {
    return "🧳 No trips or events yet — book a flight or schedule a meeting and it shows up here.";
  }

  const byDate = new Map();
  for (const trip of trips) {
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