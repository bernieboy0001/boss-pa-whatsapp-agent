import dotenv from "dotenv";

dotenv.config();

const OR_KEY = process.env.OPENROUTER_API_KEY ?? "";
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";

// Fixed dashboard display names, so a signed-in account shows a chosen name
// instead of whatever their Google profile happens to say. Env `USER_NAMES`
// (format "email:NAME,email2:NAME2") extends/overrides these defaults.
const DEFAULT_DISPLAY_NAMES = {
  "delightbernard7@gmail.com": "BERNIE",
  "pa.co.sec.davricgroup@gmail.com": "ESTHER",
  "jagotunba@gmail.com": "JAGI",
};

function parseDisplayNames(raw) {
  const map = {};
  String(raw || "")
    .split(",")
    .forEach((pair) => {
      const i = pair.indexOf(":");
      if (i <= 0) return;
      const email = pair.slice(0, i).trim().toLowerCase();
      const name = pair.slice(i + 1).trim();
      if (email && name) map[email] = name;
    });
  return map;
}

// Comma-separated address list -> clean, lowercased, de-duped array.
function parseEmails(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// One OpenAI-compatible brain, two possible providers. Whichever key is present
// wins: explicit LLM_* config first, then OpenRouter, then Groq.
function resolveBrain() {
  if (process.env.LLM_API_KEY) {
    return {
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
      model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
    };
  }
  if (OR_KEY) {
    return {
      apiKey: OR_KEY,
      baseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
      model: process.env.LLM_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-oss-120b",
    };
  }
  if (GROQ_KEY) {
    return {
      apiKey: GROQ_KEY,
      baseUrl: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
      model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
    };
  }
  return { apiKey: "", baseUrl: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1", model: process.env.LLM_MODEL ?? "" };
}

const brain = resolveBrain();

export const cfg = {
  // --- Channel (Photon/Spectrum) ---
  channelProvider: process.env.CHANNEL_PROVIDER ?? "imessage", // imessage | whatsapp-business | terminal
  projectId: process.env.SPECTRUM_PROJECT_ID ?? process.env.PROJECT_ID ?? "",
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET ?? process.env.PROJECT_SECRET ?? "",
  paDry: process.env.PA_DRY === "1",
  // WhatsApp Business provider needs Meta Cloud API creds (direct mode).
  waAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
  waPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  waAppSecret: process.env.WHATSAPP_APP_SECRET ?? "",

  // --- Brain (OpenAI-compatible) ---
  llmApiKey: brain.apiKey,
  llmBaseUrl: brain.baseUrl,
  llmModel: brain.model,

  // --- Tools: Flights ---
  flightProvider: process.env.FLIGHT_PROVIDER ?? "stub", // google-flights | amadeus | stub
  serpApiKey: process.env.SERP_API_KEY ?? "",
  amadeusClientId: process.env.AMADEUS_CLIENT_ID ?? "",
  amadeusClientSecret: process.env.AMADEUS_CLIENT_SECRET ?? "",

  // --- Tools: Google Workspace (stubbed until §0 fork is confirmed) ---
  saKeyPath: process.env.GOOGLE_SA_KEY_PATH ?? "",
  bossCalendarEmail: process.env.BOSS_CALENDAR_EMAIL ?? "",
  bossTimezone: process.env.BOSS_TIMEZONE ?? "Africa/Lagos",
  // Where new events are written. Reads span every calendar the token can see;
  // writes always target this one. Defaults to the token owner's primary.
  calendarWriteId: process.env.CALENDAR_WRITE_ID ?? "",

  // --- Tools: Google OAuth2 (personal Gmail) ---
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  googleOauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "",

  // --- Fallback REST webhook (server.js) ---
  webhookSecret: process.env.PHOTON_WEBHOOK_SECRET ?? "",
  sendToken: process.env.PHOTON_SEND_TOKEN ?? "",
  sendUrl: process.env.PHOTON_SEND_URL ?? "",
  agentPhone: process.env.PHOTON_AGENT_PHONE ?? "",
  port: Number(process.env.PORT ?? 3000),

  // --- Multi-user auth (dashboard) ---
  // Turns the single-tenant dashboard into a per-user app. When enabled, every
  // signed-in Google account gets its own calendar/mail token, preferences,
  // reminders and chat history. Leave AUTH unset locally and behaviour is the
  // original single-owner app.
  sessionSecret: process.env.SESSION_SECRET ?? "",
  // Comma-separated allowlist. Only these addresses may sign in. Case-insensitive.
  // `ALLOWED_EMAILS_EXTRA` is appended so new people can be added without ever
  // needing to read back (or risk clobbering) the sensitive primary list.
  allowedEmails: [
    ...new Set([
      ...parseEmails(process.env.ALLOWED_EMAILS),
      ...parseEmails(process.env.ALLOWED_EMAILS_EXTRA),
    ]),
  ],
  // The account that owns the pre-existing (pre-multi-user) data. Its records
  // keep the original unscoped storage keys, so nothing has to be migrated.
  ownerEmail: (process.env.OWNER_EMAIL ?? "delightbernard7@gmail.com").trim().toLowerCase(),

  // email (lowercase) -> preferred display name.
  userDisplayNames: { ...DEFAULT_DISPLAY_NAMES, ...parseDisplayNames(process.env.USER_NAMES) },
};

/** Preferred display name for an account, or "" to fall back to the profile name. */
export function displayNameFor(email) {
  const e = String(email || "").trim().toLowerCase();
  return cfg.userDisplayNames[e] || "";
}

export function brainConfigured() {
  return Boolean(cfg.llmApiKey);
}

/**
 * Multi-user mode is on only when there is a signing key AND an allowlist AND
 * a Google client. Anything short of that falls back to the original
 * single-owner behaviour, which is what local dev and the smoke suite rely on.
 */
export function authConfigured() {
  return Boolean(cfg.sessionSecret && cfg.allowedEmails.length && cfg.googleOauthClientId && cfg.googleOauthClientSecret);
}
