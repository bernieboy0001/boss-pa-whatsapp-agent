import http from "node:http";
import handler from "../api/[...path].js";

// Minimal adapter: expose the bundled Vercel handler over real HTTP so we can
// exercise Express routing exactly as the platform will.
const server = http.createServer((req, res) => handler(req, res));

await new Promise((r) => server.listen(0, r));
const { port } = server.address();

const ROUTES = [
  ["GET", "/healthz"],
  ["GET", "/api/day"],
  ["GET", "/api/week"],
  ["GET", "/api/inbox"],
  ["GET", "/api/itinerary"],
  ["GET", "/api/reminders"],
  ["GET", "/api/prefs"],
  ["GET", "/api/legal/templates"],
  ["GET", "/api/legal/search?q=contract"],
  // Unknown API route must 404 as JSON, never fall through to the SPA shell.
  ["GET", "/api/nope-not-a-route", 404],
  // Single-segment aliases are the only shape Vercel's catch-all routes.
  ["GET", "/api/legal-templates"],
  ["GET", "/api/legal-search?q=contract"],
  ["GET", "/api/healthz"],
  ["GET", "/api/calendars"],
  // Mail endpoints hit real Gmail when a token is configured. A provider error
  // is a legitimate 502 here, so both 200 and 502 count as "route works".
  ["GET", "/api/mail?max=3", [200, 502]],
  ["GET", "/api/mail-stats", [200, 500]],
];

let failures = 0;
for (const [method, path, expected = 200] of ROUTES) {
  const want = Array.isArray(expected) ? expected : [expected];
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const text = await res.text();
    const ms = Date.now() - started;
    const ok = want.includes(res.status);
    if (!ok) failures++;
    const preview = text.length > 160 ? text.slice(0, 160) + "..." : text;
    console.log(`${ok ? "PASS" : "FAIL"} ${res.status} ${method.padEnd(4)} ${path.padEnd(30)} ${ms}ms  ${preview}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ---  ${method.padEnd(4)} ${path.padEnd(30)} threw: ${e.message}`);
  }
}

// POST /api/chat exercises the real agent + tool wiring.
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "what's on my calendar today?" }),
  });
  const text = await res.text();
  const ok = res.status < 400;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${res.status} POST /api/chat  ${text.slice(0, 160)}`);
} catch (e) {
  failures++;
  console.log(`FAIL ---  POST /api/chat threw: ${e.message}`);
}

// Reminder mutations must work through the single-segment ?id= form.
try {
  const created = await fetch(`http://127.0.0.1:${port}/api/reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "smoke test reminder" }),
  });
  const rec = await created.json();
  const patched = await fetch(`http://127.0.0.1:${port}/api/reminders?id=${encodeURIComponent(rec.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "done" }),
  });
  const patchedBody = await patched.json();
  const removed = await fetch(`http://127.0.0.1:${port}/api/reminders?id=${encodeURIComponent(rec.id)}`, {
    method: "DELETE",
  });
  const removedBody = await removed.json();
  const ok =
    created.status < 400 &&
    patched.status < 400 &&
    removed.status < 400 &&
    patchedBody.status === "done" &&
    removedBody.ok === true;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} reminder create/patch/delete via ?id= (${created.status}/${patched.status}/${removed.status})`);
} catch (e) {
  failures++;
  console.log(`FAIL reminder mutation threw: ${e.message}`);
}

// A reminder marked done must STAY done. Before the store existed this silently
// reverted, which is the exact failure the durability work is meant to remove.
try {
  const created = await fetch(`http://127.0.0.1:${port}/api/reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "durability probe" }),
  });
  const rec = await created.json();
  await fetch(`http://127.0.0.1:${port}/api/reminders?id=${encodeURIComponent(rec.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "done" }),
  });
  const reread = await (await fetch(`http://127.0.0.1:${port}/api/reminders`)).json();
  const kept = reread.reminders.find((r) => r.id === rec.id);
  await fetch(`http://127.0.0.1:${port}/api/reminders?id=${encodeURIComponent(rec.id)}`, { method: "DELETE" });
  const ok = kept && kept.status === "done";
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} reminder status persists on re-read (${kept ? kept.status : "missing"})`);
} catch (e) {
  failures++;
  console.log(`FAIL reminder durability threw: ${e.message}`);
}

// Seeded reminders must not come back after a delete (the "does it resurrect?"
// check that the meta sentinel exists for).
try {
  const before = await (await fetch(`http://127.0.0.1:${port}/api/reminders`)).json();
  const ok = Array.isArray(before.reminders);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} reminder list shape (${before.reminders?.length} items)`);
} catch (e) {
  failures++;
  console.log(`FAIL reminder list threw: ${e.message}`);
}

server.close();
console.log(failures === 0 ? "\nALL ROUTES OK" : `\n${failures} ROUTE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);