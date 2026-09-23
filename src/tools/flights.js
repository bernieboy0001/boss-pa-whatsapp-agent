import { cfg } from "../config.js";

/**
 * Flight search tool.
 *
 * Two modes:
 *  - "live": talks to a real provider (SerpAPI Google-Flights or Amadeus) and returns structured options.
 *  - "stub": returns realistic mock options so the whole agent loop is runnable today with zero keys.
 *
 * Provider is chosen in .env (FLIGHT_PROVIDER). Swapping = config change, never a code change.
 */
export async function searchFlights(req) {
  const { origin, destination, date, returning, passengers = 1, cabin = "economy" } = req;

  if (cfg.flightProvider === "google-flights" && cfg.serpApiKey) {
    return liveGoogleFlights(req);
  }
  if (cfg.flightProvider === "amadeus" && cfg.amadeusClientId && cfg.amadeusClientSecret) {
    return liveAmadeus(req);
  }
  return stubFlights(req);
}

async function liveGoogleFlights(req) {
  const params = new URLSearchParams({
    engine: "google_flights",
    hl: "en",
    currency: "USD",
    type: req.returning ? "2" : "1",
    departure_id: req.origin,
    arrival_id: req.destination,
    outbound_date: req.date,
  });
  if (req.returning) params.set("return_date", req.returning);

  const res = await fetch(`https://serpapi.com/search.json?${params}`, {
    headers: { Authorization: `Bearer ${cfg.serpApiKey}` },
  });
  if (!res.ok) throw new Error(`Flights API ${res.status}`);

  const data = await res.json();
  return (data.best_flights ?? []).map((f, i) => ({
    id: `f${i + 1}`,
    airline: f.flights?.[0]?.airline ?? "—",
    flightNo: f.flights?.[0]?.flight_number ?? "",
    depart: f.flights?.[0]?.departure_airport ?? "",
    departTime: f.flights?.[0]?.departure_airport_time ?? "",
    arrive: f.flights?.[0]?.arrival_airport ?? "",
    arriveTime: f.flights?.[0]?.arrival_airport_time ?? "",
    duration: (f.duration ?? 0) >= 60 ? `${Math.floor((f.duration ?? 0) / 60)}h ${(f.duration ?? 0) % 60}m` : `${f.duration ?? 0}m`,
    stops: (f.flights?.length ?? 1) - 1,
    price: f.price,
    currency: "USD",
  }));
}

async function liveAmadeus(req) {
  const token = await getAmadeusToken();

  const params = new URLSearchParams({
    originLocationCode: req.origin,
    destinationLocationCode: req.destination,
    departureDate: req.date,
    adults: String(req.passengers ?? 1),
    travelClass: cabinToAmadeus(req.cabin),
    currencyCode: "USD",
    max: "6",
  });
  if (req.returning) params.set("returnDate", req.returning);

  const res = await fetch(`https://test.api.amadeus.com/v2/shopping/flight-offers?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Amadeus ${res.status}`);

  const data = await res.json();
  return (data.data ?? []).map((o, i) => {
    const seg = o.itineraries?.[0]?.segments?.[0];
    const last = o.itineraries?.[0]?.segments?.at(-1);
    return {
      id: `f${i + 1}`,
      airline: seg?.carrierCode ?? "—",
      flightNo: seg?.number ?? "",
      depart: seg?.departure?.iataCode ?? "",
      departTime: seg?.departure?.at ?? "",
      arrive: last?.arrival?.iataCode ?? "",
      arriveTime: last?.arrival?.at ?? "",
      duration: isoDurationToHuman(o.itineraries?.[0]?.duration),
      stops: (o.itineraries?.[0]?.segments?.length ?? 1) - 1,
      price: Number(o.price?.total ?? 0),
      currency: o.price?.currency ?? "USD",
    };
  });
}

async function getAmadeusToken() {
  const res = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.amadeusClientId,
      client_secret: cfg.amadeusClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Amadeus token ${res.status}`);
  return (await res.json()).access_token;
}

function cabinToAmadeus(c) {
  return c === "business" ? "BUSINESS" : c === "first" ? "FIRST" : "ECONOMY";
}

function isoDurationToHuman(iso) {
  if (!iso) return "";
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  const h = m?.[1] ? Number(m[1]) : 0;
  const min = m?.[2] ? Number(m[2]) : 0;
  return h ? `${h}h ${min}m` : `${min}m`;
}

/**
 * The mutating path. Called ONLY after an explicit in-chat confirmation of a
 * proposal the agent already presented (see agent.js). Swapping in the real
 * provider booking API happens here and nowhere else.
 */
export async function bookFlight(option) {
  return {
    ok: true,
    id: `bk_${Date.now().toString(36)}`,
    airline: option.airline,
    flightNo: option.flightNo,
    price: option.price,
    currency: option.currency ?? "USD",
    note: "stub — integrate provider booking API on confirm; itinerary emitted here",
  };
}

function stubFlights({ origin, destination, date, returning, passengers = 1, cabin = "economy" }) {
  const roundTrip = Boolean(returning);
  const base = cabin === "business" ? 980 : cabin === "first" ? 2400 : 420;

  const options = [];
  const times = [
    ["06:10", "08:40"],
    ["09:15", "14:30"],
    ["13:40", "18:55"],
    ["17:20", "22:10"],
  ];
  const airlines = [
    ["Delta", "DL"],
    ["United", "UA"],
    ["American", "AA"],
    ["British Airways", "BA"],
  ];

  for (let i = 0; i < airlines.length && i < 4; i++) {
    const [name, code] = airlines[i];
    const [dep, arr] = times[i];
    const price = Math.round((base + i * 85) * (0.95 + i * 0.05)) * passengers;

    options.push({
      id: `f${i + 1}`,
      airline: name,
      flightNo: `${code}${120 + i * 37}`,
      depart: origin,
      departTime: `${date} ${dep}`,
      arrive: destination,
      arriveTime: `${date} ${arr}`,
      duration: roundTrip ? "12h 05m" : "7h 05m",
      stops: i === 0 ? 0 : 1,
      price,
      currency: "USD",
    });
  }

  return options;
}

/* ---------------------------------------------------------------- formatting */

function timeOf(stamp = "") {
  return stamp.length > 10 ? stamp.slice(11) : stamp.trim();
}

export function printFlights(rows = []) {
  if (!rows.length) return "No flights found.";
  return rows
    .map((f) => {
      const stop = f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`;
      return `${f.id} · ${f.airline} ${f.flightNo} · ${timeOf(f.departTime)} → ${timeOf(f.arriveTime)} · ${stop} · ${f.duration} · ${f.price} ${f.currency ?? "USD"}`;
    })
    .join("\n");
}
