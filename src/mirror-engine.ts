/** MirrorEngine — decision table, card formatting, sanitization (spec §5). */

import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";

import type {
  CardKind,
  Config,
  EndpointInfo,
  IBuzzClient,
  IListingCache,
  IMirrorEngine,
  IStateStore,
  MirrorOutcome,
  MirroredEntry,
  Negotiable,
  NostrEvent,
  NostrTag,
  OkResult,
  ParsedListing,
  PriceTier,
} from "./types.js";

/** Kind of a NostrWolfe capability advertisement. */
export const LISTING_KIND = 38400;

/** Kind of a Buzz chat message (the card carrier). */
const CHAT_KIND = 9;

/** Em-dash used for every missing/unrenderable field (§5 step 4). */
const DASH = "—";

/** Card separator line that precedes the machine-readable footer. */
const SEPARATOR = "─";

/** Max chars of provider `content` rendered into a card (§5 step 4, security §2). */
export const CONTENT_MAX = 400;

/** Card headers. The footer parser (§7) keys off these exact strings. */
const HEADERS: Record<CardKind, string> = {
  new: "🐺 New service: ",
  updated: "🐺 Updated: ",
  delisted: "🐺 Delisted: ",
};

// ---------------------------------------------------------------------------
// Logging (plain stdout JSON lines, spec §1 LOG_LEVEL)
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type Level = keyof typeof LEVELS;

function log(
  min: Level,
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVELS[level] < LEVELS[min]) return;
  process.stdout.write(
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      mod: "mirror-engine",
      msg,
      ...fields,
    }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Sanitization (spec §5 step 4 + Security §2)
// ---------------------------------------------------------------------------

/**
 * C0/C1 control characters plus zero-width, bidi-override and BOM codepoints.
 * The channel is read by LLM-driven buzz-agents, so invisible steering
 * characters are stripped alongside classic control bytes (Security §2).
 * `\n` is preserved here and handled per-context by the callers.
 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** The bridge's own command grammar; a listing must never be re-interpretable. */
const BRIDGE_COMMAND = /@bridge\b/i;

/** A provider line forging the machine-readable footer grammar. */
const FOOTER_LINE = /^nw:/i;

/**
 * Per-field render caps. `content` has its own {@link CONTENT_MAX}; every
 * *tag*-derived field is capped here too, so a 64 KB tag value can never push a
 * card past the 65,536-byte Buzz WS frame cap (§2 frame budget).
 */
export const FIELD_MAX = {
  /** `d` — also the address/footer key, so the cap is generous but finite. */
  d: 200,
  url: 512,
  short: 64,
} as const;

/** Strip control chars; collapse tabs to spaces. Keeps newlines. */
function stripControl(raw: string): string {
  return raw.replace(CONTROL_CHARS, "").replace(/\t/g, " ").replace(/\r/g, "");
}

/**
 * Sanitize a value rendered into a single card field: no control chars, no
 * newlines (a newline in a tag value could otherwise forge a card line or
 * footer), no bridge command grammar, whitespace-collapsed, trimmed, and capped.
 *
 * Security §2 requires "anything matching the bridge's own command grammar" to
 * be stripped from the whole card, not just from `content` — tags come from the
 * same unauthenticated relay and land in the same LLM-read channel, so the
 * `@bridge` cut lives here rather than only in {@link sanitizeContent}.
 *
 * Idempotent: sanitizing an already-sanitized value (including a truncated one)
 * returns it unchanged, which is what lets the address, header and footer be
 * derived from the same string by construction (§7).
 */
export function sanitizeField(
  raw: string | undefined,
  max: number = FIELD_MAX.url,
): string {
  if (raw === undefined) return "";
  let s = stripControl(raw);
  const cmd = s.search(BRIDGE_COMMAND);
  if (cmd >= 0) s = s.slice(0, cmd);
  s = s.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Sanitize untrusted provider `content` for rendering (Security §2):
 * 1. strip control/zero-width/bidi characters,
 * 2. cut each line at any `@bridge` occurrence (the bridge command grammar),
 * 3. drop any line beginning with `nw:` (a forged machine-readable footer would
 *    otherwise poison footer-based recovery, §7),
 * 4. drop blank lines, then truncate to {@link CONTENT_MAX} chars.
 */
export function sanitizeContent(raw: string): string {
  const lines = stripControl(raw)
    .split("\n")
    .map((line) => {
      const cmd = line.search(BRIDGE_COMMAND);
      return (cmd >= 0 ? line.slice(0, cmd) : line).trim();
    })
    .filter((line) => line.length > 0 && !FOOTER_LINE.test(line));

  const joined = lines.join("\n");
  if (joined.length <= CONTENT_MAX) return joined;
  // Truncation only removes a suffix, so it can never create a new line start
  // and therefore can never resurrect a stripped `nw:` / `@bridge` line.
  return joined.slice(0, CONTENT_MAX - 1) + "…";
}

// ---------------------------------------------------------------------------
// Tag parsing (spec §5 step 1-2; nips/agent-service-agreements.md kind 38400)
// ---------------------------------------------------------------------------

function tagValues(tags: NostrTag[], name: string): NostrTag[] {
  return tags.filter((t) => t[0] === name);
}

function firstTag(tags: NostrTag[], name: string): NostrTag | undefined {
  return tags.find((t) => t[0] === name);
}

function parseNegotiable(tag: NostrTag | undefined): Negotiable | undefined {
  if (!tag) return undefined;
  const v = (tag[1] ?? "").trim().toLowerCase();
  if (v === "true") return { kind: "yes" };
  if (v === "false") return { kind: "no" };
  if (v === "floor") {
    const sats = Number((tag[2] ?? "").trim());
    if (Number.isFinite(sats)) return { kind: "floor", sats };
  }
  return undefined;
}

/**
 * Addressable form `38400:<pubkey>:<d>` (NIP-33, spec §5 step 2).
 *
 * The `d` part is the **sanitized** tag value, because the same string is the
 * dedupe key, the card header and the card footer — deriving all three from one
 * normalization is what makes footer recovery able to re-derive the dedupe set
 * (§7). A raw `d` would also let a newline inside the tag forge extra card
 * lines wherever the address is rendered (Security §2).
 */
export function addressOf(event: NostrEvent): string | null {
  const d = sanitizeField(firstTag(event.tags, "d")?.[1], FIELD_MAX.d);
  if (d.length === 0) return null;
  return `${LISTING_KIND}:${event.pubkey}:${d}`;
}

/**
 * Parse and validate a raw kind:38400 into a {@link ParsedListing} (§5 step 1-2).
 *
 * §5 step 1: `verifyEvent` (BIP-340) — never trust an open relay's contents —
 * plus the NIP's required tags: non-empty `d`, at least one `s`, and a `price`.
 * Returns null (caller drops + logs) on any failure.
 */
export function parseListing(event: NostrEvent): ParsedListing | null {
  if (event.kind !== LISTING_KIND) return null;
  // Verify a plain 7-field copy: nostr-tools caches a "already verified" symbol
  // on event objects, and an object that carried it in would skip BIP-340
  // entirely. Untrusted input must always be re-verified from scratch.
  const plain = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
  if (!verifyEvent(plain as never)) return null;

  // Normalize once, here: `listing.d`, `listing.address`, the card header and
  // the card footer are all this one string, so the footer a recovery scan
  // reads is always exactly the key the live path looks up (§7).
  const d = sanitizeField(firstTag(event.tags, "d")?.[1], FIELD_MAX.d);
  if (d.length === 0) return null;

  const s = tagValues(event.tags, "s")
    .map((t) => (t[1] ?? "").trim())
    .filter((v) => v.length > 0);
  if (s.length === 0) return null;

  const prices: PriceTier[] = tagValues(event.tags, "price")
    .filter((t) => t.length >= 2)
    .map((t) => {
      const tier: PriceTier = {
        amount: (t[1] ?? "").trim(),
        currency: (t[2] ?? "").trim(),
      };
      const freq = (t[3] ?? "").trim();
      if (freq.length > 0) tier.frequency = freq;
      return tier;
    });
  if (prices.length === 0) return null;

  const listing: ParsedListing = {
    event,
    address: `${LISTING_KIND}:${event.pubkey}:${d}`,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    d,
    s,
    prices,
    t: tagValues(event.tags, "t")
      .map((tag) => (tag[1] ?? "").trim())
      .filter((v) => v.length > 0),
    content: event.content,
  };

  const l402 = firstTag(event.tags, "l402")?.[1];
  if (l402 !== undefined && l402.length > 0) listing.l402 = l402;

  const endpointTag = firstTag(event.tags, "endpoint");
  if (endpointTag && (endpointTag[1] ?? "").length > 0) {
    const endpoint: EndpointInfo = { url: endpointTag[1] as string };
    const method = (endpointTag[2] ?? "").trim();
    if (method.length > 0) endpoint.method = method;
    listing.endpoint = endpoint;
  }

  const schema = firstTag(event.tags, "schema")?.[1];
  if (schema !== undefined && schema.length > 0) listing.schema = schema;

  const capacityTag = firstTag(event.tags, "capacity");
  if (capacityTag && (capacityTag[1] ?? "").length > 0) {
    const unit = (capacityTag[2] ?? "").trim();
    listing.capacity =
      unit.length > 0
        ? `${capacityTag[1] as string} ${unit}`
        : (capacityTag[1] as string);
  }

  const uptime = firstTag(event.tags, "uptime")?.[1];
  if (uptime !== undefined && uptime.length > 0) listing.uptime = uptime;

  // NIP-ASA: "If the `negotiable` tag is omitted, agents SHOULD assume the
  // price is negotiable (`true`)" — so an absent tag is materialized as `yes`
  // here. A *present but unparseable* tag stays undefined and renders as `—`.
  const negotiableTag = firstTag(event.tags, "negotiable");
  const negotiable = negotiableTag
    ? parseNegotiable(negotiableTag)
    : ({ kind: "yes" } as const);
  if (negotiable) listing.negotiable = negotiable;

  return listing;
}

// ---------------------------------------------------------------------------
// Per-tag formatters (spec §5 step 4; Security §2 — never render raw)
// ---------------------------------------------------------------------------

function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** `50 sats per-request`; a non-numeric amount renders as `—` (Security §2). */
export function formatPriceTier(tier: PriceTier): string {
  if (tier.amount.length === 0 || !Number.isFinite(Number(tier.amount)))
    return DASH;
  const parts = [sanitizeField(tier.amount, FIELD_MAX.short)];
  const currency = sanitizeField(tier.currency, FIELD_MAX.short);
  if (currency.length > 0) parts.push(currency);
  const frequency = sanitizeField(tier.frequency, FIELD_MAX.short);
  if (frequency.length > 0) parts.push(frequency);
  return parts.join(" ");
}

/** All tiers joined with ` · ` (§5 step 4 "additional tiers"). */
export function formatPrices(tiers: PriceTier[]): string {
  if (tiers.length === 0) return DASH;
  return tiers.map(formatPriceTier).join(" · ");
}

/** l402 URL, else endpoint URL (+ method), else em-dash. */
export function formatEndpoint(listing: ParsedListing): string {
  if (listing.l402) return sanitizeField(listing.l402, FIELD_MAX.url);
  if (listing.endpoint) {
    const url = sanitizeField(listing.endpoint.url, FIELD_MAX.url);
    const method = sanitizeField(listing.endpoint.method, FIELD_MAX.short);
    return method.length > 0 ? `${url} (${method})` : url;
  }
  return DASH;
}

/**
 * The NIP defines `uptime` as a decimal ratio (`"0.997"`), rendered as a
 * percentage. Values above 1 are tolerated as already-percent input.
 */
export function formatUptime(raw: string | undefined): string {
  if (raw === undefined) return DASH;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DASH;
  return `${trimNumber(n <= 1 ? n * 100 : n)}%`;
}

/** `yes` | `no` | `floor <n> sats` (§5 step 4). */
export function formatNegotiable(n: Negotiable | undefined): string {
  if (!n) return DASH;
  if (n.kind === "yes") return "yes";
  if (n.kind === "no") return "no";
  return `floor ${trimNumber(n.sats)} sats`;
}

// ---------------------------------------------------------------------------
// Card formatting (spec §5 step 4)
// ---------------------------------------------------------------------------

/**
 * Render a card body for the given listing and header kind (§5 step 4).
 *
 * Update cards are identical to new-listing cards in every field and line
 * except the header. Delisted notes carry only header + separator + footer.
 * The final line is always the machine-readable footer `nw:38400:<pubkey>:<d>`
 * — the sole recovery key (§7), which is why `d` is field-sanitized (no
 * newlines) before it reaches either the header or the footer.
 */
export function formatCard(listing: ParsedListing, kind: CardKind): string {
  // `listing.d` is already the canonical sanitized value (parseListing), so the
  // footer here is byte-identical to `listing.address`'s `d` part by
  // construction — the invariant footer recovery depends on (§7).
  const d = sanitizeField(listing.d, FIELD_MAX.d);
  const footer = `nw:${LISTING_KIND}:${listing.pubkey}:${d}`;
  const header = `${HEADERS[kind]}${d}`;

  if (kind === "delisted") {
    return [header, SEPARATOR, footer].join("\n");
  }

  const categories =
    listing.s
      .map((v) => sanitizeField(v, FIELD_MAX.short))
      .filter((v) => v.length > 0)
      .join(", ") || DASH;
  const hashtags =
    listing.t
      .map((tag) => sanitizeField(tag, FIELD_MAX.short))
      .filter((v) => v.length > 0)
      .map((v) => `#${v}`)
      .join(" ") || DASH;
  const capacity = listing.capacity
    ? sanitizeField(listing.capacity, FIELD_MAX.short)
    : DASH;

  const lines = [
    header,
    `Provider: ${npubEncode(listing.pubkey)}`,
    `Categories: ${categories}  •  Tags: ${hashtags}`,
    `Price: ${formatPrices(listing.prices)}`,
    `Endpoint: ${formatEndpoint(listing)}`,
    `Uptime: ${formatUptime(listing.uptime)} · Capacity: ${capacity}`,
    `Negotiable: ${formatNegotiable(listing.negotiable)}`,
  ];

  const content = sanitizeContent(listing.content);
  if (content.length > 0) lines.push(content);

  lines.push(SEPARATOR, footer);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MirrorEngine
// ---------------------------------------------------------------------------

/**
 * Thrown when the Buzz relay rejects a card with `OK false`. The engine
 * deliberately does not record the address in that case, so the next 38400 for
 * it retries the post; the caller inspects `result.message` against the §
 * "Error handling" prefix table (e.g. `invalid: channel not found`).
 */
export class CardPublishError extends Error {
  constructor(
    readonly address: string,
    readonly result: OkResult,
  ) {
    super(`card publish rejected for ${address}: ${result.message}`);
    this.name = "CardPublishError";
  }
}

/** Clock-skew allowance shared with the live-sub `since` (§4). */
const CURSOR_SKEW = 300;

function secretKeyFrom(nsec: string): Uint8Array {
  const trimmed = nsec.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  const decoded = nip19Decode(trimmed);
  if (decoded.type !== "nsec") throw new Error("BRIDGE_NSEC is not an nsec");
  return decoded.data;
}

export class MirrorEngine implements IMirrorEngine {
  private readonly level: Level;
  private secretKey: Uint8Array | null = null;

  constructor(
    private readonly config: Config,
    private readonly buzz: IBuzzClient,
    private readonly cache: IListingCache,
    private readonly state: IStateStore,
    private readonly getChannelId: () => string,
  ) {
    this.level = config.logLevel;
  }

  /**
   * Apply the §5 decision table to one incoming 38400 and return the outcome.
   *
   * Decision inputs: the *state* `mirrored` entry is the replace/skip clock
   * (footer recovery seeds `createdAt: 0`, §7), while the cap is measured
   * against the in-memory cache size.
   */
  async handleListing(event: NostrEvent): Promise<MirrorOutcome> {
    // §5 step 1 — validate.
    const listing = parseListing(event);
    if (!listing) {
      log(this.level, "debug", "dropped invalid 38400", {
        id: event.id,
        kind: event.kind,
      });
      return { type: "skip", reason: "invalid" };
    }

    const outcome = await this.decide(listing);
    // §4 — the cursor is the max `created_at` *terminally* processed. It is
    // advanced only here, after `decide` returned without throwing: a card
    // publish that was rejected (CardPublishError) or a channel that is
    // mid-re-run must not move the cursor past an event the live sub would then
    // never redeliver (`since = cursor − 300`).
    this.advanceCursor(listing.createdAt);
    return outcome;
  }

  /** The §5 decision table proper. Throws if the card publish is rejected. */
  private async decide(listing: ParsedListing): Promise<MirrorOutcome> {
    const { address } = listing;
    const matches = this.categoriesMatch(listing.s);
    const entry = this.state.getState().mirrored[address];

    // Unknown address.
    if (!entry) {
      if (!matches) {
        log(this.level, "debug", "ignoring listing outside MIRROR_CATEGORIES", {
          address,
        });
        return { type: "skip", reason: "category-mismatch" };
      }
      if (this.cache.size >= this.config.mirrorMaxListings) {
        // §5 step 3 — no eviction in v1: skip + warn (Open question 5).
        log(
          this.level,
          "warn",
          "MIRROR_MAX_LISTINGS reached; skipping listing",
          {
            address,
            cap: this.config.mirrorMaxListings,
          },
        );
        return { type: "skip", reason: "at-cap" };
      }
      const cardMsgId = await this.postCard(listing, "new");
      this.record(listing, cardMsgId, false);
      this.cache.set(address, listing);
      return { type: "new", address, cardMsgId };
    }

    // Known address — is this a replacement?
    let replaces: boolean;
    if (listing.createdAt > entry.createdAt) {
      replaces = true;
    } else if (listing.createdAt === entry.createdAt) {
      // §5 step 3 — NIP-33 same-second tie-break: lowest id wins. An
      // unconditional `≤ → skip` would drop legitimate replacements.
      replaces =
        listing.event.id !== entry.eventId && listing.event.id < entry.eventId;
      if (!replaces) {
        return { type: "skip", reason: "duplicate", address };
      }
    } else {
      return { type: "skip", reason: "out-of-order", address };
    }

    if (!replaces) return { type: "skip", reason: "duplicate", address };

    if (matches) {
      const cardMsgId = await this.postCard(listing, "updated");
      this.record(listing, cardMsgId, false);
      this.cache.set(address, listing);
      return { type: "update", address, cardMsgId };
    }

    // §5 step 3 — category exit: post a delisted note rather than leaving a
    // stale card. The address stays in `mirrored` for dedupe; a later matching
    // replacement flips it back via an "updated" card.
    const cardMsgId = await this.postCard(listing, "delisted");
    this.record(listing, cardMsgId, true);
    this.cache.delete(address);
    return { type: "delisted", address, cardMsgId };
  }

  /** `MIRROR_CATEGORIES` is applied here, client-side only (§1, §5 step 3). */
  private categoriesMatch(categories: string[]): boolean {
    const allow = this.config.mirrorCategories;
    if (allow.length === 0) return true;
    const wanted = new Set(allow.map((c) => c.trim().toLowerCase()));
    return categories.some((c) => wanted.has(c.trim().toLowerCase()));
  }

  private async postCard(
    listing: ParsedListing,
    kind: CardKind,
  ): Promise<string> {
    const event = finalizeEvent(
      {
        kind: CHAT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", this.getChannelId()]],
        content: formatCard(listing, kind),
      },
      this.key(),
    ) as unknown as NostrEvent;

    const result = await this.buzz.publish(event);
    if (!result.ok) {
      log(this.level, "error", "card publish rejected", {
        address: listing.address,
        cardKind: kind,
        message: result.message,
      });
      throw new CardPublishError(listing.address, result);
    }
    log(this.level, "info", "card posted", {
      address: listing.address,
      cardKind: kind,
      cardMsgId: event.id,
    });
    return event.id;
  }

  private record(
    listing: ParsedListing,
    cardMsgId: string,
    delisted: boolean,
  ): void {
    const entry: MirroredEntry = {
      eventId: listing.event.id,
      createdAt: listing.createdAt,
      cardMsgId,
      delisted,
    };
    this.state.mutate((s) => {
      s.mirrored[listing.address] = entry;
    });
  }

  private advanceCursor(createdAt: number): void {
    if (createdAt <= this.state.getState().cursors.wolfe) return;
    this.state.mutate((s) => {
      if (createdAt > s.cursors.wolfe) s.cursors.wolfe = createdAt;
    });
  }

  private key(): Uint8Array {
    this.secretKey ??= secretKeyFrom(this.config.bridgeNsec);
    return this.secretKey;
  }
}

export { CURSOR_SKEW };
