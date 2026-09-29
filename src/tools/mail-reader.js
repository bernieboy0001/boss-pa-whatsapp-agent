import { google } from "googleapis";
import { getOAuth2Client } from "./oauth2-client.js";

/**
 * Real mailbox reader.
 *
 * The previous `inboxSummary` asked Gmail for 20 unread ids, fetched only the
 * From/Subject/Date headers, and then classified on the subject line with
 * regexes. That is enough for a badge count, and not enough to answer "what is
 * actually in my inbox" — which is the question this exists to answer.
 *
 * So this module fetches real message bodies, walks the MIME tree (Google
 * returns multipart/alternative and multipart/mixed nests, not a flat body),
 * and returns structured messages the brain can actually reason over.
 *
 * Cost control: Gmail bills per 10k messages.list items and per
 * messages.get. We page explicitly, cap the default at 25 messages, and
 * truncate each body to BODY_LIMIT so a single 200KB newsletter cannot blow
 * the context window or the function's token budget.
 */

let gmailClient = null;

function getGmailClient() {
  if (gmailClient) return gmailClient;
  gmailClient = google.gmail({ version: "v1", auth: getOAuth2Client() });
  return gmailClient;
}

const BODY_LIMIT = 4000;
const MAX_MESSAGES = 50;
const LIST_PAGE = 100;

function decodeBase64Url(s) {
  if (!s) return "";
  const norm = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pull the best human-readable text out of a MIME payload.
 *
 * Prefers text/plain, falls back to stripped HTML, and recurses through
 * nested multiparts. Inline attachments are skipped — an invoice PDF is
 * noise for a triage summary.
 */
function extractText(part, depth = 0) {
  if (!part || depth > 6) return "";
  const mime = part.mimeType ?? "";

  if (mime === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (mime === "text/html" && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data));
  }
  if (Array.isArray(part.parts) && part.parts.length) {
    const collected = [];
    for (const child of part.parts) {
      const childMime = child.mimeType ?? "";
      if (childMime.startsWith("image/") || childMime.startsWith("application/")) continue;
      if (child.filename) continue;
      const text = extractText(child, depth + 1);
      if (text) collected.push(text);
    }
    if (collected.length) return collected.join("\n\n");
  }
  if (part.body?.data) return decodeBase64Url(part.body.data);
  return "";
}

function header(payload, name) {
  const h = (payload?.headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function parseAddress(raw) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(raw ?? "");
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: (raw ?? "").trim() };
}

function snippetOf(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 320 ? `${clean.slice(0, 317)}…` : clean;
}

/**
 * Gmail's own `snippet` field is HTML-escaped and is often padded with
 * zero-width characters that marketing senders use as preheader padding. Left
 * alone, a subject reads "Bernard&#39;s projects" and a body starts with a row
 * of invisible glyphs.
 */
function cleanSnippet(s) {
  return String(s ?? "")
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[-‍⁠﻿]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOne(gmail, id) {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;
  const payload = msg.payload ?? {};
  const body = extractText(payload);
  const from = parseAddress(header(payload, "From"));
  const to = parseAddress(header(payload, "To"));
  // X-GM-MSGFLAGS is not reliably present on `format:"full"` responses, so the
  // authoritative unread/starred signals are the label ids.
  const labels = msg.labelIds ?? [];
  const has = (l) => labels.includes(l);

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: from.email || from.name,
    fromName: from.name,
    to: to.email || to.name,
    subject: header(payload, "Subject") || "(no subject)",
    date: header(payload, "Date") || "",
    // Gmail's own thread snippet is a good, already-truncated preview.
    snippet: cleanSnippet(msg.snippet) || snippetOf(body),
    body: body.replace(/[-‍⁠﻿]/g, "").slice(0, BODY_LIMIT),
    bodyTruncated: body.length > BODY_LIMIT,
    unread: has("UNREAD"),
    starred: has("STARRED"),
    important: has("IMPORTANT"),
    labels,
    attachments: (payload.parts ?? [])
      .filter((p) => p.filename)
      .map((p) => ({ name: p.filename, mimeType: p.mimeType, size: p.body?.size ?? 0 })),
    hasAttachments: (payload.parts ?? []).some((p) => Boolean(p.filename)),
  };
}

/**
 * Read the mailbox.
 *
 * @param {object} opts
 * @param {string} opts.query       Gmail search syntax, e.g. "is:unread newer_than:7d"
 * @param {number} opts.max         message cap (default 25, hard max 50)
 * @param {boolean} opts.fullBody   include decoded bodies (default true)
 */
export async function readMailbox(opts = {}) {
  const gmail = getGmailClient();
  const query = opts.query ?? "in:inbox newer_than:7d";
  const max = Math.min(Math.max(1, opts.max ?? 25), MAX_MESSAGES);
  const fullBody = opts.fullBody !== false;

  // Gmail caps a single list page at 500, but paging in LIST_PAGE-sized
  // chunks keeps latency predictable and lets us stop as soon as we have
  // enough ids.
  const ids = [];
  let pageToken;
  let estimated = 0;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(LIST_PAGE, max * 2),
      pageToken,
    });
    estimated = res.data.resultSizeEstimate ?? estimated;
    for (const m of res.data.messages ?? []) {
      ids.push(m.id);
      if (ids.length >= max * 2) break;
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (ids.length >= max * 2) break;
  } while (pageToken);

  const selected = ids.slice(0, max);
  const messages = await Promise.all(
    selected.map((id) => fetchOne(gmail, id).catch((err) => ({ id, error: err.message }))),
  );

  const ok = messages.filter((m) => !m.error);
  return {
    query,
    requested: max,
    fetched: ok.length,
    // resultSizeEstimate is Gmail's own count for the whole query, not the
    // slice we read — keep both so the UI can say "showing 25 of ~201".
    totalMatching: estimated || null,
    unread: ok.filter((m) => m.unread).length,
    withAttachments: ok.filter((m) => m.hasAttachments).length,
    messages: ok.map((m) => (fullBody ? m : { ...m, body: undefined, snippet: m.snippet })),
    partial: messages.length - ok.length,
  };
}

/** Mailbox-wide counters, cheap enough for a dashboard badge. */
export async function mailboxStats() {
  const gmail = getGmailClient();
  const [profile, unread, recent] = await Promise.all([
    gmail.users.getProfile({ userId: "me" }),
    gmail.users.messages.list({ userId: "me", q: "is:unread", maxResults: 1 }),
    gmail.users.messages.list({ userId: "me", q: "in:inbox newer_than:7d", maxResults: 1 }),
  ]);
  return {
    account: profile.data.emailAddress,
    // Gmail's profile omits messagesUnread on some accounts; fall back to the
    // search estimate rather than reporting a hard 0.
    totalMessages: profile.data.messagesTotal ?? null,
    unread: profile.data.messagesUnread ?? unread.data.resultSizeEstimate ?? null,
    unreadEstimate: unread.data.resultSizeEstimate ?? null,
    last7Days: recent.data.resultSizeEstimate ?? null,
  };
}
