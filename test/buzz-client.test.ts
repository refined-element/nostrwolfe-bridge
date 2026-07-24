/**
 * BuzzClient tests (spec §2 + the Error handling prefix matrix).
 *
 * Everything runs against the in-process fake buzz-relay in
 * `test/mocks/buzz-mock.ts`, which speaks the proactive-AUTH handshake and the
 * exact OK/CLOSED strings from the spec table.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import {
  BuzzClient,
  BuzzFatalError,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  TokenBucket,
  parseRetryInSeconds,
  type BuzzClientOptions,
  type Logger,
} from "../src/buzz-client.js";
import type {
  BridgeIdentity,
  Config,
  NostrEvent,
  OkResult,
} from "../src/types.js";
import {
  BuzzMockRelay,
  OK_MESSAGES,
  rateLimitedRetryIn,
  waitUntil,
} from "./mocks/buzz-mock.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface LogRecord {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function recordingLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level, msg, fields: fields ?? {} });
    };
  return {
    records,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

function makeIdentity(): BridgeIdentity {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

function makeConfig(url: string, over: Partial<Config> = {}): Config {
  return {
    bridgeNsec: "unused-in-these-tests",
    buzzRelayUrl: url,
    wolfeRelayUrl: "wss://agents.lightningenable.com",
    channelName: "Services",
    channelAbout: "NostrWolfe marketplace mirror",
    mirrorCategories: [],
    mirrorMaxListings: 200,
    backfillLimit: 100,
    buzzMsgsPerMin: 30,
    stateFile: "./bridge-state.json",
    logLevel: "debug",
    ...over,
  };
}

const CHANNEL = "9f1f5c1e-0000-4000-8000-000000000001";

function makeChatEvent(
  identity: BridgeIdentity,
  content = "hello",
): NostrEvent {
  return finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", CHANNEL]],
      content,
    },
    identity.secretKey,
  ) as unknown as NostrEvent;
}

interface Harness {
  mock: BuzzMockRelay;
  client: BuzzClient;
  identity: BridgeIdentity;
  logger: Logger & { records: LogRecord[] };
}

const harnesses: Harness[] = [];

async function setup(
  mockOptions: Parameters<typeof BuzzMockRelay.start>[0] = {},
  clientOptions: BuzzClientOptions = {},
  configOver: Partial<Config> = {},
): Promise<Harness> {
  const mock = await BuzzMockRelay.start(mockOptions);
  const identity = makeIdentity();
  const logger = recordingLogger();
  const client = new BuzzClient(
    makeConfig(mock.url, configOver),
    identity,
    // timeScale keeps backoff/pauses proportional but fast (1s → 2ms).
    { timeScale: 0.002, logger, ...clientOptions },
  );
  const harness = { mock, client, identity, logger };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (!h) continue;
    h.client.close();
    await h.mock.stop();
  }
});

// ---------------------------------------------------------------------------
// AUTH handshake (spec §2)
// ---------------------------------------------------------------------------

describe("proactive AUTH handshake", () => {
  it("answers the relay's challenge with a kind:22242 carrying challenge + dialed relay url", async () => {
    const { mock, client, identity } = await setup();
    await client.connect();

    expect(client.authenticated).toBe(true);
    expect(mock.authEvents).toHaveLength(1);

    const auth = mock.authEvents[0]!;
    expect(auth.kind).toBe(22242);
    expect(auth.pubkey).toBe(identity.publicKey);
    expect(mock.authChallenges()[0]).toBe(mock.challenges[0]);
    // The relay tag must be the DIALED url, verbatim (§2).
    expect(mock.authRelayTags()[0]).toBe(mock.url);
    expect(
      Math.abs(auth.created_at - Math.floor(Date.now() / 1000)),
    ).toBeLessThan(60);
    // The mock verifies the BIP-340 signature itself; OK-true proves it passed.
  });

  it("runs the caller-provided post-AUTH hook on connect and on every reconnect", async () => {
    let hookRuns = 0;
    const { mock, client } = await setup(
      {},
      { hooks: { onAuthenticated: () => void hookRuns++ } },
    );
    await client.connect();
    expect(hookRuns).toBe(1);

    mock.dropConnections();
    await waitUntil(() => hookRuns === 2 && client.authenticated);
    expect(mock.authEvents.length).toBe(2);
    // Fresh connection ⇒ fresh challenge (§2).
    expect(mock.authChallenges()[1]).toBe(mock.challenges[1]);
    expect(mock.challenges[0]).not.toBe(mock.challenges[1]);
  });
});

// ---------------------------------------------------------------------------
// Queue-until-auth (spec §2: no EVENT/REQ before the AUTH OK)
// ---------------------------------------------------------------------------

describe("outbound queueing", () => {
  it("queues publishes until the AUTH OK arrives", async () => {
    const { mock, client, identity } = await setup({ holdAuthOk: true });
    const connectPromise = client.connect();
    const publishPromise = client.publish(makeChatEvent(identity));

    await waitUntil(() => mock.authEvents.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.published).toHaveLength(0);
    expect(client.authenticated).toBe(false);
    expect(client.queueLength).toBe(1);

    mock.releaseAuth();
    await connectPromise;
    const result = await publishPromise;
    expect(result.ok).toBe(true);
    expect(mock.published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error matrix (spec "Error handling")
// ---------------------------------------------------------------------------

describe("OK-false prefix matrix", () => {
  it("auth-required (generic): re-AUTHs once with the STORED challenge, then retries the publish", async () => {
    const { mock, client, identity } = await setup();
    await client.connect();

    mock.onEvent((_e, ctx) =>
      ctx.attempt === 1
        ? { ok: false, message: OK_MESSAGES.AUTH_REQUIRED }
        : undefined,
    );

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(result.ok).toBe(true);
    expect(mock.sendCount(event.id)).toBe(2);
    expect(mock.authEvents).toHaveLength(2);
    // Same connection ⇒ same challenge on the retry (issued once per connection).
    expect(mock.authChallenges()[1]).toBe(mock.challenges[0]);
    expect(mock.connections).toHaveLength(1);
  });

  it("auth-required twice: drops the connection and reconnects for a fresh challenge", async () => {
    const { mock, client, identity } = await setup();
    await client.connect();

    // Both the publish and the stored-challenge re-AUTH are rejected.
    mock.onEvent((_e, ctx) =>
      ctx.attempt <= 2
        ? { ok: false, message: OK_MESSAGES.AUTH_REQUIRED }
        : undefined,
    );
    mock.onAuth((_e, ctx) =>
      ctx.index === 2
        ? { ok: false, message: OK_MESSAGES.AUTH_REQUIRED }
        : undefined,
    );

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(result.ok).toBe(true);
    expect(mock.connections.length).toBeGreaterThanOrEqual(2);
    expect(mock.sendCount(event.id)).toBe(3);
    const challenges = mock.authChallenges();
    expect(challenges[0]).toBe(mock.challenges[0]);
    expect(challenges[1]).toBe(mock.challenges[0]);
    expect(challenges[2]).toBe(mock.challenges[1]);
  });

  it("auth-required: verification failed → backoff-retries ~5 times then goes fatal with operator guidance", async () => {
    let fatal: BuzzFatalError | null = null;
    const { mock, client, identity } = await setup(
      {},
      {
        hooks: {
          onFatal: (err) => {
            fatal = err;
          },
        },
      },
    );
    mock.onAuth(() => ({
      ok: false,
      message: OK_MESSAGES.AUTH_VERIFICATION_FAILED,
    }));

    const connectError = client.connect().catch((e: unknown) => e);
    const publishError = client
      .publish(makeChatEvent(identity))
      .catch((e: unknown) => e);

    await waitUntil(() => fatal !== null, 5_000);
    const err = fatal as unknown as BuzzFatalError;
    expect(err).toBeInstanceOf(BuzzFatalError);
    // 5 attempts, each a reconnect + fresh AUTH.
    expect(mock.authEvents).toHaveLength(5);
    expect(mock.connections).toHaveLength(5);
    expect(err.guidance).toContain("BUZZ_PUBKEY_ALLOWLIST=true");
    expect(err.guidance).toMatch(/before relay startup/i);
    expect(err.guidance).toContain("INSERT INTO pubkey_allowlist");
    expect(err.guidance).toContain(client["identity"].publicKey);

    expect(await connectError).toBeInstanceOf(BuzzFatalError);
    expect(await publishError).toBeInstanceOf(BuzzFatalError);
  });

  it("restricted: not a relay member → fatal with the buzz-admin guidance", async () => {
    let fatal: BuzzFatalError | null = null;
    const { mock, client, identity } = await setup(
      {},
      {
        hooks: {
          onFatal: (err) => {
            fatal = err;
          },
        },
      },
    );
    await client.connect();
    mock.scriptOk({
      ok: false,
      message: OK_MESSAGES.RESTRICTED_NOT_RELAY_MEMBER,
    });

    const event = makeChatEvent(identity);
    const err = await client.publish(event).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BuzzFatalError);
    expect((err as BuzzFatalError).guidance).toContain("buzz-admin add-member");
    expect(fatal).not.toBeNull();
    expect(mock.sendCount(event.id)).toBe(1);
  });

  it("restricted: not a channel member → joins once via the hook, then retries the publish", async () => {
    let joins = 0;
    const { mock, client, identity } = await setup(
      {},
      {
        hooks: {
          onNotChannelMember: async () => {
            joins++;
            return true;
          },
        },
      },
    );
    await client.connect();
    mock.onEvent((_e, ctx) =>
      ctx.attempt === 1
        ? { ok: false, message: OK_MESSAGES.RESTRICTED_NOT_CHANNEL_MEMBER }
        : undefined,
    );

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(joins).toBe(1);
    expect(result.ok).toBe(true);
    expect(mock.sendCount(event.id)).toBe(2);
  });

  it("restricted: not a channel member → fatal when the join does not take", async () => {
    const { mock, client, identity } = await setup(
      {},
      { hooks: { onNotChannelMember: async () => false } },
    );
    await client.connect();
    mock.onEvent(() => ({
      ok: false,
      message: OK_MESSAGES.RESTRICTED_NOT_CHANNEL_MEMBER,
    }));

    const err = await client
      .publish(makeChatEvent(identity))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuzzFatalError);
  });

  it("restricted: channel is private → fatal, the bridge never forces its way in", async () => {
    const { mock, client, identity } = await setup();
    await client.connect();
    mock.scriptOk({
      ok: false,
      message: OK_MESSAGES.RESTRICTED_CHANNEL_PRIVATE,
    });

    const err = await client
      .publish(makeChatEvent(identity))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuzzFatalError);
    expect((err as BuzzFatalError).relayMessage).toBe(
      OK_MESSAGES.RESTRICTED_CHANNEL_PRIVATE,
    );
  });

  it("duplicate: channel already exists → passes the OK straight through to the caller", async () => {
    const { mock, client, identity } = await setup();
    await client.connect();
    mock.scriptOk({ ok: false, message: OK_MESSAGES.DUPLICATE_CHANNEL_EXISTS });

    const event = makeChatEvent(identity);
    const result: OkResult = await client.publish(event);

    expect(result.ok).toBe(false);
    expect(result.message).toBe(OK_MESSAGES.DUPLICATE_CHANNEL_EXISTS);
    expect(result.id).toBe(event.id);
    // No retry — ChannelManager decides what to do (falls back to discovery).
    expect(mock.sendCount(event.id)).toBe(1);
  });

  it("invalid: channel not found → emits channelLost and calls the hook", async () => {
    let hookCalls = 0;
    const { mock, client, identity } = await setup(
      {},
      { hooks: { onChannelLost: () => void hookCalls++ } },
    );
    let emitted = 0;
    client.on("channelLost", () => emitted++);
    await client.connect();
    mock.scriptOk({
      ok: false,
      message: OK_MESSAGES.INVALID_CHANNEL_NOT_FOUND,
    });

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(hookCalls).toBe(1);
    expect(emitted).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(OK_MESSAGES.INVALID_CHANNEL_NOT_FOUND);
    expect(mock.sendCount(event.id)).toBe(1);
  });

  it("rate-limited: quota exceeded; retry in 3s → pauses the queue for 3s and re-sends (never drops)", async () => {
    const { mock, client, identity, logger } = await setup();
    await client.connect();
    mock.onEvent((_e, ctx) =>
      ctx.attempt === 1
        ? { ok: false, message: rateLimitedRetryIn(3) }
        : undefined,
    );

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(result.ok).toBe(true);
    expect(mock.sendCount(event.id)).toBe(2);
    const pause = logger.records.find(
      (r) => r.msg === "publish rate-limited; pausing queue",
    );
    expect(pause).toBeDefined();
    expect(pause?.fields["pauseMs"]).toBe(3000);
  });

  it("rate-limited: too many concurrent requests → 1s backoff, retry", async () => {
    const { mock, client, identity, logger } = await setup();
    await client.connect();
    mock.onEvent((_e, ctx) =>
      ctx.attempt === 1
        ? { ok: false, message: OK_MESSAGES.RATE_LIMITED_CONCURRENT }
        : undefined,
    );

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(result.ok).toBe(true);
    expect(mock.sendCount(event.id)).toBe(2);
    const pause = logger.records.find(
      (r) => r.msg === "publish rate-limited; pausing queue",
    );
    expect(pause?.fields["pauseMs"]).toBe(1000);
  });

  it("invalid: (anything else) → logs the full event at error and drops the message", async () => {
    const { mock, client, identity, logger } = await setup();
    await client.connect();
    mock.scriptOk({ ok: false, message: OK_MESSAGES.INVALID_UNKNOWN_KIND });

    const event = makeChatEvent(identity);
    const result = await client.publish(event);

    expect(result.ok).toBe(false);
    expect(mock.sendCount(event.id)).toBe(1);
    expect(client.queueLength).toBe(0);
    const logged = logger.records.find(
      (r) =>
        r.level === "error" &&
        r.msg === "publish rejected (invalid); dropping message",
    );
    expect(logged).toBeDefined();
    expect((logged?.fields["event"] as NostrEvent).id).toBe(event.id);
  });

  it("parses `retry in Ns` out of the rate-limit message", () => {
    expect(parseRetryInSeconds(rateLimitedRetryIn(7))).toBe(7);
    expect(parseRetryInSeconds(OK_MESSAGES.RATE_LIMITED_CONCURRENT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Subscriptions (spec §2)
// ---------------------------------------------------------------------------

describe("subscriptions", () => {
  it("resubscribes after reconnect with since = cursor − 300 and explicit kinds", async () => {
    const { mock, client } = await setup();
    await client.connect();

    let cursor = 1_753_280_000;
    const seen: NostrEvent[] = [];
    client.subscribe(
      `ch-${CHANNEL}`,
      [{ kinds: [9], "#h": [CHANNEL] }],
      (e) => seen.push(e),
      undefined,
      () => cursor,
    );

    await waitUntil(() => mock.reqs.length === 1);
    expect(mock.reqs[0]!.filters[0]).toMatchObject({
      kinds: [9],
      "#h": [CHANNEL],
      since: cursor - 300,
    });

    cursor = 1_753_290_000;
    mock.dropConnections();

    await waitUntil(() => mock.reqs.length === 2, 5_000);
    const resubscribed = mock.reqs[1]!;
    expect(resubscribed.subId).toBe(`ch-${CHANNEL}`);
    expect(resubscribed.filters[0]).toMatchObject({
      kinds: [9],
      since: cursor - 300,
    });
    expect(seen).toHaveLength(0);
  });

  it("delivers events and EOSE, and refuses filters without explicit kinds", async () => {
    const { mock, client, identity } = await setup();
    const stored = makeChatEvent(identity, "stored card");
    mock.setStored([stored]);
    await client.connect();

    const seen: NostrEvent[] = [];
    let eosed = false;
    client.subscribe(
      "s1",
      [{ kinds: [9], "#h": [CHANNEL] }],
      (e) => seen.push(e),
      () => {
        eosed = true;
      },
    );
    await waitUntil(() => eosed);
    expect(seen.map((e) => e.id)).toEqual([stored.id]);

    expect(() =>
      client.subscribe("s2", [{ "#h": [CHANNEL] }], () => {}),
    ).toThrow(/explicit `kinds`/);
    await expect(client.query("q-bad", [{}])).rejects.toThrow(
      /explicit `kinds`/,
    );
  });

  it("query() collects historical events until EOSE and then closes the sub", async () => {
    const { mock, client, identity } = await setup();
    const stored = makeChatEvent(identity, "history");
    mock.setStored([stored]);
    await client.connect();

    const events = await client.query("chan-disc", [{ kinds: [9] }]);
    expect(events.map((e) => e.id)).toEqual([stored.id]);
    await waitUntil(() => mock.closes.includes("chan-disc"));
  });
});

// ---------------------------------------------------------------------------
// Frame guard (spec §2 frame budget)
// ---------------------------------------------------------------------------

describe("frame guard", () => {
  it("rejects oversized frames locally and never puts them on the wire", async () => {
    const { mock, client, identity } = await setup();
    await client.connect();

    const oversized = makeChatEvent(identity, "x".repeat(MAX_FRAME_BYTES));
    const err = await client.publish(oversized).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FrameTooLargeError);
    expect((err as FrameTooLargeError).bytes).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(client.queueLength).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.published).toHaveLength(0);

    // The client is still usable afterwards.
    const ok = await client.publish(makeChatEvent(identity, "small"));
    expect(ok.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token bucket (spec §2 rate limiter)
// ---------------------------------------------------------------------------

describe("TokenBucket", () => {
  it("allows a 5/sec burst and then makes the caller wait", () => {
    let now = 1_000_000;
    const bucket = new TokenBucket(30, 5, () => now);
    for (let i = 0; i < 5; i++) expect(bucket.tryConsume()).toBe(0);
    const wait = bucket.tryConsume();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(200);

    now += wait;
    expect(bucket.tryConsume()).toBe(0);
  });

  it("enforces the per-minute budget once the burst window is exhausted", () => {
    let now = 1_000_000;
    // 6 msgs/min: the minute budget runs out long before a minute has passed.
    const bucket = new TokenBucket(6, 5, () => now);
    for (let i = 0; i < 6; i++) {
      let wait = bucket.tryConsume();
      while (wait > 0) {
        now += wait;
        wait = bucket.tryConsume();
      }
    }
    // The 7th send must wait on the minute bucket (~10s at 6/min), not the burst.
    const wait = bucket.tryConsume();
    expect(wait).toBeGreaterThan(5_000);
  });
});
