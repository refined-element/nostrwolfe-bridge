/**
 * OutboundPublisher tests (spec §8, Phase 2).
 *
 * validateOutbound is pure and exhaustively tabled; forwardToWolfe + the
 * end-to-end handler run against an in-process ws server scripted as the public
 * relay (OK true / OK false / silence / refusal).
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  forwardToWolfe,
  makePublishHandler,
  OUTBOUND_FRESHNESS_SECONDS,
  validateOutbound,
} from "../src/outbound-publisher.js";

import type { NostrEvent, NostrTag } from "../src/types.js";

const NOW = 1_784_000_000;

function signListing(
  sk: Uint8Array,
  overrides: { tags?: NostrTag[]; created_at?: number; content?: string } = {},
): NostrEvent {
  return finalizeEvent(
    {
      kind: 38400,
      created_at: overrides.created_at ?? NOW,
      tags: overrides.tags ?? [
        ["d", "my-service"],
        ["s", "ai"],
        ["price", "50", "sats", "per-request"],
      ],
      content: overrides.content ?? "My own service.",
    },
    sk,
  ) as NostrEvent;
}

describe("validateOutbound", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  it("accepts a well-formed self-signed listing and returns its address", () => {
    const ev = signListing(sk);
    const v = validateOutbound(JSON.stringify(ev), pk, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.address).toBe(`38400:${pk}:my-service`);
  });

  it("accepts a payload wrapped in a ```json fence", () => {
    const ev = signListing(sk);
    const fenced = "```json\n" + JSON.stringify(ev) + "\n```";
    expect(validateOutbound(fenced, pk, NOW).ok).toBe(true);
  });

  it("rejects non-JSON", () => {
    const v = validateOutbound("not json {", pk, NOW);
    expect(v).toMatchObject({ ok: false });
  });

  it("rejects the wrong kind", () => {
    const ev = finalizeEvent(
      { kind: 1, created_at: NOW, tags: [], content: "" },
      sk,
    ) as NostrEvent;
    const v = validateOutbound(JSON.stringify(ev), pk, NOW);
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toContain("38400");
  });

  it("rejects a tampered signature", () => {
    const ev = signListing(sk);
    const forged = { ...ev, content: "changed after signing" };
    const v = validateOutbound(JSON.stringify(forged), pk, NOW);
    expect(v).toMatchObject({
      ok: false,
      reason: expect.stringContaining("signature"),
    });
  });

  it("rejects a listing signed by a different key than the author", () => {
    const other = generateSecretKey();
    const ev = signListing(other); // validly signed, but not by `pk`
    const v = validateOutbound(JSON.stringify(ev), pk, NOW);
    expect(v).toMatchObject({
      ok: false,
      reason: expect.stringContaining("your own key"),
    });
  });

  it("rejects missing required tags", () => {
    for (const tags of [
      [
        ["s", "ai"],
        ["price", "50", "sats"],
      ], // no d
      [
        ["d", "x"],
        ["price", "50", "sats"],
      ], // no s
      [
        ["d", "x"],
        ["s", "ai"],
      ], // no price
    ] as NostrTag[][]) {
      const ev = signListing(sk, { tags });
      expect(validateOutbound(JSON.stringify(ev), pk, NOW).ok).toBe(false);
    }
  });

  it("rejects a timestamp outside the ±15 min window, both directions", () => {
    const future = signListing(sk, {
      created_at: NOW + OUTBOUND_FRESHNESS_SECONDS + 60,
    });
    const past = signListing(sk, {
      created_at: NOW - OUTBOUND_FRESHNESS_SECONDS - 60,
    });
    expect(validateOutbound(JSON.stringify(future), pk, NOW).ok).toBe(false);
    expect(validateOutbound(JSON.stringify(past), pk, NOW).ok).toBe(false);
    // Just inside the window is fine.
    const edge = signListing(sk, {
      created_at: NOW - OUTBOUND_FRESHNESS_SECONDS + 1,
    });
    expect(validateOutbound(JSON.stringify(edge), pk, NOW).ok).toBe(true);
  });
});

describe("forwardToWolfe + makePublishHandler", () => {
  let server: WebSocketServer | undefined;
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  /** Start an in-process relay that answers EVENT with a scripted OK. */
  function startRelay(reply: (id: string) => unknown | null): Promise<string> {
    return new Promise((resolve) => {
      server = new WebSocketServer({ port: 0 }, () => {
        const addr = server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(`ws://127.0.0.1:${port}`);
      });
      server.on("connection", (ws) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg[0] === "EVENT") {
            const r = reply(msg[1].id);
            if (r !== null) ws.send(JSON.stringify(r));
          }
        });
      });
    });
  }

  it("resolves ok:true when the relay accepts", async () => {
    const url = await startRelay((id) => ["OK", id, true, ""]);
    const ev = signListing(sk);
    const r = await forwardToWolfe(url, ev, { timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: true, timedOut: false });
  });

  it("resolves ok:false with the relay's message when rejected", async () => {
    const url = await startRelay((id) => ["OK", id, false, "blocked: nope"]);
    const r = await forwardToWolfe(url, signListing(sk), { timeoutMs: 2000 });
    expect(r).toMatchObject({
      ok: false,
      timedOut: false,
      message: "blocked: nope",
    });
  });

  it("times out when the relay never answers", async () => {
    const url = await startRelay(() => null); // swallow, never OK
    const r = await forwardToWolfe(url, signListing(sk), { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, timedOut: true });
  });

  it("handler: success reply names the published address", async () => {
    const url = await startRelay((id) => ["OK", id, true, ""]);
    const handler = makePublishHandler({
      wolfeRelayUrl: url,
      now: () => NOW * 1000,
      timeoutMs: 2000,
    });
    const reply = await handler(JSON.stringify(signListing(sk)), pk);
    expect(reply).toContain(`Published nw:38400:${pk}:my-service`);
  });

  it("handler: validation failure never touches the relay", async () => {
    let hit = false;
    const url = await startRelay((id) => {
      hit = true;
      return ["OK", id, true, ""];
    });
    const handler = makePublishHandler({
      wolfeRelayUrl: url,
      now: () => NOW * 1000,
    });
    const other = generateSecretKey();
    const reply = await handler(JSON.stringify(signListing(other)), pk);
    expect(reply).toContain("Rejected:");
    expect(hit).toBe(false);
  });

  it("handler: timeout returns the retry-guidance message", async () => {
    const url = await startRelay(() => null);
    const handler = makePublishHandler({
      wolfeRelayUrl: url,
      now: () => NOW * 1000,
      timeoutMs: 120,
    });
    const reply = await handler(JSON.stringify(signListing(sk)), pk);
    expect(reply).toContain("did not acknowledge");
  });
});
