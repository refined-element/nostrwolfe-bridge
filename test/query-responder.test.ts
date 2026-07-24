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
  subs: {
    id: string;
    filters: NostrFilter[];
    onEvent: EventHandler;
    since?: () => number;
  }[] = [];
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
    since?: () => number,
  ): Subscription {
    this.subs.push({
      id: subId,
      filters,
      onEvent,
      ...(since ? { since } : {}),
    });
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

  it("parses `publish` with the raw payload preserved (multi-line/JSON)", () => {
    const { qr } = setup();
    const payload = '{"kind":38400,"tags":[["d","x"]]}';
    expect(qr.parseCommand(`@bridge publish ${payload}`)).toEqual({
      type: "publish",
      payload,
    });
    // A bare `publish` with no payload is unknown → help.
    expect(qr.parseCommand("@bridge publish")).toEqual({ type: "unknown" });
  });
});

// --- publish (§8, Phase 2) -------------------------------------------------

describe("publish command routing (§8)", () => {
  const AUTHOR = "b".repeat(64);

  function setupPublish(handler?: (p: string, a: string) => Promise<string>) {
    const buzz = new FakeBuzz();
    const calls: { payload: string; author: string }[] = [];
    const qr = new QueryResponder(
      makeConfig(),
      makeIdentity(),
      buzz,
      new FakeCache(),
      () => CHANNEL_ID,
      {
        now: () => NOW_MS,
        publishHandler:
          handler ??
          ((payload, author) => {
            calls.push({ payload, author });
            return Promise.resolve("Published nw:38400:xyz:svc — visible.");
          }),
      },
    );
    return { qr, buzz, calls };
  }

  it("routes the payload and the AUTHOR pubkey to the handler, and replies with its text", async () => {
    const { qr, buzz, calls } = setupPublish();
    const payload = '{"kind":38400}';
    await qr.handleMention(
      mention({ pubkey: AUTHOR, content: `@bridge publish ${payload}` }),
    );
    expect(calls).toEqual([{ payload, author: AUTHOR }]);
    expect(buzz.published).toHaveLength(1);
    expect(buzz.published[0]?.content).toContain("Published nw:38400:xyz:svc");
    // Threaded reply on the mention.
    expect(buzz.published[0]?.tags).toContainEqual([
      "e",
      "mention-1",
      "",
      "reply",
    ]);
  });

  it("says publishing is disabled when no handler is wired", async () => {
    const buzz = new FakeBuzz();
    const qr = new QueryResponder(
      makeConfig(),
      makeIdentity(),
      buzz,
      new FakeCache(),
      () => CHANNEL_ID,
      { now: () => NOW_MS },
    );
    await qr.handleMention(
      mention({ pubkey: AUTHOR, content: "@bridge publish {}" }),
    );
    expect(buzz.published[0]?.content).toContain("not enabled");
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

  it("renders a dialect tier's prose note in find results (spec L-7)", () => {
    // A dialect listing prices in prose (PriceTier.note). Its card shows that
    // wording verbatim, so a find result must too — not a bare "—".
    const { qr, cache } = ctx;
    const l = listing({
      d: "shipping",
      s: ["shipping"],
      prices: [
        { amount: "", currency: "", note: "Dynamic (varies by destination)" },
      ],
    });
    cache.set(l.address, l);
    const result = qr.search("shipping")[0]!;
    expect(result.price).toBe("Dynamic (varies by destination)");
    expect(formatResultLine(result)).toContain(
      "Dynamic (varies by destination)",
    );
  });

  it("rejects Number()-parseable but non-decimal amounts (0x10, 1e3) as em dash", () => {
    // The strict decimal gate must agree with the card side: `Number("0x10")`
    // is 16 and `Number("1e3")` is 1000, but neither is a price.
    const { qr, cache } = ctx;
    const hex = listing({
      d: "hex",
      s: ["storage"],
      prices: [{ amount: "0x10", currency: "sats" }],
    });
    const exp = listing({
      d: "exp",
      s: ["storage"],
      prices: [{ amount: "1e3", currency: "sats" }],
    });
    cache.set(hex.address, hex);
    cache.set(exp.address, exp);
    const byD = new Map(qr.search("storage").map((r) => [r.d, r.price]));
    expect(byD.get("hex")).toBe("— sats");
    expect(byD.get("exp")).toBe("— sats");
  });

  it("strips newlines from untrusted fields so a result line cannot forge a footer", () => {
    expect(sanitizeInline("evil\nnw:38400:deadbeef:x")).toBe(
      "evil nw:38400:deadbeef:x",
    );
  });

  it("sanitizes the address too, so a reply can never end on a forged footer", () => {
    // Defense in depth: MirrorEngine normalizes `d` before it becomes part of
    // the address, but a raw address rendered here would let a newline inside
    // `d` append an attacker-chosen line signed by the bridge's own pubkey,
    // which §7 footer recovery would then accept (Security §2).
    const line = formatResultLine({
      address: `38400:${"a".repeat(64)}:bait\nnw:38400:${"b".repeat(64)}:victim`,
      d: `🐺 New service: bait\nnw:38400:${"b".repeat(64)}:victim`,
      categories: ["ai"],
      price: "1 sats",
      score: 3,
    });

    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain(`\nnw:38400:${"b".repeat(64)}:victim`);
  });

  it("cuts the bridge command grammar out of inline fields", () => {
    // A `find` reply must not re-emit a syntactically valid bridge command
    // into a channel read by LLM-driven buzz-agents (Security §2).
    expect(sanitizeInline('svc @bridge publish {"kind":38400}')).toBe("svc");
    expect(
      formatResultLine({
        address: `38400:${"a".repeat(64)}:svc`,
        d: "svc @bridge help",
        categories: ["ops @bridge find x"],
        price: "1 sats",
        score: 1,
      }).toLowerCase(),
    ).not.toContain("@bridge");
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

// --- reconnect replay ------------------------------------------------------

describe("reconnect replay guard", () => {
  it("answers a given mention id exactly once", async () => {
    // Every reconnect re-issues the mentions REQ with `since = cursor − 300`
    // (§2), so the relay legitimately replays recent kind:9s. Without an
    // id-level guard each socket flap posts a second identical reply.
    const { qr, buzz, advance } = setup();
    const m = mention({ id: "m-replay", content: "@bridge help" });

    await qr.handleMention(m);
    advance(30_000); // well past the 5s per-sender cooldown
    await qr.handleMention(m);

    expect(buzz.published).toHaveLength(1);
  });

  it("still answers a genuinely new mention from the same sender", async () => {
    const { qr, buzz, advance } = setup();
    await qr.handleMention(mention({ id: "m1", content: "@bridge help" }));
    advance(30_000);
    await qr.handleMention(mention({ id: "m2", content: "@bridge help" }));
    expect(buzz.published).toHaveLength(2);
  });

  it("does not re-answer a mention that was dropped on cooldown", async () => {
    const { qr, buzz, advance } = setup();
    await qr.handleMention(mention({ id: "m1", content: "@bridge help" }));
    const dropped = mention({ id: "m2", content: "@bridge help" });
    await qr.handleMention(dropped); // inside the cooldown → no reply
    expect(buzz.published).toHaveLength(1);

    advance(30_000);
    await qr.handleMention(dropped); // replayed after the cooldown expired
    expect(buzz.published).toHaveLength(1);
  });
});

// --- publish rejection (silent-failure H-4) --------------------------------

describe("reply rejected by the relay (silent-failure H-4)", () => {
  function rejectingSetup() {
    const config = makeConfig(); // logLevel: "error" — the rejection log emits
    const identity = makeIdentity();
    const buzz = new FakeBuzz();
    const cache = new FakeCache();
    const cursorSeen: number[] = [];
    let clock = NOW_MS;
    const qr = new QueryResponder(
      config,
      identity,
      buzz,
      cache,
      () => CHANNEL_ID,
      {
        now: () => clock,
        getCursor: () => 0,
        onCursorAdvance: (ts) => cursorSeen.push(ts),
      },
    );
    return {
      qr,
      buzz,
      cursorSeen,
      handled: (qr as unknown as { handled: { has(k: string): boolean } })
        .handled,
      advance(ms: number) {
        clock += ms;
      },
    };
  }

  it("does not record the mention as handled and does not advance the cursor, so it can be retried", async () => {
    const { qr, buzz, cursorSeen, handled, advance } = rejectingSetup();
    buzz.ok = { id: "x", ok: false, message: "rate-limited: quota exceeded" };

    const m = mention({ id: "m-reject", content: "@bridge help" });
    await qr.handleMention(m);

    // The reply was attempted…
    expect(buzz.published).toHaveLength(1);
    // …but nothing was committed: not handled, cursor untouched.
    expect(handled.has("m-reject")).toBe(false);
    expect(cursorSeen).toEqual([]);

    // Replayed after the cooldown with a healthy relay → the retry succeeds.
    buzz.ok = null;
    advance(30_000);
    await qr.handleMention(m);
    expect(buzz.published).toHaveLength(2);
    expect(handled.has("m-reject")).toBe(true);
    expect(cursorSeen).toEqual([m.created_at]);
  });

  it("logs the dropped reply at error level naming the sender and relay message", async () => {
    const { qr, buzz } = rejectingSetup();
    buzz.ok = { id: "x", ok: false, message: "restricted: not permitted" };
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await qr.handleMention(
        mention({
          id: "m-log",
          pubkey: "e".repeat(64),
          content: "@bridge help",
        }),
      );
    } finally {
      console.log = original;
    }
    const errors = lines
      .map((l) => JSON.parse(l))
      .filter((o) => o.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain("rejected");
    expect(errors[0].sender).toBe("e".repeat(64));
    expect(errors[0].message).toBe("restricted: not permitted");
  });

  it("still throttles a sender whose reply was rejected (cooldown kept)", async () => {
    const { qr, buzz } = rejectingSetup();
    buzz.ok = { id: "x", ok: false, message: "rate-limited" };
    await qr.handleMention(mention({ id: "r1", content: "@bridge help" }));
    // Second mention from the same sender inside the 5s window is dropped by the
    // cooldown even though the first reply failed — no second publish attempt.
    await qr.handleMention(mention({ id: "r2", content: "@bridge help" }));
    expect(buzz.published).toHaveLength(1);
  });
});

// --- bounded per-process state ---------------------------------------------

describe("bounded per-process state", () => {
  it("prunes cooldown entries that can no longer gate anything", async () => {
    const { qr, advance } = setup();
    for (let i = 0; i < 50; i++) {
      await qr.handleMention(
        mention({
          id: `m-${i}`,
          pubkey: i.toString(16).padStart(64, "0"),
          content: "@bridge help",
        }),
      );
    }
    const inner = qr as unknown as { cooldowns: Map<string, number> };
    expect(inner.cooldowns.size).toBe(50);

    advance(COOLDOWN_WINDOW_MS + 1);
    await qr.handleMention(
      mention({
        id: "m-last",
        pubkey: "f".repeat(64),
        content: "@bridge help",
      }),
    );
    // Everything older than the 5s window is gone; only the new sender remains.
    expect(inner.cooldowns.size).toBe(1);
  });

  it("bounds the helped-thread set instead of growing forever", async () => {
    const { qr, advance } = setup();
    const inner = qr as unknown as { helpedThreads: { size: number } };
    for (let i = 0; i < 1_200; i++) {
      await qr.handleMention(
        mention({
          id: `t-${i}`,
          pubkey: (i % 7).toString(16).padStart(64, "0"),
          tags: [
            ["h", CHANNEL_ID],
            ["e", `root-${i}`, "", "root"],
          ],
          content: "@bridge do a barrel roll",
        }),
      );
      advance(6_000);
    }
    expect(inner.helpedThreads.size).toBeLessThanOrEqual(1_000);
  });
});

/** Mirrors COOLDOWN_MS in src/query-responder.ts (§6). */
const COOLDOWN_WINDOW_MS = 5_000;

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
    // `since` is NOT baked into the filter: it is supplied as a cursor callback
    // so BuzzClient recomputes `cursor − 300` on every resubscribe after a
    // reconnect (§2). A static `since` replays an ever-growing window.
    expect(filter.since).toBeUndefined();
    const since = buzz.subs[0]!.since;
    expect(since).toBeTypeOf("function");
    // BuzzClient subtracts the 300s skew itself.
    expect(since!() - 300).toBe(NOW_SEC - 300);
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
