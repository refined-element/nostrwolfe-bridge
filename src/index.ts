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
      stateReset = true;
      log.warn(warning.message, { event: warning.event });
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
    if (id === null) throw new Error("Services channel is not resolved yet");
    return id;
  };

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
        const id = await run();
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
      try {
        const ok = await buzz.publishNow(join);
        if (ok.ok || ok.message.startsWith("duplicate:")) {
          log.info("kind:9021 join accepted after membership rejection", {
            channelId: id,
          });
          return true;
        }
        log.warn("kind:9021 join rejected", { message: ok.message });
        return false;
      } catch (err) {
        log.error("kind:9021 join failed to send", { error: String(err) });
        return false;
      }
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
    try {
      await mirror.handleListing(event);
    } catch (err) {
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
    const recovered = await recoverMirroredFromChannel(
      buzz,
      resolvedChannelId,
      identity.publicKey,
    );
    const addresses = Object.entries(recovered);
    if (addresses.length > 0) {
      state.mutate((s) => {
        for (const [address, entry] of addresses) {
          s.mirrored[address] ??= entry;
        }
      });
    }
    log.info("footer recovery complete", {
      reason: stateMissing ? "no-state-file" : "state-reset",
      addresses: addresses.length,
    });
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

  await state.flush();
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
      for (const timer of channelRerunTimers) clearTimeout(timer);
      channelRerunTimers.clear();
      mentionsSub?.close();
      mentionsSub = null;
      wolfe.close();
      buzz.close();
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
