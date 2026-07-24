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

/** Duck-typed event source — BuzzClient exposes `on()` if it emits triggers. */
interface TriggerSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

function isTriggerSource(value: unknown): value is TriggerSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { on?: unknown }).on === "function"
  );
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
    this.inFlight ??= this.runEnsure().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
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
    let found = await this.discover(persisted, deterministic);
    let preExisting = found !== null;
    let channelId = found?.channelId ?? null;

    // 2. Create if absent.
    if (channelId === null) {
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
        found = await this.discover(persisted, deterministic);
        channelId = found?.channelId ?? deterministic;
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
    const events = await this.buzz.query("chan-verify", [
      { kinds: [KIND_GROUP_METADATA] },
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

  /**
   * Wire both re-run triggers to a BuzzClient that emits them. Duck-typed so the
   * shared `IBuzzClient` contract (types.ts) does not need an emitter surface.
   */
  attachTriggers(source: unknown = this.buzz): void {
    if (!isTriggerSource(source)) {
      this.log("warn", "trigger source has no on(); re-run triggers not wired");
      return;
    }
    source.on("channelLost", () => {
      void this.handleChannelLost().catch((err: unknown) => {
        this.log("error", "channelLost re-run failed", { err: String(err) });
      });
    });
    // BuzzClient emits `authenticated` after **every** AUTH — initial connect
    // and every reconnect. There is no `reconnected` event; listening for one
    // silently disabled the reconnect-side 39000 verification (§3).
    source.on("authenticated", () => {
      void this.handleReconnect().catch((err: unknown) => {
        this.log("error", "reconnect verification failed", {
          err: String(err),
        });
      });
    });
  }

  // --- internals -----------------------------------------------------------

  private async discover(
    persisted: string | null,
    deterministic: string,
  ): Promise<ChannelCandidate | null> {
    const events = await this.buzz.query("chan-disc", [
      { kinds: [KIND_GROUP_METADATA] },
    ]);
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
    }
    return picked;
  }

  /** Membership via the relay-signed 39002 member list for this channel. */
  private async isMember(channelId: string): Promise<boolean> {
    const events = await this.buzz.query("chan-members", [
      { kinds: [KIND_GROUP_MEMBERS], "#d": [channelId] },
    ]);
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
    const existing = await this.buzz.query("bridge-profile", [
      { kinds: [KIND_PROFILE], authors: [this.identity.publicKey], limit: 1 },
    ]);
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
