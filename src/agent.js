import { getPrefs } from "./prefs.js";
import { cfg } from "./config.js";
import { searchFlights, printFlights, bookFlight } from "./tools/flights.js";
import { getTodaySummary, freeBusy, bookOrMove, getWeekSummary } from "./tools/calendar.js";
import { draftReply, readMail, sendEmail } from "./tools/email.js";
import { addFlightToItinerary, viewItinerary } from "./tools/itinerary.js";
import { zonedToday, addDays } from "./tools/zoned-time.js";
import { humanDuration } from "./tools/availability.js";
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
  // Optional mutable bag. Callers that care (the dashboard) pass one so a
  // fallback reply can be flagged; the CLI and WhatsApp ignore it entirely.
  const degraded = opts.degraded ?? {};
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
  if (session.pendingEmail && (isConfirm(low) || isSend(low))) return confirmEmail(session);
  if ((session.pendingFlight || session.pendingCalendar || session.pendingEmail) && isDecline(low)) return clearProposal(session);
  if (isConfirm(low) || isDecline(low)) {
    return "Nothing pending to confirm or cancel right now. Try: \"flights JFK to LHR Friday\", \"schedule 1:1 with Sara Wed 4pm\", \"what's my day?\", or \"inbox?\".";
  }

  if (isFlightQuery(low)) return handleFlights(low, session);
  if (isItineraryQuery(low)) return handleItinerary();

  // Conversational reads (day / week / inbox) go to the brain when it's
  // configured, so the boss gets a written PA answer it can act on ("reply to
  // Sarah saying..."). The deterministic handlers stay as the honest fallback.
  if (brainConfigured() && (isDayQuery(low) || isWeekQuery(low) || isEmailQuery(low))) {
    try {
      const answer = await brainReply(t, { session });
      if (answer) return answer;
      degraded.reason = "empty-answer";
    } catch (err) {
      console.warn("[agent] brain failed:", err.message);
      degraded.reason = "brain-error";
      degraded.detail = err.message;
    }
  }

  if (isDayQuery(low)) return handleDay(low);
  if (isWeekQuery(low)) return handleWeek();
  if (isEmailQuery(low)) return handleEmail(low, session);
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
      degraded.reason = "empty-answer";
    } catch (err) {
      console.warn("[agent] brain failed:", err.message);
      degraded.reason = "brain-error";
      degraded.detail = err.message;
    }
  } else {
    degraded.reason = "no-key";
  }

  if (!isFlightQuery(low)) degraded.fallback = "router";
  return isFlightQuery(low) ? handleFlights(low, session) : HELP;
}

/* --------------------------------------------------------------- intent match */

/**
 * True when no live flight provider is wired up. flights.js falls back to
 * synthetic options in that mode, so anything derived from them (fares,
 * booking refs) is fabricated and must never be presented as real.
 */
function flightsAreSimulated() {
  return cfg.flightProvider === "stub";
}

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

function isWeekQuery(low) {
  return /\bthis week\b|\bnext week\b|\bmy week\b|\bweek ahead\b|\bcoming week\b|\b7 days\b|\bseven days\b|\bweek\??$/.test(low);
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

/** Explicit "send it" for a staged email draft. */
function isSend(low) {
  return /^(send|send it|send that|send now|yes,? send|go ahead,? send|approve|sounds good|looks good|lgtm)\b/.test(low.trim());
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

  const simulated = flightsAreSimulated();
  const out = [
    `✈️ ${origin} → ${destination} — ${date || "your travel date"}`,
    `(${roundTrip ? "round-trip" : "one-way"} · ${passengers} pax · ${cabin})`,
    "",
    printFlights(results),
    "",
  ];

  if (simulated) {
    out.push(
      `⚠️ Simulated options — no live flight data source is connected (FLIGHT_PROVIDER=stub).`,
      `Nothing here is a real fare or a real booking. Add Amadeus or Google Flights credentials to go live.`,
    );
  } else {
    out.push(`Reply "book f1" (or "confirm" for the first option) and I'll book it.`);
  }
  return out.join("\n");
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

  if (flightsAreSimulated()) {
    return [
      `⚠️ Not a real booking.`,
      `${ticket.airline} ${ticket.flightNo} (${origin} → ${destination} · ${date} · ${when}) is a placeholder from the stub provider.`,
      `No ticket was issued and nothing was charged. Connect a live flight provider to enable real bookings.`,
    ].join("\n");
  }

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
  const lines = [`🗓 ${summary.day} — ${summary.date}`, ""];

  // If the live calendar couldn't be read, say so rather than presenting an
  // empty day as a genuinely free one.
  if (summary.degraded) {
    lines.push(`⚠️ Couldn't read your live calendar — ${summary.error}`);
    lines.push("Showing only events booked through this assistant.");
    lines.push("");
  }

  lines.push(...summary.items.map((it) => `${it.time}  ${it.title}`), "");

  if (/free|busy|slot|when|open/.test(low)) {
    const fb = await freeBusy({ date });
    if (fb.degraded || summary.degraded) {
      lines.push("Free/busy unavailable — calendar not readable right now.");
    } else {
      lines.push(`Open ${humanDuration(fb.freeMinutes)} of a ${humanDuration(fb.workday.minutes)} workday (${fb.freePct}% free):`);
      for (const f of fb.free) lines.push(`  • free ${f.start}–${f.end}`);
      if (fb.busy.length) {
        lines.push("  booked:");
        for (const b of fb.busy) lines.push(`  • ${b.start}–${b.end}  ${b.title}`);
      }
    }
  }
  return lines.join("\n");
}

async function handleWeek() {
  const week = await getWeekSummary({});
  const lines = [`🗓 Your week — starting ${week.start}`, ""];
  for (const d of week.days ?? []) {
    lines.push(`${d.day ?? d.date} · ${d.date}:`);
    if (d.degraded) lines.push("  ⚠️ unavailable");
    else if (!d.summary?.length) lines.push("  — open");
    else for (const it of d.summary) lines.push(`  ${it.time}  ${it.title}${it.calendar ? `  · ${it.calendar}` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trim();
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
  const had = session.pendingFlight
    ? "flight options"
    : session.pendingCalendar
    ? "calendar proposal"
    : session.pendingEmail
    ? "email draft"
    : "";
  delete session.pendingFlight;
  delete session.pendingCalendar;
  delete session.pendingEmail;
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

/** "Jane Doe <jane@x.com>" → "Jane Doe". */
function senderName(from = "") {
  const m = /^\s*"?([^"<]+?)"?\s*<([^>]+)>/.exec(String(from));
  return (m?.[1] ?? String(from)).trim() || String(from);
}

async function handleEmail(low, session) {
  // Fallback path (no brain): read the real mailbox and answer like a PA —
  // "you have a mail from X" plus a one-line summary — never a raw dump.
  const box = await readMail({ query: "in:inbox newer_than:14d", max: 8 });
  if (box.simulated) return `📥 Demo mail — no Gmail provider configured.\n\n${box.top}`;
  if (box.error) return `📥 Could not read the mailbox: ${box.error}`;
  if (!box.messages.length) return "📥 Nothing new in the inbox — you're clear.";

  const lines = [
    `📥 ${box.fetched} recent message${box.fetched === 1 ? "" : "s"}${box.totalMatching ? ` (of ~${box.totalMatching} matching)` : ""}:`,
    "",
  ];
  for (const m of box.messages.slice(0, 6)) {
    const who = senderName(m.from);
    const summary = String(m.snippet ?? "").trim();
    lines.push(`${m.unread ? "●" : "○"} From ${who} — ${summary || m.subject || "(no subject)"}`);
    if (m.subject && summary) lines.push(`   ↳ ${m.subject}`);
  }
  lines.push("");

  if (/reply|respond|draft/.test(low)) {
    const first = box.messages[0];
    const draft = await draftReply({ to: first.from, topic: first.subject });
    session.pendingEmail = {
      to: first.from,
      subject: draft.subject ?? `RE: ${first.subject ?? ""}`,
      body: draft.body ?? "",
    };
    lines.push(`✍️ Draft ready for ${senderName(first.from)} — review it, then say "send" to send (or "never mind"):`, "", draft.body ?? "");
  } else {
    lines.push(`Want me to go deeper? Say "reply to <name> saying ..." or "read the one from <name>".`);
  }
  return lines.join("\n");
}

async function confirmEmail(session) {
  const { to, subject, body } = session.pendingEmail;
  const res = await sendEmail({ to, subject, body });
  if (!res?.ok) return `✉️ Couldn't send to ${to}: ${res?.error ?? "unknown error"}. Draft not sent — tell me to try again.`;
  delete session.pendingEmail;
  return [`✉️ Sent to ${to}.`, subject ? `Subject: ${subject}` : "", res.id ? `Ref: ${res.id}` : ""].filter(Boolean).join("\n");
}

/* ---------------------------------------------------------------- date parser */

function fmtLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "Today" must mean today in the boss's zone. On a UTC server these used to be
// the server's date, which was a day off for most of the US evening.
function localToday() {
  return zonedToday(cfg.bossTimezone ?? "Africa/Lagos");
}

function dayOfWeekInZone() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.bossTimezone ?? "Africa/Lagos",
      weekday: "number",
    }).format(new Date()),
  ) % 7;
}

/** Friday / next Friday / tomorrow / today / 2026-06-01 */
function detectDate(t) {
  const named = /(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.exec(t);
  if (named) {
    const target = DAY_NAMES.indexOf(named[2]);
    const today = zonedToday(cfg.bossTimezone ?? "Africa/Lagos");
    let diff = (target - dayOfWeekInZone() + 7) % 7;
    if (diff === 0) diff = 7; // "Friday" means the coming one, not today
    if (named[1]) diff += 7;
    return addDays(today, diff);
  }
  if (/tomorrow/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return fmtLocal(d);
  }
  if (/today|tonight/.test(t)) return localToday();
  return /\b(20\d{2}-\d{2}-\d{2})\b/.exec(t)?.[1] ?? "";
}
