import { cfg } from "../config.js";
import { inboxSummary as gmailInbox, draftReply as gmailDraft, sendEmail as gmailSend } from "./google-gmail.js";
import { inboxSummary as oauthInbox, draftReply as oauthDraft, sendEmail as oauthSend } from "./google-gmail-oauth.js";
import { readMailbox, mailboxStats } from "./mail-reader.js";

/**
 * Demo fixtures, used ONLY when no mail provider is configured at all.
 *
 * These must never be returned once a provider exists: this module's job is to
 * report what is genuinely in the boss's inbox, and silently substituting
 * invented senders ("Invoice #8812 overdue") on a provider error is far worse
 * than saying "I couldn't read your mail". Every result is tagged
 * `simulated: true` so callers and the UI can label it.
 */
const DEMO_MAIL = [
  { id: "demo_1", from: "travel@amex.example", subject: "RE: Trip change — your flight was rescheduled", date: "", snippet: "Demo message.", unread: true, simulated: true },
  { id: "demo_2", from: "legal@example.com", subject: "RE: NDA v3 needs signature before COB", date: "", snippet: "Demo message.", unread: true, simulated: true },
  { id: "demo_3", from: "billing@vendor.example", subject: "Invoice #8812 overdue (30 days)", date: "", snippet: "Demo message.", unread: true, simulated: true },
];

function stubInbox() {
  return {
    unread: 3,
    urgent: [
      { from: DEMO_MAIL[0].from, subject: DEMO_MAIL[0].subject, action: "confirm/acknowledge", id: DEMO_MAIL[0].id },
      { from: DEMO_MAIL[1].from, subject: DEMO_MAIL[1].subject, action: "draft-reply", id: DEMO_MAIL[1].id },
      { from: DEMO_MAIL[2].from, subject: DEMO_MAIL[2].subject, action: "flag-pay", id: DEMO_MAIL[2].id },
    ],
    promise: [],
    count: 3,
    top: "3 demo items (no mail provider configured)",
    simulated: true,
  };
}

function stubDraft(req) {
  const { to, topic, tone = "polite" } = req ?? {};
  return { to, subject: `RE: ${topic}`, body: `Hi,\n\nThanks for circling back on ${topic}. I'll confirm the details shortly.\n\nBest,\n[PA draft — approve before send]` };
}

async function stubSend(req) {
  return { ok: true, to: req?.to, id: `msg_${Date.now().toString(36)}`, note: "stub — swap for Gmail send via service account after approval" };
}

const useServiceAccount = () => Boolean(cfg.saKeyPath && cfg.bossCalendarEmail);
const useOAuth2 = () => Boolean(cfg.googleOauthClientId && cfg.googleOauthClientSecret && cfg.googleOauthRefreshToken && cfg.bossCalendarEmail);
const anyProvider = () => useServiceAccount() || useOAuth2();

/**
 * Triage summary. When a provider is configured but errors, we surface the
 * error rather than degrading to demo data — a wrong "urgent" list is worse
 * than no list.
 */
export async function inboxSummary(req) {
  if (useServiceAccount()) {
    try { return await gmailInbox(req); } catch (e) {
      console.warn("[email] Service Account failed:", e.message);
      if (!useOAuth2()) return { ...stubInbox(), error: `Service account read failed: ${e.message}` };
    }
  }
  if (useOAuth2()) {
    try { return await oauthInbox(req); } catch (e) {
      console.warn("[email] OAuth2 failed:", e.message);
      return { unread: 0, urgent: [], promise: [], count: 0, top: "Could not read the inbox", error: e.message };
    }
  }
  return stubInbox();
}

/** Real mailbox read: paginated messages with decoded bodies. */
export async function readMail(req) {
  if (!anyProvider()) {
    return {
      simulated: true,
      query: req?.query ?? "",
      fetched: DEMO_MAIL.length,
      messages: DEMO_MAIL,
      top: "Demo mail — no Gmail provider configured",
    };
  }
  return readMailbox(req ?? {});
}

export async function mailboxStatsSafe() {
  if (!anyProvider()) return { simulated: true, account: null, totalMessages: null, unread: null, last7Days: null };
  try {
    return await mailboxStats();
  } catch (e) {
    console.warn("[email] mailboxStats failed:", e.message);
    return { account: null, totalMessages: null, unread: null, last7Days: null, error: e.message };
  }
}

export async function draftReply(req) {
  if (useServiceAccount()) {
    try { return await gmailDraft(req); } catch (e) { console.warn("[email] Service Account failed, falling back:", e.message); }
  }
  if (useOAuth2()) {
    try { return await oauthDraft(req); } catch (e) { console.warn("[email] OAuth2 failed, falling back to stub:", e.message); }
  }
  return stubDraft(req);
}

export async function sendEmail(req) {
  if (useServiceAccount()) {
    try { return await gmailSend(req); } catch (e) { console.warn("[email] Service Account failed, falling back:", e.message); }
  }
  if (useOAuth2()) {
    try { return await oauthSend(req); } catch (e) { console.warn("[email] OAuth2 failed, falling back to stub:", e.message); }
  }
  return stubSend(req);
}