# Boss's PA — WhatsApp AI Agent (Hackathon Build Plan)

**Objective:** A real, production-shaped AI "personal assistant" that the boss's PA texts
with over WhatsApp. It books/checks flights, manages the calendar, drafts email, and
handles the day-to-day — all in one chat thread. Goal is to **win the hackathon** with a
real product (not just a demo loop), plus a polished demo video submitted later.

**Channel:** WhatsApp only. **Messaging infra:** Photon/Spectrum (always-on webhook layer).

---

## 0. The one fact that changes everything (confirm early)

| Assumption (default) | If actually true... | If false, swap to |
|---|---|---|
| Calendar = **Google Workspace** (Gmail + Google Calendar) | Build normally | Outlook/Microsoft Graph — swap GCal/Gmail tools only; rest unchanged |

This is the **only** hard fork in the whole plan. Everything else is buildable today.

---

## 1. Architecture

```
PA texts WhatsApp
        │
        ▼
Photon/Spectrum (channel glue + always-on webhook)
        │  POST events
        ▼
Your agent server (webhook → decide → tools)
        │
        ├──► Google Calendar   (schedule/move/cancel, free-busy, invites)
        ├──► Gmail            (draft/reply, triage, extract confirmations)
        ├──► Flight API(s)    (search real options) → present in chat
        ├──► Booking confirm  (human-in-the-loop step)
        ├──► Reservations     (restaurants/Uber — stretch)
        ├──► Weather/traffic/commute
        └──► Preference store (window seat, no early mtgs, fave airline)
        │
        ▼
agent replies back via Photon → WhatsApp thread
```

---

## 2. Capability map — "everything a PA does"

| # | Capability | Tool | Agent behavior | Autonomy |
|---|---|---|---|---|
| 1 | Schedule | Google Calendar | find free slots → book/move/cancel → invite; timezone-aware | confirm before change |
| 2 | Day prep | Gmail + Calendar | summarize today: who's in each meeting, what was promised | autonomous (read) |
| 3 | Trips & flights | Flights API | real search → options as chat cards → book on confirm → itinerary | confirm before book |
| 4 | Email triage | Gmail | draft replies, flag urgent, pull confirm codes | draft→approve |
| 5 | Reminders/todos | Tasks + Calendar | create, defer, snooze, nudge | autonomous |
| 6 | Reservations | Maps/OpenTable/Uber | find + book table/ride (stretch) | confirm before book |
| 7 | React to change | Event hooks | "2pm moved → replan evening" (the winning shine) | confirm before change |
| 8 | Tiny details | Weather/commute/contacts | add commute, weather, who-to-call | autonomous |
| 9 | Expenses | store + sheet | log & tally trip costs (later tier) | autonomous |
| 10 | Memory | preference store | remembers seats/airline/schedule rules — feels like *her* PA | autonomous |

**Safety model (what makes it a "real product", not a demo):**
- Read-only ops (search, check, summarize, retrieve) → **autonomous**
- Mutating/irreversible ops (book, send, pay, cancel) → **always confirm in chat**, with a roll-back path

---

## 3. Priority tiers for the hackathon

- **Tier 1 — MUST (this wins):** Scheduling + Flight search/present + itinerary + reminders + email summary, all in one WhatsApp thread.
- **Tier 2 — FILL (breadth):** Reservations, weather/commute, expenses, confirmations.
- **Tier 3 — SHINE:** surprise-change adaptive replan, preference memory, 90-second demo video.

**Target: Tier 1 fully real + Tier 3 shine; Tier 2 stubbed.**

---

## 4. Build order (task list)

### Phase 0 — De-risk the channel (start NOW, it's the bottleneck)
- [ ] Confirm Google Workspace (or Outlook fork)
- [ ] WhatsApp: get a number + business account; kick off Meta/Cloud API or Photon WhatsApp approval immediately
- [ ] Decide whether Photon pre-bundles WhatsApp setup (it does) — prefer it over hand-rolling Meta Cloud API
- [ ] Set up Photon/Spectrum project + verify send/receive with a test number

### Phase 1 — Agent core (works in plain text/CLI, before WhatsApp is live)
- [x] Webhook server skeleton (receive message → return reply)
- [x] Agent wiring: pick model (LLM tool-calling loop) — `src/brain.js` runs an
      OpenAI-compatible tool-calling loop (OpenRouter now; Groq by setting `LLM_API_KEY`),
      with model auto-resolve + fallback. No key configured ⇒ deterministic router still runs.
- [x] Tool 1: Flight search → structured option list
- [x] Tool 2: Google Calendar read + free-busy (stub provider)
- [x] Tool 3: Gmail summary/draft (stub provider)
- [x] Preference store (tiny; seats, airline, rules)
- [x] Print hello-world flow in terminal to prove the loop

### Phase 2 — Wire WhatsApp
- [x] Connect Photon webhook → agent → reply (`src/server.js`; dry-run outbound until `PHOTON_SEND_URL`/token set)
- [ ] Send option "cards"/rich text over WhatsApp
- [x] Multi-turn statefulness (search → pick → book)

### Phase 3 — Booking + safety
- [x] Human-in-the-loop confirm before booking/sending
- [x] Calendar book/move/cancel with invites (stub store, confirm-gated; real GCal swap at provider)
- [x] Itinerary builder from confirmations (flights + calendar events, merged by date)

### Phase 4 — The shine
- [ ] "Surprise change" adaptive replan demo
- [ ] Memory across conversations

### Completed this session (safety + Tier 1 close)
- **Safety fix**: "book f1" / "confirm" with no pending proposal → deterministic "nothing pending" instead of LLM hallucination
- **Bug fix**: `server.js:25` `cfg.provider` → `cfg.channelProvider` (healthz crash)
- **Bug fix**: `flights.js:34` `returningSelect` → `returning` (live Google-Flights round-trip)
- **Implicit time**: "Friday morning" → 09:00, "afternoon" → 13:00, "evening/tonight" → 18:00
- **LLM date anchor**: system prompt includes "Today is YYYY-MM-DD"; propose_event sanitizes past-year guesses
- **Casing**: calendar proposals preserve original casing in summaries
- **Day/free-busy**: `what's my day Friday` now shows that date's schedule

### Phase 5 — Ship
- [ ] End-to-end test on the PA's real number
- [ ] 90-second demo video (screen-recording + flow) — with a **local messenger mock fallback** in case WhatsApp flakes live

---

## 5. Key gotchas / risks

1. **WhatsApp/Meta approval lead time** — the #1 risk; start Phase 0 the moment the hackathon allows (or before).
2. **Public internet reachability** — Photon removes your own 24/7 server burden; only the agent needs a public webhook (Cloud Run/Container App/Compute).
3. **Booking legality** — present + human-confirm keeps it simple and demo-safe (no stored card payments needed).
4. **Timezone handling** — always resolve to boss's home zone + travel zone.
5. **Live-demo resilience** — always have the messenger-mock fallback.

---

## 6. Open items to confirm with the PA (non-blocking at start)

1. WhatsApp Business number — new, or migrate existing?
2. Is the boss's calendar Google Workspace or Outlook?  ← only real fork
3. Book full flights or search-and-present-first?
4. Any locked preferences to hard-code (airline, seats, airport)?
