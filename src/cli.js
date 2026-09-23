import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { handleMessage } from "./agent.js";

/**
 * Phase 1 terminal loop. Pure transport: read a line, hand it to the channel-
 * agnostic agent, print the reply. The WhatsApp webhook in server.js is the same
 * shape — that symmetry is the point.
 */

const rl = createInterface({ input: process.stdin, output: process.stdout });
const session = {};

export async function runOnce(line) {
  return handleMessage(line, { session });
}

async function loop() {
  rl.question("you > ", async (line) => {
    if (/^\s*(exit|quit)\s*$/i.test(line)) {
      rl.close();
      return;
    }
    try {
      const reply = await handleMessage(line, { session });
      console.log(`\nPA   > ${reply}\n`);
    } catch (err) {
      console.error(`\nPA   > [error] ${err.message}\n`);
    }
    loop();
  });
}

// Only start the interactive loop when run directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("🧑‍💼 BOSS PA agent — Phase 1 (terminal). Type a message, or 'exit'.");
  console.log("Try:  flights JFK to LHR Friday  ·  schedule 1:1 with Sara Wed 4pm  ·  what's my day?  ·  itinerary  ·  book f1\n");
  rl.on("close", () => process.exit(0));
  loop();
}
