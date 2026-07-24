/**
 * nostrwolfe-bridge entrypoint — wires every component together and runs the
 * startup sequence from the spec's "Startup ordering" paragraph:
 *
 *   connect Buzz → AUTH → ChannelManager → footer recovery if state is
 *   missing/reset → connect Wolfe → full hydration (§4) → live subs.
 *
 * The mentions subscription starts only after the channel is confirmed, so the
 * bridge never replies into a void.
 */

import { existsSync } from "node:fs";

import { finalizeEvent } from "nostr-tools/pure";

import {
  BuzzClient,
  BuzzFatalError,
  FrameTooLargeError,
  type BuzzClientHooks,
  type Logger,
} from "./buzz-client.js";
import { ChannelManager } from "./channel-manager.js";
import { loadConfig, resolveIdentity } from "./config.js";
import { recoverMirroredFromChannel } from "./footer-recovery.js";
import { ListingCache } from "./listing-cache.js";
import { CardPublishError, MirrorEngine } from "./mirror-engine.js";
import { QueryResponder } from "./query-responder.js";
import { StateStore } from "./state-store.js";
import {
  WolfeSubscriber,
  type WolfeSubscriberOptions,
} from "./wolfe-subscriber.js";

import type {
  BridgeIdentity,
  Config,
  LogLevel,
  MirroredMap,
  NostrEvent,
  Subscription,
} from "./types.js";

// ---------------------------------------------------------------------------
// Kinds (the bridge only ever writes kinds the Buzz relay already accepts)
// ---------------------------------------------------------------------------

const KIND_JOIN_REQUEST = 9021;

/** Backoff for retrying a failed ChannelManager re-run (§3, error matrix). */
const CHANNEL_RERUN_BASE_DELAY_MS = 1_000;
const CHANNEL_RERUN_MAX_DELAY_MS = 60_000;

/**
 * Hard ceiling on a single ChannelManager re-run before it is treated as hung
 * (finding H-6/M-4). ChannelManager memoizes an in-flight run and also caps it,
 * but the re-run ladder here needs its own guard: without it a run that never
 * settles never reaches the retry `catch`, so `channelId` stays null forever and
 * every card/reply throws "Services channel is not resolved yet". Racing the run
 * against this timeout turns a hang into a rejection the ladder retries.
 */
const CHANNEL_RERUN_TIMEOUT_MS = 150_000;

/** Operator-visible heartbeat cadence (finding H-1): one status line every 5 min. */
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/**
 * Thrown by the `channelId()` accessor while the Services channel is unresolved
 * (finding H-6/M-4). A distinct type lets `onListing` log the null-channel drop
 * with its own message and a running count instead of burying it under the
 * generic "listing handling failed" error.
 */
export class ChannelUnresolvedError extends Error {
  constructor() {
    super("Services channel is not resolved yet");
    this.name = "ChannelUnresolvedError";
  }
}

// ---------------------------------------------------------------------------
// Logging — plain stdout JSON lines, pino-style levels (spec §1 `LOG_LEVEL`)
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Structured JSON-line logger on stdout, filtered by `LOG_LEVEL`. */
export function createLogger(level: LogLevel, component = "bridge"): Logger {
  const emit = (
    lvl: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    process.stdout.write(
      `${JSON.stringify({
        level: lvl,
        time: new Date().toISOString(),
        component,
        msg,
        ...fields,
      })}\n`,
    );
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/**
 * Structured footer-recovery result (finding H-7). The mirror-engine owner is
 * changing `recoverMirroredFromChannel` to return this so a scan that hit the
 * page cap can be flagged; {@link normalizeRecovery} accepts both this and the
 * legacy plain-map return so index.ts stays correct whichever shipped first.
 */
interface RecoveryResult {
  mirrored: MirroredMap;
  truncated: boolean;
  pages?: number;
}

function isRecoveryResult(value: unknown): value is RecoveryResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "mirrored" in value &&
    "truncated" in value
  );
}

/** Accept either the structured result or the legacy `MirroredMap` (finding H-7). */
export function normalizeRecovery(value: unknown): RecoveryResult {
  if (isRecoveryResult(value)) return value;
  return { mirrored: (value ?? {}) as MirroredMap, truncated: false };
}

/**
 * Race `promise` against a deadline, rejecting with a descriptive error if it
 * does not settle in time (finding H-6/M-4). The timer is unref'd so it never
 * keeps an idle process alive, and cleared as soon as either side wins.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(Math.round(ms))}ms`));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface StartBridgeOptions {
  /** Structured logger; defaults to a stdout JSON-line logger at `LOG_LEVEL`. */
  logger?: Logger;
  /**
   * Scales BuzzClient reconnect backoff and rate-limit pauses only. Production
   * leaves this at 1; integration tests scale it down.
   */
  timeScale?: number;
  /** WolfeSubscriber backoff/timeout seams (defaults are the spec values). */
  wolfe?: WolfeSubscriberOptions;
  /** StateStore debounce override (spec default: 2000ms). */
  stateDebounceMs?: number;
  /**
   * Unrecoverable relay condition (the fatal rows of the error matrix). The
   * daemon's handler shuts down and exits 1; tests observe instead.
   */
  onFatal?: (error: Error) => void;
}

/** Everything a caller (daemon or test) needs to observe and stop the bridge. */
export interface BridgeHandle {
  readonly config: Config;
  readonly identity: BridgeIdentity;
  readonly state: StateStore;
  readonly buzz: BuzzClient;
  readonly wolfe: WolfeSubscriber;
  readonly channels: ChannelManager;
  readonly cache: ListingCache;
  readonly mirror: MirrorEngine;
  readonly responder: QueryResponder;
  /** Resolved Services-channel UUID. */
  channelId(): string;
  /** Close both relay connections and flush state. */
  stop(): Promise<void>;
}

/**
 * Boot the whole daemon and resolve once it is live (hydrated + subscribed).
 *
 * Every step below is ordered by the spec's "Startup ordering" paragraph; the
 * ordering is load-bearing, not incidental:
 *  - AUTH before anything else, because no EVENT/REQ may precede the AUTH OK (§2).
 *  - ChannelManager before recovery/hydration, because both need the UUID (§3).
 *  - Footer recovery before hydration, or hydration would re-post a "new" card
 *    for every listing that already has one in the channel (§7).
 *  - Full hydration before the live sub, because the cache can never be rebuilt
 *    from a cursor-windowed REQ (§4).
 */
export async function startBridge(
  config: Config,
  options: StartBridgeOptions = {},
): Promise<BridgeHandle> {
  const log = options.logger ?? createLogger(config.logLevel);
  const identity = resolveIdentity(config.bridgeNsec);

  // --- state (§7) ---------------------------------------------------------
  // Footer recovery runs when there is no state file, or when the store had to
  // throw the document away (community mismatch / corruption).
  const stateMissing = !existsSync(config.stateFile);
  let stateReset = false;
  const state = new StateStore(config.stateFile, {
    ...(options.stateDebounceMs === undefined
      ? {}
      : { debounceMs: options.stateDebounceMs }),
    onWarn: (warning) => {
      const { event, message, ...extra } = warning;
      // A write failure is a durability alarm, not a discarded document: log it
      // at error and do NOT trip `stateReset` — footer recovery is only for a
      // state file that was thrown away (corrupt / community mismatch). Tripping
      // it on every transient write failure would kick off a spurious ~100-query
      // footer-recovery scan on an otherwise healthy channel (finding M-3).
      if (event === "write-failed") {
        log.error(message, { event, ...extra });
        return;
      }
      stateReset = true;
      log.warn(message, { event, ...extra });
    },
    onFatal: (error) => {
      log.error("state store durability failure; going fatal", {
        error: error.message,
      });
      options.onFatal?.(error);
    },
  });
  await state.load(config.buzzRelayUrl);

  log.info("nostrwolfe-bridge starting", {
    pubkey: identity.publicKey,
    buzzRelayUrl: config.buzzRelayUrl,
    wolfeRelayUrl: config.wolfeRelayUrl,
    channelName: config.channelName,
    stateFile: config.stateFile,
  });

  // --- forward declarations (the hooks close over these) -------------------
  let buzz!: BuzzClient;
  let channels!: ChannelManager;
  let bootstrapped = false;
  let stopped = false;
  let mentionsSub: Subscription | null = null;
  let mentionsChannelId: string | null = null;
  /** Serializes ChannelManager re-runs triggered from hooks. */
  let rerun: Promise<void> = Promise.resolve();
  /** Pending re-run retries, cleared on stop() so tests/daemons exit cleanly. */
  const channelRerunTimers = new Set<NodeJS.Timeout>();

  const channelId = (): string => {
    const id = state.getState().channelId;
    if (id === null) throw new ChannelUnresolvedError();
    return id;
  };

  /** 38400s dropped because the Services channel was unresolved (finding H-6/M-4). */
  let nullChannelDrops = 0;
  /** Wall-clock ms of the last 38400 seen from wolfe; 0 until the first (finding H-1). */
  let lastListingAt = 0;

  /**
   * (Re)open the mentions subscription (§6, flow #7). `since` is supplied as a
   * cursor callback so BuzzClient re-issues `since = cursor − 300` on every
   * reconnect; a first run (cursor 0) uses `now − 300` — never `since: 0`,
   * which would replay and mass-reply to the channel's whole history.
   */
  const ensureMentionsSubscription = (): void => {
    if (stopped) return;
    const id = state.getState().channelId;
    if (id === null) return;
    if (mentionsSub !== null && mentionsChannelId === id) return;
    mentionsSub?.close();
    mentionsChannelId = id;
    // Delegate to QueryResponder.start() so the shipped path is the tested one.
    mentionsSub = responder.start();
    log.info("mentions subscription open", { channelId: id });
  };

  /**
   * Serialized ChannelManager re-run + mentions resubscribe.
   *
   * A failed re-run leaves `channelId` null, which wedges every publish and
   * every reply (`channelId()` throws), so the failure MUST be retried rather
   * than logged and dropped: the only other escape is a WS reconnect that a
   * healthy socket may never produce (§3, error matrix).
   */
  const scheduleChannelRerun = (
    reason: string,
    run: () => Promise<string>,
    attempt = 0,
  ): void => {
    rerun = rerun.then(async () => {
      if (stopped) return;
      try {
        const id = await withTimeout(
          run(),
          CHANNEL_RERUN_TIMEOUT_MS * (options.timeScale ?? 1),
          `ChannelManager re-run (${reason})`,
        );
        log.info("ChannelManager re-run complete", { reason, channelId: id });
        ensureMentionsSubscription();
      } catch (err) {
        const delay =
          Math.min(
            CHANNEL_RERUN_MAX_DELAY_MS,
            CHANNEL_RERUN_BASE_DELAY_MS * 2 ** attempt,
          ) * (options.timeScale ?? 1);
        log.error("ChannelManager re-run failed; retrying", {
          reason,
          attempt: attempt + 1,
          delayMs: Math.round(delay),
          error: String(err),
        });
        const timer: NodeJS.Timeout = setTimeout(() => {
          channelRerunTimers.delete(timer);
          scheduleChannelRerun(reason, run, attempt + 1);
        }, delay);
        // A pending retry must not hold an otherwise-idle process open.
        if (typeof timer.unref === "function") timer.unref();
        channelRerunTimers.add(timer);
      }
    });
  };

  // --- BuzzClient (§2) -----------------------------------------------------
  const hooks: BuzzClientHooks = {
    /**
     * Runs after every AUTH — initial connect *and* every reconnect. Before the
     * first ensureChannel there is nothing to verify; afterwards this is the
     * reconnect-side 39000 verification that clears a stale `channelId` (§3).
     */
    onAuthenticated: () => {
      if (!bootstrapped || stopped) return;
      scheduleChannelRerun("reconnect-verification", () =>
        channels.handleReconnect(),
      );
    },
    /**
     * `invalid: channel not found` — the sole publish-side re-run trigger (§3).
     * Deliberately does not await the re-run: this hook is invoked on the
     * publish pump's own stack, so awaiting a publish here would deadlock.
     */
    onChannelLost: () => {
      scheduleChannelRerun("channel-not-found", () =>
        channels.handleChannelLost(),
      );
    },
    /**
     * `restricted: not a channel member` — attempt the kind:9021 join once and
     * report whether it took (§ Error handling). Uses `publishNow` for the same
     * pump-stack reason as above.
     */
    onNotChannelMember: async (): Promise<boolean> => {
      const id = state.getState().channelId;
      if (id === null) return false;
      const join = finalizeEvent(
        {
          kind: KIND_JOIN_REQUEST,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["h", id]],
          content: "",
        },
        identity.secretKey,
      ) as unknown as NostrEvent;
      // A rejection from publishNow (e.g. a DisconnectedError from a socket flap
      // mid-reconnect) is intentionally NOT caught here: BuzzClient's join-hook
      // wrapper maps a thrown DisconnectedError onto the "unavailable" outcome
      // (keep the subscription alive for the reconnect) and everything else onto
      // "rejected". Swallowing it and returning false would collapse a transient
      // flap into the fatal "rejected" path. Only a genuine relay OK-false is
      // reported as a boolean rejection.
      const ok = await buzz.publishNow(join);
      if (ok.ok || ok.message.startsWith("duplicate:")) {
        log.info("kind:9021 join accepted after membership rejection", {
          channelId: id,
        });
        return true;
      }
      log.warn("kind:9021 join rejected", { message: ok.message });
      return false;
    },
    onFatal: (error: BuzzFatalError) => {
      log.error("fatal relay condition", {
        message: error.message,
        guidance: error.guidance,
        relayMessage: error.relayMessage,
      });
      options.onFatal?.(error);
    },
  };

  buzz = new BuzzClient(config, identity, {
    hooks,
    logger: options.logger ?? createLogger(config.logLevel, "buzz-client"),
    ...(options.timeScale === undefined
      ? {}
      : { timeScale: options.timeScale }),
  });

  const cache = new ListingCache();
  channels = new ChannelManager(config, identity, buzz, state);
  const mirror = new MirrorEngine(config, buzz, cache, state, channelId);
  const responder = new QueryResponder(
    config,
    identity,
    buzz,
    cache,
    channelId,
    {
      getCursor: () => state.getState().cursors.buzz,
      onCursorAdvance: (createdAt) => {
        if (createdAt <= state.getState().cursors.buzz) return;
        state.mutate((s) => {
          if (createdAt > s.cursors.buzz) s.cursors.buzz = createdAt;
        });
      },
    },
  );

  /**
   * One 38400 through the mirror. A rejected card is not recorded, so the next
   * 38400 for that address retries the post; `invalid: channel not found` has
   * already triggered the ChannelManager re-run via the BuzzClient hook (§3).
   */
  const onListing = async (event: NostrEvent): Promise<void> => {
    lastListingAt = Date.now();
    try {
      await mirror.handleListing(event);
    } catch (err) {
      if (err instanceof ChannelUnresolvedError) {
        // The Services channel is mid-re-run (channelId null), so this 38400
        // cannot be mirrored. Name the condition and count it — a silent generic
        // failure here hides a bridge that has stopped mirroring entirely while
        // ChannelManager retries (finding H-6/M-4). The card is not recorded, so
        // the live sub's `since = cursor − 300` window will redeliver it once
        // the channel resolves; a fresh 38400 for the address also retries.
        nullChannelDrops += 1;
        log.error("38400 dropped: Services channel unresolved", {
          id: event.id,
          pubkey: event.pubkey,
          droppedWhileUnresolved: nullChannelDrops,
        });
        return;
      }
      if (err instanceof CardPublishError) {
        log.warn("card publish rejected; address not recorded", {
          address: err.address,
          message: err.result.message,
        });
        return;
      }
      if (err instanceof FrameTooLargeError) {
        // Not transient and not retryable: the listing's tags render to a card
        // bigger than the 65,536-byte frame cap, so it can never be mirrored.
        // Name it explicitly instead of hiding it in a generic failure log.
        log.error("listing renders to an oversized card; never mirrorable", {
          id: event.id,
          pubkey: event.pubkey,
          bytes: err.bytes,
        });
        return;
      }
      log.error("listing handling failed", {
        id: event.id,
        error: String(err),
      });
    }
  };

  // 1. Connect Buzz → AUTH (spec "Startup ordering").
  await buzz.connect();

  // 2. ChannelManager: discover → create → join → persist + profile (§3).
  const resolvedChannelId = await channels.ensureChannel();
  bootstrapped = true;
  log.info("services channel confirmed", { channelId: resolvedChannelId });

  // 3. Footer recovery when the state file was missing or reset (§7).
  if (stateMissing || stateReset) {
    const { mirrored: recovered, truncated } = normalizeRecovery(
      await recoverMirroredFromChannel(
        buzz,
        resolvedChannelId,
        identity.publicKey,
      ),
    );
    const addresses = Object.entries(recovered);
    if (addresses.length > 0) {
      state.mutate((s) => {
        for (const [address, entry] of addresses) {
          s.mirrored[address] ??= entry;
        }
      });
    }
    if (truncated) {
      // The scan hit the page cap: the rebuilt dedupe set is incomplete, so
      // some already-mirrored listings will get a duplicate "new" card when
      // hydration re-posts them (finding H-7). Surface it — this is the
      // duplicate-card storm §7's recovery exists to bound.
      log.warn(
        "footer recovery truncated at the page cap; expect duplicate cards for listings past the scan window",
        {
          reason: stateMissing ? "no-state-file" : "state-reset",
          addresses: addresses.length,
        },
      );
    } else {
      log.info("footer recovery complete", {
        reason: stateMissing ? "no-state-file" : "state-reset",
        addresses: addresses.length,
      });
    }
  }

  // 4. Connect Wolfe + full hydration; the cache is rebuilt on every start (§4).
  const wolfe = new WolfeSubscriber(
    config,
    () => state.getState().cursors.wolfe,
    {
      // §1: `MIRROR_MAX_LISTINGS` caps addresses *tracked*, so hydration measures
      // the mirror's own cache rather than every address the relay hands it —
      // otherwise a narrow `MIRROR_CATEGORIES` spends the cap on listings the
      // client-side filter immediately discards.
      trackedCount: () => cache.size,
      ...(options.wolfe ?? {}),
    },
  );
  await wolfe.hydrate(onListing);

  // 5. Live subs: the wolfe 38400 stream and — channel now confirmed — mentions.
  wolfe.subscribeLive(onListing);
  ensureMentionsSubscription();

  // Operator-visible heartbeat (finding H-1): one line every 5 min that makes a
  // silently-stopped mirror obvious. The ping/pong socket watchdogs live in the
  // client files; this is purely for the human reading the logs.
  const heartbeat = setInterval(() => {
    if (stopped) return;
    const secondsSinceLastListing =
      lastListingAt === 0
        ? null
        : Math.round((Date.now() - lastListingAt) / 1000);
    log.info("heartbeat", {
      cacheSize: cache.size,
      buzzQueueLength: buzz.queueLength,
      wolfeCursor: state.getState().cursors.wolfe,
      secondsSinceLastListing,
      nullChannelDrops,
    });
  }, HEARTBEAT_INTERVAL_MS);
  // A pure diagnostic must never hold the process open.
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // `flush()` now propagates write failures (finding M-3). A single transient
  // failure of this startup barrier must not abort the whole boot — it is
  // already logged at error via the store's `write-failed` warning, and the
  // consecutive-failure escalation covers a persistently dead disk.
  try {
    await state.flush();
  } catch (err) {
    log.warn("startup state flush failed; continuing", { error: String(err) });
  }
  log.info("nostrwolfe-bridge ready", {
    channelId: resolvedChannelId,
    listingsCached: cache.size,
  });

  return {
    config,
    identity,
    state,
    buzz,
    wolfe,
    channels,
    cache,
    mirror,
    responder,
    channelId,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      for (const timer of channelRerunTimers) clearTimeout(timer);
      channelRerunTimers.clear();
      mentionsSub?.close();
      mentionsSub = null;
      wolfe.close();
      buzz.close();
      // `flush()` now propagates a real write failure (finding M-3), so this
      // catch is no longer dead: a failed final durability write is logged at
      // error rather than becoming an unhandled rejection out of stop().
      try {
        await state.flush();
      } catch (err) {
        log.error("final state flush failed", { error: String(err) });
      }
      log.info("nostrwolfe-bridge stopped", {});
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  let handle: BridgeHandle | null = null;
  let exiting = false;
  const shutdown = (code: number, reason: string): void => {
    if (exiting) return;
    exiting = true;
    log.info("shutting down", { reason, code });
    const done = handle?.stop() ?? Promise.resolve();
    void done.finally(() => {
      process.exit(code);
    });
  };

  handle = await startBridge(config, {
    logger: log,
    onFatal: () => {
      shutdown(1, "fatal-relay-condition");
    },
  });

  // SIGINT/SIGTERM: the store flushes synchronously first (§7), then we close
  // both sockets and exit — the store never exits the process itself.
  handle.state.installSignalHandlers((signal) => {
    shutdown(0, signal);
  });
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
