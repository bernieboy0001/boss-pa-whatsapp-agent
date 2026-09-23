import { cfg, brainConfigured } from "./config.js";
import { getPrefs, setPrefs } from "./prefs.js";
import { searchFlights, bookFlight } from "./tools/flights.js";
import { getTodaySummary, freeBusy, bookOrMove } from "./tools/calendar.js";
import { inboxSummary, draftReply } from "./tools/email.js";
import { addFlightToItinerary, getItinerary } from "./tools/itinerary.js";

/**
 * The PA's brain: one OpenAI-compatible chat-completions client (Groq or
 * OpenRouter — whichever key is present) with function calling over the PA's
 * tools. Ported from crow's proven brain.ts: model auto-resolve, tool loop,
 * and graceful degradation when a provider rejects tools or retires a model.
 *
 * If no key is configured, brainConfigured() is false and the agent falls back
 * to its deterministic router — the product still runs with zero keys.
 */

const MODEL_PREFERENCE = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-3.3-70b-instruct",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

let workingModel = null;
let candidates = [];
let candidateIndex = 0;

function authHeaders() {
  const h = { authorization: `Bearer ${cfg.llmApiKey}`, "content-type": "application/json" };
  if (/openrouter\.ai/.test(cfg.llmBaseUrl)) {
    h["http-referer"] = "https://github.com/boss-pa";
    h["x-title"] = "Boss PA";
  }
  return h;
}

async function listModels() {
  const res = await fetch(`${cfg.llmBaseUrl}/models`, { headers: authHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`models list ${res.status}`);
  const j = await res.json();
  return (j.data ?? [])
    .map((d) => d.id)
    .filter((id) => typeof id === "string" && !/whisper|guard|embed/i.test(id));
}

/** Build the ordered model try-list from the provider's live catalogue. */
async function refreshCandidates() {
  const ids = await listModels();
  const ordered = [];
  if (cfg.llmModel && ids.includes(cfg.llmModel)) ordered.push(cfg.llmModel);
  for (const m of MODEL_PREFERENCE) if (ids.includes(m) && !ordered.includes(m)) ordered.push(m);
  candidates = ordered;
  candidateIndex = 0;
  workingModel = candidates[0] ?? null;
  return candidates;
}

/** Advance to the next candidate after a provider/model failure. */
function advanceModel() {
  if (candidateIndex + 1 >= candidates.length) return false;
  candidateIndex += 1;
  workingModel = candidates[candidateIndex];
  return true;
}

/** Verify the configured model on boot; self-heal to a working one if it's gone. */
export async function warmupBrain() {
  if (!brainConfigured()) {
    console.warn("[brain] offline — set LLM_API_KEY (or OPENROUTER_API_KEY) to wake it.");
    return;
  }
  try {
    const list = await refreshCandidates();
    if (!list.length) return console.warn("[brain] provider offered no usable chat models.");
    console.log(`[brain] ${cfg.llmBaseUrl} · using ${workingModel}${list.length > 1 ? ` (${list.length} fallbacks)` : ""}.`);
  } catch (e) {
    console.warn(`[brain] warmup failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------- tools */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_flights",
      description: "Search real flight options between two airports for a date. Returns structured options with stable ids.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "IATA code, e.g. JFK" },
          destination: { type: "string", description: "IATA code, e.g. LHR" },
          date: { type: "string", description: "YYYY-MM-DD" },
          passengers: { type: "integer" },
          cabin: { type: "string", enum: ["economy", "business", "first"] },
          round_trip: { type: "boolean" },
        },
        required: ["destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_day",
      description: "Summarize the boss's calendar for a day (default today).",
      parameters: { type: "object", properties: { date: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "free_busy",
      description: "Which hours are free vs busy on a day.",
      parameters: { type: "object", properties: { date: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "inbox_summary",
      description: "Summarize the unread inbox: urgent items and promises.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_reply",
      description: "Draft an email reply for the boss to approve. Never sends.",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, topic: { type: "string" } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Persist a standing preference (seat, airline, home airport, meeting rules).",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_itinerary",
      description: "Show the boss's booked travel itinerary (flights and confirmed calendar events).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_event",
      description:
        "Propose a calendar change (book/move/cancel) for the boss to confirm. Sets a pending proposal; nothing is committed. Tell the boss to reply \"confirm\" to commit it.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["book", "move", "cancel"] },
          summary: { type: "string", description: "short meeting/event title" },
          when: { type: "string", description: "YYYY-MM-DD HH:MM in boss timezone" },
        },
        required: ["action", "summary"],
      },
    },
  },
];

const BOOK_TOOL = {
  type: "function",
  function: {
    name: "book_flight",
    description: "Book one of the flight options already shown. Only call after the user explicitly confirms.",
    parameters: { type: "object", properties: { flight_id: { type: "string", description: "e.g. f2" } } },
  },
};

const EVENT_TOOL = {
  type: "function",
  function: {
    name: "book_event",
    description: "Commit a calendar proposal that the boss has explicitly confirmed. Never call otherwise.",
    parameters: { type: "object", properties: {} },
  },
};

async function runTool(name, args, ctx) {
  switch (name) {
    case "search_flights": {
      const prefs = getPrefs();
      const origin = (args.origin ?? prefs.homeAirport ?? "JFK").toUpperCase();
      const destination = String(args.destination ?? "").toUpperCase();
      const results = await searchFlights({
        origin,
        destination,
        date: args.date ?? "",
        passengers: args.passengers ?? 1,
        cabin: args.cabin ?? prefs.cabin ?? "economy",
        returning: args.round_trip ? args.date ?? "" : "",
      });
      ctx.session.pendingFlight = { origin, destination, date: args.date ?? "", passengers: args.passengers ?? 1, cabin: args.cabin ?? "economy", results };
      return { origin, destination, date: args.date ?? "", options: results };
    }
    case "get_day":
      return getTodaySummary({ date: args.date });
    case "free_busy":
      return freeBusy({ date: args.date });
    case "inbox_summary":
      return inboxSummary({});
    case "draft_reply":
      return draftReply({ to: args.to, topic: args.topic });
    case "remember":
      return setPrefs({ [args.key]: args.value });
    case "get_itinerary":
      return getItinerary();
    case "propose_event": {
      ctx.session.pendingCalendar = {
        action: args.action ?? "book",
        summary: args.summary ?? "Untitled event",
        when: fixUpcomingWhen(args.when ?? ""),
      };
      return { pending: true, action: args.action, summary: args.summary, when: args.when, note: "awaiting explicit confirmation" };
    }
    case "book_event": {
      const pending = ctx.session.pendingCalendar;
      if (!pending) return { error: "No calendar proposal is pending — propose one first." };
      const res = bookOrMove(pending);
      delete ctx.session.pendingCalendar;
      return res;
    }
    case "book_flight": {
      const pending = ctx.session.pendingFlight;
      if (!pending) return { error: "No flight options are pending — search first." };
      const choice = args.flight_id ? pending.results.find((f) => f.id === args.flight_id) : pending.results[0];
      if (!choice) return { error: `No option ${args.flight_id}.` };
      const ticket = await bookFlight({ ...choice, origin: pending.origin, destination: pending.destination, date: pending.date });
      addFlightToItinerary({
        ticketId: ticket.id,
        airline: ticket.airline,
        flightNo: ticket.flightNo,
        origin: pending.origin,
        destination: pending.destination,
        date: pending.date,
        departTime: choice.departTime ?? "",
        price: ticket.price,
        currency: ticket.currency ?? "USD",
      });
      delete ctx.session.pendingFlight;
      return ticket;
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

/* ------------------------------------------------------------------- chat */

function systemPrompt(session) {
  const prefs = getPrefs();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const lines = [
    "You are the Boss's personal assistant (PA), texting over the boss's chat channel. You are capable, discreet, and concise — at most a few short sentences unless presenting options.",
    `Today is ${today} in the boss's timezone (${prefs.bossZone}). Always use real, upcoming dates (current year); never invent past dates for events or flights.`,
    "You can: search real flights (then present options and book ONLY after explicit confirmation), read the boss's calendar and free/busy, summarize the inbox, draft email for approval, build the itinerary, and remember preferences.",
    "SAFETY: never claim you booked, sent, or changed anything unless a tool actually did it.",
    "If options were just presented, an explicit instruction to book (\"book the cheapest\", \"book it\", \"book f2\", \"confirm\") IS the confirmation — call book_flight immediately, don't ask again. If no options exist yet, search first; never book without a prior explicit request.",
    "For calendar changes (schedule/move/cancel a meeting): call propose_event to put the proposal in front of the boss, and never book_event until the boss says \"confirm\" in the SAME message you just received. Tell them to reply 'confirm'.",
    `Boss timezone: ${prefs.bossZone}. Home airport: ${prefs.homeAirport}. Preferred cabin: ${prefs.cabin}, seat: ${prefs.seat}, no meetings before ${prefs.noMeetingsBefore}.`,
    `Standing rules: ${prefs.standingRules.join("; ")}.`,
  ];
  if (session.pendingFlight) {
    lines.push(
      `There are pending flight options for ${session.pendingFlight.origin}→${session.pendingFlight.destination}: ${session.pendingFlight.results
        .map((f) => `${f.id} ${f.airline} ${f.flightNo} ${f.price}${f.currency}`)
        .join(", ")}.`,
    );
  }
  if (session.pendingCalendar) {
    lines.push(
      `There is a pending calendar proposal: ${session.pendingCalendar.action} "${session.pendingCalendar.summary}" at ${session.pendingCalendar.when || "unscheduled"}. It is NOT committed yet.`,
    );
  }
  return lines.join("\n");
}

async function postChat(body) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function ensureCandidates() {
  if (candidates.length) return;
  try {
    await refreshCandidates();
  } catch {
    if (cfg.llmModel) {
      candidates = [cfg.llmModel];
      workingModel = cfg.llmModel;
    }
  }
}

async function callChat(messages, tools, allowSwitch = true) {
  await ensureCandidates();
  const body = { model: workingModel ?? cfg.llmModel, messages, max_tokens: 800, temperature: 0.6 };
  if (tools?.length) body.tools = tools;

  const res = await postChat(body);
  if (res.status === 400 && tools?.length) return callChat(messages, null, allowSwitch); // provider rejects tools

  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error || !j.choices?.length) {
    const msg = j.error?.message ?? `HTTP ${res.status}`;
    if (allowSwitch && advanceModel()) {
      console.warn(`[brain] ${body.model} unavailable (${msg}); retrying with ${workingModel}`);
      return callChat(messages, tools, true);
    }
    throw new Error(`brain: ${msg}`);
  }
  const m = j.choices[0].message ?? {};
  return {
    content: m.content ?? null,
    toolCalls: (m.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      args: safeJson(tc.function?.arguments),
    })),
  };
}

function safeJson(raw) {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Backstop against the LLM inventing a past year for an event (e.g. 2023). */
function fixUpcomingWhen(when) {
  const dMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(when ?? ""));
  if (!dMatch) return when ?? "";
  const now = new Date();
  let y = Number(dMatch[1]);
  const m = dMatch[2];
  const day = dMatch[3];
  const time = when.length > 10 ? when.slice(10) : "";
  if (y < now.getFullYear()) y = now.getFullYear();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (`${y}-${m}-${day}` < today) y += 1;
  return `${y}-${m}-${day}${time}`;
}

/* ------------------------------------------------------------------ public */

export { brainConfigured };

export async function brainReply(question, ctx = {}) {
  if (!brainConfigured()) return null;
  const session = ctx.session ?? {};
  const tools = [...TOOLS];
  if (session.pendingFlight) tools.push(BOOK_TOOL);
  if (session.pendingCalendar) tools.push(EVENT_TOOL);
  const messages = [
    { role: "system", content: systemPrompt(session) },
    { role: "user", content: question },
  ];

  for (let round = 0; round < 3; round++) {
    const reply = await callChat(messages, tools);
    if (!reply.toolCalls?.length) return reply.content?.trim() || null;

    messages.push({
      role: "assistant",
      content: reply.content ?? null,
      tool_calls: reply.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })),
    });
    for (const t of reply.toolCalls) {
      let result;
      try {
        result = await runTool(t.name, t.args ?? {}, { session });
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify(result) });
    }
  }
  // Ran out of rounds — ask for a plain final answer without tools.
  const final = await callChat([...messages, { role: "user", content: "Summarize the outcome for the boss in plain text." }], null);
  return final.content?.trim() || "I ran into a snag — try again?";
}
