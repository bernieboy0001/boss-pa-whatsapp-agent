import { google } from "googleapis";
import { cfg } from "../config.js";
import { getRecord, putRecord } from "../store.js";
import { scopeId, isOwnerScope } from "../context.js";

const SCOPES = [
  // Identity — lets one consent both sign the user in and grant calendar/mail.
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

const SECRETS_NS = "secrets";
const REFRESH_TOKEN_ID = "google_refresh_token";

// One OAuth client per user scope. Previously a single module-level client
// served everyone, which is exactly the bug multi-user mode fixes: user B's
// request would have gone out on user A's credentials.
const clientCache = new Map();

function baseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.URL) return process.env.URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://flexagent.vercel.app";
}

/** Redirect URI for the operator re-authorization flow (single stored account). */
export function getCallbackUrl() {
  // Must byte-for-byte match a URI registered in the Google Cloud console, so
  // explicit config wins.
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  return `${baseUrl()}/oauth2callback`;
}

/** Redirect URI for multi-user sign-in (one URI, many accounts). */
export function getSigninCallbackUrl() {
  if (process.env.GOOGLE_SIGNIN_REDIRECT_URI) return process.env.GOOGLE_SIGNIN_REDIRECT_URI;
  return `${baseUrl()}/auth/callback`;
}

/**
 * The refresh token in force for the active user.
 *
 * A token re-issued through /oauth-start or a fresh sign-in wins over the env
 * var. Only the owner scope may fall back to the single-tenant env token — a
 * different signed-in user must never inherit the owner's credentials.
 */
export function currentRefreshToken() {
  const stored = getRecord(SECRETS_NS, REFRESH_TOKEN_ID)?.token;
  if (stored) return stored;
  return isOwnerScope() ? cfg.googleOauthRefreshToken || "" : "";
}

/** Persist a freshly issued refresh token for the active scope and drop its cache. */
export function setStoredRefreshToken(token) {
  putRecord(SECRETS_NS, REFRESH_TOKEN_ID, { token, updated: new Date().toISOString() });
  clientCache.delete(scopeId());
  return token;
}

function buildClient(redirectUri, refreshToken) {
  const { googleOauthClientId, googleOauthClientSecret } = cfg;
  const client = new google.auth.OAuth2(googleOauthClientId, googleOauthClientSecret, redirectUri);
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function requireClientConfig() {
  const { googleOauthClientId, googleOauthClientSecret } = cfg;
  if (!googleOauthClientId || !googleOauthClientSecret) {
    throw new Error("Missing OAuth2 config: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET");
  }
}

export function getOAuth2Client() {
  const key = scopeId();
  const cached = clientCache.get(key);
  if (cached) return cached;

  requireClientConfig();
  const refreshToken = currentRefreshToken();
  if (!refreshToken) {
    throw new Error("No Google account is connected for this user (missing refresh token).");
  }
  const client = buildClient(getCallbackUrl(), refreshToken);
  clientCache.set(key, client);
  return client;
}

/** Consent URL for the operator re-authorization flow. */
export function generateAuthUrl(state) {
  requireClientConfig();
  return buildClient(getCallbackUrl()).generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    ...(state ? { state } : {}),
  });
}

/** Consent URL for signing a user in (also requests offline calendar/mail access). */
export function generateSigninUrl(state) {
  requireClientConfig();
  return buildClient(getSigninCallbackUrl()).generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    include_granted_scopes: true,
    ...(state ? { state } : {}),
  });
}

export async function exchangeCodeForTokens(code, { signin = false } = {}) {
  requireClientConfig();
  const client = buildClient(signin ? getSigninCallbackUrl() : getCallbackUrl());
  const { tokens } = await client.getToken(code);
  return tokens;
}

/** Decode the payload of an id_token (issued to us by Google over TLS). */
export function decodeIdToken(idToken) {
  const part = String(idToken || "").split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function isOAuth2Configured() {
  return Boolean(cfg.googleOauthClientId && cfg.googleOauthClientSecret && currentRefreshToken());
}
