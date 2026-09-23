import { cfg } from "./config.js";

/**
 * Channel glue for Photon/Spectrum ⇄ WhatsApp.
 *
 * Kept deliberately dumb: one inbound normalizer and one outbound send. If the
 * send URL / token aren't configured the send is logged and skipped, so the
 * whole agent stays testable locally without WhatsApp approval.
 */

/** Pull a { from, text } pair out of whatever shape Photon posts. */
export function normalizeInbound(body = {}) {
  const from = body.from ?? body.sender ?? body.phone ?? body.msisdn ?? body?.message?.from ?? "";
  const text = body.text ?? body.body ?? body.message ?? body?.message?.text ?? "";
  return { from: String(from), text: String(text) };
}

export function verifyWebhook(req) {
  if (!cfg.webhookSecret) return true; // no secret configured → dev mode
  const given = req.get?.("x-photon-secret") ?? req.query?.secret ?? "";
  return given === cfg.webhookSecret;
}

export async function sendText(to, text) {
  if (!cfg.sendUrl || !cfg.sendToken) {
    console.log(`[photon:dry-run] → ${to || "(no number)"}: ${text}`);
    return { ok: true, dryRun: true };
  }
  const res = await fetch(cfg.sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.sendToken}` },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) throw new Error(`Photon send ${res.status}`);
  return { ok: true };
}
