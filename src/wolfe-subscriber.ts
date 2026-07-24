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
}

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

  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private stopped = false;
  private attempt = 0;

  /** One-shot REQ collectors (hydration + gap drain), keyed by sub id. */
  private readonly pages = new Map<string, PageCollector>();

  private liveListener: Listener | null = null;
  private liveSince = 0;
  private resuming = false;
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

    for (;;) {
      if (this.stopped) return;
      const filter: NostrFilter = { kinds: [LISTING_KIND], limit };
      // Deliberately no `since` — hydration is cursor-independent (§4).
      if (until !== undefined) filter.until = until;

      const events = await this.requestPage(SUB_HYDRATE, filter);
      if (events.length === 0) break;

      let fresh = 0;
      let oldest = Number.POSITIVE_INFINITY;
      let atCap = false;

      for (const event of events) {
        if (event.created_at < oldest) oldest = event.created_at;
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        fresh++;
        await onListing(event);
        const address = addressOfEvent(event);
        if (address !== null) addresses.add(address);
        if (addresses.size >= maxAddresses) {
          atCap = true;
          break;
        }
      }

      if (atCap) {
        this.log("warn", "hydration stopped at MIRROR_MAX_LISTINGS", {
          addresses: addresses.size,
        });
        break;
      }
      // A relay may cap a page below `limit`, so page-shortness is NOT a drain
      // signal (§4); only an empty page or a page with no new ids ends paging.
      if (fresh === 0) break;
      until = oldest;
    }

    this.log("info", "hydration complete", {
      events: seenIds.size,
      addresses: addresses.size,
    });
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
    if (this.resuming) return;
    this.resuming = true;
    try {
      await this.ensureOpen();
      if (isReconnect) {
        // §4: if a reconnect gap is large enough that the relay caps the
        // response, drain the window by paging with `until` before resuming.
        await this.drainGap(Math.max(0, this.getCursor() - CURSOR_SKEW));
        // Let the drained events settle so the cursor reflects them before the
        // live window is computed.
        await this.queue;
      }
      const since = Math.max(0, this.getCursor() - CURSOR_SKEW);
      this.liveSince = since;
      this.send(["REQ", SUB_LIVE, { kinds: [LISTING_KIND], since }]);
      this.log("info", "live subscription open", { since, isReconnect });
    } catch (err) {
      this.log("error", "failed to open live subscription", {
        error: String(err),
      });
    } finally {
      this.resuming = false;
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

    for (;;) {
      if (this.stopped) return;
      const filter: NostrFilter = { kinds: [LISTING_KIND], since, limit };
      if (until !== undefined) filter.until = until;

      const events = await this.requestPage(SUB_DRAIN, filter);
      if (events.length === 0) break;

      let fresh = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const event of events) {
        if (event.created_at < oldest) oldest = event.created_at;
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        fresh++;
        this.enqueue(event);
      }
      if (fresh === 0) break;
      if (oldest <= since) break;
      until = oldest;
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
        this.attempt = 0;
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
        const event = frame[2] as NostrEvent | undefined;
        if (!event || typeof event.id !== "string") return;
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
        return await this.reqOnce(ws, subId, filter);
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

/** `38400:<pubkey>:<d>` — distinct-address accounting for the hydration cap. */
function addressOfEvent(event: NostrEvent): string | null {
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (d === undefined || d.length === 0) return null;
  return `${LISTING_KIND}:${event.pubkey}:${d}`;
}

export { CURSOR_SKEW, SUB_HYDRATE, SUB_DRAIN, SUB_LIVE };
