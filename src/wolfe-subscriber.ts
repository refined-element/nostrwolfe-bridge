/** WolfeSubscriber — paged hydration + live sub on the public relay (spec §4). */

import WebSocket from "ws";

import { addressOf } from "./mirror-engine.js";
import type {
  Config,
  IWolfeSubscriber,
  NostrEvent,
  NostrFilter,
} from "./types.js";

/** Kind of a NostrWolfe capability advertisement. */
const LISTING_KIND = 38400;

/** Clock-skew allowance subtracted from the cursor for the live sub (§4). */
const CURSOR_SKEW = 300;

/**
 * Sub-id *prefixes*, matching the wire summary in the spec's data-flow table.
 * Paged REQs (hydrate/drain) append `-<page>` so each in-flight page owns a
 * distinct sub id — reusing one constant id meant a CLOSE for page N could race
 * a REQ for page N+1 on the same id, and left a server-side sub leaked whenever
 * two pages overlapped (silent-failure M-6, mirrors footer-recovery's ids).
 */
const SUB_HYDRATE = "wolfe-hydrate";
const SUB_DRAIN = "wolfe-drain";
const SUB_LIVE = "wolfe-38400";

/**
 * Bounded in-place re-issues of the live sub after a relay CLOSED before the
 * connection is dropped so the reconnect path rebuilds it (BuzzClient's
 * CLOSED_RESUB policy; silent-failure C-3).
 */
const LIVE_CLOSED_RESUB_MAX = 3;

/** Heartbeat interval; a pong must arrive before the next tick (§4, H-1). */
const DEFAULT_PING_INTERVAL_MS = 30_000;

/** Above this share of invalid/unmirrorable events a run is logged at warn. */
const HIGH_INVALID_RATIO = 0.5;

type Listener = (event: NostrEvent) => Promise<void> | void;

/** Test/ops seams; every field has a spec-mandated default. */
export interface WolfeSubscriberOptions {
  /** Backoff floor (§4 "same reconnect/backoff policy as BuzzClient": 1s). */
  minBackoffMs?: number;
  /** Backoff ceiling (60s). */
  maxBackoffMs?: number;
  /** How long one paged REQ may take before it is retried. */
  pageTimeoutMs?: number;
  /** Retries for a single page before giving up on the hydration/drain run. */
  pageRetries?: number;
  /**
   * Live count of addresses actually **tracked** by the mirror (spec §1 defines
   * `MIRROR_MAX_LISTINGS` as a cap on tracked addresses). Without it, hydration
   * counts every address it sees — including ones MirrorEngine's client-side
   * category filter then discards — so a narrow `MIRROR_CATEGORIES` would let
   * the cap be consumed by listings that are never mirrored (Open question 5).
   */
  trackedCount?: () => number;
  /** Safety valve on the `until` walk when `trackedCount` never reaches the cap. */
  maxPages?: number;
  /**
   * Keepalive ping interval (§4, H-1). A pong must arrive before the next tick
   * or the socket is `terminate()`d into the reconnect path. Seam for tests.
   */
  pingIntervalMs?: number;
}

/** Default ceiling on hydration/drain pages; see {@link WolfeSubscriberOptions.maxPages}. */
export const DEFAULT_MAX_PAGES = 200;

// ---------------------------------------------------------------------------
// Logging (plain stdout JSON lines, spec §1 LOG_LEVEL)
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PageCollector {
  events: NostrEvent[];
  resolve(events: NostrEvent[]): void;
  reject(err: Error): void;
}

/**
 * Single WebSocket to `WOLFE_RELAY_URL`. strfry is a plain relay — no AUTH, no
 * write gating — so this is REQ/EVENT/EOSE only.
 */
export class WolfeSubscriber implements IWolfeSubscriber {
  private readonly level: Level;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pageTimeoutMs: number;
  private readonly pageRetries: number;
  private readonly trackedCount: (() => number) | null;
  private readonly maxPages: number;
  private readonly pingIntervalMs: number;

  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private stopped = false;
  private attempt = 0;

  /** In-place live-sub re-issues since the last healthy live REQ (C-3). */
  private liveClosedResubs = 0;
  /** Heartbeat state for the current socket (H-1). */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;

  /** One-shot REQ collectors (hydration + gap drain), keyed by sub id. */
  private readonly pages = new Map<string, PageCollector>();

  private liveListener: Listener | null = null;
  private liveSince = 0;
  private resuming = false;
  /**
   * A reconnect arrived while {@link openLive} was already running. Dropping it
   * (the old `if (this.resuming) return;`) permanently killed the live sub
   * whenever a disconnect landed during the multi-minute gap drain, so the
   * attempt is coalesced and re-dispatched by `openLive`'s `finally` instead.
   */
  private pendingReconnect = false;
  /** Serializes async listener invocations so events are processed in order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly getCursor: () => number,
    opts: WolfeSubscriberOptions = {},
  ) {
    this.level = config.logLevel;
    this.minBackoffMs = opts.minBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.pageTimeoutMs = opts.pageTimeoutMs ?? 30_000;
    this.pageRetries = opts.pageRetries ?? 5;
    this.trackedCount = opts.trackedCount ?? null;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  // -------------------------------------------------------------------------
  // Hydration (§4)
  // -------------------------------------------------------------------------

  /**
   * Startup hydration — runs on **every** startup, cursor or not.
   *
   * Full REQ `{kinds:[38400], limit: BACKFILL_LIMIT}` with **no `since`**
   * (§4: the wolfe cursor plays no role in hydration), paging backwards with
   * `until` until the set is drained or `MIRROR_MAX_LISTINGS` distinct
   * addresses have been seen.
   */
  async hydrate(onListing: Listener): Promise<void> {
    const limit = this.config.backfillLimit;
    const maxAddresses = this.config.mirrorMaxListings;
    const seenIds = new Set<string>();
    const addresses = new Set<string>();
    let until: number | undefined;
    let atCap = false;
    let page = 0;
    // Per-run health counters so a 100%-parse-failure run is distinguishable
    // from a healthy one at the "hydration complete" line (M-1/M-2).
    let listenerErrors = 0;
    let noAddress = 0;

    try {
      for (; page < this.maxPages; page++) {
        if (this.stopped) return;
        const filter: NostrFilter = { kinds: [LISTING_KIND], limit };
        // Deliberately no `since` — hydration is cursor-independent (§4).
        if (until !== undefined) filter.until = until;

        // Unique sub id per page (M-6): a CLOSE for one page can never collide
        // with the REQ for the next on a shared id.
        const events = await this.requestPage(`${SUB_HYDRATE}-${page}`, filter);
        if (events.length === 0) break;

        let fresh = 0;
        let oldest = Number.POSITIVE_INFINITY;

        for (const event of events) {
          if (
            typeof event.created_at === "number" &&
            event.created_at < oldest
          ) {
            oldest = event.created_at;
          }
          if (seenIds.has(event.id)) continue;
          seenIds.add(event.id);
          fresh++;
          // The relay is untrusted and unauthenticated: one malformed frame
          // must never abort hydration (which re-runs from scratch every
          // startup, so an abort here is a crash loop the open relay can
          // trigger, §4/sec §2).
          try {
            await onListing(event);
            // §5: address the same way MirrorEngine does (sanitized `d`), so
            // the cap's fallback accounting measures the identical address set
            // rather than a raw-`d` set that drifts from it (L-2).
            const address = addressOf(event);
            if (address !== null) addresses.add(address);
            else noAddress++;
          } catch (err) {
            listenerErrors++;
            this.log("error", "hydration listener failed for 38400", {
              id: event.id,
              error: String(err),
            });
          }
          // §1: the cap counts addresses actually *tracked*. `trackedCount` is
          // the mirror's own tally (post category filter); the seen-address set
          // is only the fallback when no counter is wired in.
          const tracked = this.trackedCount?.() ?? addresses.size;
          if (tracked >= maxAddresses) {
            atCap = true;
            break;
          }
        }

        if (atCap) {
          this.log("warn", "hydration stopped at MIRROR_MAX_LISTINGS", {
            addresses: addresses.size,
            tracked: this.trackedCount?.() ?? addresses.size,
          });
          break;
        }

        const next = this.nextUntil(events, fresh, oldest, limit, until);
        // A relay may cap a page below `limit`, so page-shortness is NOT a drain
        // signal (§4); only an empty page or a genuinely exhausted window ends it.
        if (next === null) break;
        until = next;
      }
    } catch (err) {
      // A page that stayed unrecoverable through the whole retry ladder (e.g. a
      // persistent CLOSED, C-2) is a HARD hydration failure — surfaced so the
      // boot fails loudly, never a silently-empty mirror.
      this.log("error", "hydration failed", {
        page,
        events: seenIds.size,
        addresses: addresses.size,
        error: String(err),
      });
      throw err;
    }

    if (page >= this.maxPages) {
      this.log("warn", "hydration stopped at the page ceiling", {
        maxPages: this.maxPages,
        addresses: addresses.size,
      });
    }

    const mirrored = this.trackedCount?.() ?? addresses.size;
    const invalid = listenerErrors + noAddress;
    const ratio = seenIds.size > 0 ? invalid / seenIds.size : 0;
    // Zero mirrored listings, or a mostly-invalid run, is not a healthy startup
    // even though it "completed" — surface it at warn (M-1/M-2).
    const degraded = mirrored === 0 || ratio > HIGH_INVALID_RATIO;
    this.log(degraded ? "warn" : "info", "hydration complete", {
      events: seenIds.size,
      addresses: addresses.size,
      mirrored,
      listenerErrors,
      invalid,
    });
  }

  /**
   * Next `until` for a backwards page walk, or null when the window is drained.
   *
   * `until` is inclusive, so the normal step is `until = oldest`. If a full page
   * yielded no new ids, every event at `oldest` that the relay is willing to
   * return has been consumed and repeating `until = oldest` would spin on the
   * same set forever — the walk steps to `oldest − 1` instead. (A page of
   * `limit` events all sharing one `created_at` is realistic for the automated
   * bulk publishers §5's same-second tie-break exists for.)
   */
  private nextUntil(
    events: NostrEvent[],
    fresh: number,
    oldest: number,
    limit: number,
    previousUntil: number | undefined,
  ): number | null {
    if (!Number.isFinite(oldest)) return null;
    // Progress was made; re-request inclusively so nothing at `oldest` is lost.
    // Termination is guaranteed because the seen-id set only ever grows.
    if (fresh > 0) return oldest;
    // No new ids: only a *full* page can still be hiding events below `oldest`.
    if (events.length < limit) return null;
    // Step strictly below the window we just asked for. `Math.min` with the
    // previous `until` keeps the walk monotonic even against a relay that
    // ignores `until` and replays the same newest-first page.
    return Math.min(oldest, previousUntil ?? oldest) - 1;
  }

  // -------------------------------------------------------------------------
  // Live subscription (§4)
  // -------------------------------------------------------------------------

  /**
   * Persistent live sub `{kinds:[38400], since: cursor − 300}` with **no
   * `limit`** — relays apply `limit` newest-first, so `since` + `limit` on
   * reconnect silently drops the oldest events in the window and the cursor
   * then advances past them. No server-side `#s` filter: category filtering is
   * client-side in MirrorEngine (§1).
   */
  subscribeLive(onListing: Listener): void {
    this.liveListener = onListing;
    void this.openLive(false);
  }

  private async openLive(isReconnect: boolean): Promise<void> {
    if (this.stopped || this.liveListener === null) return;
    if (this.resuming) {
      // Coalesce: the in-flight attempt re-dispatches from its `finally`.
      this.pendingReconnect = true;
      return;
    }
    this.resuming = true;
    let failed = false;
    try {
      await this.ensureOpen();
      if (isReconnect) {
        // §4: if a reconnect gap is large enough that the relay caps the
        // response, drain the window by paging with `until` before resuming.
        await this.drainGap(Math.max(0, this.getCursor() - CURSOR_SKEW));
        // Let the drained events settle so the cursor reflects them before the
        // live window is computed. This can take minutes (the listener chain is
        // publish-rate-limited), which is exactly when a socket drop lands here.
        await this.queue;
        // The socket may have died during that wait; re-establish before REQ.
        await this.ensureOpen();
      }
      const since = Math.max(0, this.getCursor() - CURSOR_SKEW);
      this.liveSince = since;
      this.send(["REQ", SUB_LIVE, { kinds: [LISTING_KIND], since }]);
      // §4 backoff parity with BuzzClient: the attempt counter resets on a
      // *useful* connection (live REQ on the wire), not on mere TCP open —
      // otherwise a relay that accepts and immediately closes is hammered at
      // sub-second intervals and the 60s ceiling is never reached.
      this.attempt = 0;
      // A freshly (re)issued live sub is healthy again: forgive the in-place
      // CLOSED re-issue budget so a later transient CLOSED gets its full ladder.
      this.liveClosedResubs = 0;
      this.log("info", "live subscription open", { since, isReconnect });
    } catch (err) {
      // A clean shutdown mid-open throws "subscriber closed" out of
      // `ensureOpen`; that is not an error, so don't emit a spurious error line
      // (L-4). `stopped` is the reliable discriminator — `ensureOpen` only
      // throws that message when `stopped` is set.
      if (this.stopped) {
        this.log("debug", "live subscription open aborted by shutdown", {});
      } else {
        failed = true;
        this.log("error", "failed to open live subscription", {
          error: String(err),
        });
      }
    } finally {
      this.resuming = false;
      const retry = this.pendingReconnect || failed;
      this.pendingReconnect = false;
      // Never leave the live sub with no socket and no pending attempt: that is
      // a silent, permanent stop to all mirroring (§4 "infinite retries").
      if (retry && !this.stopped && this.liveListener !== null) {
        void this.reconnectLive();
      }
    }
  }

  /**
   * Drain `[since, now]` by paging backwards with `until` (§4). Page-shortness
   * is not a drain signal — the whole point is that the relay capped us.
   */
  private async drainGap(since: number): Promise<void> {
    const limit = this.config.backfillLimit;
    const seenIds = new Set<string>();
    let until: number | undefined;

    for (let page = 0; page < this.maxPages; page++) {
      if (this.stopped) return;
      const filter: NostrFilter = { kinds: [LISTING_KIND], since, limit };
      if (until !== undefined) filter.until = until;

      // Unique sub id per page (M-6), same rationale as hydrate.
      const events = await this.requestPage(`${SUB_DRAIN}-${page}`, filter);
      if (events.length === 0) break;

      let fresh = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const event of events) {
        if (typeof event.created_at === "number" && event.created_at < oldest) {
          oldest = event.created_at;
        }
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        fresh++;
        this.enqueue(event);
      }
      const next = this.nextUntil(events, fresh, oldest, limit, until);
      if (next === null) break;
      if (next < since) break;
      until = next;
    }

    if (seenIds.size > 0) {
      this.log("info", "reconnect gap drained", {
        since,
        events: seenIds.size,
      });
    }
  }

  close(): void {
    this.stopped = true;
    this.liveListener = null;
    this.stopHeartbeat();
    for (const [subId, page] of this.pages) {
      this.pages.delete(subId);
      page.reject(new Error("subscriber closed"));
    }
    const ws = this.ws;
    this.ws = null;
    this.connecting = null;
    if (ws) {
      ws.removeAllListeners();
      // `ws` rethrows an `error` event that has no listener, and a socket torn
      // down mid-handshake still emits one asynchronously.
      ws.on("error", () => undefined);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection management (§4: same reconnect/backoff policy as BuzzClient —
  // exponential 1s → 60s cap, full jitter, infinite retries)
  // -------------------------------------------------------------------------

  private async ensureOpen(): Promise<WebSocket> {
    for (;;) {
      if (this.stopped) throw new Error("subscriber closed");
      try {
        return await this.connect();
      } catch (err) {
        if (this.stopped) throw new Error("subscriber closed");
        const delay = this.nextBackoff();
        this.log("warn", "wolfe relay connect failed; backing off", {
          error: String(err),
          delayMs: delay,
        });
        await sleep(delay);
      }
    }
  }

  private connect(): Promise<WebSocket> {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }
    if (this.connecting !== null) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.config.wolfeRelayUrl);
      let opened = false;

      ws.on("open", () => {
        opened = true;
        this.ws = ws;
        this.connecting = null;
        // NB: `attempt` is deliberately NOT reset here — see openLive().
        this.startHeartbeat(ws);
        resolve(ws);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        this.onMessage(String(data));
      });

      ws.on("error", (err: Error) => {
        if (!opened) {
          this.connecting = null;
          reject(err);
        }
      });

      ws.on("close", () => {
        if (!opened) {
          this.connecting = null;
          reject(new Error("wolfe relay closed before open"));
          return;
        }
        this.onDisconnect();
      });
    });

    return this.connecting;
  }

  private onDisconnect(): void {
    this.stopHeartbeat();
    this.ws = null;
    this.connecting = null;
    for (const [subId, page] of this.pages) {
      this.pages.delete(subId);
      page.reject(new Error("wolfe relay connection lost"));
    }
    if (this.stopped || this.liveListener === null) return;
    this.log("warn", "wolfe relay disconnected; reconnecting", {});
    void this.reconnectLive();
  }

  private async reconnectLive(): Promise<void> {
    await sleep(this.nextBackoff());
    if (this.stopped) return;
    await this.openLive(true);
  }

  /**
   * A CLOSED on the *live* sub (C-3). The socket stays OPEN, so onDisconnect /
   * reconnectLive never fire on their own — leaving mirroring silently stopped
   * on a healthy-looking connection. Mirror BuzzClient's CLOSED_RESUB policy:
   * re-issue the sub a bounded number of times with backoff, then drop the
   * connection so the reconnect path rebuilds it from scratch.
   */
  private handleLiveClosed(message: string): void {
    if (this.stopped || this.liveListener === null) return;
    this.liveClosedResubs += 1;
    if (this.liveClosedResubs > LIVE_CLOSED_RESUB_MAX) {
      this.log("error", "live sub closed repeatedly; dropping connection", {
        message,
        attempts: this.liveClosedResubs,
      });
      this.dropConnection();
      return;
    }
    this.log("error", "live sub closed by relay; re-issuing", {
      message,
      attempt: this.liveClosedResubs,
    });
    const delay = Math.min(
      this.maxBackoffMs,
      this.minBackoffMs * 2 ** (this.liveClosedResubs - 1),
    );
    void (async () => {
      await sleep(delay);
      if (this.stopped || this.liveListener === null) return;
      const ws = this.ws;
      if (ws === null || ws.readyState !== WebSocket.OPEN) return; // reconnect owns it
      try {
        const since = Math.max(0, this.getCursor() - CURSOR_SKEW);
        this.liveSince = since;
        this.send(["REQ", SUB_LIVE, { kinds: [LISTING_KIND], since }]);
      } catch {
        // The socket died under us; drop into the reconnect path.
        this.dropConnection();
      }
    })();
  }

  /**
   * Force the current socket through its reconnect path. `terminate()` fires the
   * `close` event → onDisconnect → reconnectLive, which re-establishes every
   * sub. Used when a live-sub CLOSED can't be recovered in place (C-3).
   */
  private dropConnection(): void {
    const ws = this.ws;
    if (ws !== null) {
      try {
        ws.terminate();
      } catch {
        /* already gone; the close handler will still drive reconnect */
      }
    }
  }

  /**
   * Application-level keepalive (§4, H-1). A silently half-open TCP connection
   * delivers no `close` event, so without this the live sub can wedge forever
   * on a dead socket. Ping every interval; if the peer misses a pong before the
   * next tick, `terminate()` the socket into the existing reconnect path.
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    ws.on("pong", () => {
      this.awaitingPong = false;
    });
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.log("warn", "wolfe relay pong missed; terminating socket", {});
        this.awaitingPong = false;
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        return;
      }
      this.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        /* socket going away; the close handler drives reconnect */
      }
    }, this.pingIntervalMs);
    // A heartbeat must never hold an otherwise-idle process open.
    if (typeof timer.unref === "function") timer.unref();
    this.pingTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
  }

  /** Exponential 1s → 60s cap with full jitter (§4). */
  private nextBackoff(): number {
    const ceiling = Math.min(
      this.maxBackoffMs,
      this.minBackoffMs * 2 ** this.attempt,
    );
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.random() * ceiling;
  }

  private send(frame: unknown[]): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error("wolfe relay not connected");
    }
    ws.send(JSON.stringify(frame));
  }

  // -------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------

  private onMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.log("debug", "unparseable frame from wolfe relay", {});
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

    const [type, subId] = frame as [string, string];
    switch (type) {
      case "EVENT": {
        // The wolfe relay is open and unauthenticated, so a frame is only
        // admitted once its full shape checks out — a half-formed event would
        // otherwise throw deep inside hydration, which re-runs from scratch on
        // every startup and would therefore crash-loop the daemon (Security §2).
        const event = asNostrEvent(frame[2]);
        if (event === null) {
          this.log("debug", "dropping malformed event frame", { subId });
          return;
        }
        const page = this.pages.get(subId);
        if (page) {
          page.events.push(event);
        } else if (subId === SUB_LIVE) {
          this.enqueue(event);
        }
        return;
      }
      case "EOSE": {
        const page = this.pages.get(subId);
        if (page) {
          this.pages.delete(subId);
          page.resolve(page.events);
        }
        // The live sub stays open past EOSE (standard persistent sub, §4).
        return;
      }
      case "CLOSED": {
        const message = String(frame[2] ?? "");
        const page = this.pages.get(subId);
        if (page) {
          // CLOSED means the relay refused/terminated this paged REQ — it is
          // NOT an empty result. Resolving it empty made hydrate see length 0
          // and stop with zero listings (C-2). Reject so requestPage's retry
          // ladder runs; a persistent CLOSED then surfaces as a hard failure.
          this.pages.delete(subId);
          page.reject(new Error(`REQ ${subId} closed: ${message}`));
        } else if (subId === SUB_LIVE && !this.stopped) {
          this.handleLiveClosed(message);
        }
        return;
      }
      case "NOTICE":
        this.log("debug", "wolfe relay notice", { notice: String(subId) });
        return;
      default:
        return;
    }
  }

  /** Serialize listener invocations so events are processed strictly in order. */
  private enqueue(event: NostrEvent): void {
    const listener = this.liveListener;
    if (listener === null) return;
    this.queue = this.queue.then(async () => {
      try {
        await listener(event);
      } catch (err) {
        this.log("error", "listener failed for 38400", {
          id: event.id,
          error: String(err),
        });
      }
    });
  }

  /** One paged REQ: send, collect until EOSE, CLOSE, resolve. Retries on drop. */
  private async requestPage(
    subId: string,
    filter: NostrFilter,
  ): Promise<NostrEvent[]> {
    for (let tries = 0; ; tries++) {
      if (this.stopped) return [];
      const ws = await this.ensureOpen();
      try {
        const events = await this.reqOnce(ws, subId, filter);
        // A completed page is a useful connection: reset the backoff ladder.
        this.attempt = 0;
        return events;
      } catch (err) {
        if (this.stopped) return [];
        if (tries >= this.pageRetries) throw err;
        const delay = this.nextBackoff();
        this.log("warn", "paged REQ failed; retrying", {
          subId,
          error: String(err),
          delayMs: delay,
        });
        await sleep(delay);
      }
    }
  }

  private reqOnce(
    ws: WebSocket,
    subId: string,
    filter: NostrFilter,
  ): Promise<NostrEvent[]> {
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pages.get(subId) === collector) {
          this.pages.delete(subId);
          // Tell the relay to forget this sub — otherwise a timed-out REQ leaks
          // a server-side subscription that keeps streaming into a dead
          // collector (M-6). Best-effort: the socket may already be gone.
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(["CLOSE", subId]));
            }
          } catch {
            /* socket going away; nothing to clean up */
          }
          reject(new Error(`REQ ${subId} timed out`));
        }
      }, this.pageTimeoutMs);

      const collector: PageCollector = {
        events: [],
        resolve: (events) => {
          clearTimeout(timer);
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(["CLOSE", subId]));
            }
          } catch {
            /* the page is already complete; CLOSE is best-effort */
          }
          resolve(events);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      this.pages.set(subId, collector);
      try {
        ws.send(JSON.stringify(["REQ", subId, filter]));
      } catch (err) {
        this.pages.delete(subId);
        collector.reject(err as Error);
      }
    });
  }

  private log(
    level: Level,
    msg: string,
    fields: Record<string, unknown>,
  ): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    process.stdout.write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        mod: "wolfe-subscriber",
        msg,
        ...fields,
      }) + "\n",
    );
  }
}

/**
 * Structural admission check for an untrusted relay frame. Signature
 * verification stays in MirrorEngine (§5 step 1); this only guarantees the
 * object is shaped like a Nostr event so no downstream code can throw on it.
 */
export function asNostrEvent(value: unknown): NostrEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  if (typeof e["id"] !== "string" || !/^[0-9a-f]{64}$/i.test(e["id"])) {
    return null;
  }
  if (typeof e["pubkey"] !== "string" || !/^[0-9a-f]{64}$/i.test(e["pubkey"])) {
    return null;
  }
  if (typeof e["sig"] !== "string") return null;
  if (typeof e["content"] !== "string") return null;
  if (!Number.isFinite(e["created_at"] as number)) return null;
  if (typeof e["created_at"] !== "number") return null;
  if (typeof e["kind"] !== "number") return null;
  const tags = e["tags"];
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (!Array.isArray(tag)) return null;
    for (const part of tag) if (typeof part !== "string") return null;
  }
  return value as NostrEvent;
}

export { CURSOR_SKEW, SUB_HYDRATE, SUB_DRAIN, SUB_LIVE };
