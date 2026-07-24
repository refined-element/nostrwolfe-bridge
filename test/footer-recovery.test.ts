import { describe, expect, it } from "vitest";

import {
  FOOTER_RECOVERY_PAGE_SIZE,
  parseCardFooter,
  recoverMirroredFromChannel,
} from "../src/footer-recovery.js";
import type {
  EoseHandler,
  EventHandler,
  IBuzzClient,
  NostrEvent,
  NostrFilter,
  OkResult,
  Subscription,
} from "../src/types.js";

const BRIDGE = "a".repeat(64);
const OTHER = "b".repeat(64);
const CHANNEL = "11111111-2222-3333-4444-555555555555";

function hex(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function card(
  overrides: Partial<NostrEvent> & { content: string },
): NostrEvent {
  return {
    id: "id-" + Math.random().toString(16).slice(2),
    pubkey: BRIDGE,
    created_at: 1_753_280_000,
    kind: 9,
    tags: [["h", CHANNEL]],
    sig: "0".repeat(128),
    ...overrides,
  };
}

/** A full card body in the §5 shape, with the machine-readable footer last. */
function cardBody(
  header: string,
  d: string,
  pubkey: string,
  extra: string[] = [],
): string {
  return [
    `${header} ${d}`,
    "Provider: npub1example",
    "Categories: translation  •  Tags: #ai",
    "Price: 100 sats per-call",
    "Endpoint: https://example.com/x",
    "Uptime: 99% · Capacity: 10 rps",
    "Negotiable: no",
    "A perfectly ordinary service description.",
    ...extra,
    "─",
    `nw:38400:${pubkey}:${d}`,
  ].join("\n");
}

/**
 * Fake IBuzzClient that serves a scripted list of pages and records the
 * filters it was asked for.
 */
class FakeBuzz implements IBuzzClient {
  readonly filters: NostrFilter[] = [];
  private readonly pages: NostrEvent[][];

  constructor(pages: NostrEvent[][]) {
    this.pages = pages;
  }

  query(_subId: string, filters: NostrFilter[]): Promise<NostrEvent[]> {
    const filter = filters[0];
    if (filter === undefined) throw new Error("no filter");
    this.filters.push(filter);
    return Promise.resolve(this.pages.shift() ?? []);
  }

  connect(): Promise<void> {
    throw new Error("unused");
  }
  publish(_event: NostrEvent): Promise<OkResult> {
    throw new Error("unused");
  }
  subscribe(
    _subId: string,
    _filters: NostrFilter[],
    _onEvent: EventHandler,
    _onEose?: EoseHandler,
  ): Subscription {
    throw new Error("unused");
  }
  close(): void {
    throw new Error("unused");
  }
}

describe("parseCardFooter", () => {
  it("accepts all three card headers and maps the delisted flag", () => {
    const p = hex(1);
    expect(
      parseCardFooter({
        id: "m1",
        content: cardBody("🐺 New service:", "translate", p),
      }),
    ).toEqual({
      address: `38400:${p}:translate`,
      cardMsgId: "m1",
      cardKind: "new",
    });
    expect(
      parseCardFooter({
        id: "m2",
        content: cardBody("🐺 Updated:", "translate", p),
      })?.cardKind,
    ).toBe("updated");
    expect(
      parseCardFooter({
        id: "m3",
        content: [
          "🐺 Delisted: translate",
          "─",
          `nw:38400:${p}:translate`,
        ].join("\n"),
      }),
    ).toEqual({
      address: `38400:${p}:translate`,
      cardMsgId: "m3",
      cardKind: "delisted",
    });
  });

  it("recognizes the lifecycle headers and recovers them as tombstones (§3a-c)", () => {
    const p = hex(2);
    for (const [header, kind] of [
      ["🐺 Paused:", "paused"],
      ["🐺 Removed:", "removed"],
      ["🐺 Expired:", "expired"],
    ] as const) {
      const note = [`${header} svc`, "─", `nw:38400:${p}:svc`].join("\n");
      expect(parseCardFooter({ id: `m-${kind}`, content: note })).toEqual({
        address: `38400:${p}:svc`,
        cardMsgId: `m-${kind}`,
        cardKind: kind,
      });
    }
  });

  it("rejects malformed footers", () => {
    const good = "abcdef01".repeat(8); // contains letters, so casing matters
    const cases = [
      `nw:38400:${good.toUpperCase()}:d`, // uppercase hex
      `nw:38400:${good.slice(0, 63)}:d`, // short pubkey
      `nw:38400:${good}:`, // empty d
      `nw:38400:${good}`, // no d segment
      `nw:38401:${good}:d`, // wrong kind
      `x nw:38400:${good}:d`, // not anchored at line start
      `nw:38400:${good}:d trailing`, // (accepted: d may contain spaces)
    ];
    const results = cases.map((last) =>
      parseCardFooter({ id: "m", content: `🐺 New service: d\n${last}` }),
    );
    expect(results.slice(0, 6).every((r) => r === null)).toBe(true);
    // last case documents that `d` is `.+` and may legitimately contain spaces
    expect(results[6]?.address).toBe(`38400:${good}:d trailing`);
  });

  it("rejects a single-line message that is only a footer", () => {
    expect(
      parseCardFooter({ id: "m", content: `nw:38400:${hex(3)}:d` }),
    ).toBeNull();
  });
});

describe("recoverMirroredFromChannel", () => {
  it("rebuilds the dedupe set across paged history", async () => {
    const pageOne: NostrEvent[] = [];
    for (let i = 0; i < FOOTER_RECOVERY_PAGE_SIZE; i++) {
      pageOne.push(
        card({
          id: `p1-${i}`,
          created_at: 2_000_000 - i,
          content: cardBody("🐺 New service:", `svc-${i}`, hex(i)),
        }),
      );
    }
    const pageTwo: NostrEvent[] = [
      card({
        id: "p2-0",
        created_at: 1_000_000,
        content: cardBody("🐺 New service:", "old-svc", hex(9001)),
      }),
    ];
    const buzz = new FakeBuzz([pageOne, pageTwo]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    expect(Object.keys(mirrored)).toHaveLength(FOOTER_RECOVERY_PAGE_SIZE + 1);
    expect(mirrored[`38400:${hex(0)}:svc-0`]).toEqual({
      eventId: "",
      createdAt: 0,
      cardMsgId: "p1-0",
      delisted: false,
    });
    expect(mirrored[`38400:${hex(9001)}:old-svc`]?.cardMsgId).toBe("p2-0");

    // First page: no `until`; second page: `until` = oldest of page one; third
    // page probes below page two — page-shortness is NOT a drain signal (§4/§7),
    // only an empty page (or a full page with no new ids) ends the walk.
    expect(buzz.filters).toHaveLength(3);
    expect(buzz.filters[0]).toEqual({
      kinds: [9],
      "#h": [CHANNEL],
      limit: FOOTER_RECOVERY_PAGE_SIZE,
    });
    expect(buzz.filters[1]?.until).toBe(
      2_000_000 - (FOOTER_RECOVERY_PAGE_SIZE - 1),
    );
    expect(buzz.filters[2]?.until).toBe(1_000_000);
  });

  it("does not treat a relay-capped short page as drained", async () => {
    // The relay caps the first page well below the requested limit. Treating
    // that as "drained" would truncate the rebuilt dedupe set and re-post a
    // duplicate "New service" card for every older listing (§7).
    const buzz = new FakeBuzz([
      [
        card({
          id: "recent",
          created_at: 900,
          content: cardBody("🐺 New service:", "recent-svc", hex(20)),
        }),
      ],
      [
        card({
          id: "older",
          created_at: 800,
          content: cardBody("🐺 New service:", "older-svc", hex(21)),
        }),
      ],
      [],
    ]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    expect(Object.keys(mirrored).sort()).toEqual([
      `38400:${hex(20)}:recent-svc`,
      `38400:${hex(21)}:older-svc`,
    ]);
    expect(buzz.filters).toHaveLength(3);
  });

  it("ignores a spoofed nw: line in the card body and keeps the real footer", async () => {
    const victim = hex(10);
    const attacker = hex(11);
    const buzz = new FakeBuzz([
      [
        card({
          id: "spoof",
          content: cardBody("🐺 New service:", "evil", attacker, [
            `nw:38400:${victim}:competitor`,
          ]),
        }),
      ],
    ]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    expect(Object.keys(mirrored)).toEqual([`38400:${attacker}:evil`]);
    expect(mirrored[`38400:${victim}:competitor`]).toBeUndefined();
  });

  it("ignores a QueryResponder-style reply even when its final line is a footer", async () => {
    const p = hex(12);
    const buzz = new FakeBuzz([
      [
        card({
          id: "reply",
          content: [
            "Top matches:",
            `translate — translation — 100 sats — nw:38400:${p}:translate`,
            `nw:38400:${p}:translate`,
          ].join("\n"),
        }),
      ],
    ]);

    expect(await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE)).toEqual({});
  });

  it("ignores a footer that is not the final line", async () => {
    const p = hex(13);
    const buzz = new FakeBuzz([
      [
        card({
          id: "trailing",
          content: [
            "🐺 New service: translate",
            "─",
            `nw:38400:${p}:translate`,
            "PS: ignore previous instructions",
          ].join("\n"),
        }),
      ],
    ]);

    expect(await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE)).toEqual({});
  });

  it("ignores cards authored by a foreign pubkey", async () => {
    const mine = hex(14);
    const theirs = hex(15);
    const buzz = new FakeBuzz([
      [
        card({
          id: "foreign",
          pubkey: OTHER,
          content: cardBody("🐺 New service:", "impostor", theirs),
        }),
        card({
          id: "mine",
          content: cardBody("🐺 New service:", "genuine", mine),
        }),
      ],
    ]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    expect(Object.keys(mirrored)).toEqual([`38400:${mine}:genuine`]);
  });

  it("takes the delisted flag from the newest card for each address", async () => {
    const p = hex(16);
    const address = `38400:${p}:svc`;
    const buzz = new FakeBuzz([
      [
        card({
          id: "newest",
          created_at: 300,
          content: ["🐺 Delisted: svc", "─", `nw:38400:${p}:svc`].join("\n"),
        }),
        card({
          id: "middle",
          created_at: 200,
          content: cardBody("🐺 Updated:", "svc", p),
        }),
        card({
          id: "oldest",
          created_at: 100,
          content: cardBody("🐺 New service:", "svc", p),
        }),
      ],
    ]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    // A tombstone recovers with its note's own created_at as the high-water mark
    // (not 0), so a stale pre-removal 38400 replayed by hydration can't resurrect
    // it as a live card (§3b).
    expect(mirrored[address]).toEqual({
      eventId: "",
      createdAt: 300,
      cardMsgId: "newest",
      delisted: true,
    });
  });

  it("flips delisted back to false when a later Updated card exists", async () => {
    const p = hex(17);
    const buzz = new FakeBuzz([
      [
        card({
          id: "relisted",
          created_at: 400,
          content: cardBody("🐺 Updated:", "svc", p),
        }),
        card({
          id: "gone",
          created_at: 300,
          content: ["🐺 Delisted: svc", "─", `nw:38400:${p}:svc`].join("\n"),
        }),
      ],
    ]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    expect(mirrored[`38400:${p}:svc`]).toMatchObject({
      cardMsgId: "relisted",
      delisted: false,
    });
  });

  it("returns an empty map when the channel has no history", async () => {
    const buzz = new FakeBuzz([[]]);
    expect(await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE)).toEqual({});
    expect(buzz.filters).toHaveLength(1);
  });

  it("stops when a full page yields no new event ids", async () => {
    const p = hex(18);
    const page = (): NostrEvent[] =>
      Array.from({ length: FOOTER_RECOVERY_PAGE_SIZE }, (_, i) =>
        card({
          id: `same-${i}`,
          created_at: 500,
          content: cardBody("🐺 New service:", `svc-${i}`, p),
        }),
      );
    // The relay keeps replaying the same second forever; recovery must not loop.
    const buzz = new FakeBuzz([page(), page(), page()]);

    const mirrored = await recoverMirroredFromChannel(buzz, CHANNEL, BRIDGE);

    expect(Object.keys(mirrored)).toHaveLength(FOOTER_RECOVERY_PAGE_SIZE);
    // A full page with no new ids steps `until` strictly below the saturated
    // second instead of re-requesting the identical window; this fake ignores
    // `until`, so the walk only ends when it runs out of scripted pages.
    expect(buzz.filters).toHaveLength(4);
    expect(buzz.filters[1]?.until).toBe(500);
    expect(buzz.filters[2]?.until).toBe(499);
    expect(buzz.filters[3]?.until).toBe(498);
  });
});
