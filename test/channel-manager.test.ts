import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  ChannelManager,
  collapseMetadata,
  deriveChannelId,
  DiscoveryTruncatedError,
  ENSURE_CHANNEL_DEADLINE_MS,
  EnsureChannelTimeoutError,
  pickChannel,
  uuidv5,
  type ChannelCandidate,
} from "../src/channel-manager.js";
import type {
  BridgeIdentity,
  BridgeState,
  Config,
  EoseHandler,
  EventHandler,
  IBuzzClient,
  IStateStore,
  NostrEvent,
  NostrFilter,
  OkResult,
  Subscription,
} from "../src/types.js";

// --- fixtures --------------------------------------------------------------

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

/** Relay-signed 39000 metadata event (sig irrelevant — never verified here). */
function meta(d: string, name: string, createdAt: number): NostrEvent {
  return {
    id: `meta-${d}-${createdAt}`,
    pubkey: "f".repeat(64),
    created_at: createdAt,
    kind: 39000,
    tags: [
      ["d", d],
      ["name", name],
      ["closed", ""],
    ],
    content: "",
    sig: "0".repeat(128),
  };
}

function members(d: string, pubkeys: string[]): NostrEvent {
  return {
    id: `members-${d}`,
    pubkey: "f".repeat(64),
    created_at: 100,
    kind: 39002,
    tags: [["d", d], ...pubkeys.map((p) => ["p", p])],
    content: "",
    sig: "0".repeat(128),
  };
}

class FakeBuzz implements IBuzzClient {
  published: NostrEvent[] = [];
  /** kind → events returned by `query`, consulted in order. */
  responses: NostrEvent[][] = [];
  metadata: NostrEvent[] = [];
  memberLists: NostrEvent[] = [];
  profiles: NostrEvent[] = [];
  okFor: (event: NostrEvent, seq: number) => OkResult = (e) => ({
    id: e.id,
    ok: true,
    message: "",
  });
  /** Observed side-state at publish time, keyed by publish sequence. */
  publishHooks: ((event: NostrEvent) => void)[] = [];
  /** Every filter array passed to `query`, in call order (test assertions). */
  queryFilters: NostrFilter[][] = [];
  /** Optional override: when set, fully controls what `query` returns/throws. */
  queryOverride:
    ((subId: string, filters: NostrFilter[]) => Promise<NostrEvent[]>) | null =
    null;
  private seq = 0;

  async connect(): Promise<void> {}

  async publish(event: NostrEvent): Promise<OkResult> {
    this.published.push(event);
    for (const hook of this.publishHooks) hook(event);
    return this.okFor(event, this.seq++);
  }

  subscribe(
    subId: string,
    _filters: NostrFilter[],
    _onEvent: EventHandler,
    _onEose?: EoseHandler,
  ): Subscription {
    return { id: subId, close() {} };
  }

  async query(subId: string, filters: NostrFilter[]): Promise<NostrEvent[]> {
    this.queryFilters.push(filters);
    if (this.queryOverride) return this.queryOverride(subId, filters);
    const kinds = filters[0]?.kinds ?? [];
    if (kinds.includes(39000)) return this.metadata;
    if (kinds.includes(39002)) return this.memberLists;
    if (kinds.includes(0)) return this.profiles;
    return [];
  }

  close(): void {}
}

class FakeState implements IStateStore {
  state: BridgeState = {
    version: 1,
    community: "ws://localhost:3000",
    channelId: null,
    cursors: { wolfe: 0, buzz: 0 },
    mirrored: {},
  };

  async load(): Promise<BridgeState> {
    return this.state;
  }
  getState(): BridgeState {
    return this.state;
  }
  mutate(fn: (state: BridgeState) => void): void {
    fn(this.state);
  }
  async flush(): Promise<void> {}
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

function setup(configOver: Partial<Config> = {}) {
  const config = makeConfig(configOver);
  const identity = makeIdentity();
  const buzz = new FakeBuzz();
  const state = new FakeState();
  const cm = new ChannelManager(config, identity, buzz, state);
  return { config, identity, buzz, state, cm };
}

afterEach(() => {
  vi.useRealTimers();
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// --- deterministic UUID ----------------------------------------------------

describe("deterministic channel UUID (§3)", () => {
  it("is a well-formed v5 UUID", () => {
    const { cm } = setup();
    expect(cm.deterministicChannelId()).toMatch(UUID_RE);
  });

  it("matches the RFC 4122 v5 test vector", () => {
    // Canonical vector: UUIDv5(DNS namespace, "www.example.org").
    expect(
      uuidv5("www.example.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    ).toBe("74738ff5-5367-5958-9aee-98fffdcd1876");
  });

  it("is stable across instances for the same pubkey + name", () => {
    const identity = makeIdentity();
    const a = new ChannelManager(
      makeConfig(),
      identity,
      new FakeBuzz(),
      new FakeState(),
    );
    const b = new ChannelManager(
      makeConfig(),
      identity,
      new FakeBuzz(),
      new FakeState(),
    );
    expect(a.deterministicChannelId()).toBe(b.deterministicChannelId());
    expect(a.deterministicChannelId()).toBe(
      deriveChannelId(identity.publicKey, "Services"),
    );
  });

  it("changes with the channel name and with the bridge pubkey", () => {
    const identity = makeIdentity();
    const other = makeIdentity();
    const base = deriveChannelId(identity.publicKey, "Services");
    expect(deriveChannelId(identity.publicKey, "Offers")).not.toBe(base);
    expect(deriveChannelId(other.publicKey, "Services")).not.toBe(base);
  });
});

// --- tie-break -------------------------------------------------------------

describe("channel tie-break (§3 step 1)", () => {
  const cands: ChannelCandidate[] = [
    {
      channelId: "cccccccc-0000-5000-8000-000000000000",
      name: "Services",
      createdAt: 50,
    },
    {
      channelId: "aaaaaaaa-0000-5000-8000-000000000000",
      name: "Services",
      createdAt: 10,
    },
    {
      channelId: "bbbbbbbb-0000-5000-8000-000000000000",
      name: "Services",
      createdAt: 10,
    },
  ];

  it("prefers the persisted channelId", () => {
    expect(
      pickChannel(cands, cands[0]!.channelId, cands[1]!.channelId)?.channelId,
    ).toBe(cands[0]!.channelId);
  });

  it("prefers the deterministic UUID when nothing is persisted", () => {
    expect(pickChannel(cands, null, cands[2]!.channelId)?.channelId).toBe(
      cands[2]!.channelId,
    );
  });

  it("falls back to oldest created_at, ties broken lexicographically", () => {
    expect(pickChannel(cands, null, "no-such-uuid")?.channelId).toBe(
      "aaaaaaaa-0000-5000-8000-000000000000",
    );
  });

  it("ignores a persisted id that is not among the candidates", () => {
    expect(
      pickChannel(cands, "ffffffff-0000-5000-8000-000000000000", "nope")
        ?.channelId,
    ).toBe("aaaaaaaa-0000-5000-8000-000000000000");
  });

  it("returns null with no candidates", () => {
    expect(pickChannel([], "x", "y")).toBeNull();
  });

  it("collapses metadata revisions: newest name, oldest age", () => {
    const collapsed = collapseMetadata([
      meta("uuid-1", "Old Name", 10),
      meta("uuid-1", "Services", 90),
      meta("uuid-2", "Other", 20),
    ]);
    const first = collapsed.find((c) => c.channelId === "uuid-1")!;
    expect(first.name).toBe("Services");
    expect(first.createdAt).toBe(10);
    expect(collapsed).toHaveLength(2);
  });
});

// --- discovery / create / join --------------------------------------------

describe("ensureChannel (§3)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("uses a discovered channel and joins it when not a member", async () => {
    const { cm, buzz, state } = ctx;
    buzz.metadata = [
      meta("11111111-0000-5000-8000-000000000000", "Services", 5),
    ];
    const id = await cm.ensureChannel();
    expect(id).toBe("11111111-0000-5000-8000-000000000000");
    expect(state.state.channelId).toBe(id);
    const kinds = buzz.published.map((e) => e.kind);
    expect(kinds).toContain(9021);
    expect(kinds).not.toContain(9007);
    const join = buzz.published.find((e) => e.kind === 9021)!;
    expect(join.tags).toContainEqual(["h", id]);
  });

  it("skips the join when the 39002 member list already contains the bridge", async () => {
    const { cm, buzz, identity } = ctx;
    const id = "11111111-0000-5000-8000-000000000000";
    buzz.metadata = [meta(id, "Services", 5)];
    buzz.memberLists = [members(id, [identity.publicKey])];
    await cm.ensureChannel();
    expect(buzz.published.map((e) => e.kind)).not.toContain(9021);
  });

  it("ignores channels whose name does not match", async () => {
    const { cm, buzz } = ctx;
    buzz.metadata = [meta("22222222-0000-5000-8000-000000000000", "Random", 5)];
    const id = await cm.ensureChannel();
    expect(id).toBe(cm.deterministicChannelId());
    expect(buzz.published.map((e) => e.kind)).toContain(9007);
  });

  it("creates with name/about/visibility=open and the deterministic h tag", async () => {
    const { cm, buzz, config } = ctx;
    const id = await cm.ensureChannel();
    const create = buzz.published.find((e) => e.kind === 9007)!;
    expect(create.tags).toContainEqual(["name", config.channelName]);
    expect(create.tags).toContainEqual(["about", config.channelAbout]);
    expect(create.tags).toContainEqual(["visibility", "open"]);
    expect(create.tags).toContainEqual(["h", cm.deterministicChannelId()]);
    expect(id).toBe(cm.deterministicChannelId());
    // No join needed — the creator is a member by construction.
    expect(buzz.published.map((e) => e.kind)).not.toContain(9021);
  });

  it("persists the UUID to state before the 9007 is published", async () => {
    const { cm, buzz, state } = ctx;
    let channelIdAtPublish: string | null = "unset";
    buzz.publishHooks.push((e) => {
      if (e.kind === 9007) channelIdAtPublish = state.state.channelId;
    });
    await cm.ensureChannel();
    expect(channelIdAtPublish).toBe(cm.deterministicChannelId());
  });

  it("falls back to discovery on `duplicate: channel already exists`", async () => {
    const { cm, buzz, state } = ctx;
    const winner = "99999999-0000-5000-8000-000000000000";
    buzz.okFor = (e) =>
      e.kind === 9007
        ? { id: e.id, ok: false, message: "duplicate: channel already exists" }
        : { id: e.id, ok: true, message: "" };
    // Discovery is empty first (the race), then the winner's channel appears.
    buzz.publishHooks.push((e) => {
      if (e.kind === 9007) buzz.metadata = [meta(winner, "Services", 7)];
    });

    const id = await cm.ensureChannel();
    expect(id).toBe(winner);
    expect(state.state.channelId).toBe(winner);
    // Losing the race means we were not the creator → join the winner's channel.
    expect(buzz.published.map((e) => e.kind)).toContain(9021);
  });

  it("falls back to the deterministic UUID if the race winner is not yet discoverable", async () => {
    const { cm, buzz } = ctx;
    buzz.okFor = (e) =>
      e.kind === 9007
        ? { id: e.id, ok: false, message: "duplicate: channel already exists" }
        : { id: e.id, ok: true, message: "" };
    const id = await cm.ensureChannel();
    expect(id).toBe(cm.deterministicChannelId());
  });

  it("throws on any other create rejection and clears the optimistic channelId", async () => {
    const { cm, buzz, state } = ctx;
    buzz.okFor = (e) =>
      e.kind === 9007
        ? { id: e.id, ok: false, message: "restricted: not a relay member" }
        : { id: e.id, ok: true, message: "" };
    await expect(cm.ensureChannel()).rejects.toThrow(/not a relay member/);
    expect(state.state.channelId).toBeNull();
  });

  it("re-runs discovery when the join reports `invalid: channel not found`", async () => {
    // The error matrix says this clears `channelId` AND re-runs ChannelManager.
    // Throwing instead left `channelId` null with nobody to retry, so every
    // later publish and reply threw "Services channel is not resolved yet".
    const { cm, buzz, state } = ctx;
    const ghost = "44444444-0000-5000-8000-000000000000";
    buzz.metadata = [meta(ghost, "Services", 5)];
    buzz.okFor = (e) =>
      e.kind === 9021 && !buzz.published.some((p) => p.kind === 9007)
        ? { id: e.id, ok: false, message: "invalid: channel not found" }
        : { id: e.id, ok: true, message: "" };
    // The channel is gone by the time we re-discover.
    buzz.publishHooks.push((e) => {
      if (e.kind === 9021) buzz.metadata = [];
    });

    const id = await cm.ensureChannel();

    expect(id).toBe(cm.deterministicChannelId());
    expect(state.state.channelId).toBe(id);
    expect(buzz.published.map((e) => e.kind)).toContain(9007);
  });

  it("throws when the join is rejected because the channel is private", async () => {
    const { cm, buzz } = ctx;
    buzz.metadata = [
      meta("33333333-0000-5000-8000-000000000000", "Services", 5),
    ];
    buzz.okFor = (e) =>
      e.kind === 9021
        ? { id: e.id, ok: false, message: "restricted: channel is private" }
        : { id: e.id, ok: true, message: "" };
    await expect(cm.ensureChannel()).rejects.toThrow(/channel is private/);
  });

  it("publishes the kind:0 profile once per community", async () => {
    const { cm, buzz, config } = ctx;
    await cm.ensureChannel();
    const profiles = buzz.published.filter((e) => e.kind === 0);
    expect(profiles).toHaveLength(1);
    const parsed = JSON.parse(profiles[0]!.content) as Record<string, string>;
    expect(parsed.name).toBe("nostrwolfe-bridge");
    expect(parsed.about).toBe(config.channelAbout);

    // A second run must not re-publish it.
    buzz.profiles = [profiles[0]!];
    await cm.handleChannelLost();
    expect(buzz.published.filter((e) => e.kind === 0)).toHaveLength(1);
  });

  it("re-publishes the profile when the relay has none for this community", async () => {
    const { config, identity, buzz, state } = ctx;
    const first = new ChannelManager(config, identity, buzz, state);
    await first.ensureChannel();
    // Fresh process against a fresh community: profiles do not inherit.
    const second = new ChannelManager(config, identity, buzz, new FakeState());
    await second.ensureChannel();
    expect(buzz.published.filter((e) => e.kind === 0)).toHaveLength(2);
  });
});

// --- re-run triggers -------------------------------------------------------

describe("re-run triggers (§3)", () => {
  it("verifyChannelExists reflects the 39000 result set", async () => {
    const { cm, buzz } = setup();
    const id = "44444444-0000-5000-8000-000000000000";
    buzz.metadata = [meta(id, "Services", 5)];
    await expect(cm.verifyChannelExists(id)).resolves.toBe(true);
    await expect(cm.verifyChannelExists("other")).resolves.toBe(false);
  });

  it("verifyChannelExists scopes the REQ to the UUID via a #d filter (finding H-2)", async () => {
    const { cm, buzz } = setup();
    const id = "44444444-0000-5000-8000-000000000000";
    // A #d-scoped REQ means an empty result is authoritative absence, immune to
    // the relay's newest-500 cap. Assert the filter, and that an empty set →
    // false (the relay legitimately returned nothing for this UUID).
    buzz.queryOverride = async (_subId, filters) => {
      expect(filters[0]?.["#d"]).toEqual([id]);
      return [];
    };
    await expect(cm.verifyChannelExists(id)).resolves.toBe(false);
    expect(buzz.queryFilters.at(-1)?.[0]).toMatchObject({
      kinds: [39000],
      "#d": [id],
    });
  });

  it("handleChannelLost clears channelId and re-runs discovery", async () => {
    const { cm, buzz, state } = setup();
    state.state.channelId = "stale-uuid";
    const live = "55555555-0000-5000-8000-000000000000";
    buzz.metadata = [meta(live, "Services", 5)];
    const id = await cm.handleChannelLost();
    expect(id).toBe(live);
    expect(state.state.channelId).toBe(live);
  });

  it("handleReconnect keeps a still-resolving channel without publishing", async () => {
    const { cm, buzz, state } = setup();
    const id = "66666666-0000-5000-8000-000000000000";
    state.state.channelId = id;
    buzz.metadata = [meta(id, "Services", 5)];
    await expect(cm.handleReconnect()).resolves.toBe(id);
    expect(buzz.published).toHaveLength(0);
  });

  it("handleReconnect re-runs ChannelManager when the stored UUID is gone", async () => {
    const { cm, buzz, state } = setup();
    state.state.channelId = "77777777-0000-5000-8000-000000000000";
    buzz.metadata = [];
    const id = await cm.handleReconnect();
    expect(id).toBe(cm.deterministicChannelId());
    expect(buzz.published.map((e) => e.kind)).toContain(9007);
  });
});

// --- discovery paging + truncation refusal (finding H-2) -------------------

describe("discovery truncation refusal (finding H-2)", () => {
  /** A full page (== the relay result cap) of non-matching metadata. */
  function fullPage(): NostrEvent[] {
    return Array.from({ length: 500 }, (_, i) =>
      meta(`d-${String(i)}`, "SomethingElse", 1000 - i),
    );
  }

  it("refuses to create when the discovery scan is truncated (page cap hit)", async () => {
    const { cm, buzz } = setup();
    // Every page comes back full and never drains → the relay is not honouring
    // `until`, so absence of a "Services" match is unproven. Creating anyway
    // would spawn a duplicate empty channel.
    const page = fullPage();
    buzz.queryOverride = async () => page;

    await expect(cm.ensureChannel()).rejects.toBeInstanceOf(
      DiscoveryTruncatedError,
    );
    // Critically: NO 9007 create was published on a truncated scan.
    expect(buzz.published.map((e) => e.kind)).not.toContain(9007);
  });

  it("still creates when a short page proves the scan genuinely drained", async () => {
    const { cm, buzz } = setup();
    // A page shorter than the cap means the relay had nothing more → drained,
    // so a missing "Services" channel is real and creation is correct.
    buzz.queryOverride = async () => [
      meta("dd-1", "SomethingElse", 5),
      meta("dd-2", "Another", 4),
    ];
    const id = await cm.ensureChannel();
    expect(id).toBe(cm.deterministicChannelId());
    expect(buzz.published.map((e) => e.kind)).toContain(9007);
  });
});

// --- hung-run deadline (finding H-6/M-4) -----------------------------------

describe("ensureChannel deadline (finding H-6/M-4)", () => {
  it("times out a hung run instead of poisoning every future caller", async () => {
    vi.useFakeTimers();
    const { cm, buzz } = setup();

    // The discovery query never resolves → the run hangs past the deadline.
    buzz.queryOverride = () => new Promise<NostrEvent[]>(() => undefined);

    const first = cm.ensureChannel();
    const firstSettled = expect(first).rejects.toBeInstanceOf(
      EnsureChannelTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(ENSURE_CHANNEL_DEADLINE_MS + 1);
    await firstSettled;

    // inFlight must have been cleared: a fresh call starts a NEW run and can
    // succeed rather than awaiting the dead promise forever.
    buzz.queryOverride = null;
    buzz.metadata = [];
    const second = await cm.ensureChannel();
    expect(second).toBe(cm.deterministicChannelId());
  });
});

// --- membership / profile probe tolerance (finding M-1/M-2) ----------------

describe("probe query tolerance (finding M-1/M-2)", () => {
  it("does not abort when the 39002 membership probe times out; joins tolerantly", async () => {
    const { cm, buzz } = setup();
    const id = "88888888-0000-5000-8000-000000000000";
    buzz.metadata = [meta(id, "Services", 5)];
    // Discovery succeeds; the 39002 membership probe rejects (EOSE timeout).
    buzz.queryOverride = async (_subId, filters) => {
      const kinds = filters[0]?.kinds ?? [];
      if (kinds.includes(39002)) {
        throw new Error("query chan-members timed out waiting for EOSE");
      }
      if (kinds.includes(39000)) return buzz.metadata;
      return [];
    };

    const resolved = await cm.ensureChannel();
    expect(resolved).toBe(id);
    // Unknown membership → tolerant path: send the (possibly redundant) join.
    expect(buzz.published.map((e) => e.kind)).toContain(9021);
  });

  it("does not abort when the kind:0 profile probe times out; publishes anyway", async () => {
    const { cm, buzz } = setup();
    // No channel exists (short drained scan) → create path; profile probe fails.
    buzz.queryOverride = async (_subId, filters) => {
      const kinds = filters[0]?.kinds ?? [];
      if (kinds.includes(0)) {
        throw new Error("query bridge-profile timed out waiting for EOSE");
      }
      return [];
    };

    const resolved = await cm.ensureChannel();
    expect(resolved).toBe(cm.deterministicChannelId());
    // The profile is published rather than the daemon aborting startup.
    expect(buzz.published.map((e) => e.kind)).toContain(0);
  });
});
