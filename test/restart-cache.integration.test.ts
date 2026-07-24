/**
 * Restart with an INTACT state file (C-1 / H1, end-to-end).
 *
 * The §7 recovery test in `integration.test.ts` restarts with the state file
 * DELETED, so the dedupe set is rebuilt from card footers. This guards the other
 * half: a restart where the state file survives. The persisted `mirrored` map
 * suppresses duplicate cards (dedupe), but the in-memory {@link ListingCache}
 * that `@bridge find` searches starts EMPTY and must be repopulated as hydration
 * replays each listing — even though every replayed listing is a same-timestamp
 * "duplicate" that produces no card. Before the C-1 fix the cache stayed empty
 * after a clean restart, so `find` answered "no matching services" for listings
 * the bridge had already mirrored. This asserts the cache is repopulated and a
 * `find` returns a hit.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveChannelId } from "../src/channel-manager.js";
import { loadConfig } from "../src/config.js";
import { startBridge, type BridgeHandle } from "../src/index.js";
import type { Config, NostrEvent } from "../src/types.js";

import { BuzzMockRelay, waitUntil } from "./mocks/buzz-mock.js";
import { StrfryMock } from "./mocks/strfry-mock.js";

const bridgeKey = generateSecretKey();
const bridgePubkey = getPublicKey(bridgeKey);
const providerKey = generateSecretKey();
const providerPubkey = getPublicKey(providerKey);
const memberKey = generateSecretKey();

const D_TAG = "translation-api";
const ADDRESS = `38400:${providerPubkey}:${D_TAG}`;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function listing(createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      kind: 38400,
      created_at: createdAt,
      tags: [
        ["d", D_TAG],
        ["s", "translation"],
        ["s", "nlp"],
        ["price", "100", "sats", "per-request"],
        ["endpoint", "https://example.test/translate", "POST"],
        ["negotiable", "true"],
      ],
      content: "Fast machine translation for agents.",
    },
    providerKey,
  ) as unknown as NostrEvent;
}

function mention(channelId: string, content: string): NostrEvent {
  return finalizeEvent(
    {
      kind: 9,
      created_at: nowSec(),
      tags: [
        ["h", channelId],
        ["p", bridgePubkey],
      ],
      content,
    },
    memberKey,
  ) as unknown as NostrEvent;
}

function newCards(buzz: BuzzMockRelay): NostrEvent[] {
  return buzz.published.filter(
    (e) => e.kind === 9 && e.content.startsWith("🐺 New service:"),
  );
}

describe("restart with an intact state file (C-1 end-to-end)", () => {
  let buzz: BuzzMockRelay;
  let strfry: StrfryMock;
  let dir: string;
  let stateFile: string;
  let config: Config;
  let handle: BridgeHandle;
  let channelId: string;
  const createdAt = nowSec() - 120;

  beforeAll(async () => {
    buzz = await BuzzMockRelay.start({ channelAware: true });
    strfry = await StrfryMock.start();
    dir = await mkdtemp(join(tmpdir(), "nwbridge-restart-"));
    stateFile = join(dir, "bridge-state.json");
    strfry.add(listing(createdAt));

    config = loadConfig({
      BRIDGE_NSEC: toHex(bridgeKey),
      BUZZ_RELAY_URL: buzz.url,
      WOLFE_RELAY_URL: strfry.url,
      STATE_FILE: stateFile,
      LOG_LEVEL: "error",
      BUZZ_MSGS_PER_MIN: "60",
      BACKFILL_LIMIT: "50",
    });
    channelId = deriveChannelId(bridgePubkey, config.channelName);

    handle = await startBridge(config, { timeScale: 0.01 });
    // First boot: the hydrated listing becomes a card and is recorded.
    await waitUntil(
      () =>
        newCards(buzz).length === 1 &&
        handle.state.getState().mirrored[ADDRESS] !== undefined,
      15_000,
    );
  }, 30_000);

  afterAll(async () => {
    await handle.stop();
    await buzz.stop();
    await strfry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("repopulates the cache and answers find after a clean restart", async () => {
    const cardsBefore = newCards(buzz).length;
    expect(cardsBefore).toBe(1);

    // Clean restart — state file left INTACT (not deleted).
    await handle.stop();
    handle = await startBridge(config, { timeScale: 0.01 });

    // The persisted dedupe entry survived the restart…
    expect(handle.state.getState().mirrored[ADDRESS]).toBeDefined();

    // …the cache is repopulated from the hydration replay even though the
    // replayed listing is a same-timestamp duplicate that posts no card (C-1).
    await waitUntil(() => handle.cache.size >= 1, 15_000);
    expect(handle.cache.size).toBe(1);

    // Dedupe held: no duplicate "New service" card on the intact-state restart.
    expect(newCards(buzz).length).toBe(cardsBefore);

    // The end-to-end guard: `@bridge find` now returns a HIT, not the empty-cache
    // "no matching services" reply it produced before the fix.
    const question = mention(channelId, "@bridge find translation");
    buzz.deliver(question);

    await waitUntil(
      () =>
        buzz.published.some(
          (e) =>
            e.kind === 9 &&
            e.tags.some((t) => t[0] === "e" && t[1] === question.id),
        ),
      15_000,
    );

    const reply = buzz.published.find(
      (e) =>
        e.kind === 9 &&
        e.tags.some((t) => t[0] === "e" && t[1] === question.id),
    );
    expect(reply).toBeDefined();
    expect(reply?.content).toContain(D_TAG);
    expect(reply?.content).toContain(`nw:${ADDRESS}`);
    expect(reply?.content).not.toContain("No matching services");
  }, 40_000);
});
