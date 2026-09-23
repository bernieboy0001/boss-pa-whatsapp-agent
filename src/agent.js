import { getPrefs } from "./prefs.js";
import { searchFlights, printFlights, bookFlight } from "./tools/flights.js";
import { getTodaySummary, freeBusy, bookOrMove } from "./tools/calendar.js";
import { inboxSummary, draftReply } from "./tools/email.js";
import { addFlightToItinerary, viewItinerary } from "./tools/itinerary.js";
import { brainConfigured, brainReply } from "./brain.js";

/**
 * THE core agent. Channel-agnostic: it takes a raw chat message plus a session
 * object and returns the reply text. Both the terminal CLI (Phase 1) and the
 * WhatsApp webhook (Phase 2) call this exact function — swapping the channel is
 * a transport change, never a rewrite of the agent.
 *
 * Safety model (see BUILD_PLAN.md §2):
 *  - Read-only ops (search, check, summarize) run autonomously.
 *  - Mutating ops (book, send, move, cancel) NEVER run on the autonomous path.
 *    They only execute when the user's message is an explicit confirmation of a
 *    proposal the agent already put in front of them (session.pending*).
 */

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const HELP = 'Say something like: "flights JFK to LHR Friday", "schedule 1:1 with Sara Wed 4pm", "itinerary", "what\'s my day?", or "inbox?".';

export async function handleMessage(text, opts = {}) {
  const session = opts.session ?? {};
  const t = String(text ?? "").trim();
  const low = t.toLowerCase();

  if (!low) {
    return HELP;
  }

  // A mutable action can ONLY act on a pending proposal — never standalone.
  // Confirms/declines are intercepted here, deterministically, so a stray
  // "book f1" can never reach the LLM and make up options out of thin air.
  if (session.pendingFlight && isConfirm(low)) return confirmFlight(low, session);
  if (session.pendingCalendar && isConfirm(low)) return confirmCalendar(low, session);
  if ((session.pendingFlight || session.pendingCalendar) && isDecline(low)) return clearProposal(session);
  if (isConfirm(low) || isDecline(low)) {
    return "Nothing pending to confirm or cancel right now. Try: \"flights JFK to LHR Friday\", \"schedule 1:1 with Sara Wed 4pm\", \"what's my day?\", or \"inbox?\".";
  }

  if (isFlightQuery(low)) return handleFlights(low, session);
  if (isDayQuery(low)) return handleDay(low);
  if (isEmailQuery(low)) return handleEmail(low);
  if (isItineraryQuery(low)) return handleItinerary();
  if (isCalendarMutation(low)) return proposeCalendar(low, session, t);
  if (!brainConfigured() && /remind\b/.test(low)) {
    return "Got it — I'll set a reminder. (Set LLM_API_KEY to let me handle freeform requests like this.)";
  }

  // Freeform: the brain reasons and calls tools when a key is configured;
  // otherwise fall back to the deterministic parser.
  if (brainConfigured()) {
    try {
      const answer = await brainReply(t, { session });
      if (answer) return answer;
    } catch (err) {
      console.warn("[agent] brain failed:", err.message);
    }
  }

  return isFlightQuery(low) ? handleFlights(low, session) : HELP;
}

/* --------------------------------------------------------------- intent match */

function isFlightQuery(low) {
  return (
    /flight|flights|\bfly\b|flying|\btrip\b|travel|book a trip/.test(low) ||
    /\b[a-z]{3}\s+(?:to|→|-)\s+[a-z]{3}\b/.test(low)
  );
}

function isDayQuery(low) {
  return /what'?s (?:my |the |boss'?s )?day|today'?s (?:schedule|calendar|day)|what am i doing|calendar|my schedule|free.?\s*busy|do i have|agenda/.test(
    low,
  );
}

function isEmailQuery(low) {
  return /email|inbox|\bmail\b/.test(low);
}

function isItineraryQuery(low) {
  return /\bitinerary\b|my trip|trip plan|my flights|travel plan|what do i have booked/.test(low);
}

function isConfirm(low) {
  return /^(confirm|yes|yep|yeah|ok(?:ay)?|do it|book it|book\s+f\d+|go ahead)\b/.test(low);
}

/** A short, unambiguous "no" — used only to drop an existing pending proposal. */
function isDecline(low) {
  const t = low.trim();
  if (/^(no|nope|not that|never mind|nevermind|skip|forget it|scratch that|drop it|negative)\b/.test(t)) return true;
  return /^cancel\b/.test(t) && t.split(/\s+/).length <= 3;
}

const MUTATION_VERBS = /\b(schedule|book|add|create|organize|set up|move|reschedule|push|postpone|cancel|delete|remove)\b/i;
const EVENT_NOUNS = /\b(meeting|call|lunch|dinner|coffee|sync|1:1|1 on 1|appointment|event|huddle|session|standup|retro|review|interview|demo)\b/i;

function isCalendarMutation(low) {
  if (!MUTATION_VERBS.test(low)) return false;
  const hasWhen = /(now|today|tonight|tomorrow|next\s+\w+|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)|[01]?\d:[0-5]\d)/i.test(low);
  return hasWhen || EVENT_NOUNS.test(low);
}

/* -------------------------------------------------------------------- flights */

async function handleFlights(low, session) {
  const prefs = getPrefs();
  const roundTrip = /round\s*trip|return\b|\brt\b/.test(low);

  const pair = /([a-z]{3})\s+(?:to|→|-)\s+([a-z]{3})/.exec(low);
  const origin = (pair?.[1] ?? prefs.homeAirport ?? "JFK").toUpperCase();
  const destination = (pair?.[2] ?? "").toUpperCase();

  if (!destination) {
    return `Where to? Try: "flights ${origin} to LHR Friday".`;
  }

  const passengers = Number(/\b(\d+)\s*(?:pax|passengers?|people)\b/.exec(low)?.[1]) || 1;
  const cabin = /first\b/.test(low) ? "first" : /business\b/.test(low) ? "business" : (prefs.cabin ?? "economy");
  const date = detectDate(low);

  const results = await searchFlights({
    origin,
    destination,
    date,
    passengers,
    cabin,
    returning: roundTrip ? date : "",
  });

  session.pendingFlight = { origin, destination, date, passengers, cabin, results };

  return [
    `✈️ ${origin} → ${destination} — ${date || "your travel date"}`,
    `(${roundTrip ? "round-trip" : "one-way"} · ${passengers} pax · ${cabin})`,
    "",
    printFlights(results),
    "",
    `Reply "book f1" (or "confirm" for the first option) and I'll book it.`,
  ].join("\n");
}

async function confirmFlight(low, session) {
  const { origin, destination, date, results } = session.pendingFlight;
  const wanted = /book\s+(f\d+)/.exec(low)?.[1];
  const choice = wanted ? results.find((f) => f.id === wanted) : results[0];

  if (!choice) return `I don't have an option "${wanted}" — say "book f1" through "f${results.length}".`;

  const ticket = await bookFlight({ ...choice, origin, destination, date });
  delete session.pendingFlight;

  addFlightToItinerary({
    ticketId: ticket.id,
    airline: ticket.airline,
    flightNo: ticket.flightNo,
    origin,
    destination,
    date,
    departTime: choice.departTime ?? "",
    price: ticket.price,
    currency: ticket.currency ?? "USD",
  });

  const depart = String(choice.departTime ?? "");
  const when = depart.length > 10 ? depart.slice(11) : depart.trim();

  return [
    `✅ Booked — ${ticket.airline} ${ticket.flightNo}`,
    `${origin} → ${destination} · ${date} · ${when}`,
    `Ref: ${ticket.id} · ${ticket.price} ${ticket.currency}`,
    "Added to your itinerary — say \"itinerary\" to view it.",
  ].join("\n");
}

/* ------------------------------------------------------------------ calendar */

async function handleDay(low) {
  const date = detectDate(low) || undefined;
  const summary = await getTodaySummary({ date });
  const lines = [`🗓 ${summary.day} — ${summary.date}`, "", ...summary.items.map((it) => `${it.time}  ${it.title}`), ""];

  if (/free|busy|slot|when|open/.test(low)) {
    const fb = await freeBusy({ date });
    lines.push(`Free: ${fb.free.join(", ")}`);
    lines.push(`Busy: ${fb.busy.join(", ")}`);
  }
  return lines.join("\n");
}

/* ----------------------------------------------------------------- itinerary */

function handleItinerary() {
  return viewItinerary();
}

/* ------------------------------------------------- calendar book/move/cancel */

function proposeCalendar(low, session, original) {
  const action = /\b(cancel|delete|remove)\b/.test(low) ? "cancel" : /\b(move|reschedule|push|postpone)\b/.test(low) ? "move" : "book";
  const time = detectTime(low) || implicitTime(low);
  const date = detectDate(low) || (time ? localToday() : "");
  const summary = extractSummary(String(original ?? low).trim());
  const when = date && time ? `${date} ${time}` : date || time || "unscheduled";

  session.pendingCalendar = { action, summary, when };
  const verb = action === "book" ? "book" : action === "move" ? "move" : "cancel";
  return [
    `📅 Proposed: ${verb} "${summary}"`,
    `When: ${when}`,
    "",
    `Reply "confirm" to ${verb} it, or "never mind" to drop.`,
  ].join("\n");
}

async function confirmCalendar(_low, session) {
  const { action, summary, when } = session.pendingCalendar;
  const res = await bookOrMove({ action, summary, when });
  delete session.pendingCalendar;
  if (!res.ok) return res.error;
  const verbPast = action === "book" ? "Booked" : action === "move" ? "Moved" : "Cancelled";
  return [`📅 ${verbPast} — "${res.summary}"`, `When: ${res.when} · Ref: ${res.id}`, `(${res.note})`].join("\n");
}

function clearProposal(session) {
  const had = session.pendingFlight ? "flight options" : session.pendingCalendar ? "calendar proposal" : "";
  delete session.pendingFlight;
  delete session.pendingCalendar;
  return had ? `OK — dropped the pending ${had}.` : "Nothing pending.";
}

/** "4pm" / "4:30 pm" / "16:30" → "16:30" (24h, boss zone). */
function detectTime(t) {
  const m = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i.exec(t);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ?? "00";
    const ap = m[3].toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${min}`;
  }
  const m2 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (m2) return `${String(Number(m2[1])).padStart(2, "0")}:${m2[2]}`;
  return "";
}

/** "morning" / "afternoon" / "evening" / "tonight" → "09:00" / "13:00" / "18:00". */
function implicitTime(t) {
  if (/\bmorning\b/i.test(t)) return "09:00";
  if (/\bafternoon\b/i.test(t)) return "13:00";
  if (/\bevening\b|\btonight\b/i.test(t)) return "18:00";
  return "";
}

/** "schedule 1:1 with Sara Wednesday at 4pm" → "1:1 with Sara". */
function extractSummary(low) {
  let s = low;
  s = s.replace(/\b(please|can you|can u|could you|hey|hi|hello|set up|put|add|create|organize|schedule|book|move|reschedule|push|postpone|cancel|delete|remove)\b/gi, " ");
  s = s.replace(/\b(now|today|tonight|tomorrow|next|this|coming)\b/gi, " ");
  s = s.replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, " ");
  s = s.replace(/\b(1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(am|pm)\b/gi, " ");
  s = s.replace(/\b([01]?\d|2[0-3]):[0-5]\d\b/g, " ");
  s = s.replace(/\b(20\d{2}-\d{2}-\d{2})\b/g, " ");
  s = s.replace(/\b(morning|afternoon|evening|noon|tonight)\b/gi, " ");
  s = s.replace(/\b(a|an|the|for|at|on|to|until)\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/g, "");
  return (s.length > 60 ? `${s.slice(0, 59)}…` : s) || "Untitled event";
}

/* --------------------------------------------------------------------- email */

async function handleEmail(low) {
  const summary = await inboxSummary({});
  const lines = [`📥 Inbox — ${summary.count} unread`, "", ...summary.urgent.map((e) => `• ${e.from}: "${e.subject}"`)];
  if (/draft|reply/.test(low)) {
    const d = await draftReply({ to: summary.urgent[0]?.from, topic: summary.urgent[0]?.subject });
    lines.push("", `Draft for approval:\n${d.body}`);
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------- date parser */

function fmtLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localToday() {
  return fmtLocal(new Date());
}

/** Friday / next Friday / tomorrow / today / 2026-06-01 */
function detectDate(t) {
  const named = /(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.exec(t);
  if (named) {
    const target = DAY_NAMES.indexOf(named[2]);
    const d = new Date();
    let diff = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // "Friday" means the coming one, not today
    if (named[1]) diff += 7;
    d.setDate(d.getDate() + diff);
    return fmtLocal(d);
  }
  if (/tomorrow/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return fmtLocal(d);
  }
  if (/today|tonight/.test(t)) return localToday();
  return /\b(20\d{2}-\d{2}-\d{2})\b/.exec(t)?.[1] ?? "";
}
