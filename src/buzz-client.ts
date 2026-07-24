/** BuzzClient — NIP-42 auth, rate-limited publish, subscriptions (spec §2). */

import { EventEmitter } from "node:events";
import { finalizeEvent } from "nostr-tools/pure";
import WebSocket from "ws";

import type {
  BridgeIdentity,
  Config,
  EoseHandler,
  EventHandler,
  IBuzzClient,
  LogLevel,
  NostrEvent,
  NostrFilter,
  OkResult,
  Subscription,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants (spec §2 + Error handling)
// ---------------------------------------------------------------------------

/** Max Buzz WS frame (ARCHITECTURE.md:161). Oversized frames are never sent. */
export const MAX_FRAME_BYTES = 65_536;

/** Clock-skew allowance subtracted from cursors on (re)subscribe (spec §2). */
export const SINCE_SKEW_SECONDS = 300;

/** NIP-42 auth event kind. */
export const AUTH_KIND = 22242;

/** Burst ceiling of the outbound token bucket: 5 sends/sec (spec §2). */
export const BURST_PER_SECOND = 5;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * `auth-required: verification failed` is ambiguous (allowlist miss vs fail-closed
 * DB error), so it is retried with reconnect + re-AUTH before going fatal.
 * 15s base with full jitter spreads 5 attempts over roughly two minutes
 * (spec Error handling).
 */
const VERIFICATION_FAILED_MAX_ATTEMPTS = 5;
const VERIFICATION_RETRY_BASE_MS = 15_000;

/** `rate-limited: too many concurrent requests` → backoff 1s, retry (spec table). */
const CONCURRENT_RETRY_MS = 1_000;

const DEFAULT_OK_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY_TIMEOUT_MS = 20_000;

/**
 * How long to wait for the relay's proactive `["AUTH", <challenge>]` after the
 * socket opens (spec §2). Without this a plain relay, a TLS-terminating proxy
 * or a dropped challenge leaves `connect()` pending forever — the whole startup
 * sequence hangs behind it and no supervisor sees a failure.
 */
const DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS = 15_000;

/** Re-issues of a persistent REQ closed with a non-retryable message. */
const CLOSED_RESUB_MAX = 3;

/**
 * Max resends of a single head-of-queue publish before it is dropped. An event
 * the relay never ACKs (OK timeout → dropConnection → resend → timeout …) would
 * otherwise sit at `queue[0]` forever and wedge every card and reply behind it.
 * Counts every attempt — dropped sockets, rate-limit retries, re-AUTH retries —
 * so no failure mode can loop unboundedly on one item.
 */
export const MAX_PUBLISH_SENDS = 5;

/** WS keepalive: send a ping this often once the socket is open (spec §2, H-1). */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** WS keepalive: terminate the socket if no pong arrives within this window. */
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A condition the bridge cannot recover from on its own. Carries operator
 * guidance verbatim from the spec's error table.
 */
export class BuzzFatalError extends Error {
  readonly guidance: string;
  readonly relayMessage: string;

  constructor(message: string, guidance: string, relayMessage = "") {
    super(`${message}\n${guidance}`);
    this.name = "BuzzFatalError";
    this.guidance = guidance;
    this.relayMessage = relayMessage;
  }
}

/** Outbound frame exceeded {@link MAX_FRAME_BYTES}; rejected locally, never sent. */
export class FrameTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `outbound frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte Buzz WS frame cap; not sent`,
    );
    this.name = "FrameTooLargeError";
    this.bytes = bytes;
  }
}

/** Transient: the socket went away before the relay answered. Item stays queued. */
class DisconnectedError extends Error {
  constructor(message = "buzz connection lost before OK") {
    super(message);
    this.name = "DisconnectedError";
  }
}

/**
 * A queued publish was resent {@link MAX_PUBLISH_SENDS} times without ever
 * being ACKed (the OK never arrived, or every attempt hit a dropped socket).
 * The item is dropped so it stops blocking every publish queued behind it.
 */
export class PublishRetriesExhaustedError extends Error {
  readonly eventId: string;
  readonly sends: number;

  constructor(eventId: string, sends: number) {
    super(
      `event ${eventId} dropped after ${sends} publish attempts without an OK`,
    );
    this.name = "PublishRetriesExhaustedError";
    this.eventId = eventId;
    this.sends = sends;
  }
}

// ---------------------------------------------------------------------------
// Logging seam
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Plain stdout JSON lines, pino-style levels (spec §1 `LOG_LEVEL`). */
export function createConsoleLogger(level: LogLevel = "info"): Logger {
  const emit = (
    lvl: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const line = JSON.stringify({
      level: lvl,
      time: new Date().toISOString(),
      component: "buzz-client",
      msg,
      ...fields,
    });
    if (lvl === "error" || lvl === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

// ---------------------------------------------------------------------------
// WebSocket keepalive / half-open watchdog (spec §2, H-1)
// ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  /** How often to send a ping while the socket is OPEN. */
  intervalMs: number;
  /** How long to wait for the matching pong before declaring the socket dead. */
  timeoutMs: number;
  /** Invoked once when a pong is missed; wire this to terminate + reconnect. */
  onDead: () => void;
}

/**
 * Half-open connection watchdog for a single WebSocket. A TCP connection can go
 * silent without a FIN — the socket stays `OPEN`, no `close` fires, and every
 * publish/subscribe hangs indefinitely. This sends an application-level ping
 * every `intervalMs`; if no `pong` comes back within `timeoutMs`, `onDead` runs
 * (the client terminates the socket and takes its normal reconnect path).
 *
 * Returns a `stop()` that clears the timers and detaches the listener. The
 * pattern is deliberately self-contained so any other single-socket client
 * (e.g. the wolfe-subscriber) can keep its own copy without sharing state.
 */
export function startHeartbeat(
  ws: WebSocket,
  { intervalMs, timeoutMs, onDead }: HeartbeatOptions,
): () => void {
  let pongTimer: NodeJS.Timeout | null = null;
  const clearPong = (): void => {
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  };
  const onPong = (): void => clearPong();
  ws.on("pong", onPong);

  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // A ping is already outstanding; wait for its pong or its deadline.
    if (pongTimer) return;
    try {
      ws.ping();
    } catch {
      return;
    }
    pongTimer = setTimeout(() => {
      pongTimer = null;
      onDead();
    }, timeoutMs);
    if (typeof pongTimer.unref === "function") pongTimer.unref();
  }, intervalMs);
  if (typeof interval.unref === "function") interval.unref();

  return () => {
    clearInterval(interval);
    clearPong();
    ws.removeListener("pong", onPong);
  };
}

// ---------------------------------------------------------------------------
// Token bucket (spec §2 outbound rate limiter)
// ---------------------------------------------------------------------------

/**
 * Two-dimensional token bucket: `BUZZ_MSGS_PER_MIN` per minute *and*
 * {@link BURST_PER_SECOND} per second. The relay allows 60 msgs/min + 10 WS
 * events/sec for the human tier; half budget leaves headroom for retries.
 */
export class TokenBucket {
  private minuteTokens: number;
  private secondTokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly perSecond: number = BURST_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {
    this.minuteTokens = perMinute;
    this.secondTokens = perSecond;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.minuteTokens = Math.min(
      this.perMinute,
      this.minuteTokens + (elapsed * this.perMinute) / 60_000,
    );
    this.secondTokens = Math.min(
      this.perSecond,
      this.secondTokens + (elapsed * this.perSecond) / 1_000,
    );
  }

  /** Consume one token, returning 0. If unavailable, returns ms to wait. */
  tryConsume(): number {
    this.refill();
    if (this.minuteTokens >= 1 && this.secondTokens >= 1) {
      this.minuteTokens -= 1;
      this.secondTokens -= 1;
      return 0;
    }
    const waitMinute =
      this.minuteTokens >= 1
        ? 0
        : ((1 - this.minuteTokens) * 60_000) / this.perMinute;
    const waitSecond =
      this.secondTokens >= 1
        ? 0
        : ((1 - this.secondTokens) * 1_000) / this.perSecond;
    return Math.max(1, Math.ceil(Math.max(waitMinute, waitSecond)));
  }
}

// ---------------------------------------------------------------------------
// Hooks / options
// ---------------------------------------------------------------------------

/**
 * Tri-state result of the {@link BuzzClientHooks.onNotChannelMember} join hook.
 *
 * - `joined` — the kind:9021 join took; retry the publish/REQ.
 * - `rejected` — a genuine membership refusal; go fatal.
 * - `unavailable` — the join could not even be *attempted* (e.g. the socket
 *   flapped mid-reconnect). This is transient: keep the connection alive and
 *   let the reconnect path retry, rather than misreport a membership problem
 *   and kill the daemon with "check channel membership".
 *
 * `boolean` is accepted for backward compatibility: `true` ≡ `joined`,
 * `false` ≡ `rejected`.
 */
export type ChannelJoinOutcome = "joined" | "rejected" | "unavailable";

export interface BuzzClientHooks {
  /**
   * Post-AUTH hook, run after every successful AUTH (initial connect and every
   * reconnect). The bridge uses it to verify the stored channel UUID still
   * resolves (spec §2 reconnect / §3 re-run triggers). Must tolerate being
   * called before ChannelManager has ever run.
   */
  onAuthenticated?: () => Promise<void> | void;
  /**
   * `invalid: channel not found` — the sole publish-side ChannelManager re-run
   * trigger (spec §3). Also emitted as the `channelLost` event.
   */
  onChannelLost?: () => Promise<void> | void;
  /**
   * `restricted: not a channel member` — attempt a kind:9021 join once.
   * Resolve `"joined"`/`true` if the join succeeded (the publish/REQ is then
   * retried); `"rejected"`/`false`/absent goes fatal; `"unavailable"` when the
   * join could not be attempted (transient) so the bridge keeps the connection
   * alive and retries instead of going fatal (spec Error handling).
   */
  onNotChannelMember?: () => Promise<ChannelJoinOutcome | boolean>;
  /** Unrecoverable condition; also emitted as the `fatal` event. */
  onFatal?: (error: BuzzFatalError) => void;
}

export interface BuzzClientOptions {
  hooks?: BuzzClientHooks;
  logger?: Logger;
  /**
   * Multiplier applied to reconnect backoff and rate-limit pauses only.
   * Production leaves this at 1; tests scale it down to keep suites fast.
   */
  timeScale?: number;
  /** How long to wait for an `OK` before dropping the connection. */
  okTimeoutMs?: number;
  /** How long a one-shot {@link BuzzClient.query} waits for EOSE. */
  queryTimeoutMs?: number;
  /** How long to wait for the relay's proactive AUTH challenge after connect. */
  authChallengeTimeoutMs?: number;
  /** Keepalive ping cadence once the socket is open (default 30s). */
  pingIntervalMs?: number;
  /** Pong deadline before the socket is treated as half-open (default 10s). */
  pongTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

interface QueueItem {
  event: NostrEvent;
  frame: string;
  resolve: (result: OkResult) => void;
  reject: (error: Error) => void;
  /** kind:9021 join already attempted for this item (spec Error handling). */
  joinAttempted: boolean;
  sends: number;
}

interface PendingOk {
  resolve: (result: OkResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SubRecord {
  id: string;
  filters: NostrFilter[];
  onEvent: EventHandler;
  onEose?: EoseHandler;
  /** Caller-provided cursor source; `since` becomes `cursor − 300` (spec §2). */
  since?: () => number;
  active: boolean;
  closed: boolean;
  /** Re-issues after a non-retryable CLOSED; reset on every fresh AUTH. */
  closedResubs: number;
}

interface QueryRecord {
  id: string;
  filters: NostrFilter[];
  events: NostrEvent[];
  resolve: (events: NostrEvent[]) => void;
  reject: (error: Error) => void;
  retried: boolean;
  /** REQ already on the wire; drives resend-on-reconnect vs first send. */
  sent: boolean;
  timer: NodeJS.Timeout;
}

type Status = "idle" | "connecting" | "ready" | "closed";

// ---------------------------------------------------------------------------
// Prefix helpers (spec Error handling table)
// ---------------------------------------------------------------------------

const P = {
  authRequired: "auth-required:",
  verificationFailed: "auth-required: verification failed",
  notRelayMember: "restricted: not a relay member",
  notChannelMember: "restricted: not a channel member",
  channelPrivate: "restricted: channel is private",
  restricted: "restricted:",
  duplicate: "duplicate:",
  channelNotFound: "invalid: channel not found",
  rateLimited: "rate-limited:",
  invalid: "invalid:",
} as const;

/** `rate-limited: quota exceeded; retry in Ns` → N seconds, else null. */
export function parseRetryInSeconds(message: string): number | null {
  const m = /retry in\s+(\d+(?:\.\d+)?)\s*s/i.exec(message);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const ALLOWLIST_GUIDANCE = [
  "Operator action required: the relay refused the bridge's NIP-42 AUTH.",
  "`BUZZ_PUBKEY_ALLOWLIST=true` must be exported BEFORE relay startup (NOSTR.md:31-32).",
  "The allowlist row itself can be added at any time, no relay restart needed:",
].join(" ");

// ---------------------------------------------------------------------------
// BuzzClient
// ---------------------------------------------------------------------------

/**
 * Owns the single WebSocket to the Buzz relay.
 *
 * Emits: `authenticated`, `disconnected`, `channelLost`, `fatal`.
 * (Events mirror {@link BuzzClientHooks}; use whichever is convenient.)
 */
export class BuzzClient extends EventEmitter implements IBuzzClient {
  private readonly config: Config;
  private readonly identity: BridgeIdentity;
  private readonly hooks: BuzzClientHooks;
  private readonly log: Logger;
  private readonly timeScale: number;
  private readonly okTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly authChallengeTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly bucket: TokenBucket;

  private ws: WebSocket | null = null;
  private status: Status = "idle";
  /** Armed on socket open, cleared by the inbound AUTH frame (spec §2). */
  private authChallengeTimer: NodeJS.Timeout | null = null;
  /** Stops the keepalive watchdog for the current socket, if running. */
  private heartbeatStop: (() => void) | null = null;

  /** Challenge for the *current* connection; issued once per connection (spec §2). */
  private challenge: string | null = null;
  /** The single stored-challenge re-AUTH allowed per connection (spec §2). */
  private authRetryUsed = false;
  private authInFlight = false;

  private reconnectAttempt = 0;
  private verificationFailures = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private fatalError: BuzzFatalError | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectSettle: {
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];

  private readonly queue: QueueItem[] = [];
  private pumping = false;
  /** Rate-limit pause deadline (`retry in Ns`); the queue never drops items. */
  private resumeAt = 0;

  private readonly pending = new Map<string, PendingOk>();
  private readonly subs = new Map<string, SubRecord>();
  private readonly queries = new Map<string, QueryRecord>();
  private querySeq = 0;

  constructor(
    config: Config,
    identity: BridgeIdentity,
    options: BuzzClientOptions = {},
  ) {
    super();
    this.config = config;
    this.identity = identity;
    this.hooks = options.hooks ?? {};
    this.log = options.logger ?? createConsoleLogger(config.logLevel);
    this.timeScale = options.timeScale ?? 1;
    this.okTimeoutMs = options.okTimeoutMs ?? DEFAULT_OK_TIMEOUT_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.authChallengeTimeoutMs =
      options.authChallengeTimeoutMs ?? DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.bucket = new TokenBucket(config.buzzMsgsPerMin, BURST_PER_SECOND);
  }

  // -- public surface -------------------------------------------------------

  /** True once the proactive-AUTH handshake has been answered with OK-true. */
  get authenticated(): boolean {
    return this.status === "ready";
  }

  /** Number of publishes waiting on the rate limiter / auth / retries. */
  get queueLength(): number {
    return this.queue.length;
  }

  connect(): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.status === "closed") {
      return Promise.reject(new Error("BuzzClient is closed"));
    }
    if (!this.connectPromise) {
      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.connectSettle = { resolve, reject };
      });
      this.openSocket();
    }
    return this.connectPromise;
  }

  publish(event: NostrEvent): Promise<OkResult> {
    // §2 frame budget: reject locally, never put an oversized frame on the wire.
    const frame = JSON.stringify(["EVENT", event]);
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > MAX_FRAME_BYTES) {
      const err = new FrameTooLargeError(bytes);
      this.log.error("outbound frame too large; dropped locally", {
        eventId: event.id,
        kind: event.kind,
        bytes,
        max: MAX_FRAME_BYTES,
      });
      return Promise.reject(err);
    }
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.status === "closed") {
      return Promise.reject(new Error("BuzzClient is closed"));
    }
    return new Promise<OkResult>((resolve, reject) => {
      this.queue.push({
        event,
        frame,
        resolve,
        reject,
        joinAttempted: false,
        sends: 0,
      });
      void this.pump().catch((err: unknown) => {
        this.log.error("publish pump crashed", {
          error: (err as Error).message,
        });
      });
    });
  }

  /**
   * Send an event immediately, bypassing the outbound queue and token bucket.
   *
   * Only for events published from **inside** a failure hook: those run on the
   * publish pump's own stack, so a queued publish there would wait for a pump
   * that is itself waiting for the hook. Today that is exactly the kind:9021
   * join triggered by `restricted: not a channel member` (spec Error handling).
   * Everything else must go through {@link publish}.
   */
  publishNow(event: NostrEvent): Promise<OkResult> {
    const frame = JSON.stringify(["EVENT", event]);
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > MAX_FRAME_BYTES) {
      return Promise.reject(new FrameTooLargeError(bytes));
    }
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.status !== "ready") {
      return Promise.reject(new DisconnectedError("not authenticated"));
    }
    return this.awaitOk(event.id, frame);
  }

  /**
   * @param since Optional cursor source. When given, every filter is (re)issued
   * with `since = cursor − 300`, including after a reconnect (spec §2).
   */
  subscribe(
    subId: string,
    filters: NostrFilter[],
    onEvent: EventHandler,
    onEose?: EoseHandler,
    since?: () => number,
  ): Subscription {
    assertExplicitKinds(filters);
    const record: SubRecord = {
      id: subId,
      filters,
      onEvent,
      ...(onEose ? { onEose } : {}),
      ...(since ? { since } : {}),
      active: false,
      closed: false,
      closedResubs: 0,
    };
    this.subs.set(subId, record);
    if (this.status === "ready") this.sendReq(record);
    return {
      id: subId,
      close: () => {
        record.closed = true;
        this.subs.delete(subId);
        if (this.status === "ready" && record.active) {
          this.trySendFrame(JSON.stringify(["CLOSE", subId]));
        }
      },
    };
  }

  query(subId: string, filters: NostrFilter[]): Promise<NostrEvent[]> {
    try {
      assertExplicitKinds(filters);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    // Sub ids must be unique on the wire; callers reuse logical ids across runs.
    const wireId = this.queries.has(subId)
      ? `${subId}-${++this.querySeq}`
      : subId;
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const record: QueryRecord = {
        id: wireId,
        filters,
        events: [],
        resolve,
        reject,
        retried: false,
        sent: false,
        timer: setTimeout(() => {
          this.queries.delete(wireId);
          reject(new Error(`query ${wireId} timed out waiting for EOSE`));
        }, this.queryTimeoutMs),
      };
      this.queries.set(wireId, record);
      void this.startQuery(record);
    });
  }

  close(): void {
    this.status = "closed";
    this.closeSocket();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const err = this.fatalError ?? new Error("BuzzClient closed");
    this.failEverything(err);
  }

  // -- connection lifecycle -------------------------------------------------

  private openSocket(): void {
    if (this.status === "closed" || this.fatalError) return;
    this.status = "connecting";
    this.challenge = null;
    this.authRetryUsed = false;
    this.authInFlight = false;

    const url = this.config.buzzRelayUrl;
    this.log.debug("connecting to buzz relay", { url });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.log.debug("buzz socket open; awaiting proactive AUTH challenge", {
        url,
      });
      // H-1: a half-open TCP connection stays OPEN with no `close` event, so
      // arm the keepalive watchdog the moment the socket is usable.
      this.startWatchdog(ws);
      // §2: the relay sends the challenge unprompted. If it never arrives the
      // socket is healthy but useless, and connect() would hang forever.
      this.clearAuthChallengeTimer();
      const timer = setTimeout(() => {
        this.authChallengeTimer = null;
        if (this.ws !== ws || this.status === "ready") return;
        this.log.error("no AUTH challenge from buzz relay; reconnecting", {
          url,
          timeoutMs: this.authChallengeTimeoutMs,
        });
        this.dropConnection("no AUTH challenge");
      }, this.authChallengeTimeoutMs * this.timeScale);
      if (typeof timer.unref === "function") timer.unref();
      this.authChallengeTimer = timer;
    });
    ws.on("message", (data: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      this.onMessage(data.toString());
    });
    ws.on("error", (err: Error) => {
      this.log.warn("buzz socket error", { error: err.message });
    });
    ws.on("close", (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onSocketClosed(code);
    });
  }

  private onSocketClosed(code: number): void {
    const wasReady = this.status === "ready";
    if (this.status !== "closed") this.status = "connecting";
    this.clearAuthChallengeTimer();
    this.stopWatchdog();
    this.challenge = null;
    this.authInFlight = false;
    for (const sub of this.subs.values()) sub.active = false;

    const err = new DisconnectedError(`buzz socket closed (code ${code})`);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();

    // In-flight queries retry once on the next connection.
    for (const record of [...this.queries.values()]) {
      if (record.retried) {
        clearTimeout(record.timer);
        this.queries.delete(record.id);
        record.reject(err);
      } else {
        record.retried = true;
        record.events = [];
        // `sent` stays true so completeAuth re-issues the REQ on the new
        // connection (startQuery has already returned for this record).
        // Re-arm the EOSE deadline: reconnect backoff routinely exceeds the
        // query timeout, so leaving the original timer running would reject a
        // query that is deliberately being retried — taking startup (channel
        // discovery) down with it on a transient relay bounce (§2).
        clearTimeout(record.timer);
        record.timer = setTimeout(() => {
          this.queries.delete(record.id);
          record.reject(
            new Error(`query ${record.id} timed out waiting for EOSE`),
          );
        }, this.queryTimeoutMs);
      }
    }

    if (wasReady) this.log.warn("buzz connection lost", { code });
    this.emit("disconnected", code);
    if (this.status === "closed" || this.fatalError) return;
    this.scheduleReconnect();
  }

  /** Exponential backoff 1s → 60s cap, full jitter, infinite retries (spec §2). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base =
      this.verificationFailures > 0
        ? VERIFICATION_RETRY_BASE_MS * 2 ** (this.verificationFailures - 1)
        : RECONNECT_BASE_MS * 2 ** this.reconnectAttempt;
    const capped = Math.min(RECONNECT_MAX_MS, base);
    const delay = Math.random() * capped * this.timeScale;
    this.reconnectAttempt += 1;
    this.log.debug("scheduling buzz reconnect", {
      attempt: this.reconnectAttempt,
      delayMs: Math.round(delay),
      verificationFailures: this.verificationFailures,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearAuthChallengeTimer(): void {
    if (this.authChallengeTimer === null) return;
    clearTimeout(this.authChallengeTimer);
    this.authChallengeTimer = null;
  }

  /** Arm the half-open watchdog for `ws`; a missed pong drops the connection. */
  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    this.heartbeatStop = startHeartbeat(ws, {
      intervalMs: this.pingIntervalMs,
      timeoutMs: this.pongTimeoutMs,
      onDead: () => {
        if (this.ws !== ws) return;
        this.log.error("buzz relay missed pong; terminating half-open socket", {
          pongTimeoutMs: this.pongTimeoutMs,
        });
        this.dropConnection("missed pong");
      },
    });
  }

  private stopWatchdog(): void {
    if (this.heartbeatStop) {
      this.heartbeatStop();
      this.heartbeatStop = null;
    }
  }

  private closeSocket(): void {
    this.clearAuthChallengeTimer();
    this.stopWatchdog();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      // A socket torn down mid-handshake still emits `error` asynchronously,
      // and `ws` rethrows an `error` event with no listener — which would take
      // the whole daemon down from inside a routine reconnect.
      ws.on("error", () => undefined);
      ws.close();
      ws.terminate();
    } catch {
      /* already gone */
    }
  }

  /** Drop the connection so the next AUTH gets a fresh challenge (spec §2). */
  private dropConnection(reason: string): void {
    this.log.warn("dropping buzz connection", { reason });
    const ws = this.ws;
    this.closeSocket();
    if (ws) {
      // Synthesize the close path we detached from above.
      this.onSocketClosed(4000);
    }
  }

  // -- wire ----------------------------------------------------------------

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn("unparseable frame from buzz relay", {
        preview: raw.slice(0, 120),
      });
      return;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return;
    const arr = parsed as unknown[];
    const type = arr[0] as string;

    switch (type) {
      case "AUTH": {
        const challenge = arr[1];
        if (typeof challenge !== "string") return;
        this.clearAuthChallengeTimer();
        this.challenge = challenge;
        this.log.debug("received proactive AUTH challenge");
        void this.runAuth();
        return;
      }
      case "OK": {
        const id = arr[1];
        const ok = arr[2];
        const message = arr[3];
        if (typeof id !== "string" || typeof ok !== "boolean") return;
        const p = this.pending.get(id);
        if (!p) {
          this.log.debug("OK for unknown event id", { id });
          return;
        }
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({
          id,
          ok,
          message: typeof message === "string" ? message : "",
        });
        return;
      }
      case "EVENT": {
        const subId = arr[1];
        const event = arr[2];
        if (typeof subId !== "string" || !isNostrEvent(event)) return;
        const q = this.queries.get(subId);
        if (q) {
          q.events.push(event);
          return;
        }
        const sub = this.subs.get(subId);
        if (!sub || sub.closed) return;
        try {
          sub.onEvent(event);
        } catch (err) {
          this.log.error("subscription handler threw", {
            subId,
            error: (err as Error).message,
          });
        }
        return;
      }
      case "EOSE": {
        const subId = arr[1];
        if (typeof subId !== "string") return;
        const q = this.queries.get(subId);
        if (q) {
          clearTimeout(q.timer);
          this.queries.delete(subId);
          this.trySendFrame(JSON.stringify(["CLOSE", subId]));
          q.resolve(q.events);
          return;
        }
        const sub = this.subs.get(subId);
        sub?.onEose?.();
        return;
      }
      case "CLOSED": {
        const subId = arr[1];
        const message = arr[2];
        if (typeof subId !== "string") return;
        void this.handleClosed(
          subId,
          typeof message === "string" ? message : "",
        ).catch((err: unknown) => {
          this.log.error("CLOSED handler crashed", {
            subId,
            error: (err as Error).message,
          });
        });
        return;
      }
      case "NOTICE": {
        this.log.info("relay notice", { notice: String(arr[1] ?? "") });
        return;
      }
      default:
        return;
    }
  }

  private trySendFrame(frame: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      this.log.error("outbound frame too large; not sent", {
        bytes: Buffer.byteLength(frame, "utf8"),
        max: MAX_FRAME_BYTES,
      });
      return false;
    }
    ws.send(frame);
    return true;
  }

  private awaitOk(id: string, frame: string): Promise<OkResult> {
    return new Promise<OkResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DisconnectedError(`no OK for ${id} within ${this.okTimeoutMs}ms`),
        );
        this.dropConnection("OK timeout");
      }, this.okTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.trySendFrame(frame)) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DisconnectedError("socket not open"));
      }
    });
  }

  // -- AUTH (spec §2) -------------------------------------------------------

  private buildAuthEvent(challenge: string): NostrEvent {
    // Tags: challenge + relay with the DIALED url verbatim — the relay
    // URL-normalizes both sides (nip42.rs:47-64), so verbatim is correct for
    // local dev and required to match the community host when hosted (§2).
    return finalizeEvent(
      {
        kind: AUTH_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challenge],
          ["relay", this.config.buzzRelayUrl],
        ],
        content: "",
      },
      this.identity.secretKey,
    ) as unknown as NostrEvent;
  }

  private async sendAuth(challenge: string): Promise<OkResult> {
    const event = this.buildAuthEvent(challenge);
    return this.awaitOk(event.id, JSON.stringify(["AUTH", event]));
  }

  private async runAuth(): Promise<void> {
    if (this.authInFlight) return;
    const challenge = this.challenge;
    if (!challenge) return;
    this.authInFlight = true;
    try {
      let res: OkResult;
      try {
        res = await this.sendAuth(challenge);
      } catch (err) {
        this.log.warn("AUTH send failed", { error: (err as Error).message });
        return;
      }
      if (res.ok) {
        await this.completeAuth();
        return;
      }
      if (isVerificationFailed(res.message)) {
        this.onVerificationFailed(res.message);
        return;
      }
      // Generic rejection: one retry with the STORED challenge (issued once per
      // connection), then drop the connection to obtain a fresh one (§2).
      if (!this.authRetryUsed) {
        this.authRetryUsed = true;
        this.log.warn("AUTH rejected; retrying once with stored challenge", {
          message: res.message,
        });
        let retry: OkResult;
        try {
          retry = await this.sendAuth(challenge);
        } catch (err) {
          this.log.warn("AUTH retry send failed", {
            error: (err as Error).message,
          });
          return;
        }
        if (retry.ok) {
          await this.completeAuth();
          return;
        }
        if (isVerificationFailed(retry.message)) {
          this.onVerificationFailed(retry.message);
          return;
        }
      }
      this.dropConnection(`AUTH rejected: ${res.message}`);
    } finally {
      this.authInFlight = false;
    }
  }

  private async completeAuth(): Promise<void> {
    this.status = "ready";
    this.reconnectAttempt = 0;
    this.verificationFailures = 0;
    this.log.info("authenticated with buzz relay", {
      url: this.config.buzzRelayUrl,
      pubkey: this.identity.publicKey,
    });
    this.emit("authenticated");

    for (const sub of this.subs.values()) {
      sub.closedResubs = 0;
      if (!sub.closed) this.sendReq(sub);
    }
    for (const record of this.queries.values()) {
      // Re-issue already-sent one-shot REQs from scratch on the new connection.
      // Not-yet-sent ones are sent by startQuery once waitReady() resolves.
      if (!record.sent) continue;
      record.events = [];
      this.sendReqFrame(record.id, record.filters);
    }

    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
    void this.pump().catch((err: unknown) => {
      this.log.error("publish pump crashed", {
        error: (err as Error).message,
      });
    });

    // Post-AUTH hook: channel verification on every reconnect (§2/§3).
    try {
      await this.hooks.onAuthenticated?.();
    } catch (err) {
      this.log.error("post-auth hook threw", {
        error: (err as Error).message,
      });
    }

    const settle = this.connectSettle;
    this.connectSettle = null;
    settle?.resolve();
  }

  /**
   * `auth-required: verification failed` — ambiguous (allowlist miss vs
   * fail-closed DB error). Backoff-reconnect + re-AUTH up to
   * {@link VERIFICATION_FAILED_MAX_ATTEMPTS}, then fatal with guidance.
   */
  private onVerificationFailed(message: string): void {
    this.verificationFailures += 1;
    if (this.verificationFailures >= VERIFICATION_FAILED_MAX_ATTEMPTS) {
      this.fatal(
        `buzz relay rejected AUTH with "${message}" ${this.verificationFailures} times`,
        `${ALLOWLIST_GUIDANCE} INSERT INTO pubkey_allowlist (pubkey) VALUES (decode('${this.identity.publicKey}','hex'));`,
        message,
      );
      return;
    }
    this.log.warn("AUTH verification failed; will reconnect and retry", {
      attempt: this.verificationFailures,
      max: VERIFICATION_FAILED_MAX_ATTEMPTS,
      message,
    });
    this.dropConnection(`auth verification failed (${message})`);
  }

  private waitReady(): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.status === "closed") {
      return Promise.reject(new Error("BuzzClient is closed"));
    }
    if (this.status === "ready") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  // -- subscriptions --------------------------------------------------------

  private resolveFilters(sub: SubRecord): NostrFilter[] {
    if (!sub.since) return sub.filters;
    const cursor = sub.since();
    const since = Math.max(0, Math.floor(cursor) - SINCE_SKEW_SECONDS);
    return sub.filters.map((f) => ({ ...f, since }));
  }

  private sendReq(sub: SubRecord): void {
    if (this.sendReqFrame(sub.id, this.resolveFilters(sub))) sub.active = true;
  }

  private sendReqFrame(subId: string, filters: NostrFilter[]): boolean {
    return this.trySendFrame(JSON.stringify(["REQ", subId, ...filters]));
  }

  /**
   * Run the kind:9021 join hook and classify the result (spec Error handling,
   * H-3). A thrown error is logged with its message *and* type — never silently
   * discarded — and mapped to `unavailable` when it is a transient
   * {@link DisconnectedError} (a socket flap mid-reconnect) rather than a
   * membership refusal.
   */
  private async attemptChannelJoin(): Promise<ChannelJoinOutcome> {
    const hook = this.hooks.onNotChannelMember;
    if (!hook) return "rejected";
    try {
      return normalizeJoinOutcome(await hook());
    } catch (err) {
      const e = err as Error;
      this.log.error("channel join hook threw", {
        error: e.message,
        type: e.name,
      });
      return e instanceof DisconnectedError ? "unavailable" : "rejected";
    }
  }

  private async startQuery(record: QueryRecord): Promise<void> {
    try {
      await this.waitReady();
    } catch (err) {
      clearTimeout(record.timer);
      this.queries.delete(record.id);
      record.reject(err as Error);
      return;
    }
    if (!this.queries.has(record.id) || record.sent) return;
    record.sent = true;
    this.sendReqFrame(record.id, record.filters);
  }

  /** CLOSED carries the same prefix vocabulary as OK-false (spec Error handling). */
  private async handleClosed(subId: string, message: string): Promise<void> {
    const query = this.queries.get(subId);
    const sub = this.subs.get(subId);
    if (!query && !sub) return;

    const retryable =
      message.startsWith(P.authRequired) || message.startsWith(P.rateLimited);

    this.log.warn("subscription CLOSED by relay", { subId, message });

    if (message.startsWith(P.notRelayMember)) {
      this.fatal(
        `buzz relay closed ${subId}: ${message}`,
        "Add the bridge as a relay member: `buzz-admin add-member <npub>` (NOSTR.md:210-297).",
        message,
      );
      return;
    }
    if (message.startsWith(P.channelPrivate)) {
      this.fatal(
        `buzz relay closed ${subId}: ${message}`,
        "The Services channel exists but is private; the bridge will not force its way in. Re-create it as an open channel or grant the bridge membership.",
        message,
      );
      return;
    }
    if (message.startsWith(P.notChannelMember)) {
      const outcome = await this.attemptChannelJoin();
      if (outcome === "joined") {
        if (sub) this.sendReq(sub);
        else if (query) this.sendReqFrame(query.id, query.filters);
        return;
      }
      if (outcome === "unavailable") {
        // Transient: the join could not be attempted (e.g. a socket flap during
        // a reconnect), not a genuine membership refusal. Keep the subscription
        // alive; the reconnect path re-issues it once AUTH completes. Going
        // fatal here would kill the daemon on a coincidental socket bounce.
        this.log.warn(
          "channel join unavailable; keeping subscription for reconnect",
          { subId, message },
        );
        if (sub) sub.active = false;
        return;
      }
      this.fatal(
        `buzz relay closed ${subId}: ${message}`,
        "kind:9021 join did not take; the bridge cannot read the channel. Check channel membership.",
        message,
      );
      return;
    }

    if (!retryable) {
      if (query) {
        clearTimeout(query.timer);
        this.queries.delete(subId);
        query.reject(new Error(`REQ ${subId} closed: ${message}`));
        return;
      }
      // A persistent sub closed with an unrecognized message must NOT be
      // abandoned: the record stays in `subs` marked active, so nothing would
      // ever re-issue it and the bridge would silently stop seeing mentions on
      // an otherwise healthy connection. Re-issue a bounded number of times,
      // then drop the connection so the reconnect path restores every sub.
      if (!sub || sub.closed) return;
      sub.active = false;
      sub.closedResubs += 1;
      if (sub.closedResubs > CLOSED_RESUB_MAX) {
        this.log.error("subscription closed repeatedly; dropping connection", {
          subId,
          message,
          attempts: sub.closedResubs,
        });
        this.dropConnection(`subscription ${subId} closed: ${message}`);
        return;
      }
      this.log.error("subscription closed with a non-retryable message", {
        subId,
        message,
        attempt: sub.closedResubs,
      });
      await this.delay(CONCURRENT_RETRY_MS * 2 ** (sub.closedResubs - 1));
      if (this.status === "ready" && !sub.closed) this.sendReq(sub);
      return;
    }

    if (message.startsWith(P.authRequired)) {
      if (isVerificationFailed(message)) {
        this.onVerificationFailed(message);
        return;
      }
      await this.reauthOnce(message);
    } else {
      const seconds = parseRetryInSeconds(message);
      await this.delay(
        seconds !== null ? seconds * 1_000 : CONCURRENT_RETRY_MS,
      );
    }

    if (this.status !== "ready") return; // resubscribe happens after re-AUTH
    if (sub && !sub.closed) this.sendReq(sub);
    else if (query && this.queries.has(subId)) {
      this.sendReqFrame(query.id, query.filters);
    }
  }

  /**
   * Stored-challenge re-AUTH, once per connection; a second failure drops the
   * connection so backoff-reconnect can fetch a fresh challenge (spec §2).
   */
  private async reauthOnce(reason: string): Promise<void> {
    const challenge = this.challenge;
    if (this.status !== "ready" || !challenge) return;
    if (this.authRetryUsed) {
      this.dropConnection(
        `auth-required again after stored-challenge retry (${reason})`,
      );
      return;
    }
    this.authRetryUsed = true;
    this.log.warn("auth-required; re-AUTHing with stored challenge", {
      reason,
    });
    let res: OkResult;
    try {
      res = await this.sendAuth(challenge);
    } catch (err) {
      this.log.warn("stored-challenge re-AUTH failed to send", {
        error: (err as Error).message,
      });
      return;
    }
    if (res.ok) {
      this.log.info("stored-challenge re-AUTH accepted");
      return;
    }
    if (isVerificationFailed(res.message)) {
      this.onVerificationFailed(res.message);
      return;
    }
    this.dropConnection(`stored-challenge re-AUTH rejected: ${res.message}`);
  }

  // -- publish queue --------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (
        this.queue.length > 0 &&
        this.status !== "closed" &&
        !this.fatalError
      ) {
        try {
          await this.waitReady();
        } catch {
          return; // closed or fatal; failEverything already settled the queue
        }
        // `item` is captured outside the body try so the catch can settle it if
        // an unexpected throw (e.g. a channelLost/onFatal listener) escapes.
        let item: QueueItem | undefined;
        try {
          await this.waitForResume();
          const wait = this.bucket.tryConsume();
          if (wait > 0) {
            await this.delayRaw(wait);
            continue;
          }
          item = this.queue[0];
          if (!item) continue;

          // H-5: bound head-of-line retries. Every attempt increments
          // `item.sends` (dropped sockets, rate-limit retries, re-AUTH retries),
          // so an event the relay never ACKs is dropped instead of wedging the
          // queue forever. Checked before the next send so exactly
          // MAX_PUBLISH_SENDS attempts are made.
          if (item.sends >= MAX_PUBLISH_SENDS) {
            this.dequeue(item);
            const exhausted = new PublishRetriesExhaustedError(
              item.event.id,
              item.sends,
            );
            this.log.error(
              "publish dropped after exhausting resends; unblocking queue",
              {
                eventId: item.event.id,
                kind: item.event.kind,
                sends: item.sends,
                queueLength: this.queue.length,
              },
            );
            item.reject(exhausted);
            continue;
          }

          let res: OkResult;
          try {
            item.sends += 1;
            res = await this.awaitOk(item.event.id, item.frame);
          } catch (err) {
            if (err instanceof DisconnectedError) {
              // Item stays queued; retried after reconnect, capped above.
              continue;
            }
            this.dequeue(item);
            item.reject(err as Error);
            continue;
          }

          if (res.ok) {
            this.dequeue(item);
            item.resolve(res);
            continue;
          }
          const action = await this.handleOkFailure(item, res);
          if (action === "settled") this.dequeue(item);
        } catch (err) {
          // An unexpected throw must not escape as an unhandled rejection (which
          // can kill the daemon) nor strand the in-flight item unsettled.
          this.log.error("publish pump iteration threw; settling item", {
            error: (err as Error).message,
            eventId: item?.event.id,
            queueLength: this.queue.length,
          });
          if (item) {
            this.dequeue(item);
            item.reject(err as Error);
          }
        }
      }
    } finally {
      this.pumping = false;
      if (
        this.queue.length > 0 &&
        this.status === "ready" &&
        !this.fatalError
      ) {
        void this.pump().catch((err: unknown) => {
          this.log.error("publish pump crashed", {
            error: (err as Error).message,
          });
        });
      }
    }
  }

  private dequeue(item: QueueItem): void {
    const idx = this.queue.indexOf(item);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  /** The OK-false matrix from the spec's Error handling table. */
  private async handleOkFailure(
    item: QueueItem,
    res: OkResult,
  ): Promise<"settled" | "retry"> {
    const msg = res.message;

    // auth-required: verification failed → backoff-retry, then fatal.
    if (isVerificationFailed(msg)) {
      this.onVerificationFailed(msg);
      return this.fatalError ? "settled" : "retry";
    }

    // auth-required: (generic) → stored-challenge re-AUTH once, else reconnect.
    if (msg.startsWith(P.authRequired)) {
      await this.reauthOnce(msg);
      return this.fatalError ? "settled" : "retry";
    }

    // restricted: not a relay member → fatal with guidance.
    if (msg.startsWith(P.notRelayMember)) {
      this.fatal(
        `publish rejected: ${msg}`,
        "NIP-43 relay membership is required. Run: `buzz-admin add-member <npub>` (NOSTR.md:210-297).",
        msg,
      );
      return "settled";
    }

    // restricted: not a channel member → kind:9021 join once, retry, then fatal.
    if (msg.startsWith(P.notChannelMember)) {
      if (!item.joinAttempted && this.hooks.onNotChannelMember) {
        item.joinAttempted = true;
        const outcome = await this.attemptChannelJoin();
        if (outcome === "joined") return "retry";
        if (outcome === "unavailable") {
          // Transient: the join could not be attempted (socket flap). Don't go
          // fatal and don't burn the single join attempt — retry the publish;
          // the per-item send cap (MAX_PUBLISH_SENDS) bounds the loop.
          item.joinAttempted = false;
          return "retry";
        }
      }
      this.fatal(
        `publish rejected: ${msg}`,
        "The bridge is not a member of the Services channel and the kind:9021 join did not take. Check the channel's visibility and membership.",
        msg,
      );
      return "settled";
    }

    // restricted: channel is private → fatal, the bridge will not force in.
    if (msg.startsWith(P.channelPrivate)) {
      this.fatal(
        `publish rejected: ${msg}`,
        "The Services channel was re-created as private. Re-create it as `visibility=open` or add the bridge as a channel member.",
        msg,
      );
      return "settled";
    }

    // duplicate: … (incl. `duplicate: channel already exists`) → caller decides.
    if (msg.startsWith(P.duplicate)) {
      this.log.info("publish returned duplicate; passing through to caller", {
        eventId: item.event.id,
        kind: item.event.kind,
        message: msg,
      });
      return this.settle(item, res);
    }

    // invalid: channel not found → clear channelId / re-run ChannelManager (§3).
    if (msg.startsWith(P.channelNotFound)) {
      this.log.warn("channel not found; signalling channelLost", {
        eventId: item.event.id,
        kind: item.event.kind,
      });
      this.emit("channelLost");
      try {
        await this.hooks.onChannelLost?.();
      } catch (err) {
        this.log.error("channelLost hook threw", {
          error: (err as Error).message,
        });
      }
      return this.settle(item, res);
    }

    // rate-limited: … → pause the queue, never drop the message.
    if (msg.startsWith(P.rateLimited)) {
      const seconds = parseRetryInSeconds(msg);
      const pauseMs = seconds !== null ? seconds * 1_000 : CONCURRENT_RETRY_MS;
      this.log.warn("publish rate-limited; pausing queue", {
        eventId: item.event.id,
        pauseMs,
        message: msg,
      });
      this.pauseQueue(pauseMs);
      return "retry";
    }

    // restricted: (anything else) → not transient; drop with an error log.
    if (msg.startsWith(P.restricted)) {
      this.log.error("publish rejected (restricted); dropping message", {
        message: msg,
        event: item.event,
      });
      return this.settle(item, res);
    }

    // invalid: (anything else) → bug, not transient: log full event and drop.
    if (msg.startsWith(P.invalid)) {
      this.log.error("publish rejected (invalid); dropping message", {
        message: msg,
        event: item.event,
      });
      return this.settle(item, res);
    }

    this.log.error("publish rejected with unrecognized prefix; dropping", {
      message: msg,
      event: item.event,
    });
    return this.settle(item, res);
  }

  /** Remove the item from the queue *before* settling the caller's promise. */
  private settle(item: QueueItem, res: OkResult): "settled" {
    this.dequeue(item);
    item.resolve(res);
    return "settled";
  }

  private pauseQueue(ms: number): void {
    const until = Date.now() + ms * this.timeScale;
    this.resumeAt = Math.max(this.resumeAt, until);
  }

  private async waitForResume(): Promise<void> {
    for (;;) {
      const remaining = this.resumeAt - Date.now();
      if (remaining <= 0) return;
      await this.delayRaw(remaining);
    }
  }

  private delay(ms: number): Promise<void> {
    return this.delayRaw(ms * this.timeScale);
  }

  private delayRaw(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  // -- fatal ---------------------------------------------------------------

  private fatal(message: string, guidance: string, relayMessage: string): void {
    if (this.fatalError) return;
    const err = new BuzzFatalError(message, guidance, relayMessage);
    this.fatalError = err;
    this.log.error("fatal buzz condition; stopping", {
      message,
      guidance,
      relayMessage,
    });
    this.status = "closed";
    this.closeSocket();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failEverything(err);
    this.emit("fatal", err);
    this.hooks.onFatal?.(err);
  }

  private failEverything(err: Error): void {
    const settle = this.connectSettle;
    this.connectSettle = null;
    settle?.reject(err);

    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(err);

    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();

    const queued = this.queue.splice(0, this.queue.length);
    for (const item of queued) item.reject(err);

    for (const [, q] of this.queries) {
      clearTimeout(q.timer);
      q.reject(err);
    }
    this.queries.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * All REQs must carry explicit `kinds` — omitting them trips the relay's
 * p-gate 403 (spec §2; req.rs:1042).
 */
export function assertExplicitKinds(filters: NostrFilter[]): void {
  if (filters.length === 0) throw new Error("REQ requires at least one filter");
  for (const f of filters) {
    if (!f.kinds || f.kinds.length === 0) {
      throw new Error(
        "every buzz REQ filter must carry explicit `kinds` (p-gate 403 otherwise)",
      );
    }
  }
}

function isVerificationFailed(message: string): boolean {
  return message.startsWith(P.verificationFailed);
}

/** Map the backward-compatible boolean form onto the tri-state outcome. */
function normalizeJoinOutcome(
  value: ChannelJoinOutcome | boolean,
): ChannelJoinOutcome {
  if (value === true) return "joined";
  if (value === false) return "rejected";
  return value;
}

/**
 * Structural admission check for an untrusted inbound event frame. Mirrors the
 * wolfe-side `asNostrEvent`, including the finite-`created_at` guard (L-5).
 */
export function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["pubkey"] === "string" &&
    typeof e["kind"] === "number" &&
    // created_at must be a finite number, matching the wolfe-side
    // asNostrEvent: a missing/NaN created_at otherwise makes the staleness
    // gate (`now − created_at > 3600`) evaluate NaN > 3600 → false, so a stale
    // or malformed mention is treated as fresh (L-5).
    typeof e["created_at"] === "number" &&
    Number.isFinite(e["created_at"]) &&
    typeof e["content"] === "string" &&
    typeof e["sig"] === "string" &&
    Array.isArray(e["tags"])
  );
}
