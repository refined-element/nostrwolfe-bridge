/** Who publishes which tag dialect on the live relay? */

import WebSocket from "ws";
import { nip19 } from "nostr-tools";

const RELAY = process.argv[2] ?? "wss://agents.lightningenable.com";

const events = await new Promise((resolve, reject) => {
  const ws = new WebSocket(RELAY);
  const collected = [];
  const timer = setTimeout(() => {
    ws.close();
    resolve(collected);
  }, 25_000);
  ws.on("open", () =>
    ws.send(JSON.stringify(["REQ", "c", { kinds: [38400], limit: 500 }])),
  );
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg[0] === "EVENT" && msg[1] === "c") collected.push(msg[2]);
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

const has = (e, name) => e.tags.some((t) => t[0] === name);
const byPubkey = new Map();

for (const e of events) {
  const nipCompliant = has(e, "s") && has(e, "price");
  const dialect = has(e, "category") && has(e, "pricing");
  const key = e.pubkey;
  const row = byPubkey.get(key) ?? { nip: 0, dialect: 0, neither: 0, ds: [] };
  if (nipCompliant) row.nip++;
  else if (dialect) row.dialect++;
  else row.neither++;
  row.ds.push(e.tags.find((t) => t[0] === "d")?.[1]);
  byPubkey.set(key, row);
}

console.log(`total kind:38400 on relay: ${events.length}`);
console.log(`distinct publishers: ${byPubkey.size}\n`);
console.log("publisher                              NIP-A5  dialect  neither");
for (const [pk, row] of byPubkey) {
  const npub = nip19.npubEncode(pk);
  console.log(
    `${npub.slice(0, 24)}…  ${String(row.nip).padStart(5)}  ${String(
      row.dialect,
    ).padStart(7)}  ${String(row.neither).padStart(7)}`,
  );
}

const totals = [...byPubkey.values()].reduce(
  (a, r) => ({
    nip: a.nip + r.nip,
    dialect: a.dialect + r.dialect,
    neither: a.neither + r.neither,
  }),
  { nip: 0, dialect: 0, neither: 0 },
);
console.log(`\ntotals — NIP-A5: ${totals.nip}, dialect: ${totals.dialect}, neither: ${totals.neither}`);
