import { google } from "googleapis";
import { cfg } from "../config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

let gmailClient = null;

function getGmailClient() {
  if (gmailClient) return gmailClient;

  if (!cfg.saKeyPath || !cfg.bossCalendarEmail) {
    throw new Error("Missing GOOGLE_SA_KEY_PATH or BOSS_CALENDAR_EMAIL in config");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.saKeyPath,
    scopes: SCOPES,
    subject: cfg.bossCalendarEmail,
  });

  gmailClient = google.gmail({ version: "v1", auth });
  return gmailClient;
}

function decodeBase64(str) {
  return Buffer.from(str, "base64").toString("utf-8");
}

function encodeBase64(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function inboxSummary(req) {
  const gmail = getGmailClient();

  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults: 20,
  });

  const messages = res.data.messages ?? [];
  const urgent = [];
  const promises = [];

  for (const msg of messages.slice(0, 10)) {
    promises.push(
      gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }).then((m) => {
        const headers = m.data.payload?.headers ?? [];
        const from = headers.find((h) => h.name === "From")?.value ?? "";
        const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
        const date = headers.find((h) => h.name === "Date")?.value ?? "";
        return { from, subject, date, id: msg.id };
      })
    );
  }

  const details = await Promise.all(promises);

  for (const d of details) {
    const lowSubj = d.subject.toLowerCase();
    const lowFrom = d.from.toLowerCase();
    if (/urgent|asap|immediate|action required|deadline|overdue|signature|sign|approve|confirm/.test(lowSubj)) {
      urgent.push({ from: d.from, subject: d.subject, action: "draft-reply", id: d.id });
    } else if (/invoice|payment|bill|receipt/.test(lowSubj)) {
      urgent.push({ from: d.from, subject: d.subject, action: "flag-pay", id: d.id });
    } else if (/travel|flight|trip|itinerary|booking/.test(lowSubj)) {
      urgent.push({ from: d.from, subject: d.subject, action: "confirm/acknowledge", id: d.id });
    }
  }

  const promise = details
    .filter((d) => /will send|follow up|get back|by (monday|tuesday|wednesday|thursday|friday|eod|cob)/.test(d.subject.toLowerCase()))
    .slice(0, 3)
    .map((d) => ({ from: d.from, subject: d.subject, due: "soon" }));

  return {
    unread: messages.length,
    urgent: urgent.slice(0, 5),
    promise,
    count: messages.length,
    top: `${urgent.length} urgent; ${promise.length} promises`,
  };
}

export async function draftReply(req) {
  const { to, topic, tone = "polite" } = req ?? {};
  const gmail = getGmailClient();

  const profile = await gmail.users.getProfile({ userId: "me" });
  const from = profile.data.emailAddress;

  const body = `Hi,\n\nThanks for circling back on ${topic}. I'll confirm the details shortly.\n\nBest,\n[PA draft — approve before send]`;

  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: RE: ${topic}`,
    "",
    body,
  ].join("\n");

  return {
    to,
    subject: `RE: ${topic}`,
    body,
    raw: encodeBase64(raw),
  };
}

export async function sendEmail(req) {
  const { to, subject, body, raw } = req ?? {};
  const gmail = getGmailClient();

  const messageRaw = raw ?? [
    `To: ${to}`,
    `Subject: ${subject}`,
    "",
    body,
  ].join("\n");

  const encoded = encodeBase64(messageRaw);

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  return {
    ok: true,
    to,
    id: `msg_${Date.now().toString(36)}`,
    note: "sent via Gmail API",
  };
}