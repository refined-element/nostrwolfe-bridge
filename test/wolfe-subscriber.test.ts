/**
 * WolfeSubscriber tests (spec §4) — paged hydration, cursor discipline,
 * no-`limit` live sub, and the large-gap drain on reconnect.
 */

import { afterEach, describe, expect, it } from "vitest";

import { WolfeSubscriber } from "../src/wolfe-subscriber.js";
import { StrfryMock } from "./mocks/strfry-mock.js";
import type { Config, NostrEvent } from "../src/types.js";

const PUBKEY = "a".repeat(64);

function baseConfig(url: string, overrides: Partial<Config> = {}): Config {
  return {
    bridgeNsec: "1".repeat(64),
    buzzRelayUrl: "ws://localhost:3000",
    wolfeRelayUrl: url,
    channelName: "Services",
    channelAbout: "test",
    mirrorCategories: [],
    mirrorMaxListings: 200,
    backfillLimit: 100,
    buzzMsgsPerMin: 30,
    stateFile: "./bridge-state.json",
    logLevel: "error",
    ...overrides,
  };
}

/**
 * WolfeSubscriber forwards raw frames without verifying them (verification is
 * MirrorEngine's job, §5 step 1), so unsigned fixtures are sufficient here.
 */
function listing(seq: number, createdAt: number, d = `svc-${seq}`): NostrEvent {
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey: PUBKEY,
    created_at: createdAt,
    kind: 38400,
    tags: [
      ["d", d],
      ["s", "translation"],
      ["price", "50", "sats", "per-request"],
    ],
    content: `listing ${seq}`,
    sig: "0".repeat(128),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let relay: StrfryMock | undefined;
let subscriber: WolfeSubscriber | undefined;

afterEach(async () => {
  subscriber?.close();
  subscriber = undefined;
  await relay?.stop();
  relay = undefined;
});

describe("WolfeSubscriber.hydrate (§4 startup hydration)", () => {
  it("pages backwards with `until` until the set is drained", async () => {
    relay = await StrfryMock.start();
    for (let i = 0; i < 250; i++) relay.add(listing(i, 1000 + i));

    subscriber = new WolfeSubscriber(
      baseConfig(relay.url, { mirrorMaxListings: 1000 }),
      () => 0,
      { minBackoffMs: 5, maxBackoffMs: 20 },
    );

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    expect(seen).toHaveLength(250);
    expect(new Set(seen.map((e) => e.id)).size).toBe(250);

    const pages = relay.reqsFor("wolfe-hydrate");
    expect(pages.length).toBeGreaterThan(1);
    // Every page carries the configured limit; only the first has no `until`.
    expect(pages[0]!.filters[0]).toEqual({ kinds: [38400], limit: 100 });
    for (const page of pages.slice(1)) {
      expect(page.filters[0]!.until).toBeTypeOf("number");
      expect(page.filters[0]!.limit).toBe(100);
    }
    // Strictly decreasing `until` — paging backwards, never forwards.
    const untils = pages.slice(1).map((p) => p.filters[0]!.until as number);
    for (let i = 1; i < untils.length; i++) {
      expect(untils[i]!).toBeLessThan(untils[i - 1]!);
    }
  });

  it("never sends `since` — hydration ignores the cursor entirely", async () => {
    relay = await StrfryMock.start();
    for (let i = 0; i < 120; i++) relay.add(listing(i, 1000 + i));

    // A cursor far in the future must not window the hydration REQ.
    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 9_999_999, {
      minBackoffMs: 5,
    });

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    expect(seen).toHaveLength(120);
    for (const req of relay.reqsFor("wolfe-hydrate")) {
      expect(req.filters[0]!.since).toBeUndefined();
    }
  });

  it("stops at MIRROR_MAX_LISTINGS distinct addresses", async () => {
    relay = await StrfryMock.start();
    for (let i = 0; i < 20; i++) relay.add(listing(i, 1000 + i));

    subscriber = new WolfeSubscriber(
      baseConfig(relay.url, { mirrorMaxListings: 5 }),
      () => 0,
      { minBackoffMs: 5 },
    );

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    expect(seen).toHaveLength(5);
  });

  it("keeps paging when the relay caps a page below BACKFILL_LIMIT", async () => {
    // Page-shortness is not a drain signal: a capped relay would otherwise
    // truncate hydration after one page.
    relay = await StrfryMock.start({ maxEventsPerReq: 7 });
    for (let i = 0; i < 30; i++) relay.add(listing(i, 1000 + i));

    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 0, {
      minBackoffMs: 5,
    });

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    expect(new Set(seen.map((e) => e.id)).size).toBe(30);
  });

  it("only counts distinct addresses, not events, against the cap", async () => {
    relay = await StrfryMock.start();
    // Three replacements of the same address plus two other addresses.
    relay.add(listing(1, 1003, "same"), listing(2, 1002, "same"));
    relay.add(listing(3, 1001, "other-a"), listing(4, 1000, "other-b"));

    subscriber = new WolfeSubscriber(
      baseConfig(relay.url, { mirrorMaxListings: 3 }),
      () => 0,
      { minBackoffMs: 5 },
    );

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    expect(seen.map((e) => e.tags[0]![1])).toEqual([
      "same",
      "same",
      "other-a",
      "other-b",
    ]);
  });
});

describe("WolfeSubscriber.subscribeLive (§4 live subscription)", () => {
  it("subscribes with `since = cursor − 300` and no `limit`", async () => {
    relay = await StrfryMock.start();
    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 5000, {
      minBackoffMs: 5,
    });

    const seen: NostrEvent[] = [];
    subscriber.subscribeLive((e) => {
      seen.push(e);
    });

    await waitFor(() => relay!.reqsFor("wolfe-38400").length === 1);
    const filter = relay.reqsFor("wolfe-38400")[0]!.filters[0]!;
    expect(filter).toEqual({ kinds: [38400], since: 4700 });
    expect(filter.limit).toBeUndefined();
    // Category filtering is client-side only (§1) — never a server-side `#s`.
    expect(filter["#s"]).toBeUndefined();

    relay.broadcast(listing(99, 6000));
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.created_at).toBe(6000);
  });

  it("drains a large reconnect gap by paging with `until` before resuming", async () => {
    // The relay caps every response at 5 results, so the reconnect window can
    // never be served in one shot — exactly the §4 large-gap case.
    relay = await StrfryMock.start({ maxEventsPerReq: 5 });

    let cursor = 0;
    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => cursor, {
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });

    const seen: NostrEvent[] = [];
    subscriber.subscribeLive((e) => {
      seen.push(e);
      cursor = Math.max(cursor, e.created_at);
    });
    await waitFor(() => relay!.reqsFor("wolfe-38400").length === 1);

    relay.dropConnections();
    // 20 listings land while the bridge is disconnected.
    for (let i = 0; i < 20; i++) relay.add(listing(i, 2000 + i));

    // Nothing in the gap is lost, even though no single REQ could return it.
    await waitFor(() => new Set(seen.map((e) => e.id)).size >= 20, 10_000);
    const delivered = new Set(seen.map((e) => e.created_at));
    for (let i = 0; i < 20; i++) expect(delivered.has(2000 + i)).toBe(true);

    // The gap was drained by paged REQs, then the live sub was re-opened.
    const drains = relay.reqsFor("wolfe-drain");
    expect(drains.length).toBeGreaterThan(1);
    for (const drain of drains) {
      expect(drain.filters[0]!.since).toBe(0);
      expect(drain.filters[0]!.limit).toBe(100);
    }
    expect(
      drains.slice(1).every((d) => typeof d.filters[0]!.until === "number"),
    ).toBe(true);
    await waitFor(() => relay!.reqsFor("wolfe-38400").length === 2);
    // The resumed live sub still carries no `limit` (§4).
    expect(relay.reqsFor("wolfe-38400")[1]!.filters[0]!.limit).toBeUndefined();
    expect(relay.reqsFor("wolfe-38400")[1]!.filters[0]!.since).toBeTypeOf(
      "number",
    );
  });
});
