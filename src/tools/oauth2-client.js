import { google } from "googleapis";
import { cfg } from "../config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

let oauth2Client = null;

function getCallbackUrl() {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (process.env.APP_URL) return `${process.env.APP_URL.replace(/\/$/, "")}/oauth2callback`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/oauth2callback`;
  if (process.env.URL) return `${process.env.URL.replace(/\/$/, "")}/oauth2callback`;
  return "https://flexagent.vercel.app/oauth2callback";
}

export function getOAuth2Client() {
  if (oauth2Client) return oauth2Client;

  const { googleOauthClientId, googleOauthClientSecret, googleOauthRefreshToken } = cfg;

  if (!googleOauthClientId || !googleOauthClientSecret || !googleOauthRefreshToken) {
    throw new Error("Missing OAuth2 config: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN");
  }

  oauth2Client = new google.auth.OAuth2(
    googleOauthClientId,
    googleOauthClientSecret,
    getCallbackUrl()
  );

  oauth2Client.setCredentials({ refresh_token: googleOauthRefreshToken });

  return oauth2Client;
}

export function generateAuthUrl() {
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
    prompt: "consent",
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
  return Boolean(cfg.googleOauthClientId && cfg.googleOauthClientSecret && cfg.googleOauthRefreshToken);
}