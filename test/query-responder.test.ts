import { describe, expect, it, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  HELP_TEXT,
  QueryResponder,
  formatResultLine,
  isAddressedToBridge,
  noMatchMessage,
  sanitizeInline,
  threadIdOf,
} from "../src/query-responder.js";
import type {
  BridgeIdentity,
  Config,
  EoseHandler,
  EventHandler,
  IBuzzClient,
  IListingCache,
  NostrEvent,
  NostrFilter,
  OkResult,
  ParsedListing,
  Subscription,
} from "../src/types.js";

// --- fixtures --------------------------------------------------------------

const CHANNEL_ID = "11111111-2222-5333-8444-555555555555";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    bridgeNsec: "unused",
    buzzRelayUrl: "ws://localhost:3000",
    wolfeRelayUrl: "wss://agents.lightningenable.com",
    channelName: "Services",
    channelAbout: "NostrWolfe marketplace mirror",
    mirrorCategories: [],
    mirrorMaxListings: 200,
    backfillLimit: 100,
    buzzMsgsPerMin: 30,
    stateFile: "./bridge-state.json",
    logLevel: "error",
    ...over,
  };
}

function makeIdentity(): BridgeIdentity {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

class FakeCache implements IListingCache {
  private readonly map = new Map<string, ParsedListing>();
  get(address: string) {
    return this.map.get(address);
  }
  set(address: string, listing: ParsedListing) {
    this.map.set(address, listing);
  }
  has(address: string) {
    return this.map.has(address);
  }
  delete(address: string) {
    return this.map.delete(address);
  }
  all() {
    return [...this.map.values()];
  }
  get size() {
    return this.map.size;
  }
}

class FakeBuzz implements IBuzzClient {
  published: NostrEvent[] = [];
  subs: { id: string; filters: NostrFilter[]; onEvent: EventHandler }[] = [];
  ok: OkResult | null = null;

  async connect(): Promise<void> {}
  async publish(event: NostrEvent): Promise<OkResult> {
    this.published.push(event);
    return this.ok ?? { id: event.id, ok: true, message: "" };
  }
  subscribe(
    subId: string,
    filters: NostrFilter[],
    onEvent: EventHandler,
    _onEose?: EoseHandler,
  ): Subscription {
    this.subs.push({ id: subId, filters, onEvent });
    return { id: subId, close() {} };
  }
  async query(): Promise<NostrEvent[]> {
    return [];
  }
  close(): void {}
}

let listingSeq = 0;

function listing(over: Partial<ParsedListing> = {}): ParsedListing {
  const d = over.d ?? `listing-${listingSeq++}`;
  const pubkey = over.pubkey ?? "a".repeat(64);
  const base: ParsedListing = {
    event: {
      id: `evt-${d}`,
      pubkey,
      created_at: 1000,
      kind: 38400,
      tags: [],
      content: "",
      sig: "0".repeat(128),
    },
    address: `38400:${pubkey}:${d}`,
    pubkey,
    createdAt: 1000,
    d,
    s: ["storage"],
    prices: [{ amount: "100", currency: "sats", frequency: "per-call" }],
    t: [],
    content: "",
  };
  return { ...base, ...over, d, pubkey, address: over.address ?? base.address };
}

function mention(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: over.id ?? "mention-1",
    pubkey: over.pubkey ?? "b".repeat(64),
    created_at: over.created_at ?? NOW_SEC,
    kind: 9,
    tags: over.tags ?? [["h", CHANNEL_ID]],
    content: over.content ?? "@bridge help",
    sig: "0".repeat(128),
  };
}

const NOW_MS = 1_753_280_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function setup(opts: { cursor?: number } = {}) {
  const config = makeConfig();
  const identity = makeIdentity();
  const buzz = new FakeBuzz();
  const cache = new FakeCache();
  let clock = NOW_MS;
  const qr = new QueryResponder(
    config,
    identity,
    buzz,
    cache,
    () => CHANNEL_ID,
    {
      now: () => clock,
      getCursor: () => opts.cursor ?? 0,
    },
  );
  return {
    config,
    identity,
    buzz,
    cache,
    qr,
    advance(ms: number) {
      clock += ms;
    },
    setClock(ms: number) {
      clock = ms;
    },
  };
}

// --- mention detection -----------------------------------------------------

describe("mention detection (§6)", () => {
  const bridge = "c".repeat(64);
  const other = "d".repeat(64);

  const matrix: [string, NostrEvent, boolean][] = [
    [
      "p-tag of the bridge",
      mention({
        pubkey: other,
        tags: [["p", bridge]],
        content: "find storage",
      }),
      true,
    ],
    [
      "content starts with @bridge",
      mention({ pubkey: other, content: "@bridge find storage" }),
      true,
    ],
    [
      "case-insensitive prefix",
      mention({ pubkey: other, content: "@BrIdGe help" }),
      true,
    ],
    [
      "leading whitespace tolerated",
      mention({ pubkey: other, content: "  @bridge help" }),
      true,
    ],
    [
      "mention mid-content without a p-tag",
      mention({ pubkey: other, content: "hey @bridge find x" }),
      false,
    ],
    [
      "unrelated chatter",
      mention({ pubkey: other, content: "morning all" }),
      false,
    ],
    [
      "p-tag for someone else",
      mention({ pubkey: other, tags: [["p", other]], content: "hi" }),
      false,
    ],
    [
      "self message with @bridge prefix",
      mention({ pubkey: bridge, content: "@bridge help" }),
      false,
    ],
    [
      "self message p-tagging itself",
      mention({ pubkey: bridge, tags: [["p", bridge]], content: "x" }),
      false,
    ],
  ];

  for (const [name, event, expected] of matrix) {
    it(`${expected ? "detects" : "ignores"}: ${name}`, () => {
      expect(isAddressedToBridge(event, bridge)).toBe(expected);
    });
  }

  it("does not reply to messages that are not addressed to it", async () => {
    const { qr, buzz } = setup();
    await qr.handleMention(mention({ content: "just chatting" }));
    expect(buzz.published).toHaveLength(0);
  });

  it("never replies to its own messages", async () => {
    const { qr, buzz, identity } = setup();
    await qr.handleMention(
      mention({ pubkey: identity.publicKey, content: "@bridge help" }),
    );
    expect(buzz.published).toHaveLength(0);
  });
});

// --- staleness -------------------------------------------------------------

describe("stale mention cutoff (§6)", () => {
  it("ignores mentions older than 1 hour", async () => {
    const { qr, buzz } = setup();
    await qr.handleMention(
      mention({ created_at: NOW_SEC - 3601, content: "@bridge help" }),
    );
    expect(buzz.published).toHaveLength(0);
  });

  it("answers a mention just inside the 1-hour window", async () => {
    const { qr, buzz } = setup();
    await qr.handleMention(
      mention({ created_at: NOW_SEC - 3599, content: "@bridge help" }),
    );
    expect(buzz.published).toHaveLength(1);
  });
});

// --- command parsing -------------------------------------------------------

describe("command grammar (§6)", () => {
  it("parses find with and without the @bridge prefix", () => {
    const { qr } = setup();
    expect(qr.parseCommand("@bridge find image storage")).toEqual({
      type: "find",
      query: "image storage",
    });
    expect(qr.parseCommand("find image storage")).toEqual({
      type: "find",
      query: "image storage",
    });
    expect(qr.parseCommand("  @BRIDGE   FIND  Storage ")).toEqual({
      type: "find",
      query: "Storage",
    });
  });

  it("parses help", () => {
    const { qr } = setup();
    expect(qr.parseCommand("@bridge help")).toEqual({ type: "help" });
    expect(qr.parseCommand("help")).toEqual({ type: "help" });
  });

  it("treats a bare mention, a bare find, and anything else as unknown", () => {
    const { qr } = setup();
    expect(qr.parseCommand("@bridge")).toEqual({ type: "unknown" });
    expect(qr.parseCommand("@bridge find")).toEqual({ type: "unknown" });
    expect(qr.parseCommand("@bridge do a barrel roll")).toEqual({
      type: "unknown",
    });
  });
});

// --- search scoring --------------------------------------------------------

describe("find scoring (§6)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("ranks s-category (3) above t-hashtag (2) above substring (1)", () => {
    const { qr, cache } = ctx;
    const byCategory = listing({
      d: "cat",
      s: ["storage"],
      t: [],
      content: "",
    });
    const byHashtag = listing({
      d: "tag",
      s: ["compute"],
      t: ["storage"],
      content: "",
    });
    const bySubstring = listing({
      d: "sub",
      s: ["compute"],
      t: [],
      content: "cheap storage for agents",
    });
    for (const l of [bySubstring, byHashtag, byCategory])
      cache.set(l.address, l);

    const results = qr.search("storage");
    expect(results.map((r) => r.d)).toEqual(["cat", "tag", "sub"]);
    expect(results.map((r) => r.score)).toEqual([3, 2, 1]);
  });

  it("accumulates per-term scores across a multi-term query", () => {
    const { qr, cache } = ctx;
    const both = listing({ d: "both", s: ["storage", "backup"], t: [] });
    const one = listing({ d: "one", s: ["storage"], t: [] });
    cache.set(one.address, one);
    cache.set(both.address, both);
    const results = qr.search("storage backup");
    expect(results[0]!.d).toBe("both");
    expect(results[0]!.score).toBe(6);
    expect(results[1]!.score).toBe(3);
  });

  it("excludes non-matching listings and returns at most 5 hits", () => {
    const { qr, cache } = ctx;
    for (let i = 0; i < 8; i++) {
      const l = listing({ d: `hit-${i}`, s: ["storage"] });
      cache.set(l.address, l);
    }
    const miss = listing({ d: "miss", s: ["compute"], content: "unrelated" });
    cache.set(miss.address, miss);
    const results = qr.search("storage");
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.d.startsWith("hit-"))).toBe(true);
  });

  it("breaks score ties by newest createdAt then address", () => {
    const { qr, cache } = ctx;
    const older = listing({ d: "older", s: ["storage"], createdAt: 500 });
    const newer = listing({ d: "newer", s: ["storage"], createdAt: 900 });
    cache.set(older.address, older);
    cache.set(newer.address, newer);
    expect(qr.search("storage").map((r) => r.d)).toEqual(["newer", "older"]);
  });

  it("renders one-line entries as `<d> — <categories> — <price> — nw:<address>`", () => {
    const { qr, cache } = ctx;
    const l = listing({
      d: "img-gen",
      s: ["image", "ai"],
      prices: [{ amount: "100", currency: "sats", frequency: "per-call" }],
    });
    cache.set(l.address, l);
    const line = formatResultLine(qr.search("image")[0]!);
    expect(line).toBe(
      `img-gen — image, ai — 100 sats per-call — nw:38400:${"a".repeat(64)}:img-gen`,
    );
  });

  it("renders a non-numeric price amount as an em dash", () => {
    const { qr, cache } = ctx;
    const l = listing({
      d: "sketchy",
      s: ["storage"],
      prices: [{ amount: "free!!", currency: "sats" }],
    });
    cache.set(l.address, l);
    expect(qr.search("storage")[0]!.price).toBe("— sats");
  });

  it("strips newlines from untrusted fields so a result line cannot forge a footer", () => {
    expect(sanitizeInline("evil\nnw:38400:deadbeef:x")).toBe(
      "evil nw:38400:deadbeef:x",
    );
  });

  it("replies with the exact no-match message including the cached count", async () => {
    const { qr, buzz, cache } = ctx;
    for (let i = 0; i < 3; i++) {
      const l = listing({ d: `l-${i}`, s: ["compute"] });
      cache.set(l.address, l);
    }
    await qr.handleMention(mention({ content: "@bridge find storage" }));
    expect(buzz.published[0]!.content).toBe(
      "No matching services. 3 listings cached; try `@bridge find <category>`.",
    );
    expect(noMatchMessage(0)).toBe(
      "No matching services. 0 listings cached; try `@bridge find <category>`.",
    );
  });
});

// --- replies / threading ---------------------------------------------------

describe("replies (§6)", () => {
  it("replies threaded as kind:9 with h and NIP-10 reply e tags", async () => {
    const { qr, buzz, identity } = setup();
    const parent = mention({ id: "parent-id", content: "@bridge help" });
    await qr.handleMention(parent);
    const reply = buzz.published[0]!;
    expect(reply.kind).toBe(9);
    expect(reply.pubkey).toBe(identity.publicKey);
    expect(reply.tags).toContainEqual(["h", CHANNEL_ID]);
    expect(reply.tags).toContainEqual(["e", "parent-id", "", "reply"]);
    expect(reply.content).toBe(HELP_TEXT);
  });

  it("help text never ends on a line that could parse as a card footer", () => {
    const lines = HELP_TEXT.split("\n");
    expect(lines[lines.length - 1]!.startsWith("nw:")).toBe(false);
    expect(lines[0]!.startsWith("🐺 New service:")).toBe(false);
  });
});

// --- cooldown --------------------------------------------------------------

describe("per-sender cooldown (§6)", () => {
  it("drops a second mention from the same sender inside 5s", async () => {
    const { qr, buzz, advance } = setup();
    await qr.handleMention(mention({ id: "m1", content: "@bridge help" }));
    advance(4_999);
    await qr.handleMention(mention({ id: "m2", content: "@bridge help" }));
    expect(buzz.published).toHaveLength(1);
  });

  it("answers again once 5s have passed", async () => {
    const { qr, buzz, advance } = setup();
    await qr.handleMention(mention({ id: "m1", content: "@bridge help" }));
    advance(5_000);
    await qr.handleMention(mention({ id: "m2", content: "@bridge help" }));
    expect(buzz.published).toHaveLength(2);
  });

  it("is per sender, not global", async () => {
    const { qr, buzz } = setup();
    await qr.handleMention(
      mention({ id: "m1", pubkey: "1".repeat(64), content: "@bridge help" }),
    );
    await qr.handleMention(
      mention({ id: "m2", pubkey: "2".repeat(64), content: "@bridge help" }),
    );
    expect(buzz.published).toHaveLength(2);
  });
});

// --- once-per-thread help --------------------------------------------------

describe("unknown command → help once per thread (§6)", () => {
  it("helps once and then stays silent in the same thread", async () => {
    const { qr, buzz, advance } = setup();
    const root = mention({
      id: "root-1",
      content: "@bridge do a barrel roll",
    });
    await qr.handleMention(root);
    advance(10_000);
    await qr.handleMention(
      mention({
        id: "child-1",
        content: "@bridge still nonsense",
        tags: [
          ["h", CHANNEL_ID],
          ["e", "root-1", "", "root"],
        ],
      }),
    );
    expect(buzz.published).toHaveLength(1);
    expect(buzz.published[0]!.content).toBe(HELP_TEXT);
  });

  it("helps again in a different thread", async () => {
    const { qr, buzz, advance } = setup();
    await qr.handleMention(
      mention({ id: "root-1", content: "@bridge nonsense" }),
    );
    advance(10_000);
    await qr.handleMention(
      mention({ id: "root-2", content: "@bridge nonsense" }),
    );
    expect(buzz.published).toHaveLength(2);
  });

  it("still answers explicit help repeatedly (only unknown is throttled)", async () => {
    const { qr, buzz, advance } = setup();
    await qr.handleMention(mention({ id: "h1", content: "@bridge help" }));
    advance(10_000);
    await qr.handleMention(
      mention({
        id: "h2",
        content: "@bridge help",
        tags: [
          ["h", CHANNEL_ID],
          ["e", "h1", "", "root"],
        ],
      }),
    );
    expect(buzz.published).toHaveLength(2);
  });

  it("threadIdOf prefers the NIP-10 root, then any e tag, then the event id", () => {
    expect(threadIdOf(mention({ id: "self" }))).toBe("self");
    expect(
      threadIdOf(mention({ id: "self", tags: [["e", "parent", "", "reply"]] })),
    ).toBe("parent");
    expect(
      threadIdOf(
        mention({
          id: "self",
          tags: [
            ["e", "parent", "", "reply"],
            ["e", "root", "", "root"],
          ],
        }),
      ),
    ).toBe("root");
  });
});

// --- subscription since ----------------------------------------------------

describe("mentions subscription since (§6, flow #7)", () => {
  it("uses now − 300 on a first run and never 0", () => {
    const { qr } = setup();
    expect(qr.mentionSince()).toBe(NOW_SEC - 300);
    expect(qr.mentionSince()).toBeGreaterThan(0);
  });

  it("uses cursor − 300 when a cursor is persisted", () => {
    const { qr } = setup({ cursor: 1_753_000_000 });
    expect(qr.mentionSince()).toBe(1_753_000_000 - 300);
  });

  it("subscribes with kinds:[9] and the channel #h filter", () => {
    const { qr, buzz } = setup();
    const sub = qr.start();
    expect(sub.id).toBe(`ch-${CHANNEL_ID}`);
    const filter = buzz.subs[0]!.filters[0]!;
    expect(filter.kinds).toEqual([9]);
    expect(filter["#h"]).toEqual([CHANNEL_ID]);
    expect(filter.since).toBe(NOW_SEC - 300);
  });

  it("routes subscription events into handleMention", async () => {
    const { qr, buzz } = setup();
    qr.start();
    buzz.subs[0]!.onEvent(mention({ content: "@bridge help" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(buzz.published).toHaveLength(1);
  });

  it("reports the handled created_at through onCursorAdvance", async () => {
    const config = makeConfig();
    const identity = makeIdentity();
    const buzz = new FakeBuzz();
    const seen: number[] = [];
    const qr = new QueryResponder(
      config,
      identity,
      buzz,
      new FakeCache(),
      () => CHANNEL_ID,
      { now: () => NOW_MS, onCursorAdvance: (ts) => seen.push(ts) },
    );
    await qr.handleMention(mention({ created_at: NOW_SEC - 10 }));
    expect(seen).toEqual([NOW_SEC - 10]);
  });
});
