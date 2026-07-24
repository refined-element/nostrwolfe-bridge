/** Dump raw tag structure of live 38400 events, to see what real publishers emit. */

import WebSocket from "ws";

const RELAY = process.argv[2] ?? "wss://agents.lightningenable.com";

const events = await new Promise((resolve, reject) => {
  const ws = new WebSocket(RELAY);
  const collected = [];
  const timer = setTimeout(() => {
    ws.close();
    resolve(collected);
  }, 20_000);
  ws.on("open", () =>
    ws.send(JSON.stringify(["REQ", "raw", { kinds: [38400], limit: 50 }])),
  );
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg[0] === "EVENT" && msg[1] === "raw") collected.push(msg[2]);
    if (msg[0] === "EOSE") {
      clearTimeout(timer);
      ws.close();
      resolve(collected);
    }
  });
  ws.on("error", (e) => {
    clearTimeout(timer);
    reject(e);
  });
});

// Tag-name frequency across the whole corpus.
const tagCounts = new Map();
for (const e of events) {
  for (const name of new Set(e.tags.map((t) => t[0]))) {
    tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
  }
}
console.log(`corpus: ${events.length} events\n`);
console.log("tag name → how many events carry it:");
for (const [name, n] of [...tagCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(12)} ${n}`);
}

const sample = events.find((e) =>
  e.tags.some((t) => t[0] === "d" && String(t[1]).startsWith("sats4ai")),
);
if (sample) {
  console.log("\nsample sats4ai listing (the rejected family):");
  console.log(JSON.stringify({ tags: sample.tags }, null, 2));
}

const ok = events.find((e) =>
  e.tags.some((t) => t[0] === "d" && String(t[1]).startsWith("shopify")),
);
if (ok) {
  console.log("\nsample shopify listing (the accepted family):");
  console.log(JSON.stringify({ tags: ok.tags }, null, 2));
}
