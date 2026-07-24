/**
 * Read-only smoke test against the live NostrWolfe relay.
 *
 * Fetches real kind:38400 listings and runs them through the bridge's own
 * parseListing + formatCard, so we validate against production data rather than
 * fixtures. Publishes nothing and touches no Buzz relay.
 *
 *   node scripts/smoke-wolfe.mjs [relayUrl]
 */

import WebSocket from "ws";

import { formatCard, parseListing } from "../dist/mirror-engine.js";

const RELAY = process.argv[2] ?? "wss://agents.lightningenable.com";
const TIMEOUT_MS = 20_000;

const events = await new Promise((resolve, reject) => {
  const ws = new WebSocket(RELAY);
  const collected = [];
  const timer = setTimeout(() => {
    ws.close();
    resolve(collected);
  }, TIMEOUT_MS);

  ws.on("open", () => {
    ws.send(JSON.stringify(["REQ", "smoke", { kinds: [38400], limit: 50 }]));
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg[0] === "EVENT" && msg[1] === "smoke") collected.push(msg[2]);
    if (msg[0] === "EOSE" && msg[1] === "smoke") {
      clearTimeout(timer);
      ws.close();
      resolve(collected);
    }
  });
  ws.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
});

console.log(`relay: ${RELAY}`);
console.log(`fetched ${events.length} kind:38400 events\n`);

let parsed = 0;
let rejected = 0;
const rejects = [];

const acceptDialects = process.env.MIRROR_ACCEPT_DIALECTS !== "false";
console.log(`dialect adapter: ${acceptDialects ? "on" : "off"}\n`);

for (const event of events) {
  const listing = parseListing(event, { acceptDialects });
  if (listing === null) {
    rejected++;
    const d = event.tags.find((t) => t[0] === "d")?.[1] ?? "(no d)";
    rejects.push(`${d} — ${event.id.slice(0, 12)}`);
    continue;
  }
  parsed++;
  if (parsed <= 3) {
    console.log("─".repeat(72));
    console.log(formatCard(listing, parsed === 2 ? "updated" : "new"));
    console.log();
  }
}

console.log("─".repeat(72));
console.log(`parsed OK: ${parsed}   rejected: ${rejected}`);
if (rejects.length > 0) {
  console.log("rejected listings (missing required d / s / price tags):");
  for (const r of rejects) console.log(`  - ${r}`);
}
