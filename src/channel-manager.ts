/** ChannelManager — discover / create / join the Services channel (spec §3). */

import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";

import type {
  BridgeIdentity,
  Config,
  IBuzzClient,
  IChannelManager,
  IStateStore,
  LogLevel,
  NostrEvent,
  NostrFilter,
  UnsignedEvent,
} from "./types.js";

// --- Kinds -----------------------------------------------------------------

const KIND_PROFILE = 0;
/** NIP-29 create-group. */
const KIND_CHANNEL_CREATE = 9007;
/** NIP-29 join-request (open channels only). */
const KIND_JOIN_REQUEST = 9021;
/** NIP-29 group metadata (relay-signed, channel-scoped). */
const KIND_GROUP_METADATA = 39000;
/** NIP-29 group members (relay-signed; `p` tag per member). */
const KIND_GROUP_MEMBERS = 39002;

// --- Discovery paging (spec §3 step 1 / finding H-2) -----------------------

/**
 * Per-page `limit` for the 39000 discovery scan. The relay caps a filter at 500
 * results (`ARCHITECTURE.md:631-638`); once more than one page of channel
 * metadata exists, an unpaged `{kinds:[39000]}` REQ silently returns only the
 * newest 500 and a channel outside that window looks absent. We page with
 * `until` instead, exactly like footer recovery.
 */
const DISCOVER_PAGE_SIZE = 500;

/**
 * Safety valve on the discovery `until` walk. Hitting it means the relay is not
 * honouring `until`; we stop and report the scan as **truncated** rather than
 * looping forever — a truncated scan is not evidence a channel is absent, so
 * ChannelManager must refuse to create rather than spawn a duplicate channel.
 */
const DISCOVER_MAX_PAGES = 100;

/**
 * Hard ceiling on a single `ensureChannel` run before its memoized `inFlight`
 * promise is treated as poisoned (finding H-6/M-4). A hung run (a relay that
 * accepts the socket but never answers a REQ, past the query timeout) would
 * otherwise leave `inFlight` pending forever, so every future caller awaits a
 * promise that never settles. The deadline turns that into a rejection the
 * caller's retry ladder can act on, and frees `inFlight` for a fresh attempt.
 */
export const ENSURE_CHANNEL_DEADLINE_MS = 120_000;

// --- Logging ---------------------------------------------------------------

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function makeLogger(config: Config) {
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
  return (
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (LEVELS[level] < threshold) return;
    console.log(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        component: "channel-manager",
        msg,
        ...fields,
      }),
    );
  };
}

// --- Deterministic UUIDv5 (spec §3 step 2) ---------------------------------

/** RFC 4122 URL namespace — the stable root all bridge namespaces hang off. */
const UUID_NS_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Root namespace for this daemon. Derived once from a fixed RFC namespace so
 * the whole derivation chain is reproducible from constants in this file.
 */
const BRIDGE_UUID_ROOT = uuidv5("nostrwolfe-bridge", UUID_NS_URL);

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * RFC 4122 UUIDv5 (SHA-1, name-based) over `node:crypto` — the spec forbids new
 * runtime deps, so this is hand-rolled rather than pulled from `uuid`.
 */
export function uuidv5(name: string, namespace: string): string {
  const digest = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The bridge's per-identity namespace: stable for a given bridge pubkey, so two
 * instances of the *same* bridge identity always derive the same channel UUID
 * (which is what makes the create race detectable — §3 step 2).
 */
export function bridgeNamespace(bridgePubkey: string): string {
  return uuidv5(bridgePubkey, BRIDGE_UUID_ROOT);
}

/** Deterministic channel UUID: UUIDv5(channelName) under the bridge namespace. */
export function deriveChannelId(
  bridgePubkey: string,
  channelName: string,
): string {
  return uuidv5(channelName, bridgeNamespace(bridgePubkey));
}

// --- Discovery + tie-break (spec §3 step 1) --------------------------------

/** One channel found by 39000 discovery, collapsed across metadata revisions. */
export interface ChannelCandidate {
  /** Channel UUID (the `d` tag). */
  channelId: string;
  /** Current name (from the newest metadata event for this UUID). */
  name: string;
  /** Oldest metadata `created_at` seen — the best available proxy for age. */
  createdAt: number;
}

/**
 * Collapse raw kind:39000 events into one candidate per channel UUID.
 * The newest revision decides the current name (renames), the oldest decides age.
 */
export function collapseMetadata(events: NostrEvent[]): ChannelCandidate[] {
  const byId = new Map<string, { cand: ChannelCandidate; newest: number }>();
  for (const ev of events) {
    if (ev.kind !== KIND_GROUP_METADATA) continue;
    const d = tagValue(ev, "d");
    if (!d) continue;
    const name = tagValue(ev, "name") ?? "";
    const existing = byId.get(d);
    if (!existing) {
      byId.set(d, {
        cand: { channelId: d, name, createdAt: ev.created_at },
        newest: ev.created_at,
      });
      continue;
    }
    if (ev.created_at < existing.cand.createdAt) {
      existing.cand.createdAt = ev.created_at;
    }
    if (ev.created_at >= existing.newest) {
      existing.newest = ev.created_at;
      existing.cand.name = name;
    }
  }
  return [...byId.values()].map((v) => v.cand);
}

/**
 * Deterministic tie-break across same-named channels (§3 step 1):
 * (a) the persisted `channelId`, (b) the bridge's deterministic UUID,
 * (c) oldest `created_at`, ties broken by lexicographically lowest UUID —
 * so every instance converges on the same channel.
 */
export function pickChannel(
  candidates: ChannelCandidate[],
  persistedId: string | null,
  deterministicId: string,
): ChannelCandidate | null {
  if (candidates.length === 0) return null;
  if (persistedId) {
    const hit = candidates.find((c) => c.channelId === persistedId);
    if (hit) return hit;
  }
  const det = candidates.find((c) => c.channelId === deterministicId);
  if (det) return det;
  return [...candidates].sort(
    (a, b) => a.createdAt - b.createdAt || (a.channelId < b.channelId ? -1 : 1),
  )[0]!;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  for (const t of event.tags) {
    if (t[0] === name && typeof t[1] === "string") return t[1];
  }
  return undefined;
}

// --- ChannelManager --------------------------------------------------------

/**
 * The channel disappeared mid-run (`invalid: channel not found` on the join).
 * Internal to {@link ChannelManager.runEnsure}, which re-runs discovery once.
 */
class ChannelVanished extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelVanished";
  }
}

/**
 * The 39000 discovery scan hit {@link DISCOVER_MAX_PAGES} with its last page
 * still full — the relay is not honouring `until`, so we cannot prove the
 * channel is absent. Creating anyway would spawn a duplicate empty channel
 * (finding H-2), so `runEnsureOnce` throws this instead. It is a *retryable*
 * condition: the caller's re-run ladder retries, and a transient relay hiccup
 * resolves on the next pass.
 */
export class DiscoveryTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryTruncatedError";
  }
}

/** A single `ensureChannel` run exceeded {@link ENSURE_CHANNEL_DEADLINE_MS}. */
export class EnsureChannelTimeoutError extends Error {
  constructor(ms: number) {
    super(`ensureChannel did not settle within ${String(ms)}ms`);
    this.name = "EnsureChannelTimeoutError";
  }
}

export class ChannelManager implements IChannelManager {
  private readonly log: ReturnType<typeof makeLogger>;
  private cachedDeterministicId: string | null = null;
  /** Community (relay URL) the kind:0 profile has been ensured for (§3 step 4). */
  private profileEnsuredFor: string | null = null;
  /** In-flight ensureChannel, so concurrent triggers never race each other. */
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly config: Config,
    private readonly identity: BridgeIdentity,
    private readonly buzz: IBuzzClient,
    private readonly state: IStateStore,
  ) {
    this.log = makeLogger(config);
  }

  /** Deterministic UUIDv5 of bridge pubkey + channel name (§3). */
  deterministicChannelId(): string {
    this.cachedDeterministicId ??= deriveChannelId(
      this.identity.publicKey,
      this.config.channelName,
    );
    return this.cachedDeterministicId;
  }

  async ensureChannel(): Promise<string> {
    // A stuck run must never poison every future caller (finding H-6/M-4): race
    // the run against a deadline so a hang becomes a rejection, and clear
    // `inFlight` whichever side wins so the next caller starts a fresh attempt.
    this.inFlight ??= this.runEnsureWithDeadline().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private runEnsureWithDeadline(): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new EnsureChannelTimeoutError(ENSURE_CHANNEL_DEADLINE_MS));
      }, ENSURE_CHANNEL_DEADLINE_MS);
      if (typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([this.runEnsure(), deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private async runEnsure(): Promise<string> {
    // `invalid: channel not found` during the join means the channel vanished
    // between discovery and join. The error matrix says clear `channelId` and
    // **re-run** ChannelManager — but re-entering ensureChannel() here would
    // await the very promise we are inside, so the re-run is this loop.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runEnsureOnce();
      } catch (err) {
        if (attempt >= 1 || !(err instanceof ChannelVanished)) throw err;
        this.log("warn", "channel vanished during join; re-running discovery", {
          message: err.message,
        });
      }
    }
  }

  private async runEnsureOnce(): Promise<string> {
    const persisted = this.state.getState().channelId;
    const deterministic = this.deterministicChannelId();

    // 1. Discover.
    let disc = await this.discover(persisted, deterministic);
    let preExisting = disc.picked !== null;
    let channelId = disc.picked?.channelId ?? null;

    // 2. Create if absent.
    if (channelId === null) {
      // A truncated scan is NOT evidence of absence (finding H-2): the relay
      // capped the discovery window, so the channel may be just past it.
      // Creating now would spawn a duplicate empty channel. Refuse and let the
      // re-run ladder retry instead.
      if (disc.truncated) {
        throw new DiscoveryTruncatedError(
          "39000 discovery scan truncated (relay result cap hit); refusing to create a possibly-duplicate channel",
        );
      }
      // Persist the client-chosen UUID *before* publishing (§3 step 2): the
      // relay can never hand a UUID back through a client-signed 9007.
      this.state.mutate((s) => {
        s.channelId = deterministic;
      });
      const ok = await this.buzz.publish(
        this.sign({
          kind: KIND_CHANNEL_CREATE,
          tags: [
            ["name", this.config.channelName],
            ["about", this.config.channelAbout],
            // Explicit even though `open` is the relay default (§3 step 2).
            ["visibility", "open"],
            ["h", deterministic],
          ],
          content: "",
        }),
      );
      if (ok.ok) {
        channelId = deterministic;
        preExisting = false;
        this.log("info", "channel created", { channelId });
      } else if (ok.message.startsWith("duplicate:")) {
        // Lost the create race (only reachable because of the client `#h`):
        // fall back to discovery and converge on the winner's channel (§3).
        this.log("info", "channel create race lost, re-discovering", {
          message: ok.message,
        });
        disc = await this.discover(persisted, deterministic);
        channelId = disc.picked?.channelId ?? deterministic;
        preExisting = true;
      } else {
        this.state.mutate((s) => {
          s.channelId = null;
        });
        throw new Error(`channel create rejected: ${ok.message}`);
      }
    }

    // 3. Join if the channel pre-existed and we are not a member.
    if (preExisting && !(await this.isMember(channelId))) {
      await this.join(channelId);
    }

    // 4. Persist + kind:0 profile, once per community.
    this.state.mutate((s) => {
      s.channelId = channelId;
    });
    await this.ensureProfile();
    this.log("info", "channel ready", { channelId, preExisting });
    return channelId;
  }

  /**
   * Active reconnect-time verification (§3): historical `{kinds:[39000]}` REQ;
   * false means the stored UUID no longer resolves and `channelId` must be cleared.
   */
  async verifyChannelExists(channelId: string): Promise<boolean> {
    // Filter by `#d` so absence is authoritative (finding H-2): an unfiltered
    // `{kinds:[39000]}` REQ returns only the newest ~500 metadata events, so a
    // channel past that window looks gone, `channelId` gets cleared, and the
    // bridge creates a NEW empty channel nobody joined. Scoping the REQ to this
    // one UUID means an empty result set truly means "does not resolve".
    const events = await this.buzz.query("chan-verify", [
      { kinds: [KIND_GROUP_METADATA], "#d": [channelId] },
    ]);
    return collapseMetadata(events).some((c) => c.channelId === channelId);
  }

  // --- re-run triggers (§3) ------------------------------------------------

  /**
   * Publish-side trigger: an `invalid: channel not found` OK-false clears
   * `channelId` and re-runs the discover → create → join steps.
   */
  async handleChannelLost(): Promise<string> {
    this.log("warn", "channelId cleared, re-running ChannelManager");
    this.state.mutate((s) => {
      s.channelId = null;
    });
    return this.ensureChannel();
  }

  /**
   * Reconnect-side trigger: after every reconnect's AUTH, verify the stored
   * UUID still resolves; if it doesn't, clear it and re-run (§3).
   */
  async handleReconnect(): Promise<string> {
    const stored = this.state.getState().channelId;
    if (!stored) return this.ensureChannel();
    if (await this.verifyChannelExists(stored)) return stored;
    return this.handleChannelLost();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Discover the Services channel by name (spec §3 step 1).
   *
   * Discovery scans by `name`, not by UUID, so it cannot use a `#d` filter and
   * must page the whole 39000 set with `until` (finding H-2). The returned
   * `truncated` flag is true when the relay capped the scan (max pages hit with
   * a full last page) — the caller must NOT treat a null `picked` under
   * truncation as "channel absent".
   */
  private async discover(
    persisted: string | null,
    deterministic: string,
  ): Promise<{ picked: ChannelCandidate | null; truncated: boolean }> {
    const { events, truncated } = await this.scanMetadata();
    const wanted = this.config.channelName.trim();
    const matches = collapseMetadata(events).filter(
      (c) => c.name.trim() === wanted,
    );
    const picked = pickChannel(matches, persisted, deterministic);
    if (picked) {
      this.log("info", "channel discovered", {
        channelId: picked.channelId,
        candidates: matches.length,
      });
    } else if (truncated) {
      this.log("warn", "channel discovery scan truncated; absence unproven", {
        maxPages: DISCOVER_MAX_PAGES,
        pageSize: DISCOVER_PAGE_SIZE,
      });
    }
    return { picked, truncated };
  }

  /**
   * Page the full 39000 metadata set backwards with `until` (§3 step 1). Ends
   * on an empty or short page (drained → not truncated); if it exhausts
   * {@link DISCOVER_MAX_PAGES} with every page full, the relay is ignoring
   * `until` and the scan is reported truncated.
   */
  private async scanMetadata(): Promise<{
    events: NostrEvent[];
    truncated: boolean;
  }> {
    const all: NostrEvent[] = [];
    const seenIds = new Set<string>();
    let until: number | undefined;
    // Assume truncated until a page proves the scan drained.
    let truncated = true;

    for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
      const filter: NostrFilter = {
        kinds: [KIND_GROUP_METADATA],
        limit: DISCOVER_PAGE_SIZE,
      };
      if (until !== undefined) filter.until = until;

      const events = await this.buzz.query(`chan-disc-${String(page)}`, [
        filter,
      ]);
      if (events.length === 0) {
        truncated = false;
        break;
      }

      let fresh = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const ev of events) {
        if (ev.created_at < oldest) oldest = ev.created_at;
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
        fresh++;
        all.push(ev);
      }

      // A short page means the relay had nothing more to give → drained.
      if (events.length < DISCOVER_PAGE_SIZE) {
        truncated = false;
        break;
      }
      // A full page that was all duplicates (one shared `created_at` window):
      // step strictly below it to make progress, keeping the walk monotonic.
      if (fresh === 0) {
        until = Math.min(oldest, until ?? oldest) - 1;
        continue;
      }
      until = oldest;
    }

    return { events: all, truncated };
  }

  /** Membership via the relay-signed 39002 member list for this channel. */
  private async isMember(channelId: string): Promise<boolean> {
    // The 39002 probe is a best-effort read (finding M-1/M-2): a query
    // rejection (EOSE timeout / CLOSED) is "unknown", NOT "not a member". If we
    // let it propagate it would abort startup (`runEnsureOnce` does not catch
    // it). Treat unknown as "not a member" so we fall through to the tolerant
    // path — a redundant kind:9021 join, whose `duplicate:` is benign.
    let events: NostrEvent[];
    try {
      events = await this.buzz.query("chan-members", [
        { kinds: [KIND_GROUP_MEMBERS], "#d": [channelId] },
      ]);
    } catch (err) {
      this.log("warn", "39002 membership probe failed; assuming not a member", {
        channelId,
        error: String(err),
      });
      return false;
    }
    for (const ev of events) {
      if (tagValue(ev, "d") !== channelId) continue;
      for (const t of ev.tags) {
        if (t[0] === "p" && t[1] === this.identity.publicKey) return true;
      }
    }
    return false;
  }

  private async join(channelId: string): Promise<void> {
    const ok = await this.buzz.publish(
      this.sign({
        kind: KIND_JOIN_REQUEST,
        tags: [["h", channelId]],
        content: "",
      }),
    );
    if (ok.ok) {
      this.log("info", "joined channel", { channelId });
      return;
    }
    // Already a member is benign; private/not-found are not (error matrix).
    if (ok.message.startsWith("duplicate:")) {
      this.log("debug", "join reported duplicate; already a member", {
        channelId,
      });
      return;
    }
    if (ok.message.startsWith("invalid: channel not found")) {
      this.state.mutate((s) => {
        s.channelId = null;
      });
      throw new ChannelVanished(`channel join rejected: ${ok.message}`);
    }
    throw new Error(`channel join rejected: ${ok.message}`);
  }

  /**
   * kind:0 profile, once per community (§3 step 4). Profiles do not inherit
   * across community hosts, so presence is probed on the relay itself rather
   * than tracked in the state file (whose schema has no slot for it).
   */
  private async ensureProfile(): Promise<void> {
    const community = this.config.buzzRelayUrl;
    if (this.profileEnsuredFor === community) return;

    const desired = {
      name: "nostrwolfe-bridge",
      about: this.config.channelAbout,
    };
    // The kind:0 readback is best-effort (finding M-1/M-2): a query rejection
    // (EOSE timeout / CLOSED) must not abort startup. On unknown, fall through
    // to publishing the profile — a redundant kind:0 is harmless (replaceable
    // event), whereas a thrown probe would take the whole daemon down.
    let existing: NostrEvent[] = [];
    try {
      existing = await this.buzz.query("bridge-profile", [
        { kinds: [KIND_PROFILE], authors: [this.identity.publicKey], limit: 1 },
      ]);
    } catch (err) {
      this.log("warn", "kind:0 profile probe failed; publishing profile", {
        community,
        error: String(err),
      });
    }
    const current = existing[0];
    if (current && profileMatches(current.content, desired)) {
      this.profileEnsuredFor = community;
      return;
    }
    const ok = await this.buzz.publish(
      this.sign({
        kind: KIND_PROFILE,
        tags: [],
        content: JSON.stringify(desired),
      }),
    );
    if (!ok.ok) {
      this.log("warn", "profile publish rejected", { message: ok.message });
      return;
    }
    this.profileEnsuredFor = community;
    this.log("info", "profile published", { community });
  }

  private sign(
    template: Omit<UnsignedEvent, "pubkey" | "created_at">,
  ): NostrEvent {
    return finalizeEvent(
      {
        kind: template.kind,
        tags: template.tags,
        content: template.content,
        created_at: Math.floor(Date.now() / 1000),
      },
      this.identity.secretKey,
    ) as NostrEvent;
  }
}

function profileMatches(
  content: string,
  desired: { name: string; about: string },
): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return false;
    const p = parsed as { name?: unknown; about?: unknown };
    return p.name === desired.name && p.about === desired.about;
  } catch {
    return false;
  }
}
