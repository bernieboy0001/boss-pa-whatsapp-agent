import { createHmac, timingSafeEqual } from "node:crypto";
import { cfg, authConfigured } from "./config.js";
import { getRecord, putRecord } from "./store.js";

/**
 * Dashboard authentication.
 *
 * One Google consent both signs the user in and grants their own calendar/mail
 * (offline). We keep only an opaque, HMAC-signed cookie client-side; the account
 * record (and its refresh token) live in the store, so a stateless serverless
 * function can validate a session on any instance.
 *
 * This module is deliberately usable *outside* a user context: it resolves who
 * the caller is before store scoping kicks in. The `users` namespace is global
 * (see store.js GLOBAL_NS), so these reads are never user-scoped.
 */

const COOKIE = "orbit_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function authEnabled() {
  return authConfigured();
}

export function isAllowed(email) {
  const e = String(email || "").trim().toLowerCase();
  return Boolean(e) && cfg.allowedEmails.includes(e);
}

function mac(data) {
  return createHmac("sha256", cfg.sessionSecret).update(data).digest("hex");
}

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ── session cookie ─────────────────────────────────────────────────────── */

export function signSession(sub, now = Date.now()) {
  const exp = now + SESSION_TTL_MS;
  return `${sub}.${exp}.${mac(`${sub}.${exp}`)}`;
}

function verifySession(value) {
  if (!value) return null;
  const last = value.lastIndexOf(".");
  if (last < 0) return null;
  const payload = value.slice(0, last);
  const sig = value.slice(last + 1);
  const dot = payload.lastIndexOf(".");
  if (dot < 0) return null;
  const sub = payload.slice(0, dot);
  const exp = Number(payload.slice(dot + 1));
  if (!sub || !Number.isFinite(exp) || Date.now() > exp) return null;
  if (!safeEq(sig, mac(`${sub}.${exp}`))) return null;
  return sub;
}

function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

export function sessionCookieValue(req) {
  return parseCookies(req.headers?.cookie)[COOKIE];
}

export function sessionSetCookie(value) {
  const parts = [`${COOKIE}=${encodeURIComponent(value || "")}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  parts.push(value ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : "Max-Age=0");
  return parts.join("; ");
}

/* ── user records ───────────────────────────────────────────────────────── */

function userFromRecord(rec) {
  return {
    id: rec.id,
    email: rec.email,
    name: rec.name || "",
    picture: rec.picture || "",
    isOwner: String(rec.email || "").toLowerCase() === cfg.ownerEmail,
  };
}

/** Resolve the signed-in user from a request, or null. */
export function resolveUser(req) {
  if (!authEnabled()) return null;
  const sub = verifySession(sessionCookieValue(req));
  if (!sub) return null;
  const rec = getRecord("users", sub);
  return rec ? userFromRecord(rec) : null;
}

/** Create or update a user record (email/name/avatar). Does not touch the token. */
export function upsertUser({ sub, email, name, picture }) {
  const existing = getRecord("users", sub) || {};
  return putRecord("users", sub, {
    email: email || existing.email || "",
    name: name || existing.name || "",
    picture: picture || existing.picture || "",
    createdAt: existing.createdAt || new Date().toISOString(),
    lastLogin: new Date().toISOString(),
  });
}

export function ownerEmail() {
  return cfg.ownerEmail;
}

/* ── signed OAuth state (sign-in) ───────────────────────────────────────── */

export function signState(now = Date.now()) {
  return `${now}.${mac(`state.${now}`)}`;
}

export function verifyState(state) {
  if (!state || !String(state).includes(".")) return false;
  const [tsStr, sig] = String(state).split(".");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return false;
  return safeEq(sig, mac(`state.${tsStr}`));
}

/* ── login page ─────────────────────────────────────────────────────────── */

export function loginPageHtml({ error } = {}) {
  const err = error
    ? `<p class="err">${String(error).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Orbit</title>
<link href="https://fonts.googleapis.com/css2?family=Caladea:ital,wght@0,400;0,700;1,400&family=Carlito:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:#141414; color:#f7f5f3; font:15.5px/1.6 Carlito,system-ui,sans-serif; }
  .card { width:min(420px,90vw); background:#1c1c1c; border:1px solid #2b2b2b;
    border-radius:10px; padding:40px 34px; text-align:center;
    box-shadow:0 24px 60px rgba(0,0,0,.45); }
  .brand { font-family:Caladea,serif; letter-spacing:.22em; font-size:13px;
    text-transform:uppercase; color:#c9a24b; margin-bottom:6px; }
  h1 { font-family:Caladea,serif; font-size:26px; margin:10px 0 6px; font-weight:700; }
  p { color:#a4a4b4; margin:0 0 24px; }
  .err { color:#e08a8a; background:rgba(178,16,31,.12); border:1px solid rgba(178,16,31,.4);
    border-radius:6px; padding:10px 12px; font-size:13px; }
  a.signin { display:inline-flex; align-items:center; gap:10px; text-decoration:none;
    background:#f7f5f3; color:#181818; font-weight:700; padding:13px 22px; border-radius:8px;
    transition:transform .15s ease, box-shadow .15s ease; }
  a.signin:hover { transform:translateY(-1px); box-shadow:0 10px 24px rgba(0,0,0,.4); }
  .g { width:18px; height:18px; }
  .foot { margin-top:26px; font-size:12px; color:#6e6e6e; }
</style></head>
<body><div class="card">
  <div class="brand">Orbit</div>
  <h1>Executive Assistant</h1>
  <p>Sign in with the Google account whose calendar and mail this assistant should manage.</p>
  ${err}
  <a class="signin" href="/auth/google">
    <svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Sign in with Google
  </a>
  <div class="foot">Access is limited to approved accounts.</div>
</div></body></html>`;
}
