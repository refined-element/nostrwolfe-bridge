/**
 * End-to-end integration: the full daemon booted against both in-process mock
 * relays (spec "Testing strategy" → integration vs mock relays, and the
 * local-relay e2e script's assertion list).
 *
 * Covers, in order:
 *  1. channel created with the deterministic client UUID (§3),
 *  2. a fixture 38400 becomes a correctly formatted card (§5 step 4),
 *  3. a NIP-33 replacement becomes an "Updated" card (§5 step 3),
 *  4. an `@bridge find` mention gets a threaded reply (§6),
 *  5. a restart with the state file deleted re-derives the dedupe set from card
 *     footers — no duplicate "New service" card (§7).
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A signed kind:38400 capability advertisement (NIP-A5 required tags + extras). */
function listing(overrides: {
  createdAt: number;
  price: string;
  content: string;
}): NostrEvent {
  return finalizeEvent(
    {
      kind: 38400,
      created_at: overrides.createdAt,
      tags: [
        ["d", D_TAG],
        ["s", "translation"],
        ["s", "nlp"],
        ["price", overrides.price, "sats", "per-request"],
        ["endpoint", "https://example.test/translate", "POST"],
        ["uptime", "0.997"],
        ["capacity", "1000", "req/day"],
        ["negotiable", "true"],
        ["t", "llm"],
      ],
      content: overrides.content,
    },
    providerKey,
  ) as unknown as NostrEvent;
}

/** A member-authored channel message (kind:9) delivered by the relay. */
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

function cardsWithHeader(buzz: BuzzMockRelay, header: string): NostrEvent[] {
  return buzz.published.filter(
    (e) => e.kind === 9 && e.content.startsWith(header),
  );
}

// ---------------------------------------------------------------------------

describe("nostrwolfe-bridge end-to-end", () => {
  let buzz: BuzzMockRelay;
  let strfry: StrfryMock;
  let dir: string;
  let stateFile: string;
  let config: Config;
  let handle: BridgeHandle;
  let expectedChannelId: string;
  const originalCreatedAt = nowSec() - 120;

  beforeAll(async () => {
    buzz = await BuzzMockRelay.start({ channelAware: true });
    strfry = await StrfryMock.start();
    dir = await mkdtemp(join(tmpdir(), "nwbridge-e2e-"));
    stateFile = join(dir, "bridge-state.json");

    strfry.add(
      listing({
        createdAt: originalCreatedAt,
        price: "100",
        content: "Fast machine translation for agents.",
      }),
    );

    config = loadConfig({
      BRIDGE_NSEC: toHex(bridgeKey),
      BUZZ_RELAY_URL: buzz.url,
      WOLFE_RELAY_URL: strfry.url,
      STATE_FILE: stateFile,
      LOG_LEVEL: "error",
      BUZZ_MSGS_PER_MIN: "60",
      BACKFILL_LIMIT: "50",
    });
    expectedChannelId = deriveChannelId(bridgePubkey, config.channelName);

    handle = await startBridge(config, { timeScale: 0.01 });
  }, 30_000);

  afterAll(async () => {
    await handle.stop();
    await buzz.stop();
    await strfry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("authenticates, then creates the channel with the deterministic UUID (§3)", () => {
    // AUTH is answered before any EVENT/REQ reaches the wire (§2).
    expect(buzz.authEvents).toHaveLength(1);
    expect(buzz.authEvents[0]?.kind).toBe(22242);
    expect(buzz.authRelayTags()[0]).toBe(buzz.url);

    expect(handle.channelId()).toBe(expectedChannelId);
    expect(buzz.channelIds()).toEqual([expectedChannelId]);
    expect(buzz.channelMembers(expectedChannelId)).toContain(bridgePubkey);

    const create = buzz.published.find((e) => e.kind === 9007);
    expect(create).toBeDefined();
    expect(create?.tags).toContainEqual(["h", expectedChannelId]);
    expect(create?.tags).toContainEqual(["name", config.channelName]);
    expect(create?.tags).toContainEqual(["visibility", "open"]);
    expect(handle.state.getState().channelId).toBe(expectedChannelId);
  });

  it("mirrors the hydrated 38400 as a correctly formatted card (§5)", () => {
    const cards = cardsWithHeader(buzz, "🐺 New service:");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.tags).toContainEqual(["h", expectedChannelId]);
    expect(card?.pubkey).toBe(bridgePubkey);

    // Blank-line-separated sections: header, [blank], description, [blank], details…, [blank], ─, footer.
    const lines = card?.content.split("\n") ?? [];
    expect(lines[0]).toBe(`🐺 New service: **${D_TAG}**`);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Fast machine translation for agents.");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Categories: translation, nlp  ·  Tags: #llm");
    expect(lines[5]).toBe("Price: 100 sats per-request  ·  Negotiable: yes");
    expect(lines[6]).toBe("Endpoint: https://example.test/translate (POST)");
    expect(lines[7]).toBe("Uptime: 99.7%  ·  Capacity: 1000 req/day");
    expect(lines[8]?.startsWith("Provider: npub1")).toBe(true);
    // The final line is the machine-readable footer — the recovery key (§7).
    expect(lines[lines.length - 1]).toBe(`nw:${ADDRESS}`);

    expect(handle.cache.size).toBe(1);
    expect(handle.state.getState().mirrored[ADDRESS]?.createdAt).toBe(
      originalCreatedAt,
    );
  });

  it("posts an Updated card for a NIP-33 replacement over the live sub (§4/§5)", async () => {
    strfry.broadcast(
      listing({
        createdAt: originalCreatedAt + 60,
        price: "150",
        content: "Fast machine translation for agents. Now cheaper per token.",
      }),
    );

    // The mock records the EVENT frame before the OK round-trip, and the
    // dedupe entry is written only once the publish resolves — so wait for the
    // recorded state, not just for the card on the wire.
    await waitUntil(
      () =>
        cardsWithHeader(buzz, "🐺 Updated:").length === 1 &&
        handle.state.getState().mirrored[ADDRESS]?.createdAt ===
          originalCreatedAt + 60,
      10_000,
    );
    const card = cardsWithHeader(buzz, "🐺 Updated:")[0];
    const lines = card?.content.split("\n") ?? [];
    expect(lines[0]).toBe(`🐺 Updated: **${D_TAG}**`);
    expect(lines[5]).toBe("Price: 150 sats per-request  ·  Negotiable: yes");
    expect(lines[lines.length - 1]).toBe(`nw:${ADDRESS}`);

    // No second "new" card for an address already mirrored.
    expect(cardsWithHeader(buzz, "🐺 New service:")).toHaveLength(1);
    expect(handle.state.getState().mirrored[ADDRESS]?.createdAt).toBe(
      originalCreatedAt + 60,
    );
  }, 15_000);

  it("answers an @bridge find mention with a threaded reply (§6)", async () => {
    const question = mention(expectedChannelId, "@bridge find translation");
    buzz.deliver(question);

    await waitUntil(
      () =>
        buzz.published.some(
          (e) =>
            e.kind === 9 &&
            e.tags.some((t) => t[0] === "e" && t[1] === question.id),
        ),
      10_000,
    );

    const reply = buzz.published.find(
      (e) =>
        e.kind === 9 &&
        e.tags.some((t) => t[0] === "e" && t[1] === question.id),
    );
    expect(reply?.pubkey).toBe(bridgePubkey);
    // NIP-10 threaded reply into the same channel (§6).
    expect(reply?.tags).toContainEqual(["e", question.id, "", "reply"]);
    expect(reply?.tags).toContainEqual(["h", expectedChannelId]);
    expect(reply?.content).toContain(`nw:${ADDRESS}`);
    expect(reply?.content).toContain(D_TAG);
    expect(reply?.content).toContain("translation, nlp");
  }, 15_000);

  it("recovers the dedupe set from card footers after the state file is deleted (§7)", async () => {
    const newCardsBefore = cardsWithHeader(buzz, "🐺 New service:").length;
    const updatedBefore = cardsWithHeader(buzz, "🐺 Updated:").length;

    await handle.stop();
    await rm(stateFile, { force: true });

    handle = await startBridge(config, { timeScale: 0.01 });

    // Footers rebuilt the address set with `createdAt: 0`, so the next 38400
    // posts an "updated" card instead of a duplicate "new" one (§7).
    expect(handle.state.getState().mirrored[ADDRESS]).toBeDefined();
    expect(cardsWithHeader(buzz, "🐺 New service:")).toHaveLength(
      newCardsBefore,
    );
    await waitUntil(
      () => cardsWithHeader(buzz, "🐺 Updated:").length > updatedBefore,
      10_000,
    );
    // Same channel, discovered via 39000 rather than re-created (§3 step 1).
    expect(handle.channelId()).toBe(expectedChannelId);
    expect(buzz.channelIds()).toEqual([expectedChannelId]);
  }, 30_000);
});
