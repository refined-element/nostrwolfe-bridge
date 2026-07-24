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
  const tmp = `${path}.tmp`;
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
  const tmp = `${path}.tmp`;
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

/** Structured warning emitted by the store (corrupt file, community reset). */
export interface StateWarning {
  event: "corrupt-state" | "community-mismatch";
  message: string;
  [extra: string]: unknown;
}

export interface StateStoreOptions {
  /** Debounce window override (tests). Defaults to {@link FLUSH_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Sink for warnings; defaults to a JSON line on stderr. */
  onWarn?: (warning: StateWarning) => void;
}

export class StateStore implements IStateStore {
  private readonly stateFile: string;
  private readonly debounceMs: number;
  private readonly onWarn: (warning: StateWarning) => void;

  private state: BridgeState;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  /** Serializes writes so a debounced flush can never race an explicit one. */
  private chain: Promise<void> = Promise.resolve();
  private writes = 0;

  constructor(stateFile: string, options: StateStoreOptions = {}) {
    this.stateFile = stateFile;
    this.debounceMs = options.debounceMs ?? FLUSH_DEBOUNCE_MS;
    this.onWarn =
      options.onWarn ??
      ((w) => {
        process.stderr.write(`${JSON.stringify({ level: "warn", ...w })}\n`);
      });
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

  /** Force an immediate atomic flush (ordering barriers, shutdown). */
  flush(): Promise<void> {
    this.cancelTimer();
    return this.enqueueWrite();
  }

  /**
   * Synchronous flush for signal handlers — a process about to die cannot
   * await a promise (spec §7).
   */
  flushSync(): void {
    this.cancelTimer();
    this.dirty = false;
    atomicWriteSync(this.stateFile, this.serialize());
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
          this.onWarn({
            event: "corrupt-state",
            message: `flush on ${signal} failed: ${String(err)}`,
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

  private enqueueWrite(): Promise<void> {
    // Snapshot at enqueue time is wrong (later mutations must win), so the
    // serialization happens inside the chained task instead.
    this.chain = this.chain.then(async () => {
      this.dirty = false;
      await atomicWrite(this.stateFile, this.serialize());
      this.writes++;
    });
    return this.chain;
  }
}
