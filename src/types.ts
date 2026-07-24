/**
 * nostrwolfe-bridge — shared contract.
 *
 * This module is the single source of truth every other module codes against.
 * It is derived directly from the design spec's "Components" section:
 * docs/superpowers/specs/2026-07-23-bridge-agent-design.md
 *
 * Nothing here has runtime behavior — it is types, interfaces, and enums only.
 */

// ---------------------------------------------------------------------------
// Primitive Nostr wire types
// ---------------------------------------------------------------------------

/** A single Nostr tag: tag name followed by zero or more string values. */
export type NostrTag = string[];

/** A signed Nostr event (NIP-01). Matches nostr-tools' `Event` shape. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
  sig: string;
}

/** An event prior to id/sig computation, ready for `finalizeEvent`. */
export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
}

/**
 * A Nostr REQ filter (NIP-01). Tag filters use `#<letter>` keys.
 * `kinds` is effectively always required for Buzz REQs — omitting it trips the
 * p-gate 403 (spec §2).
 */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagFilter: `#${string}`]: string[] | undefined;
}

/** Result of correlating a relay `["OK", id, ok, message]` frame. */
export interface OkResult {
  /** Event id the OK refers to. */
  id: string;
  /** Relay accepted the event. */
  ok: boolean;
  /** Human/machine-readable message (e.g. `rate-limited: quota exceeded; retry in 5s`). */
  message: string;
}

/** Callback invoked for each event delivered on a subscription. */
export type EventHandler = (event: NostrEvent) => void;

/** Callback invoked once when a subscription reaches EOSE. */
export type EoseHandler = () => void;

/** Handle to an active subscription; `close()` sends CLOSE for the sub id. */
export interface Subscription {
  readonly id: string;
  close(): void;
}

// ---------------------------------------------------------------------------
// Config (spec §1 — all 11 env vars, typed)
// ---------------------------------------------------------------------------

/** Log verbosity, pino-style levels emitted as plain stdout JSON lines. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Fully validated configuration. Loaded from the environment (`.env` supported),
 * one property per spec §1 env var. `MIRROR_CATEGORIES` is parsed from CSV into
 * an array (empty array = mirror all categories).
 */
export interface Config {
  /** BRIDGE_NSEC — bech32 nsec or 64-hex; signs AUTH, 9007, 9021, kind:9, kind:0. */
  bridgeNsec: string;
  /** BUZZ_RELAY_URL — `ws://localhost:3000` (dev) or `wss://<community-host>` (hosted). */
  buzzRelayUrl: string;
  /** WOLFE_RELAY_URL — public strfry relay, read-only in v1. */
  wolfeRelayUrl: string;
  /** BRIDGE_CHANNEL_NAME — match/create key; input to the deterministic channel UUID (§3). */
  channelName: string;
  /** BRIDGE_CHANNEL_ABOUT — 9007 `about` tag. */
  channelAbout: string;
  /** MIRROR_CATEGORIES — parsed CSV; empty = all. Applied client-side in MirrorEngine (§5). */
  mirrorCategories: string[];
  /**
   * MIRROR_ACCEPT_DIALECTS — normalize listings that don't use NIP-A5 tags
   * (see `dialect.ts`). Default true; false makes the parser strictly
   * spec-compliant and drops most of the live relay.
   */
  mirrorAcceptDialects: boolean;
  /** MIRROR_MAX_LISTINGS — cap on distinct addresses tracked; overflow logged and skipped. */
  mirrorMaxListings: number;
  /** BACKFILL_LIMIT — page size (`limit`) for the paged strfry hydration REQ (§4). */
  backfillLimit: number;
  /** BUZZ_MSGS_PER_MIN — self-imposed publish budget for the token bucket (§2). */
  buzzMsgsPerMin: number;
  /** STATE_FILE — path to the flat JSON state file. */
  stateFile: string;
  /** LOG_LEVEL — pino-style level. */
  logLevel: LogLevel;
  /**
   * STALE_LISTING_DAYS — age (in days) past which an active mirrored listing is
   * reported as stale by the daily staleness sweep (§3d). Default 30.
   */
  staleListingDays: number;
}

/** Resolved signing identity derived from `BRIDGE_NSEC`. Never logged or persisted. */
export interface BridgeIdentity {
  /** 32-byte secret key for nostr-tools' `finalizeEvent`. */
  secretKey: Uint8Array;
  /** 64-hex public key. */
  publicKey: string;
}

// ---------------------------------------------------------------------------
// Persistent state (spec §7)
// ---------------------------------------------------------------------------

/** Dedupe metadata for one mirrored address. Cards themselves live in the channel. */
export interface MirroredEntry {
  /** Event id of the latest 38400 seen for this address. */
  eventId: string;
  /** `created_at` of that event; drives the replace/skip decision (§5). */
  createdAt: number;
  /** Message id of the last card posted for this address (kind:9). */
  cardMsgId: string;
  /**
   * True when the address is **not in the active cache** — the tombstone flag.
   * Set for a category exit (delisted) *and* for the lifecycle-inactive states
   * (paused via `status:inactive`, removed via NIP-09/`status:removed`, expired
   * via NIP-40). All four share the delisted-tombstone machinery: dropped from
   * the search cache, retained here for dedupe, restored by a later active
   * matching replacement. Cleared (a fresh entry) whenever an active card posts.
   */
  delisted: boolean;
  /**
   * True once this address has been reported in a staleness digest (§3d), so a
   * daily sweep announces each stale listing at most once. Reset (absent on the
   * fresh entry) whenever an active `new`/`updated` card re-records the address,
   * so a listing that refreshes and later goes stale again is re-reported.
   */
  staleNotified?: boolean;
}

/** Addressable-event key → dedupe metadata. Key is `38400:<pubkey>:<d>`. */
export type MirroredMap = Record<string, MirroredEntry>;

/** The full on-disk state document (`bridge-state.json`). */
export interface BridgeState {
  /** Schema version. */
  version: number;
  /** Relay URL this state belongs to; mismatch triggers a full reset (§7). */
  community: string;
  /** Resolved Services-channel UUID, or null before ChannelManager runs. */
  channelId: string | null;
  /** Live-subscription cursors (max `created_at` processed) per relay. */
  cursors: {
    /** Wolfe live-sub `since` source (§4). */
    wolfe: number;
    /** Buzz mentions live-sub `since` source (§6). */
    buzz: number;
  };
  /** Dedupe set keyed by addressable form. */
  mirrored: MirroredMap;
}

// ---------------------------------------------------------------------------
// Parsed 38400 listing (spec §5 — all NIP tags)
// ---------------------------------------------------------------------------

/** One price tier from a `["price","<n>","<currency>","<frequency>"]` tag. */
export interface PriceTier {
  /** Raw amount string; renders as `—` if non-numeric (§ security). */
  amount: string;
  /** Currency code, e.g. `sats`, `usd`. */
  currency: string;
  /** Optional billing frequency, e.g. `monthly`, `per-call`. */
  frequency?: string;
  /**
   * Free-form pricing text that could not be reduced to amount+currency, kept
   * verbatim so a card can still say something true. Only ever set by the
   * dialect adapter, whose sources price in prose ("Dynamic (varies by
   * destination)"). Rendered instead of a numeric tier when `amount` is empty.
   */
  note?: string;
}

/** Endpoint metadata from an `["endpoint","<url>","<method>"]` tag. */
export interface EndpointInfo {
  url: string;
  method?: string;
}

/** Parsed `negotiable` tag. Card renders as `yes | no | floor <n> sats`. */
export type Negotiable =
  { kind: "yes" } | { kind: "no" } | { kind: "floor"; sats: number };

/**
 * A validated, parsed kind:38400 capability advertisement.
 * Fields cover every tag the NIP defines (spec §5 step 4).
 */
export interface ParsedListing {
  /** The raw, signature-verified source event. */
  event: NostrEvent;
  /** Addressable form `38400:<pubkey>:<d>`. */
  address: string;
  /** Signer pubkey (64-hex) = listing owner. */
  pubkey: string;
  /** `created_at` of the source event; the replace/skip clock. */
  createdAt: number;
  /** `d` tag — required, non-empty; the logical listing id. */
  d: string;
  /** `s` tags — service categories; at least one required. */
  s: string[];
  /** `price` tags — one or more tiers; at least one required. */
  prices: PriceTier[];
  /** `l402` tag — L402-gated endpoint URL, if any. */
  l402?: string;
  /** `endpoint` tag — plain endpoint URL + method, if any. */
  endpoint?: EndpointInfo;
  /** `schema` tag — request/response schema reference, if any. */
  schema?: string;
  /** `capacity` tag — self-reported capacity `<amount> <unit>`, if any. */
  capacity?: string;
  /** `uptime` tag — self-reported uptime (renders as %), if any. */
  uptime?: string;
  /** `t` tags — freeform hashtags. */
  t: string[];
  /** `negotiable` tag, parsed. */
  negotiable?: Negotiable;
  /**
   * `status` tag (NIP-A5 listing lifecycle). One of `"active"`, `"inactive"`
   * (paused), or `"removed"`. Absent tag → treated as `"active"` (the NIP's
   * default). An unrecognized value is treated as `"active"` too, so a typo can
   * never silently hide a live listing. Drives the availability decision (§5).
   */
  status?: "active" | "inactive" | "removed";
  /**
   * `expiration` tag (NIP-40), parsed to a unix timestamp (seconds). A listing
   * whose `expiration` is in the past is treated as unavailable (§5/§3c).
   */
  expiration?: number;
  /** Provider content, plain-text (untrusted; sanitized at render time §5/§security). */
  content: string;
  /**
   * Set when the listing did not use NIP-A5 tags and was normalized by the
   * dialect adapter — the short label of the dialect that matched. Absent for
   * spec-compliant listings. Cards surface it so a reader can tell a normalized
   * listing from a canonical one.
   */
  dialect?: string;
}

// ---------------------------------------------------------------------------
// Mirror decision (spec §5 decision table)
// ---------------------------------------------------------------------------

/**
 * Which card header a mirror post carries.
 *
 * `new`/`updated` are active cards; `delisted`/`paused`/`removed`/`expired` are
 * the tombstone notes (§5, §3a-c) — header + separator + footer only, dropped
 * from the active cache.
 */
export type CardKind =
  "new" | "updated" | "delisted" | "paused" | "removed" | "expired";

/** Reason a 38400 produced no card (the "skip"/"ignore" rows of §5). */
export type MirrorSkipReason =
  /** Failed sig/required-tag validation (§5 step 1). */
  | "invalid"
  /** Unknown address whose categories are outside the allowlist. */
  | "category-mismatch"
  /** Unknown address but cache already at `MIRROR_MAX_LISTINGS`. */
  | "at-cap"
  /** Same `created_at`, id not lower than stored (not a lowest-id replacement). */
  | "duplicate"
  /** `created_at` older than stored (relay replay / out-of-order). */
  | "out-of-order"
  /**
   * A lifecycle-inactive listing (paused/removed/expired) that produced no new
   * card: either an unknown address that was never mirrored while active, or an
   * already-tombstoned address whose state was refreshed without re-posting
   * (idempotent NIP-09 + `status:removed`, repeated non-active replacements).
   */
  | "not-active";

/**
 * Outcome of {@link IMirrorEngine.handleListing}, as a discriminated union over
 * the §5 decision table. `new`/`update`/`delisted`/`paused`/`removed`/`expired`
 * each posted a card; `skip` posted nothing and carries the reason.
 */
export type MirrorOutcome =
  | { type: "new"; address: string; cardMsgId: string }
  | { type: "update"; address: string; cardMsgId: string }
  | { type: "delisted"; address: string; cardMsgId: string }
  | { type: "paused"; address: string; cardMsgId: string }
  | { type: "removed"; address: string; cardMsgId: string }
  | { type: "expired"; address: string; cardMsgId: string }
  | { type: "skip"; reason: MirrorSkipReason; address?: string };

// ---------------------------------------------------------------------------
// QueryResponder (spec §6)
// ---------------------------------------------------------------------------

/** Parsed `@bridge` command from a channel mention. */
export type BridgeCommand =
  | { type: "find"; query: string }
  /** `@bridge publish <signed 38400 JSON>` — forward a member's own listing (§8). */
  | { type: "publish"; payload: string }
  | { type: "help" }
  /** Addressed to the bridge but not a recognized command → help once per thread. */
  | { type: "unknown" };

/** A scored search hit rendered as one compact line in a `find` reply. */
export interface SearchResult {
  address: string;
  d: string;
  categories: string[];
  /** Pre-rendered price summary, e.g. `100 sats monthly`. */
  price: string;
  /** Relevance score (higher first). */
  score: number;
}

// ---------------------------------------------------------------------------
// Footer recovery (spec §7)
// ---------------------------------------------------------------------------

/** A dedupe entry recovered from a card footer during state-less recovery (§7). */
export interface RecoveredFooter {
  address: string;
  /** Message id of the card the footer came from. */
  cardMsgId: string;
  /** Header kind of the recovered card. */
  cardKind: CardKind;
}

// ---------------------------------------------------------------------------
// Component interfaces
// ---------------------------------------------------------------------------

/**
 * BuzzClient (spec §2) — owns the single WebSocket to the Buzz relay, handles
 * NIP-42 AUTH, rate-limited publish with OK tracking, and subscriptions with
 * automatic resubscription on reconnect.
 */
export interface IBuzzClient {
  /** Connect, complete the proactive-AUTH handshake, and resolve once authed. */
  connect(): Promise<void>;
  /** Publish an event, resolving with the correlated OK (§2, error matrix). */
  publish(event: NostrEvent): Promise<OkResult>;
  /**
   * Open a persistent subscription. Resubscribes on reconnect with
   * `since = cursor − 300`. All filters must carry explicit `kinds` (§2).
   */
  subscribe(
    subId: string,
    filters: NostrFilter[],
    onEvent: EventHandler,
    onEose?: EoseHandler,
    /**
     * Cursor source. When given, every (re)issue of the REQ carries
     * `since = cursor − 300`, which is what makes a resubscribe after reconnect
     * pick up where the last one left off instead of replaying a static window
     * (spec §2). Callers that bake `since` into `filters` get a fixed window.
     */
    since?: () => number,
  ): Subscription;
  /**
   * One-shot historical REQ: collect events until EOSE, then CLOSE and resolve.
   * Used for 39000 discovery and kind:9 footer recovery (§3, §7).
   */
  query(subId: string, filters: NostrFilter[]): Promise<NostrEvent[]>;
  /** Close the WebSocket and stop reconnecting. */
  close(): void;
}

/**
 * WolfeSubscriber (spec §4) — single WebSocket to the public strfry relay
 * (no AUTH). Rebuilds the cache via paged hydration, then stays live.
 */
export interface IWolfeSubscriber {
  /**
   * Full paged hydration REQ (`{kinds:[38400], limit}` paging backwards with
   * `until`), invoking `onListing` for every event. Resolves when the set is
   * drained or `MIRROR_MAX_LISTINGS` addresses have been seen (§4).
   */
  hydrate(
    onListing: (event: NostrEvent) => Promise<void> | void,
  ): Promise<void>;
  /**
   * Start the persistent live subscription `{kinds:[38400], since: cursor−300}`
   * (no `limit`), invoking `onListing` for each new event (§4).
   */
  subscribeLive(onListing: (event: NostrEvent) => Promise<void> | void): void;
  /** Close the WebSocket and stop reconnecting. */
  close(): void;
}

/**
 * MirrorEngine + ListingCache (spec §5) — the dedupe/replace/format core.
 */
export interface IMirrorEngine {
  /** Apply the §5 decision table to one incoming 38400 and return the outcome. */
  handleListing(event: NostrEvent): Promise<MirrorOutcome>;
  /**
   * Apply a NIP-09 kind:5 deletion (§3b). For each `["a","38400:<pubkey>:<d>"]`
   * tag whose pubkey **matches the deletion's author** (no cross-author
   * deletion) and whose address is currently mirrored-and-live, post a
   * "Removed" note, drop it from the cache, and tombstone the entry. Idempotent:
   * a replayed kind:5 over an already-removed address is a no-op. Returns one
   * outcome per address acted on (empty when nothing matched).
   */
  handleDeletion(event: NostrEvent): Promise<MirrorOutcome[]>;
}

/**
 * ListingCache (spec §5) — in-memory, addressable-keyed store of the latest
 * parsed listing per address. Rebuilt on every startup by hydration.
 */
export interface IListingCache {
  get(address: string): ParsedListing | undefined;
  set(address: string, listing: ParsedListing): void;
  has(address: string): boolean;
  delete(address: string): boolean;
  /** Every currently cached listing (for QueryResponder search). */
  all(): ParsedListing[];
  /** Distinct addresses tracked; compared against `MIRROR_MAX_LISTINGS`. */
  readonly size: number;
}

/**
 * QueryResponder (spec §6) — answers `@bridge` mentions in the channel.
 */
export interface IQueryResponder {
  /**
   * Handle one inbound kind:9 mention: detect addressing, enforce the 1-hour
   * staleness cutoff and per-sender cooldown, parse the command, and reply
   * in-thread (§6).
   */
  handleMention(event: NostrEvent): Promise<void>;
  /** Parse `@bridge <command>` content into a structured command. */
  parseCommand(content: string): BridgeCommand;
  /** Score cached listings for a `find` query, returning the top hits. */
  search(query: string): SearchResult[];
}

/**
 * ChannelManager (spec §3) — discovers, creates, or joins the Services channel
 * and keeps the deterministic UUID resolved.
 */
export interface IChannelManager {
  /**
   * Ensure the Services channel exists and the bridge is a member; return its
   * UUID. Runs the discover → create → join steps (§3), persisting the UUID.
   */
  ensureChannel(): Promise<string>;
  /**
   * Active reconnect-time verification: historical `{kinds:[39000]}` REQ; returns
   * false (and the caller clears `channelId`) if the stored UUID no longer
   * resolves (§3 re-run triggers).
   */
  verifyChannelExists(channelId: string): Promise<boolean>;
  /** Deterministic UUIDv5 of bridge pubkey + channel name (§3). */
  deterministicChannelId(): string;
}

/**
 * StateStore (spec §7) — single JSON file, atomic debounced writes, community
 * guard with full reset on mismatch.
 */
export interface IStateStore {
  /**
   * Load state from disk (or a fresh default). If the persisted `community`
   * differs from `expectedCommunity`, perform a full reset (§7) before
   * returning.
   */
  load(expectedCommunity: string): Promise<BridgeState>;
  /** In-memory snapshot of current state. */
  getState(): BridgeState;
  /** Apply a mutation and schedule a debounced (2s) atomic flush. */
  mutate(fn: (state: BridgeState) => void): void;
  /** Force an immediate atomic flush (SIGINT/SIGTERM, ordering barriers). */
  flush(): Promise<void>;
  /** Full reset for `community`: clear mirrored/channelId/cursors (§7). */
  reset(community: string): void;
}
