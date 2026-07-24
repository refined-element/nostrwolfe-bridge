/**
 * WolfeSubscriber tests (spec §4) — paged hydration, cursor discipline,
 * no-`limit` live sub, and the large-gap drain on reconnect.
 */

import { afterEach, describe, expect, it } from "vitest";

import { asNostrEvent, WolfeSubscriber } from "../src/wolfe-subscriber.js";
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

    const pages = relay.reqsForPrefix("wolfe-hydrate");
    expect(pages.length).toBeGreaterThan(1);
    // Every page carries the configured limit; only the first has no `until`.
    expect(pages[0]!.filters[0]).toEqual({ kinds: [38400, 5], limit: 100 });
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
    for (const req of relay.reqsForPrefix("wolfe-hydrate")) {
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

  it("keeps paging past a page saturated by a single `created_at`", async () => {
    // `until` is inclusive, so a full page whose events all share one second
    // returns the identical set forever. Treating that as "drained" silently
    // truncated hydration and lost every older listing (§4).
    relay = await StrfryMock.start();
    for (let i = 0; i < 10; i++) relay.add(listing(i, 1000));
    for (let i = 10; i < 15; i++) relay.add(listing(i, 900));

    subscriber = new WolfeSubscriber(
      baseConfig(relay.url, { backfillLimit: 10, mirrorMaxListings: 1000 }),
      () => 0,
      { minBackoffMs: 5 },
    );

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    // All five events below the saturated second are still hydrated.
    expect(new Set(seen.map((e) => e.id)).size).toBe(15);
  });

  it("counts the mirror's tracked addresses against the cap, not every address seen", async () => {
    // §1: `MIRROR_MAX_LISTINGS` caps addresses *tracked*. Counting every
    // address hydration sees lets a narrow `MIRROR_CATEGORIES` spend the whole
    // cap on listings the client-side filter immediately discards.
    relay = await StrfryMock.start();
    for (let i = 0; i < 30; i++) {
      relay.add(listing(i, 2000 - i, i % 10 === 0 ? `keep-${i}` : `drop-${i}`));
    }

    const tracked = new Set<string>();
    subscriber = new WolfeSubscriber(
      baseConfig(relay.url, { backfillLimit: 10, mirrorMaxListings: 3 }),
      () => 0,
      { minBackoffMs: 5, trackedCount: () => tracked.size },
    );

    await subscriber.hydrate((e) => {
      const d = e.tags.find((t) => t[0] === "d")?.[1] ?? "";
      if (d.startsWith("keep-")) tracked.add(d);
    });

    // All three matching listings are mirrored even though 20+ non-matching
    // addresses passed through first.
    expect(tracked.size).toBe(3);
  });

  it("survives a listener that throws instead of aborting the whole run", async () => {
    relay = await StrfryMock.start();
    for (let i = 0; i < 5; i++) relay.add(listing(i, 1000 + i));

    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 0, {
      minBackoffMs: 5,
    });

    const seen: string[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e.id);
      if (seen.length === 2) throw new Error("boom");
    });

    expect(seen).toHaveLength(5);
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

describe("relay frame admission (Security §2)", () => {
  it("rejects half-formed events instead of letting them reach the mirror", () => {
    // The exact PoC frame: `["EVENT","wolfe-hydrate",{"id":"aa"}]`. Admitting
    // it made hydration throw on `event.tags.find(...)`, and since hydration
    // re-runs from scratch every startup that is a crash loop the open,
    // unauthenticated relay can trigger at will.
    expect(asNostrEvent({ id: "aa" })).toBeNull();
    expect(asNostrEvent(null)).toBeNull();
    expect(asNostrEvent("nope")).toBeNull();

    const good = listing(1, 1000);
    expect(asNostrEvent(good)).toBe(good);

    expect(asNostrEvent({ ...good, tags: undefined })).toBeNull();
    expect(asNostrEvent({ ...good, tags: [["d", 7]] })).toBeNull();
    expect(asNostrEvent({ ...good, tags: ["d"] })).toBeNull();
    expect(asNostrEvent({ ...good, created_at: undefined })).toBeNull();
    expect(asNostrEvent({ ...good, created_at: "soon" })).toBeNull();
    expect(asNostrEvent({ ...good, kind: "38400" })).toBeNull();
    expect(asNostrEvent({ ...good, content: undefined })).toBeNull();
    expect(asNostrEvent({ ...good, sig: undefined })).toBeNull();
    expect(asNostrEvent({ ...good, id: "short" })).toBeNull();
    expect(asNostrEvent({ ...good, pubkey: "nothex" })).toBeNull();
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
    expect(filter).toEqual({ kinds: [38400, 5], since: 4700 });
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
    const drains = relay.reqsForPrefix("wolfe-drain");
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

  it("recovers when a disconnect lands while a reconnect is still draining", async () => {
    // The listener chain is publish-rate-limited in production, so draining a
    // gap takes minutes — long enough for a second disconnect to land inside
    // it. That second reconnect used to hit the `resuming` guard, get dropped,
    // and leave the live sub permanently dead: no socket, no pending attempt,
    // silent loss of all mirroring (§4 "infinite retries").
    relay = await StrfryMock.start({ maxEventsPerReq: 5 });

    let cursor = 0;
    let slow = false;
    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => cursor, {
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });

    const seen: NostrEvent[] = [];
    subscriber.subscribeLive(async (e) => {
      seen.push(e);
      cursor = Math.max(cursor, e.created_at);
      if (slow) await new Promise((r) => setTimeout(r, 40));
    });
    await waitFor(() => relay!.reqsFor("wolfe-38400").length === 1);

    // First disconnect: 20 events to drain through a deliberately slow listener.
    slow = true;
    relay.dropConnections();
    for (let i = 0; i < 20; i++) relay.add(listing(i, 2000 + i));

    // Second disconnect, landing strictly inside `await this.queue`: every
    // drain page is already on the wire, but the slow listener is still
    // chewing through them.
    await waitFor(
      () => relay!.reqsForPrefix("wolfe-drain").length >= 4,
      10_000,
    );
    await waitFor(() => seen.length >= 2, 10_000);
    expect(seen.length).toBeLessThan(20);
    relay.dropConnections();

    // The live sub must come back and deliver new events again.
    await waitFor(() => relay!.reqsFor("wolfe-38400").length >= 2, 10_000);
    slow = false;
    await waitFor(() => new Set(seen.map((e) => e.id)).size >= 20, 10_000);

    relay.broadcast(listing(500, 9_000));
    await waitFor(() => seen.some((e) => e.created_at === 9_000), 10_000);
  });

  it("re-issues the live sub on CLOSED, then drops the connection to reconnect", async () => {
    // C-3: a CLOSED on the live sub leaves the socket OPEN, so onDisconnect
    // never fires. Without re-issue-then-drop, mirroring stops permanently on a
    // healthy-looking connection. The relay CLOSEDs the first four live REQs
    // (initial + 3 bounded in-place re-issues); the fifth attempt escalates to
    // dropping the connection, and the post-reconnect REQ is served for real.
    relay = await StrfryMock.start();
    relay.closeReqs("wolfe-38400", 4, "closed: rate-limited");

    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 5000, {
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });

    const seen: NostrEvent[] = [];
    subscriber.subscribeLive((e) => {
      seen.push(e);
    });

    // Four CLOSEDs -> four re-issues; the fifth REQ is the healthy one issued
    // after the connection was dropped and the reconnect path restored the sub.
    await waitFor(() => relay!.reqsFor("wolfe-38400").length >= 5, 10_000);
    // The connection was actually dropped and re-established (not just re-REQ'd).
    expect(relay.connectionCount).toBeGreaterThanOrEqual(2);

    // The now-healthy live sub delivers new events again.
    relay.broadcast(listing(99, 6000));
    await waitFor(() => seen.some((e) => e.created_at === 6000), 10_000);
  });

  it("surfaces a hard failure when a hydrate page stays CLOSED, never a silent empty", async () => {
    // C-2: resolving a CLOSED paged REQ as an empty page made hydrate break on
    // page 0 and finish with zero listings. CLOSED must reject so requestPage's
    // retry ladder runs; a persistent CLOSED then throws out of hydrate.
    relay = await StrfryMock.start();
    for (let i = 0; i < 10; i++) relay.add(listing(i, 1000 + i));
    // Every hydrate page REQ is refused.
    relay.closeReqs("wolfe-hydrate", 100, "closed: rate-limited");

    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 0, {
      minBackoffMs: 5,
      maxBackoffMs: 20,
      pageRetries: 2,
    });

    const seen: NostrEvent[] = [];
    await expect(
      subscriber.hydrate((e) => {
        seen.push(e);
      }),
    ).rejects.toThrow(/closed/);

    // Not a silent empty: nothing was mirrored, and the ladder actually retried
    // (1 initial + 2 retries = 3 REQs, all on the same page-0 sub id).
    expect(seen).toHaveLength(0);
    const pages = relay.reqsForPrefix("wolfe-hydrate");
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.subId === "wolfe-hydrate-0")).toBe(true);
  });

  it("sends CLOSE and uses a unique sub id when a page times out", async () => {
    // M-6: a timed-out REQ must CLOSE its sub (else it leaks a server-side
    // subscription) and paged sub ids must be unique per page.
    relay = await StrfryMock.start();
    for (let i = 0; i < 5; i++) relay.add(listing(i, 1000 + i));
    // Swallow only the first page REQ so its timeout fires; the retry is served.
    relay.stallReqs("wolfe-hydrate", 1);

    subscriber = new WolfeSubscriber(baseConfig(relay.url), () => 0, {
      minBackoffMs: 5,
      maxBackoffMs: 20,
      pageTimeoutMs: 60,
      pageRetries: 3,
    });

    const seen: NostrEvent[] = [];
    await subscriber.hydrate((e) => {
      seen.push(e);
    });

    // The retry after the timeout completed hydration.
    expect(new Set(seen.map((e) => e.id)).size).toBe(5);
    // Every paged sub id is unique-per-page (`wolfe-hydrate-<page>`).
    const pages = relay.reqsForPrefix("wolfe-hydrate");
    expect(pages.every((p) => /^wolfe-hydrate-\d+$/.test(p.subId))).toBe(true);
    // The timed-out page-0 REQ was CLOSEd (leak prevention).
    expect(relay.closesFor("wolfe-hydrate-0").length).toBeGreaterThanOrEqual(1);
  });
});
