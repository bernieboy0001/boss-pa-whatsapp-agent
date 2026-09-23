import { cfg } from "../config.js";
import { inboxSummary as gmailInbox, draftReply as gmailDraft, sendEmail as gmailSend } from "./google-gmail.js";
import { inboxSummary as oauthInbox, draftReply as oauthDraft, sendEmail as oauthSend } from "./google-gmail-oauth.js";

function stubInbox(req) {
  return {
    unread: 14,
    urgent: [
      { from: "Amex Travel", subject: "RE: Trip change — your flight was rescheduled", action: "confirm/acknowledge" },
      { from: "Legal — Nadia", subject: "RE: NDA v3 needs signature before COB", action: "draft-reply" },
      { from: "Q3 vendor", subject: "Invoice #8812 overdue (30 days)", action: "flag-pay" },
    ],
    promise: [
      { from: "Eng lead", subject: "Q3 report draft — will send Thursday", due: "Thursday" },
    ],
    count: 14,
    top: "2 urgent need decisions; 1 draft recap due",
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

export async function inboxSummary(req) {
  if (useServiceAccount()) {
    try { return await gmailInbox(req); } catch (e) { console.warn("[email] Service Account failed, falling back:", e.message); }
  }
  if (useOAuth2()) {
    try { return await oauthInbox(req); } catch (e) { console.warn("[email] OAuth2 failed, falling back to stub:", e.message); }
  }
  return stubInbox(req);
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