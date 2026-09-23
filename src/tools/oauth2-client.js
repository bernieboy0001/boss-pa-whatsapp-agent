import { google } from "googleapis";
import { cfg } from "../config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

let oauth2Client = null;

export function getOAuth2Client() {
  if (oauth2Client) return oauth2Client;

  const { googleOauthClientId, googleOauthClientSecret, googleOauthRefreshToken } = cfg;

  if (!googleOauthClientId || !googleOauthClientSecret || !googleOauthRefreshToken) {
    throw new Error("Missing OAuth2 config: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN");
  }

  oauth2Client = new google.auth.OAuth2(
    googleOauthClientId,
    googleOauthClientSecret,
    "http://localhost:3000/oauth2callback"
  );

  oauth2Client.setCredentials({ refresh_token: googleOauthRefreshToken });

  return oauth2Client;
}

export function generateAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function exchangeCodeForTokens(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export function isOAuth2Configured() {
  return Boolean(cfg.googleOauthClientId && cfg.googleOauthClientSecret && cfg.googleOauthRefreshToken);
}