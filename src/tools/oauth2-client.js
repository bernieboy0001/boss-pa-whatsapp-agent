import { google } from "googleapis";
import { cfg } from "../config.js";
import { getRecord, putRecord } from "../store.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

const SECRETS_NS = "secrets";
const REFRESH_TOKEN_ID = "google_refresh_token";

let oauth2Client = null;

/**
 * The refresh token actually in force.
 *
 * A token re-issued through /oauth-start wins over the env var: Google only
 * hands back a refresh token at consent time, and a serverless deployment
 * cannot rewrite its own environment, so persisting it in the store is the
 * difference between "re-authorise and it just works" and "copy this string
 * into Vercel and redeploy".
 */
export function currentRefreshToken() {
  const stored = getRecord(SECRETS_NS, REFRESH_TOKEN_ID)?.token;
  return stored || cfg.googleOauthRefreshToken || "";
}

/** Persist a freshly issued refresh token and drop the cached client so the next call uses it. */
export function setStoredRefreshToken(token) {
  putRecord(SECRETS_NS, REFRESH_TOKEN_ID, { token, updated: new Date().toISOString() });
  oauth2Client = null;
  return token;
}

function getCallbackUrl() {
  // Must byte-for-byte match a URI registered in the Google Cloud console, so
  // explicit config wins. VERCEL_URL is the *ephemeral* deployment domain and
  // is deliberately last — preferring it would return a redirect_uri_mismatch
  // whenever the canonical (production) alias is the registered one.
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (process.env.APP_URL) return `${process.env.APP_URL.replace(/\/$/, "")}/oauth2callback`;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/oauth2callback`;
  if (process.env.URL) return `${process.env.URL.replace(/\/$/, "")}/oauth2callback`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/oauth2callback`;
  return "https://flexagent.vercel.app/oauth2callback";
}

export function getOAuth2Client() {
  if (oauth2Client) return oauth2Client;

  const { googleOauthClientId, googleOauthClientSecret } = cfg;
  const refreshToken = currentRefreshToken();

  if (!googleOauthClientId || !googleOauthClientSecret || !refreshToken) {
    throw new Error("Missing OAuth2 config: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN");
  }

  oauth2Client = new google.auth.OAuth2(
    googleOauthClientId,
    googleOauthClientSecret,
    getCallbackUrl()
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return oauth2Client;
}

export function generateAuthUrl(state) {
  const { googleOauthClientId, googleOauthClientSecret } = cfg;
  if (!googleOauthClientId || !googleOauthClientSecret) {
    throw new Error("Missing OAuth2 config: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET");
  }
  const client = new google.auth.OAuth2(
    googleOauthClientId,
    googleOauthClientSecret,
    getCallbackUrl()
  );
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    // `consent` forces a refresh token even if this account authorised before,
    // which is the usual reason a re-auth returns no token.
    prompt: "consent",
    ...(state ? { state } : {}),
  });
}

export async function exchangeCodeForTokens(code) {
  const { googleOauthClientId, googleOauthClientSecret } = cfg;
  if (!googleOauthClientId || !googleOauthClientSecret) {
    throw new Error("Missing OAuth2 config: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET");
  }
  const client = new google.auth.OAuth2(
    googleOauthClientId,
    googleOauthClientSecret,
    getCallbackUrl()
  );
  const { tokens } = await client.getToken(code);
  return tokens;
}

export function isOAuth2Configured() {
  return Boolean(cfg.googleOauthClientId && cfg.googleOauthClientSecret && currentRefreshToken());
}