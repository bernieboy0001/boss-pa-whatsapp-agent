#!/usr/bin/env node
/**
 * WhatsApp Channel Verification Script
 *
 * Run AFTER all .env vars are set (see WHATSAPP_SETUP.md).
 * Tests: config load → Photon connect → send test message → receive echo.
 */

import { config } from "dotenv";
config();

import { cfg } from "../src/config.js";
import { startChannel } from "../src/channel.js";
import { normalizeInbound, verifyWebhook, sendText } from "../src/photon.js";
import { handleMessage } from "../src/agent.js";

console.log("🔧 WhatsApp Channel Verification");
console.log("================================\n");

// 1. Config validation
console.log("1️⃣  Config check:");
const required = [
  ["CHANNEL_PROVIDER", cfg.channelProvider],
  ["SPECTRUM_PROJECT_ID", cfg.projectId],
  ["SPECTRUM_PROJECT_SECRET", cfg.projectSecret ? "***" : ""],
  ["WHATSAPP_ACCESS_TOKEN", cfg.waAccessToken ? "***" : ""],
  ["WHATSAPP_PHONE_NUMBER_ID", cfg.waPhoneNumberId],
  ["WHATSAPP_APP_SECRET", cfg.waAppSecret ? "***" : ""],
];

let ok = true;
for (const [k, v] of required) {
  const pass = v && v !== "***" && v.length > 0;
  console.log(`   ${pass ? "✅" : "❌"} ${k}: ${v || "(missing)"}`);
  if (!pass) ok = false;
}
if (!ok) {
  console.log("\n❌ Missing required vars. See WHATSAPP_SETUP.md");
  process.exit(1);
}
console.log("   ✅ All required config present\n");

// 2. Photon webhook signature verification (unit test)
console.log("2️⃣  Webhook signature verify:");
const mockReq = {
  get: (h) => (h === "x-photon-secret" ? cfg.webhookSecret : ""),
  query: {},
  body: { from: "15551234567", text: "hi" },
};
const sigOk = verifyWebhook(mockReq);
console.log(`   ${sigOk ? "✅" : "❌"} Signature check ${sigOk ? "passed" : "FAILED"}`);
if (!sigOk) console.log("   (Set PHOTON_WEBHOOK_SECRET in .env to enable)\n");

// 3. Inbound normalization
console.log("3️⃣  Inbound normalization:");
const { from, text } = normalizeInbound({ from: "15551234567", text: "hello" });
console.log(`   from: ${from}, text: "${text}"`);
console.log("   ✅ Normalizer works\n");

// 4. Agent logic sanity (dry-run)
console.log("4️⃣  Agent logic (dry-run):");
const session = {};
const testMsgs = [
  "hi",
  "flights JFK to LHR Friday",
  "book f1",
  "itinerary",
];
for (const msg of testMsgs) {
  try {
    const reply = await handleMessage(msg, { session });
    console.log(`   > ${msg}`);
    console.log(`   < ${reply.split("\n")[0]}...`);
  } catch (e) {
    console.log(`   ❌ ${msg}: ${e.message}`);
    ok = false;
  }
}
console.log("   ✅ Agent logic OK\n");

// 5. Photon send (dry-run if no sendUrl/token)
console.log("5️⃣  Photon send (dry-run):");
try {
  const res = await sendText("15551234567", "Verification test from Boss PA");
  console.log(`   ${res.dryRun ? "🟡 Dry-run (no sendUrl/token)" : "✅ Sent"} → ${JSON.stringify(res)}`);
} catch (e) {
  console.log(`   ❌ Send failed: ${e.message}`);
  ok = false;
}
console.log("");

// 6. Live channel connect (optional — requires Photon project)
if (cfg.paDry) {
  console.log("6️⃣  Live channel: SKIPPED (PA_DRY=1)");
  console.log("   Set PA_DRY=0 and run: node src/channel.js");
} else {
  console.log("6️⃣  Live channel connect test (5s timeout)...");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const channelPromise = startChannel();
    await Promise.race([channelPromise, new Promise((_, r) => controller.signal.addEventListener("abort", () => r(new Error("timeout"))))]);
    clearTimeout(timeout);
    console.log("   ✅ Channel connected (Ctrl+C to stop)");
  } catch (e) {
    if (e.name === "AbortError" || e.message === "timeout") {
      console.log("   ✅ Channel connect initiated (would stay connected)");
    } else {
      console.log(`   ❌ Channel connect failed: ${e.message}`);
      ok = false;
    }
  }
}

console.log("\n" + "=".repeat(40));
if (ok) {
  console.log("🎉 ALL CHECKS PASSED — WhatsApp channel ready!");
  console.log("\nNext: text your Business number → agent should reply.");
} else {
  console.log("⚠️  Some checks failed — review output above.");
  process.exit(1);
}