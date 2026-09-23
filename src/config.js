import dotenv from "dotenv";

dotenv.config();

const OR_KEY = process.env.OPENROUTER_API_KEY ?? "";
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";

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
  bossTimezone: process.env.BOSS_TIMEZONE ?? "America/New_York",

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
};

export function brainConfigured() {
  return Boolean(cfg.llmApiKey);
}
