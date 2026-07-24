/**
 * Read-only membership/AUTH probe for a Buzz community.
 *
 * Connects, completes the NIP-42 proactive-AUTH handshake with BRIDGE_NSEC, and
 * reports whether the relay admits this identity. Then runs ONE historical REQ
 * for kind:39000 (group metadata) to list channels the identity can see.
 *
 * Writes nothing: no EVENT, no channel create/join. Safe to run against a live
 * community. Reads config from .env (BRIDGE_NSEC, BUZZ_RELAY_URL).
 */

import "dotenv/config";
import WebSocket from "ws";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";

const URL = process.env.BUZZ_RELAY_URL;
const NSEC = process.env.BRIDGE_NSEC;
if (!URL || !NSEC) {
  console.error("BUZZ_RELAY_URL and BRIDGE_NSEC required in .env");
  process.exit(1);
}

const sk = NSEC.startsWith("nsec")
  ? decode(NSEC).data
  : Uint8Array.from(Buffer.from(NSEC, "hex"));
const pk = getPublicKey(sk);
console.log(`identity pubkey: ${pk}`);
console.log(`dialing:        ${URL}\n`);

const ws = new WebSocket(URL);
let authed = false;
const channels = [];
const done = (code) => {
  try {
    ws.close();
  } catch {}
  process.exit(code);
};

const timer = setTimeout(() => {
  console.error("timeout after 25s");
  done(2);
}, 25_000);

ws.on("open", () => console.log("socket open; waiting for proactive AUTH…"));

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const [type] = msg;

  if (type === "AUTH" && typeof msg[1] === "string") {
    const challenge = msg[1];
    const evt = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challenge],
          ["relay", URL],
        ],
        content: "",
      },
      sk,
    );
    ws.send(JSON.stringify(["AUTH", evt]));
    console.log("sent AUTH (kind 22242)…");
    return;
  }

  if (type === "OK") {
    // OK for our AUTH event id
    const ok = msg[2];
    const info = msg[3] ?? "";
    if (!authed) {
      authed = ok;
      console.log(`AUTH result:    ${ok ? "ADMITTED ✅" : "REJECTED ❌"}  ${info}`);
      if (!ok) {
        console.log("\n→ This identity is not admitted to the community.");
        clearTimeout(timer);
        done(0);
        return;
      }
      // Authed: list channels via historical REQ (read-only).
      ws.send(JSON.stringify(["REQ", "chan-list", { kinds: [39000] }]));
      console.log("\nauthenticated; listing channels (kind:39000)…");
    }
    return;
  }

  if (type === "EVENT" && msg[1] === "chan-list") {
    const ev = msg[2];
    const name = ev.tags.find((t) => t[0] === "name")?.[1] ?? "(unnamed)";
    const d = ev.tags.find((t) => t[0] === "d")?.[1] ?? "?";
    channels.push({ name, d });
    return;
  }

  if (type === "EOSE" && msg[1] === "chan-list") {
    console.log(`\nchannels visible to this identity: ${channels.length}`);
    for (const c of channels) console.log(`  • ${c.name}   [${c.d}]`);
    const services = channels.find((c) => c.name === "Services");
    console.log(
      services
        ? `\n"Services" channel ALREADY EXISTS [${services.d}] — bridge would discover + reuse it.`
        : `\nNo "Services" channel yet — bridge would create one.`,
    );
    clearTimeout(timer);
    done(0);
    return;
  }

  if (type === "CLOSED" && msg[1] === "chan-list") {
    console.log(`channel list CLOSED by relay: ${msg[2] ?? ""}`);
    clearTimeout(timer);
    done(0);
  }
});

ws.on("error", (err) => {
  console.error("socket error:", err.message);
  clearTimeout(timer);
  done(2);
});
