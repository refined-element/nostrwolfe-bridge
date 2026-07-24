/**
 * Footer-recovery against a FAITHFUL relay (test-analyzer M-5).
 *
 * The unit tests in `footer-recovery.test.ts` feed `recoverMirroredFromChannel`
 * scripted pages, so they never exercise the relay's own newest-first ordering
 * and per-REQ result cap — the exact behavior the `until` walk (§7) is designed
 * around. This test drives a real {@link BuzzClient} against the in-process
 * {@link BuzzMockRelay}, which now orders newest-first and honors `limit` /
 * `maxEventsPerReq` like strfry, and preloads MORE than
 * {@link FOOTER_RECOVERY_PAGE_SIZE} bridge cards so the multi-page backward walk
 * actually runs. A correct walk rebuilds every address; a broken one (single
 * capped page treated as the whole history) would recover only the newest 500.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import { BuzzClient } from "../src/buzz-client.js";
import {
  FOOTER_RECOVERY_PAGE_SIZE,
  recoverMirroredFromChannel,
} from "../src/footer-recovery.js";
import type { BridgeIdentity, Config, NostrEvent } from "../src/types.js";

import { BuzzMockRelay } from "./mocks/buzz-mock.js";

const CHANNEL = "11111111-2222-3333-4444-555555555555";

function makeConfig(url: string): Config {
  return {
    bridgeNsec: "unused",
    buzzRelayUrl: url,
    wolfeRelayUrl: "wss://agents.lightningenable.com",
    channelName: "Services",
    channelAbout: "test",
    mirrorCategories: [],
    mirrorAcceptDialects: true,
    mirrorMaxListings: 200,
    backfillLimit: 100,
    buzzMsgsPerMin: 30,
    stateFile: "./bridge-state.json",
    logLevel: "error",
  };
}

/**
 * A bridge card as it sits in channel history. Signatures are irrelevant here —
 * neither `parseCardFooter` nor the mock's REQ path verifies stored events — so
 * we build them directly and keep the test fast even at 600+ cards.
 */
function card(
  bridgePubkey: string,
  provider: string,
  d: string,
  createdAt: number,
): NostrEvent {
  return {
    id: `card-${d}`,
    pubkey: bridgePubkey,
    created_at: createdAt,
    kind: 9,
    tags: [["h", CHANNEL]],
    content: [`🐺 New service: ${d}`, "─", `nw:38400:${provider}:${d}`].join(
      "\n",
    ),
    sig: "0".repeat(128),
  } as NostrEvent;
}

const harnesses: BuzzMockRelay[] = [];
const clients: BuzzClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()!.close();
  while (harnesses.length > 0) await harnesses.pop()!.stop();
});

describe("footer recovery pages a faithful relay (M-5)", () => {
  it("rebuilds every address when history exceeds one capped page", async () => {
    const secretKey = generateSecretKey();
    const identity: BridgeIdentity = {
      secretKey,
      publicKey: getPublicKey(secretKey),
    };
    const bridgePubkey = identity.publicKey;
    const provider = "a".repeat(64);

    // One more than a full page, plus a bit, so at least two pages are walked
    // and the boundary `created_at` (inclusive `until`) is re-seen and deduped.
    const total = FOOTER_RECOVERY_PAGE_SIZE + 123;
    const base = 1_753_280_000;
    const cards: NostrEvent[] = [];
    for (let i = 0; i < total; i++) {
      // Distinct, strictly-descending created_at so newest-first ordering and
      // the `until = oldest` step advance deterministically.
      cards.push(card(bridgePubkey, provider, `svc-${i}`, base + i));
    }

    const mock = await BuzzMockRelay.start({ stored: cards });
    harnesses.push(mock);
    const client = new BuzzClient(makeConfig(mock.url), identity, {
      timeScale: 0.002,
    });
    clients.push(client);
    await client.connect();

    const mirrored = await recoverMirroredFromChannel(
      client,
      CHANNEL,
      bridgePubkey,
    );

    // Every address was recovered — not just the newest capped page.
    expect(Object.keys(mirrored)).toHaveLength(total);
    for (let i = 0; i < total; i++) {
      expect(mirrored[`38400:${provider}:svc-${i}`]).toBeDefined();
    }

    // The walk genuinely paged: more than one footer-recover REQ was issued,
    // and the first page was capped at the client's requested limit.
    const recoverReqs = mock.reqs.filter((r) =>
      r.subId.startsWith("footer-recover-"),
    );
    expect(recoverReqs.length).toBeGreaterThanOrEqual(2);
    expect(recoverReqs[0]?.filters[0]?.limit).toBe(FOOTER_RECOVERY_PAGE_SIZE);
  }, 20_000);

  it("honors an explicit server-side cap below the client's limit", async () => {
    const secretKey = generateSecretKey();
    const identity: BridgeIdentity = {
      secretKey,
      publicKey: getPublicKey(secretKey),
    };
    const bridgePubkey = identity.publicKey;
    const provider = "b".repeat(64);

    const total = 250;
    const base = 1_753_280_000;
    const cards: NostrEvent[] = [];
    for (let i = 0; i < total; i++) {
      cards.push(card(bridgePubkey, provider, `svc-${i}`, base + i));
    }

    // Relay caps every REQ at 100, well below the client's 500 limit — the walk
    // must still recover all 250 by paging.
    const mock = await BuzzMockRelay.start({
      stored: cards,
      maxEventsPerReq: 100,
    });
    harnesses.push(mock);
    const client = new BuzzClient(makeConfig(mock.url), identity, {
      timeScale: 0.002,
    });
    clients.push(client);
    await client.connect();

    const mirrored = await recoverMirroredFromChannel(
      client,
      CHANNEL,
      bridgePubkey,
    );

    expect(Object.keys(mirrored)).toHaveLength(total);
    const recoverReqs = mock.reqs.filter((r) =>
      r.subId.startsWith("footer-recover-"),
    );
    // 250 cards at 100/page → at least 3 pages.
    expect(recoverReqs.length).toBeGreaterThanOrEqual(3);
  }, 20_000);
});
