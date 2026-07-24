/** Staleness sweep tests (spec §3d). */

import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";

import {
  DIGEST_MAX_ITEMS,
  findStaleAddresses,
  formatStaleDigest,
  sweepStaleListings,
} from "../src/staleness.js";
import { STALE_DIGEST_HEADER } from "../src/sanitize.js";
import type {
  BridgeState,
  IBuzzClient,
  IStateStore,
  MirroredEntry,
  MirroredMap,
  NostrEvent,
  OkResult,
} from "../src/types.js";

const DAY = 86_400;
const NOW = 1_800_000_000;
const PK = "a".repeat(64);

function entry(
  createdAt: number,
  over: Partial<MirroredEntry> = {},
): MirroredEntry {
  return { eventId: "e", createdAt, cardMsgId: "c", delisted: false, ...over };
}

class FakeState implements IStateStore {
  state: BridgeState = {
    version: 1,
    community: "ws://localhost:3000",
    channelId: "chan-uuid",
    cursors: { wolfe: 0, buzz: 0 },
    mirrored: {},
  };
  load(): Promise<BridgeState> {
    return Promise.resolve(this.state);
  }
  getState(): BridgeState {
    return this.state;
  }
  mutate(fn: (s: BridgeState) => void): void {
    fn(this.state);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  reset(): void {}
}

class FakeBuzz implements IBuzzClient {
  readonly published: NostrEvent[] = [];
  ok = true;
  connect(): Promise<void> {
    return Promise.resolve();
  }
  publish(event: NostrEvent): Promise<OkResult> {
    this.published.push(event);
    return Promise.resolve({ id: event.id, ok: this.ok, message: "" });
  }
  subscribe(): never {
    throw new Error("unused");
  }
  query(): Promise<NostrEvent[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

function deps(state: FakeState, buzz: FakeBuzz, staleListingDays = 30) {
  return {
    state,
    buzz,
    channelId: () => "chan-uuid",
    secretKey: generateSecretKey(),
    staleListingDays,
    now: () => NOW,
    log: () => undefined,
  };
}

describe("findStaleAddresses (§3d)", () => {
  it("selects only active, aged, unreported entries — oldest first", () => {
    const cutoff = NOW - 30 * DAY;
    const mirrored: MirroredMap = {
      [`38400:${PK}:fresh`]: entry(NOW - 5 * DAY),
      [`38400:${PK}:old`]: entry(NOW - 40 * DAY),
      [`38400:${PK}:oldest`]: entry(NOW - 90 * DAY),
      [`38400:${PK}:paused`]: entry(NOW - 40 * DAY, { delisted: true }),
      [`38400:${PK}:reported`]: entry(NOW - 40 * DAY, { staleNotified: true }),
      [`38400:${PK}:recovered`]: entry(0), // footer-recovered, unknown age
    };
    const stale = findStaleAddresses(mirrored, cutoff, NOW);
    expect(stale.map((s) => s.d)).toEqual(["oldest", "old"]);
    expect(stale[0]!.ageDays).toBe(90);
  });
});

describe("formatStaleDigest (§3d)", () => {
  it("headers with the count and lists each stale d with its age", () => {
    const digest = formatStaleDigest(
      [
        { address: `38400:${PK}:a`, d: "a", ageDays: 40 },
        { address: `38400:${PK}:b`, d: "b", ageDays: 35 },
      ],
      30,
    );
    const lines = digest.split("\n");
    expect(lines[0]).toBe(`${STALE_DIGEST_HEADER} 2 not refreshed in 30+ days`);
    expect(lines).toContain("• a (40d)");
    expect(lines).toContain("• b (35d)");
    // No `nw:` footer — must never enter footer recovery.
    expect(digest.includes("nw:38400:")).toBe(false);
  });

  it("collapses the overflow beyond the item cap to a +K more line", () => {
    const many = Array.from({ length: DIGEST_MAX_ITEMS + 5 }, (_, i) => ({
      address: `38400:${PK}:svc${String(i)}`,
      d: `svc${String(i)}`,
      ageDays: 40,
    }));
    const lines = formatStaleDigest(many, 30).split("\n");
    // header + DIGEST_MAX_ITEMS items + 1 overflow line
    expect(lines).toHaveLength(1 + DIGEST_MAX_ITEMS + 1);
    expect(lines.at(-1)).toBe("… +5 more");
  });
});

describe("sweepStaleListings (§3d)", () => {
  it("posts a digest and marks each stale listing reported", async () => {
    const state = new FakeState();
    const buzz = new FakeBuzz();
    state.state.mirrored[`38400:${PK}:old`] = entry(NOW - 40 * DAY);
    state.state.mirrored[`38400:${PK}:fresh`] = entry(NOW - 5 * DAY);

    const result = await sweepStaleListings(deps(state, buzz));
    expect(result).toEqual({ stale: 1, posted: true });
    expect(buzz.published).toHaveLength(1);
    expect(buzz.published[0]!.content.startsWith(STALE_DIGEST_HEADER)).toBe(
      true,
    );
    expect(state.state.mirrored[`38400:${PK}:old`]!.staleNotified).toBe(true);
    expect(
      state.state.mirrored[`38400:${PK}:fresh`]!.staleNotified,
    ).toBeUndefined();

    // Idempotent: a second sweep finds nothing new and posts nothing.
    const again = await sweepStaleListings(deps(state, buzz));
    expect(again).toEqual({ stale: 0, posted: false });
    expect(buzz.published).toHaveLength(1);
  });

  it("does not mark reported when the digest publish is rejected", async () => {
    const state = new FakeState();
    const buzz = new FakeBuzz();
    buzz.ok = false;
    state.state.mirrored[`38400:${PK}:old`] = entry(NOW - 40 * DAY);

    const result = await sweepStaleListings(deps(state, buzz));
    expect(result).toEqual({ stale: 1, posted: false });
    expect(
      state.state.mirrored[`38400:${PK}:old`]!.staleNotified,
    ).toBeUndefined();
  });

  it("no-ops when nothing is stale", async () => {
    const state = new FakeState();
    const buzz = new FakeBuzz();
    state.state.mirrored[`38400:${PK}:fresh`] = entry(NOW - 1 * DAY);
    expect(await sweepStaleListings(deps(state, buzz))).toEqual({
      stale: 0,
      posted: false,
    });
    expect(buzz.published).toHaveLength(0);
  });
});
