/** WolfeSubscriber — paged hydration + live sub on the public relay (spec §4). */

import WebSocket from "ws";

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

/** Sub ids, matching the wire summary in the spec's data-flow table. */
const SUB_HYDRATE = "wolfe-hydrate";
const SUB_DRAIN = "wolfe-drain";
const SUB_LIVE = "wolfe-38400";

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

  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private stopped = false;
  private attempt = 0;

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

    for (; page < this.maxPages; page++) {
      if (this.stopped) return;
      const filter: NostrFilter = { kinds: [LISTING_KIND], limit };
      // Deliberately no `since` — hydration is cursor-independent (§4).
      if (until !== undefined) filter.until = until;

      const events = await this.requestPage(SUB_HYDRATE, filter);
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
        // The relay is untrusted and unauthenticated: one malformed frame must
        // never abort hydration (which re-runs from scratch every startup, so
        // an abort here is a crash loop the open relay can trigger, §4/sec §2).
        try {
          await onListing(event);
          const address = addressOfEvent(event);
          if (address !== null) addresses.add(address);
        } catch (err) {
          this.log("debug", "hydration listener failed for 38400", {
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

    if (page >= this.maxPages) {
      this.log("warn", "hydration stopped at the page ceiling", {
        maxPages: this.maxPages,
        addresses: addresses.size,
      });
    }

    this.log("info", "hydration complete", {
      events: seenIds.size,
      addresses: addresses.size,
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
      this.log("info", "live subscription open", { since, isReconnect });
    } catch (err) {
      failed = true;
      this.log("error", "failed to open live subscription", {
        error: String(err),
      });
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

      const events = await this.requestPage(SUB_DRAIN, filter);
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
        const page = this.pages.get(subId);
        if (page) {
          this.pages.delete(subId);
          page.resolve(page.events);
        } else if (subId === SUB_LIVE && !this.stopped) {
          this.log("warn", "live sub closed by relay", {
            message: String(frame[2] ?? ""),
          });
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

/** `38400:<pubkey>:<d>` — distinct-address accounting for the hydration cap. */
function addressOfEvent(event: NostrEvent): string | null {
  const d = Array.isArray(event.tags)
    ? event.tags.find((t) => Array.isArray(t) && t[0] === "d")?.[1]
    : undefined;
  if (d === undefined || d.length === 0) return null;
  return `${LISTING_KIND}:${event.pubkey}:${d}`;
}

export { CURSOR_SKEW, SUB_HYDRATE, SUB_DRAIN, SUB_LIVE };
