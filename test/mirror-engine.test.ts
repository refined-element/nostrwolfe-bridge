/**
 * MirrorEngine + ListingCache tests (spec §5).
 *
 * Covers: validation (§5 step 1), the full dedupe/replace decision table
 * (§5 step 3) including the same-second lowest-id tie-break in both
 * directions, and golden card snapshots (§5 step 4) with the injection
 * defenses from Security §2.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { FrameTooLargeError } from "../src/buzz-client.js";
import { ListingCache } from "../src/listing-cache.js";
import {
  CardPublishError,
  MirrorEngine,
  formatCard,
  parseListing,
} from "../src/mirror-engine.js";
import type {
  BridgeState,
  Config,
  EventHandler,
  IBuzzClient,
  IStateStore,
  NostrEvent,
  NostrFilter,
  NostrTag,
  OkResult,
  ParsedListing,
  Subscription,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed key so the golden cards carry a stable npub. */
const SK = new Uint8Array(32).fill(7);
const PK = getPublicKey(SK);
const NPUB = "npub1nzwqkakt2cuhrlwfhme3asrvx4s0xfyadm57tkpu2a39t9hqtahs7fsn89";
/** How the card renders the provider: a middle-elided npub. */
const NPUB_SHORT = `${NPUB.slice(0, 12)}…${NPUB.slice(-6)}`;
const T0 = 1_753_280_000;

function sign(tags: NostrTag[], content = "", createdAt = T0): NostrEvent {
  return finalizeEvent(
    { kind: 38400, created_at: createdAt, tags, content },
    SK,
  ) as unknown as NostrEvent;
}

/** The NIP's full kind:38400 example (nips/agent-service-agreements.md). */
function fullListingEvent(createdAt = T0): NostrEvent {
  return sign(
    [
      ["d", "image-generation"],
      ["s", "image-generation"],
      ["s", "ai"],
      ["price", "50", "sats", "per-request"],
      ["price", "200", "sats", "batch-10"],
      ["l402", "https://agent.example.com/v1/generate"],
      ["endpoint", "https://agent.example.com/v1/generate", "POST"],
      ["schema", "https://agent.example.com/v1/schema.json"],
      ["capacity", "100", "requests/hour"],
      ["uptime", "0.997"],
      ["t", "image"],
      ["t", "flux"],
      ["negotiable", "true"],
    ],
    "High-quality image generation using Flux. Supports PNG, WEBP, SVG.",
    createdAt,
  );
}

function simpleListing(
  d: string,
  categories: string[],
  createdAt: number,
  content = "",
): NostrEvent {
  return sign(
    [
      ["d", d],
      ...categories.map((c): NostrTag => ["s", c]),
      ["price", "50", "sats", "per-request"],
    ],
    content,
    createdAt,
  );
}

function parse(event: NostrEvent): ParsedListing {
  const listing = parseListing(event);
  if (!listing) throw new Error("fixture failed validation");
  return listing;
}

/**
 * A real sats4ai-style non-NIP-A5 listing: no `s`/`price` tags, a JSON blob
 * body, priced in prose via `pricing`, categorized via `category`/`subcategory`.
 * Strict NIP parsing returns null; only the dialect adapter can render it.
 * Signed with SK so `verifyEvent` inside the engine passes.
 */
function dialectListing(
  d = "sats4ai-deblur-image",
  createdAt = T0,
): NostrEvent {
  return sign(
    [
      ["d", d],
      ["name", "Image Deblurring"],
      [
        "description",
        "Remove motion blur and defocus from images. Restores sharpness.",
      ],
      ["category", "ai"],
      ["subcategory", "image-processing"],
      ["endpoint", "https://sats4ai.com/api/l402/deblur-image"],
      ["method", "POST"],
      ["pricing", "10 sats"],
      ["protocol", "L402"],
      ["provider", "Sats4AI"],
      ["website", "https://sats4ai.com"],
    ],
    JSON.stringify({
      name: "Image Deblurring",
      description:
        "Remove motion blur and defocus from images. Restores sharpness.",
      endpoint: "https://sats4ai.com/api/l402/deblur-image",
      pricing: "10 sats",
      category: "ai",
    }),
    createdAt,
  );
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeBuzz implements IBuzzClient {
  readonly published: NostrEvent[] = [];
  ok = true;
  message = "";
  /** When set, publish rejects with a FrameTooLargeError of this size. */
  frameTooLargeBytes: number | null = null;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  publish(event: NostrEvent): Promise<OkResult> {
    if (this.frameTooLargeBytes !== null) {
      return Promise.reject(new FrameTooLargeError(this.frameTooLargeBytes));
    }
    this.published.push(event);
    return Promise.resolve({
      id: event.id,
      ok: this.ok,
      message: this.message,
    });
  }
  subscribe(subId: string, _f: NostrFilter[], _cb: EventHandler): Subscription {
    return { id: subId, close: () => undefined };
  }
  query(): Promise<NostrEvent[]> {
    return Promise.resolve([]);
  }
  close(): void {}
  get contents(): string[] {
    return this.published.map((e) => e.content);
  }
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
  reset(community: string): void {
    this.state = {
      version: 1,
      community,
      channelId: null,
      cursors: { wolfe: 0, buzz: 0 },
      mirrored: {},
    };
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    bridgeNsec: Buffer.from(SK).toString("hex"),
    buzzRelayUrl: "ws://localhost:3000",
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
    ...overrides,
  };
}

interface Harness {
  engine: MirrorEngine;
  buzz: FakeBuzz;
  cache: ListingCache;
  state: FakeState;
}

function harness(overrides: Partial<Config> = {}, now?: () => number): Harness {
  const buzz = new FakeBuzz();
  const cache = new ListingCache();
  const state = new FakeState();
  const engine = new MirrorEngine(
    makeConfig(overrides),
    buzz,
    cache,
    state,
    () => "chan-uuid",
    now,
  );
  return { engine, buzz, cache, state };
}

// ---------------------------------------------------------------------------
// §5 step 1 — validation
// ---------------------------------------------------------------------------

describe("parseListing (§5 step 1 validate)", () => {
  it("parses every tag the NIP defines", () => {
    const listing = parse(fullListingEvent());
    expect(listing.address).toBe(`38400:${PK}:image-generation`);
    expect(listing.s).toEqual(["image-generation", "ai"]);
    expect(listing.prices).toEqual([
      { amount: "50", currency: "sats", frequency: "per-request" },
      { amount: "200", currency: "sats", frequency: "batch-10" },
    ]);
    expect(listing.l402).toBe("https://agent.example.com/v1/generate");
    expect(listing.endpoint).toEqual({
      url: "https://agent.example.com/v1/generate",
      method: "POST",
    });
    expect(listing.schema).toBe("https://agent.example.com/v1/schema.json");
    expect(listing.capacity).toBe("100 requests/hour");
    expect(listing.uptime).toBe("0.997");
    expect(listing.t).toEqual(["image", "flux"]);
    expect(listing.negotiable).toEqual({ kind: "yes" });
  });

  it("rejects a tampered signature — never trust an open relay", () => {
    const event = fullListingEvent();
    expect(parseListing({ ...event, content: "rewritten" })).toBeNull();
  });

  it("rejects missing required tags (d, >=1 s, price)", () => {
    expect(
      parseListing(
        sign([
          ["s", "ai"],
          ["price", "1", "sats"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseListing(
        sign([
          ["d", "x"],
          ["s", ""],
          ["price", "1", "sats"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseListing(
        sign([
          ["d", "x"],
          ["price", "1", "sats"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseListing(
        sign([
          ["d", "x"],
          ["s", "ai"],
        ]),
      ),
    ).toBeNull();
    expect(
      parseListing(
        sign([
          ["d", ""],
          ["s", "ai"],
          ["price", "1", "sats"],
        ]),
      ),
    ).toBeNull();
    // A bare `["price"]` tag carries no amount and does not satisfy the NIP.
    expect(parseListing(sign([["d", "x"], ["s", "ai"], ["price"]]))).toBeNull();
  });

  it("rejects a non-38400 kind", () => {
    const event = finalizeEvent(
      { kind: 1, created_at: T0, tags: [["d", "x"]], content: "" },
      SK,
    ) as unknown as NostrEvent;
    expect(parseListing(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 step 4 — golden cards
// ---------------------------------------------------------------------------

describe("formatCard golden snapshots (§5 step 4)", () => {
  it("renders a new-listing card", () => {
    expect(formatCard(parse(fullListingEvent()), "new")).toBe(
      [
        "🐺 New service: image-generation",
        "High-quality image generation using Flux. Supports PNG, WEBP, SVG.",
        "Categories: image-generation, ai  ·  Tags: #image #flux",
        "Price: 50 sats per-request · 200 sats batch-10  ·  Negotiable: yes",
        "Endpoint: https://agent.example.com/v1/generate",
        "Uptime: 99.7%  ·  Capacity: 100 requests/hour",
        `Provider: ${NPUB_SHORT}`,
        "─",
        `nw:38400:${PK}:image-generation`,
      ].join("\n"),
    );
  });

  it("renders an updated card identical to the new card but for the header", () => {
    const listing = parse(fullListingEvent());
    const newCard = formatCard(listing, "new");
    const updated = formatCard(listing, "updated");
    expect(updated).toBe(
      [
        "🐺 Updated: image-generation",
        "High-quality image generation using Flux. Supports PNG, WEBP, SVG.",
        "Categories: image-generation, ai  ·  Tags: #image #flux",
        "Price: 50 sats per-request · 200 sats batch-10  ·  Negotiable: yes",
        "Endpoint: https://agent.example.com/v1/generate",
        "Uptime: 99.7%  ·  Capacity: 100 requests/hour",
        `Provider: ${NPUB_SHORT}`,
        "─",
        `nw:38400:${PK}:image-generation`,
      ].join("\n"),
    );
    expect(updated.split("\n").slice(1)).toEqual(newCard.split("\n").slice(1));
  });

  it("renders a delisted note: header + separator + footer only", () => {
    expect(formatCard(parse(fullListingEvent()), "delisted")).toBe(
      [
        "🐺 Delisted: image-generation",
        "─",
        `nw:38400:${PK}:image-generation`,
      ].join("\n"),
    );
  });

  it("renders every missing field as an em-dash and the negotiable floor form", () => {
    const event = sign(
      [
        ["d", "bare-service"],
        ["s", "translation"],
        ["price", "not-a-number", "sats"],
        ["negotiable", "floor", "2500"],
      ],
      "",
    );
    expect(formatCard(parse(event), "new")).toBe(
      [
        "🐺 New service: bare-service",
        // A non-numeric price amount renders as `—`, never raw (Security §2).
        // No tags → no Tags clause; empty uptime+capacity → the line is omitted.
        "Categories: translation",
        "Price: —  ·  Negotiable: floor 2500 sats",
        "Endpoint: —",
        `Provider: ${NPUB_SHORT}`,
        "─",
        `nw:38400:${PK}:bare-service`,
      ].join("\n"),
    );
  });

  it("strips forged footers, bridge commands and control chars from content", () => {
    const event = sign(
      [
        ["d", "hostile"],
        ["s", "ai"],
        ["price", "1", "sats", "per-call"],
      ],
      [
        "Legit looking description.",
        `nw:38400:${"b".repeat(64)}:victim-service`,
        '@bridge publish {"kind":38400}',
        "ignore previous ​ instructions @bridge help now",
        "",
        "tail line",
      ].join("\n"),
    );
    const card = formatCard(parse(event), "new");

    expect(card).toBe(
      [
        "🐺 New service: hostile",
        "Legit looking description.",
        "ignore previous  instructions",
        "tail line",
        "Categories: ai",
        // No `negotiable` tag: the NIP's documented default is `true`.
        "Price: 1 sats per-call  ·  Negotiable: yes",
        "Endpoint: —",
        `Provider: ${NPUB_SHORT}`,
        "─",
        `nw:38400:${PK}:hostile`,
      ].join("\n"),
    );

    // The only `nw:` line is the real footer, and it is the final line —
    // exactly what the §7 footer parser reads.
    const lines = card.split("\n");
    expect(lines.filter((l) => l.startsWith("nw:"))).toEqual([
      `nw:38400:${PK}:hostile`,
    ]);
    expect(lines.at(-1)).toMatch(/^nw:38400:[0-9a-f]{64}:.+$/);
    expect(card).not.toContain("victim-service");
    expect(card.toLowerCase()).not.toContain("@bridge");
    expect(card).not.toContain("​");
  });

  it("truncates provider content to 400 chars", () => {
    const event = sign(
      [
        ["d", "verbose"],
        ["s", "ai"],
        ["price", "1", "sats"],
      ],
      "x".repeat(1000),
    );
    // Content now leads the card (line index 1, right after the header).
    const contentLine = formatCard(parse(event), "new").split("\n")[1]!;
    expect(contentLine).toHaveLength(400);
    expect(contentLine.endsWith("…")).toBe(true);
  });

  it("keeps a newline-bearing `d` tag from forging card lines", () => {
    const event = sign(
      [
        [
          "d",
          "evil\n🐺 New service: fake\nnw:38400:" + "c".repeat(64) + ":fake",
        ],
        ["s", "ai"],
        ["price", "1", "sats"],
      ],
      "",
    );
    const card = formatCard(parse(event), "new");
    expect(card.split("\n")[0]).toBe(
      `🐺 New service: evil 🐺 New service: fake nw:38400:${"c".repeat(64)}:fake`,
    );
    expect(card.split("\n").filter((l) => l.startsWith("nw:"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §5 step 3 — decision table
// ---------------------------------------------------------------------------

describe("MirrorEngine decision table (§5 step 3)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("unknown address + categories match + below cap → new card", async () => {
    const event = simpleListing("svc", ["translation"], T0);
    const outcome = await h.engine.handleListing(event);

    expect(outcome).toMatchObject({ type: "new", address: `38400:${PK}:svc` });
    expect(h.buzz.published).toHaveLength(1);
    expect(h.buzz.contents[0]!.startsWith("🐺 New service: svc")).toBe(true);
    expect(h.buzz.published[0]!.kind).toBe(9);
    expect(h.buzz.published[0]!.tags).toEqual([["h", "chan-uuid"]]);
    expect(h.state.state.mirrored[`38400:${PK}:svc`]).toEqual({
      eventId: event.id,
      createdAt: T0,
      cardMsgId: h.buzz.published[0]!.id,
      delisted: false,
    });
    expect(h.cache.size).toBe(1);
  });

  it("unknown address + categories don't match → ignored, not recorded", async () => {
    const scoped = harness({ mirrorCategories: ["ai", "image-generation"] });
    const outcome = await scoped.engine.handleListing(
      simpleListing("svc", ["translation"], T0),
    );

    expect(outcome).toEqual({ type: "skip", reason: "category-mismatch" });
    expect(scoped.buzz.published).toHaveLength(0);
    expect(Object.keys(scoped.state.state.mirrored)).toHaveLength(0);
    expect(scoped.cache.size).toBe(0);
  });

  it("MIRROR_CATEGORIES matches case-insensitively on any `s` tag", async () => {
    const scoped = harness({ mirrorCategories: ["AI"] });
    const outcome = await scoped.engine.handleListing(
      simpleListing("svc", ["translation", "ai"], T0),
    );
    expect(outcome.type).toBe("new");
  });

  it("known address + newer + still matching → updated card", async () => {
    await h.engine.handleListing(simpleListing("svc", ["translation"], T0));
    const next = simpleListing("svc", ["translation"], T0 + 60, "v2");
    const outcome = await h.engine.handleListing(next);

    expect(outcome).toMatchObject({ type: "update" });
    expect(h.buzz.contents[1]!.startsWith("🐺 Updated: svc")).toBe(true);
    expect(h.state.state.mirrored[`38400:${PK}:svc`]).toMatchObject({
      eventId: next.id,
      createdAt: T0 + 60,
      delisted: false,
    });
  });

  it("known address + newer + categories left the allowlist → delisted note", async () => {
    const scoped = harness({ mirrorCategories: ["translation"] });
    await scoped.engine.handleListing(
      simpleListing("svc", ["translation"], T0),
    );

    const exited = simpleListing("svc", ["image-generation"], T0 + 60);
    const outcome = await scoped.engine.handleListing(exited);

    expect(outcome).toMatchObject({ type: "delisted" });
    expect(scoped.buzz.contents[1]).toBe(
      ["🐺 Delisted: svc", "─", `nw:38400:${PK}:svc`].join("\n"),
    );
    // Stays in `mirrored` for dedupe, leaves the search cache.
    expect(scoped.state.state.mirrored[`38400:${PK}:svc`]).toMatchObject({
      createdAt: T0 + 60,
      delisted: true,
    });
    expect(scoped.cache.has(`38400:${PK}:svc`)).toBe(false);
  });

  it("a delisted address flips back to an updated card when it matches again", async () => {
    const scoped = harness({ mirrorCategories: ["translation"] });
    await scoped.engine.handleListing(
      simpleListing("svc", ["translation"], T0),
    );
    await scoped.engine.handleListing(simpleListing("svc", ["other"], T0 + 60));
    const back = simpleListing("svc", ["translation"], T0 + 120);
    const outcome = await scoped.engine.handleListing(back);

    expect(outcome).toMatchObject({ type: "update" });
    expect(scoped.buzz.contents[2]!.startsWith("🐺 Updated: svc")).toBe(true);
    expect(scoped.state.state.mirrored[`38400:${PK}:svc`]!.delisted).toBe(
      false,
    );
    expect(scoped.cache.has(`38400:${PK}:svc`)).toBe(true);
  });

  it("same created_at + lower incoming id → NIP-33 replacement (update)", async () => {
    const [low, high] = sameSecondPair();
    await h.engine.handleListing(high);
    const outcome = await h.engine.handleListing(low);

    expect(outcome).toMatchObject({ type: "update" });
    expect(h.buzz.contents[1]!.startsWith("🐺 Updated: tie")).toBe(true);
    expect(h.state.state.mirrored[`38400:${PK}:tie`]!.eventId).toBe(low.id);
  });

  it("same created_at + higher incoming id → skip", async () => {
    const [low, high] = sameSecondPair();
    await h.engine.handleListing(low);
    const outcome = await h.engine.handleListing(high);

    expect(outcome).toEqual({
      type: "skip",
      reason: "duplicate",
      address: `38400:${PK}:tie`,
    });
    expect(h.buzz.published).toHaveLength(1);
    expect(h.state.state.mirrored[`38400:${PK}:tie`]!.eventId).toBe(low.id);
  });

  it("same created_at + identical id → skip", async () => {
    const event = simpleListing("svc", ["translation"], T0);
    await h.engine.handleListing(event);
    const outcome = await h.engine.handleListing(event);

    expect(outcome).toEqual({
      type: "skip",
      reason: "duplicate",
      address: `38400:${PK}:svc`,
    });
    expect(h.buzz.published).toHaveLength(1);
  });

  it("older created_at (relay replay / out-of-order) → skip", async () => {
    await h.engine.handleListing(
      simpleListing("svc", ["translation"], T0 + 60),
    );
    const outcome = await h.engine.handleListing(
      simpleListing("svc", ["translation"], T0),
    );

    expect(outcome).toEqual({
      type: "skip",
      reason: "out-of-order",
      address: `38400:${PK}:svc`,
    });
    expect(h.buzz.published).toHaveLength(1);
    expect(h.state.state.mirrored[`38400:${PK}:svc`]!.createdAt).toBe(T0 + 60);
  });

  it("unknown address at MIRROR_MAX_LISTINGS → skip + no card (no eviction)", async () => {
    const capped = harness({ mirrorMaxListings: 2 });
    await capped.engine.handleListing(simpleListing("a", ["translation"], T0));
    await capped.engine.handleListing(simpleListing("b", ["translation"], T0));
    const outcome = await capped.engine.handleListing(
      simpleListing("c", ["translation"], T0),
    );

    expect(outcome).toEqual({ type: "skip", reason: "at-cap" });
    expect(capped.buzz.published).toHaveLength(2);
    expect(capped.cache.size).toBe(2);
    // Existing addresses still update at cap.
    const update = await capped.engine.handleListing(
      simpleListing("a", ["translation"], T0 + 60),
    );
    expect(update.type).toBe("update");
  });

  it("invalid events are dropped before any decision is taken", async () => {
    const tampered = { ...fullListingEvent(), content: "rewritten" };
    const outcome = await h.engine.handleListing(tampered);

    expect(outcome).toEqual({ type: "skip", reason: "invalid" });
    expect(h.buzz.published).toHaveLength(0);
    expect(h.state.state.cursors.wolfe).toBe(0);
  });

  it("a footer-recovered entry (createdAt 0) posts an updated card, not a new one", async () => {
    // §7: recovery leaves `createdAt` unknown → 0, bounding post-state-loss
    // duplicate spam to one "updated" card per listing.
    h.state.state.mirrored[`38400:${PK}:svc`] = {
      eventId: "",
      createdAt: 0,
      cardMsgId: "recovered",
      delisted: false,
    };
    const outcome = await h.engine.handleListing(
      simpleListing("svc", ["translation"], T0),
    );

    expect(outcome).toMatchObject({ type: "update" });
    expect(h.buzz.contents[0]!.startsWith("🐺 Updated: svc")).toBe(true);
  });

  it("advances the wolfe cursor to the max created_at processed, including skips", async () => {
    await h.engine.handleListing(simpleListing("svc", ["translation"], T0));
    expect(h.state.state.cursors.wolfe).toBe(T0);

    // A duplicate still moves the cursor forward is not applicable (same ts),
    // but an out-of-order replay must never move it backwards.
    await h.engine.handleListing(
      simpleListing("svc", ["translation"], T0 - 500),
    );
    expect(h.state.state.cursors.wolfe).toBe(T0);

    await h.engine.handleListing(
      simpleListing("other", ["translation"], T0 + 90),
    );
    expect(h.state.state.cursors.wolfe).toBe(T0 + 90);
  });

  it("does not record the address when the relay rejects the card", async () => {
    h.buzz.ok = false;
    h.buzz.message = "invalid: channel not found";

    await expect(
      h.engine.handleListing(simpleListing("svc", ["translation"], T0)),
    ).rejects.toBeInstanceOf(CardPublishError);
    expect(Object.keys(h.state.state.mirrored)).toHaveLength(0);
    expect(h.cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dialect path THROUGH the engine (test-analyzer H-3)
// ---------------------------------------------------------------------------

describe("dialect listings through MirrorEngine.handleListing", () => {
  it("mirrorAcceptDialects:true → a new card marked non-standard", async () => {
    const h = harness({ mirrorAcceptDialects: true });
    const event = dialectListing();

    const outcome = await h.engine.handleListing(event);

    expect(outcome).toMatchObject({
      type: "new",
      address: `38400:${PK}:sats4ai-deblur-image`,
    });
    expect(h.buzz.published).toHaveLength(1);
    const card = h.buzz.contents[0]!;
    // The dialect marker proves this went through the adapter, not strict NIP.
    expect(card).toContain("Format: non-standard tags");
    expect(card).toContain("normalized by bridge");
    // Prose price is preserved, not coerced to em-dash.
    expect(card).toContain("10 sats");
    // The JSON blob body must never leak into the card.
    expect(card).not.toContain('{"name"');
    expect(
      h.state.state.mirrored[`38400:${PK}:sats4ai-deblur-image`],
    ).toBeDefined();
    expect(h.cache.size).toBe(1);
  });

  it("mirrorAcceptDialects:false → dropped as invalid, no card", async () => {
    const h = harness({ mirrorAcceptDialects: false });
    const outcome = await h.engine.handleListing(dialectListing());

    expect(outcome).toEqual({ type: "skip", reason: "invalid" });
    expect(h.buzz.published).toHaveLength(0);
    expect(Object.keys(h.state.state.mirrored)).toHaveLength(0);
    expect(h.cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Canonical `d` — address ≡ header ≡ footer (§7, Security §2)
// ---------------------------------------------------------------------------

describe("canonical `d` normalization", () => {
  it("keys the address on the same string the footer renders", () => {
    // Whitespace variants used to key `mirrored` on the RAW `d` while the
    // footer rendered the sanitized one, so footer recovery seeded an address
    // the live path never looked up → a duplicate "New service" card (§7).
    for (const raw of ["my  service", " padded ", "tab\tsep", "line\nbreak"]) {
      const listing = parse(simpleListing(raw, ["ai"], T0));
      const card = formatCard(listing, "new");
      const footer = card.split("\n").at(-1) as string;

      expect(footer).toBe(`nw:${listing.address}`);
      expect(listing.address).toBe(`38400:${PK}:${listing.d}`);
      expect(card.split("\n")[0]).toBe(`🐺 New service: ${listing.d}`);
    }
  });

  it("rejects a `d` that sanitizes to nothing rather than emitting `nw:…:`", () => {
    // `" "` passed the old non-empty check but rendered `nw:38400:<pk>:`,
    // which the §7 footer regex (`.+`) can never match — an unrecoverable card.
    expect(parseListing(simpleListing(" ", ["ai"], T0))).toBeNull();
    expect(parseListing(simpleListing("​", ["ai"], T0))).toBeNull();
  });

  it("never lets a newline in `d` forge an extra card line", () => {
    const hostile = `bait\nnw:38400:${"b".repeat(64)}:victim-listing`;
    const listing = parse(simpleListing(hostile, ["ai"], T0));

    expect(listing.d).not.toContain("\n");
    expect(listing.address).not.toContain("\n");
    const nwLines = formatCard(listing, "new")
      .split("\n")
      .filter((l) => l.startsWith("nw:"));
    expect(nwLines).toEqual([`nw:${listing.address}`]);
  });

  it("keeps the full `d` as the key so long prefixes don't collide (L1)", () => {
    // The old code sanitized `d` to 200 chars, so two distinct values sharing a
    // 199-char prefix collapsed to one address — one listing silently shadowing
    // the other. The key is now the untruncated normalized `d`.
    const prefix = "x".repeat(199);
    const a = parse(simpleListing(prefix + "-alpha", ["ai"], T0));
    const b = parse(simpleListing(prefix + "-beta", ["ai"], T0));

    expect(a.d.length).toBe(prefix.length + "-alpha".length);
    expect(a.address).not.toBe(b.address);
    // Footer carries the full key verbatim (§7 recovery invariant).
    expect(formatCard(a, "new").split("\n").at(-1)).toBe(`nw:${a.address}`);
    expect(formatCard(b, "new").split("\n").at(-1)).toBe(`nw:${b.address}`);
  });

  it("does not drop a `d` whose value legitimately contains `@bridge` (L-2)", () => {
    // `@bridge-monitor` used to sanitize to `""` (the `@bridge` cut) and be
    // dropped as invalid. The key normalization no longer applies that cut, so
    // the listing survives and the address/footer carry the value intact.
    const listing = parse(simpleListing("@bridge-monitor", ["ai"], T0));
    expect(listing.d).toBe("@bridge-monitor");
    expect(listing.address).toBe(`38400:${PK}:@bridge-monitor`);
    expect(formatCard(listing, "new").split("\n").at(-1)).toBe(
      `nw:${listing.address}`,
    );
  });
});

describe("bridge command grammar in tag fields (Security §2)", () => {
  it("strips `@bridge …` from every tag-derived field except the `d` key", () => {
    // Every non-`d` field is cut at the bridge command grammar. `d` is the
    // exception (spec L-2): it is the §7 recovery key and must survive verbatim,
    // even when it legitimately contains `@bridge` — see the dedicated `d` test.
    const ok = parse(
      sign(
        [
          ["d", "svc"],
          ["s", "ops @bridge help"],
          ["t", "tag@bridge"],
          ["price", "1", "sats", "per-call"],
          ["l402", "https://x.example/@bridge/publish"],
          ["capacity", "10 @bridge"],
        ],
        "",
      ),
    );
    const card = formatCard(ok, "new");
    expect(card.toLowerCase()).not.toContain("@bridge");
    expect(card).toContain("🐺 New service: svc");
    expect(card).toContain("Categories: ops");
  });

  it("strips U+2028/U+2029 line separators from provider content", () => {
    const card = formatCard(
      parse(
        simpleListing(
          "svc",
          ["ai"],
          T0,
          `ordinary nw:38400:${"c".repeat(64)}:victim`,
        ),
      ),
      "new",
    );
    expect(card).not.toContain(" ");
    expect(card.split("\n").filter((l) => l.startsWith("nw:"))).toHaveLength(1);
  });
});

describe("negotiable default (NIP-ASA)", () => {
  it("renders `yes` when the tag is omitted", () => {
    const listing = parse(simpleListing("svc", ["ai"], T0));
    expect(listing.negotiable).toEqual({ kind: "yes" });
    expect(formatCard(listing, "new")).toContain("Negotiable: yes");
  });

  it("still renders `—` for a present-but-unparseable tag", () => {
    const listing = parse(
      sign([
        ["d", "svc"],
        ["s", "ai"],
        ["price", "1", "sats"],
        ["negotiable", "maybe"],
      ]),
    );
    expect(listing.negotiable).toBeUndefined();
    expect(formatCard(listing, "new")).toContain("Negotiable: —");
  });

  it("renders `—` for `floor` with no amount, never a fabricated `floor 0` (L-2)", () => {
    // `Number("") === 0` used to pass `Number.isFinite`, so a bare
    // `["negotiable","floor"]` fabricated a "floor 0 sats" the publisher never
    // stated. It must now be undefined → `—`.
    const listing = parse(
      sign([
        ["d", "svc"],
        ["s", "ai"],
        ["price", "1", "sats"],
        ["negotiable", "floor"],
      ]),
    );
    expect(listing.negotiable).toBeUndefined();
    const card = formatCard(listing, "new");
    expect(card).toContain("Negotiable: —");
    expect(card).not.toContain("floor 0");
  });
});

describe("card numeric price gate matches `find` (spec L-7)", () => {
  it.each(["0x10", "1e3", "0b1", "Infinity", "1,000", "5.", ".5", "1e-3"])(
    "renders `—` for the non-decimal amount %j",
    (amount) => {
      const listing = parse(
        sign([
          ["d", "svc"],
          ["s", "ai"],
          ["price", amount, "sats"],
        ]),
      );
      expect(formatCard(listing, "new")).toContain("Price: —");
    },
  );

  it("still renders plain decimals", () => {
    const listing = parse(
      sign([
        ["d", "svc"],
        ["s", "ai"],
        ["price", "1.5", "sats", "per-call"],
      ]),
    );
    expect(formatCard(listing, "new")).toContain("Price: 1.5 sats per-call");
  });
});

describe("future-timestamp cursor poisoning (security H-1)", () => {
  const NOW = T0 + 1_000;
  const clock = () => NOW;

  it("drops a 38400 dated past now + skew and leaves the cursor untouched", async () => {
    const h = harness({}, clock);
    const far = simpleListing("evil", ["ai"], NOW + 10 * 365 * 24 * 3600);

    const outcome = await h.engine.handleListing(far);

    expect(outcome).toEqual({ type: "skip", reason: "invalid" });
    expect(h.buzz.published).toHaveLength(0);
    expect(h.state.state.cursors.wolfe).toBe(0);
  });

  it("accepts an event within the skew window", async () => {
    const h = harness({}, clock);
    const edge = simpleListing("ok", ["ai"], NOW + 200); // < NOW + 300
    const outcome = await h.engine.handleListing(edge);
    expect(outcome.type).toBe("new");
    expect(h.state.state.cursors.wolfe).toBe(NOW + 200);
  });

  it("clamps the cursor to now + skew even if a listing slips through", async () => {
    // advanceCursor is clamped independently of parseListing's drop, so a
    // cursor can never be pushed past real time (`since = cursor − 300`).
    const h = harness({}, clock);
    // Directly exercise the clamp: a poison created_at inside a listing that
    // parseListing would drop is covered above; here we assert the ceiling.
    await h.engine.handleListing(simpleListing("a", ["ai"], NOW));
    expect(h.state.state.cursors.wolfe).toBe(NOW);
    expect(h.state.state.cursors.wolfe).toBeLessThanOrEqual(NOW + 300);
  });
});

describe("cache repopulation on a normal restart (C-1 / H1)", () => {
  it("rehydrates the search cache from replayed events with intact state", async () => {
    // Simulate a restart: the state file already records the listing (as the
    // live path would leave it), the in-memory cache starts empty, then
    // hydration replays the SAME event. Before the fix this hit the duplicate
    // skip and left the cache empty forever.
    const h = harness();
    const event = simpleListing("svc", ["translation"], T0, "v1");

    h.state.state.mirrored[`38400:${PK}:svc`] = {
      eventId: event.id,
      createdAt: T0,
      cardMsgId: "prior-card",
      delisted: false,
    };
    expect(h.cache.size).toBe(0);

    const outcome = await h.engine.handleListing(event);

    // Same-timestamp, identical id → duplicate skip, no new card...
    expect(outcome).toEqual({
      type: "skip",
      reason: "duplicate",
      address: `38400:${PK}:svc`,
    });
    expect(h.buzz.published).toHaveLength(0);
    // ...but the cache is now populated so `find` works and the cap counts it.
    expect(h.cache.size).toBe(1);
    expect(h.cache.get(`38400:${PK}:svc`)?.content).toBe("v1");
  });

  it("an out-of-order replay seeds an empty slot but never clobbers a newer one", async () => {
    const h = harness();
    // Cache already holds the current (newer) version.
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0 + 60, "new"));
    expect(h.cache.get(`38400:${PK}:svc`)?.content).toBe("new");

    // An older replay must not overwrite it.
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0, "old"));
    expect(h.cache.get(`38400:${PK}:svc`)?.content).toBe("new");
  });

  it("does not repopulate the cache for a delisted tombstone", async () => {
    const scoped = harness({ mirrorCategories: ["translation"] });
    // Record then delist svc (category exit) → tombstone, cache cleared.
    await scoped.engine.handleListing(
      simpleListing("svc", ["translation"], T0),
    );
    await scoped.engine.handleListing(simpleListing("svc", ["other"], T0 + 60));
    expect(scoped.cache.has(`38400:${PK}:svc`)).toBe(false);

    // A replay of the delisting event (same ts, same id) must not re-cache it.
    await scoped.engine.handleListing(simpleListing("svc", ["other"], T0 + 60));
    expect(scoped.cache.has(`38400:${PK}:svc`)).toBe(false);
  });
});

describe("card is bounded by tag COUNT, not just width (security L-3/M-1)", () => {
  it("caps prices/categories/hashtags so a many-tag listing stays under the frame", async () => {
    const tags: NostrTag[] = [["d", "huge"]];
    for (let i = 0; i < 5_000; i++) {
      tags.push(["s", `cat-${i}`]);
      tags.push(["t", `tag-${i}`]);
      tags.push(["price", String(i + 1), "sats", "per-call"]);
    }
    const event = sign(tags, "x".repeat(2_000), T0);
    const listing = parse(event);

    const card = formatCard(listing, "new");
    // A `["EVENT", event]` frame of the kind:9 card must fit the WS frame cap.
    const frameBytes = Buffer.byteLength(
      JSON.stringify(["EVENT", { content: card }]),
      "utf8",
    );
    expect(frameBytes).toBeLessThan(65_536);
    // The overflow markers are present (prices/categories/hashtags all capped).
    expect(card).toMatch(/\+\d+ more/);

    // And the whole thing still posts + advances the cursor.
    const h = harness();
    const outcome = await h.engine.handleListing(event);
    expect(outcome.type).toBe("new");
    expect(h.state.state.cursors.wolfe).toBe(T0);
  });

  it("advances the cursor past a card the relay deems oversized", async () => {
    // Defense in depth: even if a card still exceeds the frame, the poison
    // event must not wedge the live sub — the cursor advances past it.
    const h = harness();
    h.buzz.frameTooLargeBytes = 70_000;

    await expect(
      h.engine.handleListing(simpleListing("svc", ["ai"], T0)),
    ).rejects.toBeInstanceOf(FrameTooLargeError);

    expect(h.state.state.cursors.wolfe).toBe(T0);
    expect(Object.keys(h.state.state.mirrored)).toHaveLength(0);
  });
});

describe("mirrored map is bounded (security M-1)", () => {
  it("measures the cap against `mirrored`, not `cache.size` (M-1)", async () => {
    // cap 3, tombstone budget = floor(3/2) = 1. Three live addresses, then
    // delist exactly one (→ deleted from cache, kept in `mirrored` as the one
    // allowed tombstone). `mirrored` count is still 3 but `cache.size` is 2, so
    // the OLD cache-size cap would wrongly admit a 4th address.
    const scoped = harness({
      mirrorCategories: ["keep"],
      mirrorMaxListings: 3,
    });

    for (const d of ["a", "b", "c"]) {
      await scoped.engine.handleListing(simpleListing(d, ["keep"], T0));
    }
    await scoped.engine.handleListing(simpleListing("a", ["gone"], T0 + 60));

    expect(scoped.cache.size).toBe(2); // a left the cache...
    expect(Object.keys(scoped.state.state.mirrored)).toHaveLength(3); // ...but not `mirrored`.

    const outcome = await scoped.engine.handleListing(
      simpleListing("d", ["keep"], T0),
    );
    expect(outcome).toEqual({ type: "skip", reason: "at-cap" });
  });

  it("prunes the oldest delisted tombstones beyond the delisted budget", async () => {
    // cap 4 → delisted budget = floor(4/2) = 2. Delist 5 distinct addresses
    // (each recorded live first, at successively newer timestamps), then assert
    // only the 2 newest tombstones survive.
    const scoped = harness({
      mirrorCategories: ["keep"],
      mirrorMaxListings: 4,
    });

    const ds = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < ds.length; i++) {
      // Record live one at a time under the cap (delist frees the cache slot,
      // and the mirrored cap counts tombstones — so we delist before the next).
      await scoped.engine.handleListing(
        simpleListing(ds[i]!, ["keep"], T0 + i),
      );
      await scoped.engine.handleListing(
        simpleListing(ds[i]!, ["gone"], T0 + 100 + i),
      );
    }

    const tombstones = Object.entries(scoped.state.state.mirrored).filter(
      ([, e]) => e.delisted,
    );
    expect(tombstones).toHaveLength(2);
    // The two newest by createdAt survive (d @ T0+103, e @ T0+104).
    const survivors = tombstones.map(([addr]) => addr).sort();
    expect(survivors).toEqual([`38400:${PK}:d`, `38400:${PK}:e`].sort());
  });
});

describe("cursor advances only on a terminal outcome (§4)", () => {
  it("leaves the cursor untouched when the card publish is rejected", async () => {
    const h = harness();
    h.buzz.ok = false;
    h.buzz.message = "rate-limited: quota exceeded; retry in 5s";

    await expect(
      h.engine.handleListing(simpleListing("svc", ["ai"], T0)),
    ).rejects.toBeInstanceOf(CardPublishError);

    // Advancing here would put the event behind `since = cursor − 300`, so the
    // live sub would never redeliver it and the listing is lost until restart.
    expect(h.state.state.cursors.wolfe).toBe(0);
  });

  it("advances the cursor on a successful post and on a genuine skip", async () => {
    const h = harness({ mirrorCategories: ["translation"] });
    await h.engine.handleListing(simpleListing("a", ["translation"], T0));
    expect(h.state.state.cursors.wolfe).toBe(T0);

    await h.engine.handleListing(simpleListing("b", ["imaging"], T0 + 5));
    expect(h.state.state.cursors.wolfe).toBe(T0 + 5);
  });
});

/**
 * Two same-second events for one address, returned as `[lowerId, higherId]` —
 * the input to the NIP-33 lowest-id-wins tie-break in both directions.
 */
function sameSecondPair(): [NostrEvent, NostrEvent] {
  const a = simpleListing("tie", ["translation"], T0, "variant-a");
  const b = simpleListing("tie", ["translation"], T0, "variant-b");
  return a.id < b.id ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// ListingCache
// ---------------------------------------------------------------------------

describe("ListingCache", () => {
  it("keeps the latest listing per address", () => {
    const cache = new ListingCache();
    const first = parse(simpleListing("svc", ["ai"], T0));
    const second = parse(simpleListing("svc", ["ai"], T0 + 1));

    cache.set(first.address, first);
    expect(cache.size).toBe(1);
    cache.set(second.address, second);
    expect(cache.size).toBe(1);
    expect(cache.get(second.address)?.createdAt).toBe(T0 + 1);
    expect(cache.all()).toHaveLength(1);
    expect(cache.has(second.address)).toBe(true);
    expect(cache.delete(second.address)).toBe(true);
    expect(cache.delete(second.address)).toBe(false);
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Listing lifecycle — pause / remove / expire (§3a-c) and NIP-09 deletion (§3b)
// ---------------------------------------------------------------------------

/** A second identity, for cross-author deletion tests. */
const SK2 = new Uint8Array(32).fill(9);
const PK2 = getPublicKey(SK2);

/** A 38400 carrying a `status` tag (§3a). */
function statusListing(
  d: string,
  categories: string[],
  status: string,
  createdAt: number,
): NostrEvent {
  return sign(
    [
      ["d", d],
      ...categories.map((c): NostrTag => ["s", c]),
      ["price", "50", "sats", "per-request"],
      ["status", status],
    ],
    "",
    createdAt,
  );
}

/** A 38400 carrying a NIP-40 `expiration` tag (§3c). */
function expiringListing(
  d: string,
  categories: string[],
  expiration: number,
  createdAt: number,
): NostrEvent {
  return sign(
    [
      ["d", d],
      ...categories.map((c): NostrTag => ["s", c]),
      ["price", "50", "sats", "per-request"],
      ["expiration", String(expiration)],
    ],
    "",
    createdAt,
  );
}

/** A NIP-09 kind:5 deletion referencing `coord`, signed by `sk` (default SK). */
function deletionEvent(
  coord: string,
  createdAt: number,
  sk: Uint8Array = SK,
): NostrEvent {
  return finalizeEvent(
    { kind: 5, created_at: createdAt, tags: [["a", coord]], content: "" },
    sk,
  ) as unknown as NostrEvent;
}

describe("formatCard lifecycle notes (§3a-c)", () => {
  it("renders paused / removed / expired as header + separator + footer only", () => {
    const listing = parse(fullListingEvent());
    for (const kind of ["paused", "removed", "expired"] as const) {
      const header = {
        paused: "Paused",
        removed: "Removed",
        expired: "Expired",
      }[kind];
      expect(formatCard(listing, kind)).toBe(
        [
          `🐺 ${header}: image-generation`,
          "─",
          `nw:38400:${PK}:image-generation`,
        ].join("\n"),
      );
    }
  });
});

describe("parseListing lifecycle tags (§3a, §3c)", () => {
  it("parses status:inactive and status:removed, ignoring active/unknown", () => {
    expect(parse(statusListing("a", ["ai"], "inactive", T0)).status).toBe(
      "inactive",
    );
    expect(parse(statusListing("b", ["ai"], "removed", T0)).status).toBe(
      "removed",
    );
    // active / unrecognized → undefined (treated active); never hides a listing.
    expect(
      parse(statusListing("c", ["ai"], "active", T0)).status,
    ).toBeUndefined();
    expect(
      parse(statusListing("d", ["ai"], "bogus", T0)).status,
    ).toBeUndefined();
  });

  it("parses a numeric expiration and ignores a non-numeric one", () => {
    expect(
      parse(expiringListing("a", ["ai"], 1_760_000_000, T0)).expiration,
    ).toBe(1_760_000_000);
    const bad = sign(
      [
        ["d", "b"],
        ["s", "ai"],
        ["price", "50", "sats"],
        ["expiration", "soon"],
      ],
      "",
      T0,
    );
    expect(parse(bad).expiration).toBeUndefined();
  });
});

describe("MirrorEngine lifecycle — pause / remove / expire (§3a-c)", () => {
  const addr = `38400:${PK}:svc`;

  it("an active listing that becomes paused posts a Paused note and leaves the cache", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));
    expect(h.cache.has(addr)).toBe(true);

    const outcome = await h.engine.handleListing(
      statusListing("svc", ["ai"], "inactive", T0 + 60),
    );
    expect(outcome).toMatchObject({ type: "paused", address: addr });
    expect(h.buzz.contents.at(-1)!.startsWith("🐺 Paused: svc")).toBe(true);
    expect(h.cache.has(addr)).toBe(false);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(true);
  });

  it("a paused listing restores via a later active replacement (updated card)", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));
    await h.engine.handleListing(
      statusListing("svc", ["ai"], "inactive", T0 + 60),
    );

    const outcome = await h.engine.handleListing(
      simpleListing("svc", ["ai"], T0 + 120),
    );
    expect(outcome).toMatchObject({ type: "update", address: addr });
    expect(h.buzz.contents.at(-1)!.startsWith("🐺 Updated: svc")).toBe(true);
    expect(h.cache.has(addr)).toBe(true);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(false);
  });

  it("status:removed posts a Removed note and leaves the cache", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));

    const outcome = await h.engine.handleListing(
      statusListing("svc", ["ai"], "removed", T0 + 60),
    );
    expect(outcome).toMatchObject({ type: "removed", address: addr });
    expect(h.buzz.contents.at(-1)!.startsWith("🐺 Removed: svc")).toBe(true);
    expect(h.cache.has(addr)).toBe(false);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(true);
  });

  it("an expired (NIP-40) replacement posts an Expired note and leaves the cache", async () => {
    const now = () => T0 + 1000;
    const h = harness({}, now);
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));

    // expiration in the past relative to the injected clock.
    const outcome = await h.engine.handleListing(
      expiringListing("svc", ["ai"], T0 + 500, T0 + 60),
    );
    expect(outcome).toMatchObject({ type: "expired", address: addr });
    expect(h.buzz.contents.at(-1)!.startsWith("🐺 Expired: svc")).toBe(true);
    expect(h.cache.has(addr)).toBe(false);
  });

  it("a future expiration keeps the listing active", async () => {
    const now = () => T0 + 1000;
    const h = harness({}, now);
    const outcome = await h.engine.handleListing(
      expiringListing("svc", ["ai"], T0 + 100_000, T0),
    );
    expect(outcome).toMatchObject({ type: "new", address: addr });
    expect(h.cache.has(addr)).toBe(true);
  });

  it("an unknown listing that arrives already inactive posts nothing", async () => {
    const h = harness();
    const outcome = await h.engine.handleListing(
      statusListing("svc", ["ai"], "removed", T0),
    );
    expect(outcome).toEqual({
      type: "skip",
      reason: "not-active",
      address: addr,
    });
    expect(h.buzz.published).toHaveLength(0);
    expect(h.cache.size).toBe(0);
    expect(h.state.state.mirrored[addr]).toBeUndefined();
  });

  it("a replayed paused replacement posts no second note (idempotent)", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));
    const paused = statusListing("svc", ["ai"], "inactive", T0 + 60);
    await h.engine.handleListing(paused);
    const before = h.buzz.published.length;

    const outcome = await h.engine.handleListing(paused);
    expect(outcome).toMatchObject({ type: "skip" });
    expect(h.buzz.published.length).toBe(before);
  });

  it("a kind:5 and a status:removed replacement produce a single Removed card", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));

    await h.engine.handleListing(
      statusListing("svc", ["ai"], "removed", T0 + 60),
    );
    const removedCards = () =>
      h.buzz.contents.filter((c) => c.startsWith("🐺 Removed:")).length;
    expect(removedCards()).toBe(1);

    // The belt-and-suspenders kind:5 that follows is a no-op.
    const outcome = await h.engine.handleDeletion(deletionEvent(addr, T0 + 70));
    expect(outcome).toEqual([]);
    expect(removedCards()).toBe(1);
  });
});

describe("MirrorEngine NIP-09 deletion (§3b)", () => {
  const addr = `38400:${PK}:svc`;

  it("a kind:5 from the listing's author removes a live listing", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));

    const outcomes = await h.engine.handleDeletion(
      deletionEvent(addr, T0 + 60),
    );
    expect(outcomes).toEqual([
      { type: "removed", address: addr, cardMsgId: expect.any(String) },
    ]);
    expect(h.buzz.contents.at(-1)!.startsWith("🐺 Removed: svc")).toBe(true);
    expect(h.cache.has(addr)).toBe(false);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(true);
  });

  it("a kind:5 from a different key is ignored (no cross-author deletion)", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));

    // Signed by SK2 but referencing SK's listing address.
    const outcomes = await h.engine.handleDeletion(
      deletionEvent(addr, T0 + 60, SK2),
    );
    expect(outcomes).toEqual([]);
    expect(h.buzz.published).toHaveLength(1); // only the original "new" card
    expect(h.cache.has(addr)).toBe(true);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(false);
  });

  it("a replayed kind:5 is idempotent (no second Removed card)", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));
    await h.engine.handleDeletion(deletionEvent(addr, T0 + 60));
    const before = h.buzz.published.length;

    const outcomes = await h.engine.handleDeletion(
      deletionEvent(addr, T0 + 70),
    );
    expect(outcomes).toEqual([]);
    expect(h.buzz.published.length).toBe(before);
  });

  it("a kind:5 for an un-mirrored address is a no-op", async () => {
    const h = harness();
    const outcomes = await h.engine.handleDeletion(
      deletionEvent(`38400:${PK}:never-seen`, T0),
    );
    expect(outcomes).toEqual([]);
    expect(h.buzz.published).toHaveLength(0);
  });

  it("a kind:5 with a tampered signature is ignored", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));
    const forged = { ...deletionEvent(addr, T0 + 60), content: "tampered" };

    const outcomes = await h.engine.handleDeletion(forged);
    expect(outcomes).toEqual([]);
    expect(h.cache.has(addr)).toBe(true);
  });

  it("a later active republish restores a kind:5-removed listing", async () => {
    const h = harness();
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));
    await h.engine.handleDeletion(deletionEvent(addr, T0 + 10));
    expect(h.cache.has(addr)).toBe(false);

    const outcome = await h.engine.handleListing(
      simpleListing("svc", ["ai"], T0 + 60),
    );
    expect(outcome).toMatchObject({ type: "update", address: addr });
    expect(h.cache.has(addr)).toBe(true);
  });

  it("ignores a non-deletion event", async () => {
    const h = harness();
    expect(
      await h.engine.handleDeletion(simpleListing("svc", ["ai"], T0)),
    ).toEqual([]);
  });

  it("a kind:5 arriving before its 38400 tombstones the address, suppressing a stale New card", async () => {
    const h = harness();
    const addr = `38400:${PK}:svc`;
    // Hydration interleaves kinds newest-first, so the deletion (T0+60) can be
    // delivered before the active 38400 (T0) it retracts.
    const del = await h.engine.handleDeletion(deletionEvent(addr, T0 + 60));
    expect(del).toEqual([]); // nothing on the channel to take down
    expect(h.buzz.published).toHaveLength(0);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(true);

    // The stale active 38400 must NOT post a "New service" card.
    const outcome = await h.engine.handleListing(
      simpleListing("svc", ["ai"], T0),
    );
    expect(outcome).toMatchObject({ type: "skip" });
    expect(h.buzz.published).toHaveLength(0);
    expect(h.cache.has(addr)).toBe(false);
  });

  it("a stale kind:5 older than the live listing does not take it down", async () => {
    const h = harness();
    const addr = `38400:${PK}:svc`;
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0 + 100));

    const del = await h.engine.handleDeletion(deletionEvent(addr, T0 + 50));
    expect(del).toEqual([]);
    expect(h.buzz.contents.some((c) => c.startsWith("🐺 Removed:"))).toBe(
      false,
    );
    expect(h.cache.has(addr)).toBe(true);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(false);
  });

  it("honors a deletion whose a-tag pubkey is uppercase hex (self-deletion)", async () => {
    const h = harness();
    const addr = `38400:${PK}:svc`;
    await h.engine.handleListing(simpleListing("svc", ["ai"], T0));

    // SK signs the deletion (its pubkey is PK, lowercase); the coordinate writes
    // the pubkey uppercase — must still match and pass author binding.
    const del = deletionEvent(`38400:${PK.toUpperCase()}:svc`, T0 + 60, SK);
    const outcomes = await h.engine.handleDeletion(del);
    expect(outcomes).toEqual([
      { type: "removed", address: addr, cardMsgId: expect.any(String) },
    ]);
    expect(h.cache.has(addr)).toBe(false);
  });

  it("honors an e-tag deletion referencing the listing's event id (author-bound)", async () => {
    const h = harness();
    const addr = `38400:${PK}:svc`;
    const listing = simpleListing("svc", ["ai"], T0);
    await h.engine.handleListing(listing);

    const del = finalizeEvent(
      { kind: 5, created_at: T0 + 60, tags: [["e", listing.id]], content: "" },
      SK,
    ) as unknown as NostrEvent;
    const outcomes = await h.engine.handleDeletion(del);
    expect(outcomes).toEqual([
      { type: "removed", address: addr, cardMsgId: expect.any(String) },
    ]);
    expect(h.cache.has(addr)).toBe(false);
  });

  it("a flood of never-mirrored deletion tombstones cannot evict a genuine removal", async () => {
    // Small cap → delistedBudget = floor(6/2) = 3.
    const h = harness({ mirrorMaxListings: 6 });
    const victimAddr = `38400:${PK}:victim`;

    // Genuine removal: mirror, then kind:5-remove → posts a "Removed" card, so the
    // tombstone carries a real cardMsgId.
    await h.engine.handleListing(simpleListing("victim", ["ai"], T0));
    await h.engine.handleDeletion(deletionEvent(victimAddr, T0 + 10));
    expect(h.state.state.mirrored[victimAddr]!.cardMsgId).not.toBe("");

    // Attacker floods never-mirrored tombstones under their OWN key (author binding
    // only constrains the pubkey), each dated far in the future (newest).
    const flood = Array.from(
      { length: 10 },
      (_, i) => `38400:${PK2}:spam-${i}`,
    );
    const del = finalizeEvent(
      {
        kind: 5,
        created_at: T0 + 1000,
        tags: flood.map((a) => ["a", a]),
        content: "",
      },
      SK2,
    ) as unknown as NostrEvent;
    await h.engine.handleDeletion(del);

    // The genuine (carded) removal high-water mark survives the flood…
    expect(h.state.state.mirrored[victimAddr]).toBeDefined();
    expect(h.state.state.mirrored[victimAddr]!.delisted).toBe(true);
    // …so a replay of the victim's stale active 38400 still can't resurrect it.
    const outcome = await h.engine.handleListing(
      simpleListing("victim", ["ai"], T0),
    );
    expect(outcome).toMatchObject({ type: "skip" });
    expect(h.cache.has(victimAddr)).toBe(false);
  });

  it("ignores a cross-author e-tag deletion", async () => {
    const h = harness();
    const addr = `38400:${PK}:svc`;
    const listing = simpleListing("svc", ["ai"], T0);
    await h.engine.handleListing(listing);

    // SK2 references SK's listing event id — not its author, must be ignored.
    const del = finalizeEvent(
      { kind: 5, created_at: T0 + 60, tags: [["e", listing.id]], content: "" },
      SK2,
    ) as unknown as NostrEvent;
    expect(await h.engine.handleDeletion(del)).toEqual([]);
    expect(h.cache.has(addr)).toBe(true);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(false);
  });
});

describe("MirrorEngine expiration sweep (§3c)", () => {
  const addr = `38400:${PK}:svc`;

  it("takes down a listing that expires while mirrored", async () => {
    let clock = T0 + 1000;
    const h = harness({}, () => clock);
    // Mirrored active: expiration is still in the future at T0+1000.
    await h.engine.handleListing(expiringListing("svc", ["ai"], T0 + 2000, T0));
    expect(h.cache.has(addr)).toBe(true);

    // Clock advances past the expiration; the sweep takes it down.
    clock = T0 + 3000;
    const outcomes = await h.engine.sweepExpired();
    expect(outcomes).toEqual([
      { type: "expired", address: addr, cardMsgId: expect.any(String) },
    ]);
    expect(h.buzz.contents.at(-1)!.startsWith("🐺 Expired: svc")).toBe(true);
    expect(h.cache.has(addr)).toBe(false);
    expect(h.state.state.mirrored[addr]!.delisted).toBe(true);
  });

  it("is a no-op when nothing has expired, and idempotent once tombstoned", async () => {
    let clock = T0 + 1000;
    const h = harness({}, () => clock);
    await h.engine.handleListing(expiringListing("svc", ["ai"], T0 + 2000, T0));

    expect(await h.engine.sweepExpired()).toEqual([]); // not yet expired
    clock = T0 + 3000;
    expect(await h.engine.sweepExpired()).toHaveLength(1);
    const after = h.buzz.published.length;
    expect(await h.engine.sweepExpired()).toEqual([]); // already tombstoned
    expect(h.buzz.published.length).toBe(after);
  });
});
