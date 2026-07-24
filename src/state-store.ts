/** StateStore — atomic debounced JSON persistence (spec §7). */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  BridgeState,
  IStateStore,
  MirroredEntry,
  MirroredMap,
} from "./types.js";

/** Schema version of the on-disk document (spec §7). */
export const STATE_VERSION = 1;

/** Debounce window: flush 2s after the last mutation (spec §7). */
export const FLUSH_DEBOUNCE_MS = 2000;

/** Signals that trigger a synchronous flush before the process dies (spec §7). */
export const FLUSH_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Consecutive failed atomic writes before the store escalates to `onFatal`
 * (finding M-3). A read-only FS or full disk otherwise runs forever with zero
 * durability and only warn-level noise; after this many back-to-back failures
 * the daemon is told to stop rather than pretend it is persisting.
 */
export const MAX_CONSECUTIVE_WRITE_FAILURES = 5;

/** A fresh, empty state document for `community`. */
export function emptyState(community: string): BridgeState {
  return {
    version: STATE_VERSION,
    community,
    channelId: null,
    cursors: { wolfe: 0, buzz: 0 },
    mirrored: {},
  };
}

let tmpSeq = 0;

/**
 * Unique scratch path per write. A single shared `<path>.tmp` lets a
 * signal-handler {@link atomicWriteSync} truncate and rename the file an
 * in-flight {@link atomicWrite} still holds an fd to — the async writer then
 * finishes writing into the *live* state file. Unique names make the two
 * writers independent; the rename remains the atomic commit point.
 */
function tmpPath(path: string): string {
  tmpSeq += 1;
  return `${path}.${String(process.pid)}.${String(tmpSeq)}.tmp`;
}

/** Hooks used by tests to interrupt an atomic write mid-flight. */
export interface AtomicWriteHooks {
  /** Invoked after the tmp file is fsynced but **before** the rename. */
  afterFsync?: () => void | Promise<void>;
}

/**
 * Write `data` to `path` atomically: tmp file → fsync → rename (spec §7).
 *
 * The fsync before the rename is what makes the crash window safe: if the
 * process dies at any point, `path` either still holds the previous complete
 * document or holds the new complete one — never a truncated blend. The
 * leftover `<path>.tmp` is inert and overwritten by the next write.
 */
export async function atomicWrite(
  path: string,
  data: string,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const tmp = tmpPath(path);
  await mkdir(dirname(path), { recursive: true });

  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (hooks.afterFsync) await hooks.afterFsync();

  await rename(tmp, path);
}

/** Synchronous twin of {@link atomicWrite}, for signal handlers (spec §7). */
export function atomicWriteSync(path: string, data: string): void {
  const tmp = tmpPath(path);
  mkdirSync(dirname(path), { recursive: true });

  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmp, path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceMirrored(raw: unknown): MirroredMap {
  if (!isRecord(raw)) return {};
  const out: MirroredMap = {};
  for (const [address, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    if (typeof value.eventId !== "string") continue;
    if (typeof value.createdAt !== "number") continue;
    const entry: MirroredEntry = {
      eventId: value.eventId,
      createdAt: value.createdAt,
      cardMsgId: typeof value.cardMsgId === "string" ? value.cardMsgId : "",
      delisted: value.delisted === true,
    };
    out[address] = entry;
  }
  return out;
}

/**
 * Parse a persisted document. Returns `null` when the file is unusable
 * (unparseable, wrong shape, or an unknown schema version) — the caller then
 * quarantines the file and starts fresh.
 */
export function parseState(text: string): BridgeState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.version !== STATE_VERSION) return null;
  if (typeof raw.community !== "string") return null;

  const cursors = isRecord(raw.cursors) ? raw.cursors : {};

  return {
    version: STATE_VERSION,
    community: raw.community,
    channelId: typeof raw.channelId === "string" ? raw.channelId : null,
    cursors: {
      wolfe: typeof cursors.wolfe === "number" ? cursors.wolfe : 0,
      buzz: typeof cursors.buzz === "number" ? cursors.buzz : 0,
    },
    mirrored: coerceMirrored(raw.mirrored),
  };
}

/**
 * Structured warning emitted by the store.
 *
 * The three events are deliberately distinct so the caller can route them
 * differently (finding M-3): `corrupt-state`/`community-mismatch` mean the
 * on-disk document was thrown away (footer recovery must re-derive the dedupe
 * set), whereas `write-failed` means a *persistence* failure with the in-memory
 * state intact (no recovery, just a durability alarm at error level).
 */
export interface StateWarning {
  event: "corrupt-state" | "community-mismatch" | "write-failed";
  message: string;
  [extra: string]: unknown;
}

export interface StateStoreOptions {
  /** Debounce window override (tests). Defaults to {@link FLUSH_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Sink for warnings; defaults to a JSON line on stderr. */
  onWarn?: (warning: StateWarning) => void;
  /**
   * Escalation sink: called once after {@link MAX_CONSECUTIVE_WRITE_FAILURES}
   * back-to-back write failures (finding M-3). The daemon uses it to go fatal;
   * defaults to a no-op so a store constructed without it never crashes.
   */
  onFatal?: (error: Error) => void;
}

export class StateStore implements IStateStore {
  private readonly stateFile: string;
  private readonly debounceMs: number;
  private readonly onWarn: (warning: StateWarning) => void;
  private readonly onFatal: (error: Error) => void;

  private state: BridgeState;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** Serializes writes so a debounced flush can never race an explicit one. */
  private chain: Promise<void> = Promise.resolve();
  private writes = 0;
  /** Back-to-back write failures; reset to 0 by the next successful write. */
  private consecutiveWriteFailures = 0;
  /** Latched once escalation has fired, so `onFatal` is called at most once. */
  private fatalEscalated = false;

  constructor(stateFile: string, options: StateStoreOptions = {}) {
    this.stateFile = stateFile;
    this.debounceMs = options.debounceMs ?? FLUSH_DEBOUNCE_MS;
    this.onWarn =
      options.onWarn ??
      ((w) => {
        process.stderr.write(`${JSON.stringify({ level: "warn", ...w })}\n`);
      });
    this.onFatal = options.onFatal ?? (() => undefined);
    this.state = emptyState("");
  }

  /** Number of completed atomic writes; used to assert debounce coalescing. */
  get writeCount(): number {
    return this.writes;
  }

  /** Path the next write will rename into place. */
  get path(): string {
    return this.stateFile;
  }

  /** True when mutations have not yet been persisted. */
  get isDirty(): boolean {
    return this.dirty;
  }

  async load(expectedCommunity: string): Promise<BridgeState> {
    let text: string | null = null;
    try {
      text = await readFile(this.stateFile, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }

    if (text === null) {
      // No state file: fresh start, nothing to warn about.
      this.state = emptyState(expectedCommunity);
      this.markDirty();
      return this.state;
    }

    const parsed = parseState(text);
    if (parsed === null) {
      const backup = `${this.stateFile}.corrupt-${String(Date.now())}`;
      try {
        await rename(this.stateFile, backup);
      } catch {
        // Best effort — an unreadable/unmovable file must not block startup.
      }
      this.onWarn({
        event: "corrupt-state",
        message: `state file unreadable; backed up to ${backup} and starting fresh`,
        backup,
      });
      this.state = emptyState(expectedCommunity);
      this.markDirty();
      return this.state;
    }

    if (parsed.community !== expectedCommunity) {
      // §7: cards are per-community. Carrying `mirrored` across communities
      // would mark every listing as already-mirrored in a channel with no
      // cards, so the reset must clear mirrored, channelId AND both cursors.
      this.state = parsed;
      const previous = parsed.community;
      this.reset(expectedCommunity);
      this.onWarn({
        event: "community-mismatch",
        message: `state file belongs to ${previous || "(unset)"}; full reset for ${expectedCommunity}`,
        previous,
        expected: expectedCommunity,
      });
      return this.state;
    }

    this.state = parsed;
    return this.state;
  }

  getState(): BridgeState {
    return this.state;
  }

  mutate(fn: (state: BridgeState) => void): void {
    fn(this.state);
    this.markDirty();
  }

  /** Full reset for `community`: clear mirrored/channelId/cursors (§7). */
  reset(community: string): void {
    this.state.version = STATE_VERSION;
    this.state.community = community;
    this.state.channelId = null;
    this.state.cursors = { wolfe: 0, buzz: 0 };
    this.state.mirrored = {};
    this.markDirty();
  }

  /**
   * Force an immediate atomic flush (ordering barriers, shutdown).
   *
   * Unlike the debounced path, an explicit `flush()` **propagates** a real write
   * failure to its awaiting caller (finding M-3) — the internal write chain
   * still never rejects (so the debounce timer's `void enqueueWrite()` cannot
   * raise an unhandled rejection), but the caller here always awaits, so it is
   * safe (and honest) to surface the error.
   */
  flush(): Promise<void> {
    this.cancelTimer();
    return this.enqueueWrite(true);
  }

  /**
   * Synchronous flush for signal handlers — a process about to die cannot
   * await a promise (spec §7).
   */
  flushSync(): void {
    this.cancelTimer();
    const payload = this.serialize();
    this.dirty = false;
    try {
      atomicWriteSync(this.stateFile, payload);
    } catch (err) {
      // Leave the document dirty so a caller that survives can retry.
      this.markDirty();
      throw err;
    }
    this.writes++;
  }

  /**
   * Install SIGINT/SIGTERM handlers that {@link flushSync} before shutdown.
   * Returns an uninstall function. `onSignal` (if given) runs after the flush
   * and owns the exit decision — the store never exits the process itself.
   */
  installSignalHandlers(
    onSignal?: (signal: NodeJS.Signals) => void,
    signals: readonly NodeJS.Signals[] = FLUSH_SIGNALS,
  ): () => void {
    const handlers = signals.map((signal) => {
      const handler = (): void => {
        try {
          this.flushSync();
        } catch (err) {
          // A failed shutdown flush is a durability failure, not a corrupt
          // document — tag it `write-failed` so the caller does not mistake it
          // for a state reset and kick off footer recovery (finding M-3).
          this.onWarn({
            event: "write-failed",
            message: `flush on ${signal} failed: ${String(err)}`,
            stateFile: this.stateFile,
          });
        }
        onSignal?.(signal);
      };
      process.on(signal, handler);
      return { signal, handler };
    });

    return () => {
      for (const { signal, handler } of handlers) {
        process.off(signal, handler);
      }
    };
  }

  /** Resolves once every scheduled write has settled (no pending timer work). */
  async whenIdle(): Promise<void> {
    await this.chain;
  }

  /** True while a debounced flush is pending. */
  get hasPendingFlush(): boolean {
    return this.timer !== null;
  }

  private serialize(): string {
    return `${JSON.stringify(this.state, null, 2)}\n`;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    const timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, this.debounceMs);
    // Don't keep an otherwise-idle process alive purely for a pending flush;
    // the signal handlers cover shutdown durability.
    if (typeof timer.unref === "function") timer.unref();
    this.timer = timer;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Chain one atomic write.
   *
   * The task must never settle rejected: a rejected `chain` would make every
   * subsequent `.then(...)` callback unreachable, silently freezing state on
   * disk forever, and the debounce timer's `void enqueueWrite()` would raise an
   * unhandled rejection (fatal under Node's default `--unhandled-rejections=
   * throw`, bypassing the SIGTERM flush entirely). So the error is caught here,
   * reported, and the document is left dirty with the debounce re-armed so the
   * write is retried.
   */
  private enqueueWrite(propagate = false): Promise<void> {
    // Snapshot at enqueue time is wrong (later mutations must win), so the
    // serialization happens inside the chained task instead.
    let failure: Error | null = null;
    this.chain = this.chain.then(async () => {
      // Serialize first, then clear `dirty`, so a mutation arriving *during*
      // the await still marks the document dirty for the next flush.
      const payload = this.serialize();
      this.dirty = false;
      try {
        await atomicWrite(this.stateFile, payload);
        this.writes++;
        this.consecutiveWriteFailures = 0;
      } catch (err) {
        failure = err as Error;
        this.onWriteFailure(err);
      }
    });
    const chained = this.chain;
    if (!propagate) return chained;
    // The chain itself must never reject (see the doc-comment above), so the
    // caller-facing rejection is a *separate* continuation off the chain — it
    // surfaces the failure to `flush()`'s awaiter without poisoning `this.chain`.
    return chained.then(() => {
      if (failure !== null) throw failure;
    });
  }

  /**
   * Shared handling for a failed atomic write (async or sync path): warn with
   * the dedicated `write-failed` event, leave the document dirty for retry, and
   * escalate to `onFatal` after {@link MAX_CONSECUTIVE_WRITE_FAILURES}
   * back-to-back failures (finding M-3).
   */
  private onWriteFailure(err: unknown): void {
    this.consecutiveWriteFailures += 1;
    this.onWarn({
      event: "write-failed",
      message: `state write failed: ${String(err)}`,
      stateFile: this.stateFile,
      consecutiveFailures: this.consecutiveWriteFailures,
    });
    this.markDirty();
    if (
      this.consecutiveWriteFailures >= MAX_CONSECUTIVE_WRITE_FAILURES &&
      !this.fatalEscalated
    ) {
      this.fatalEscalated = true;
      this.onFatal(
        new Error(
          `state store failed ${String(this.consecutiveWriteFailures)} consecutive writes to ${this.stateFile}; last error: ${String(err)}`,
        ),
      );
    }
  }
}
