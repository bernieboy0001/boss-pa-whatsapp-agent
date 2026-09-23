import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";
import { cfg } from "./config.js";
import { handleMessage } from "./agent.js";
import { warmupBrain } from "./brain.js";

/**
 * Live channel transport, ported from crow's proven loop.
 *
 * Photon/Spectrum holds the connection, so there is no public webhook to run:
 * we await `app.messages` and reply on each `space`. The platform is chosen by
 * CHANNEL_PROVIDER (imessage = hosted with PROJECT_ID/SECRET; whatsapp-business
 * = Meta Cloud API creds or Spectrum-hosted).
 *
 * PA_DRY=1 (or missing project secret) runs the same handler over stdin so the
 * whole thing is demoable without any channel approval — the plan's fallback.
 */

function buildProvider() {
  switch (cfg.channelProvider) {
    case "whatsapp-business": {
      if (cfg.waAccessToken && cfg.waPhoneNumberId) {
        return whatsappBusiness.config({
          accessToken: cfg.waAccessToken,
          phoneNumberId: cfg.waPhoneNumberId,
          ...(cfg.waAppSecret ? { appSecret: cfg.waAppSecret } : {}),
        });
      }
      console.warn("[channel] whatsapp-business: no Meta creds — trying Spectrum-hosted config.");
      return whatsappBusiness.config({});
    }
    case "imessage":
      return imessage.config();
    default:
      throw new Error(`Unknown CHANNEL_PROVIDER "${cfg.channelProvider}" (imessage | whatsapp-business)`);
  }
}

export async function startChannel() {
  const sessions = new Map();
  const sessionFor = (id) => {
    if (!sessions.has(id)) sessions.set(id, {});
    return sessions.get(id);
  };

  if (cfg.paDry || !cfg.projectSecret) {
    return runRepl(sessionFor);
  }

  await warmupBrain();
  const app = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [buildProvider()] });
  const tag = cfg.projectId ? cfg.projectId.slice(0, 8) + "…" : "unset";
  console.log(`🧑‍💼 BOSS PA online via ${cfg.channelProvider} (project ${tag}).`);

  for await (const [space, message] of app.messages) {
    if (message.content?.type !== "text") continue;
    try {
      const reply = await handleMessage(message.content.text, { session: sessionFor(space.id) });
      await space.send(reply);
    } catch (err) {
      console.error("[channel] handler error:", err.message);
      await space.send("Sorry — something went wrong. Try again?").catch(() => {});
    }
  }
}

function runRepl(sessionFor) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you > " });
  console.log("🧑‍💼 BOSS PA — dry-run (stdin). Type a message, or 'exit'.");
  console.log("Try:  flights JFK to LHR Friday  ·  schedule 1:1 with Sara Wed 4pm  ·  what's my day?  ·  itinerary  ·  book f1\n");
  rl.prompt();
  rl.on("line", async (line) => {
    if (/^\s*(exit|quit)\s*$/i.test(line)) return rl.close();
    try {
      const reply = await handleMessage(line, { session: sessionFor("stdin") });
      console.log(`\nPA   > ${reply}\n`);
    } catch (err) {
      console.error(`\nPA   > [error] ${err.message}\n`);
    }
    rl.prompt();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startChannel().catch((e) => {
    console.error("channel failed:", e.message);
    process.exit(1);
  });
}
