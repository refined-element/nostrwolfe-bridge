/** MirrorEngine — decision table, card formatting, sanitization (spec §5). */

import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";

import { FrameTooLargeError } from "./buzz-client.js";
import { normalizeDialect } from "./dialect.js";
import {
  CARD_HEADERS_BY_KIND,
  CARD_SEPARATOR,
  sanitizeContent,
  sanitizeField,
  stripControl,
} from "./sanitize.js";

// The sanitizer moved to ./sanitize.js so mirror-engine and query-responder
// share one hardened implementation (Security §2). Re-exported here so existing
// importers of these names from mirror-engine keep working.
export { CONTENT_MAX } from "./sanitize.js";
export { sanitizeContent, sanitizeField };

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
  MirroredMap,
  Negotiable,
  NostrEvent,
  NostrTag,
  OkResult,
  ParsedListing,
  PriceTier,
} from "./types.js";

/** Kind of a NostrWolfe capability advertisement. */
export const LISTING_KIND = 38400;

/** Kind of a NIP-09 deletion request (§3b). */
export const DELETION_KIND = 5;

/** Kind of a Buzz chat message (the card carrier). */
const CHAT_KIND = 9;

/** Em-dash used for every missing/unrenderable field (§5 step 4). */
const DASH = "—";

/** Card separator line that precedes the machine-readable footer. */
const SEPARATOR = CARD_SEPARATOR;

/**
 * Clock-skew allowance shared with the live-sub `since` (§4). Declared here (not
 * further down) because {@link parseListing} uses it as the future-timestamp
 * ceiling, and a listing dated past `now + CURSOR_SKEW` is dropped so it cannot
 * poison the persisted wolfe cursor (security H-1).
 */
const CURSOR_SKEW = 300;

/**
 * A card renders each `s`, `t` and `price` tag, and every value is width-capped
 * by {@link FIELD_MAX}/{@link CONTENT_MAX}. But nothing caps the *count* of those
 * tags, so a listing carrying thousands of them would still join into a card
 * past the 65,536-byte Buzz frame cap — falsifying the spec's "well under by
 * construction" claim and, worse, making {@link formatCard}'s output throw
 * {@link FrameTooLargeError} on publish (security L-3 / M-1). Beyond these caps a
 * single `+K more` marker stands in, so the card is bounded by construction. The
 * caps are small enough that the worst case (caps × per-field widths) stays far
 * under the frame budget.
 */
export const RENDER_MAX = {
  prices: 20,
  categories: 20,
  hashtags: 20,
} as const;

/** Strict decimal a card amount must match to render as a number, else `—`. */
const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

/**
 * Card headers (header prefix + a trailing space before the `d`). The footer
 * parser (§7) keys off these exact prefixes, and the chrome-rejection filter in
 * {@link sanitizeContent} keys off the same set — both are derived from the one
 * shared {@link CARD_HEADERS_BY_KIND} map so they cannot drift.
 */
const HEADERS = Object.fromEntries(
  Object.entries(CARD_HEADERS_BY_KIND).map(([kind, prefix]) => [
    kind,
    `${prefix} `,
  ]),
) as Record<CardKind, string>;

/**
 * The card's first line: the kind prefix followed by the `d` in **bold** (Buzz
 * renders markdown, so the service name stands out). Footer recovery (§7) keys
 * off the *prefix* via `startsWith` and reads the address from the footer, so the
 * bold markup around `d` is display-only and does not affect recovery.
 */
function formatCardHeader(kind: CardKind, d: string): string {
  return `${HEADERS[kind]}**${d}**`;
}

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
// Sanitization caps (spec §5 step 4 + Security §2)
// ---------------------------------------------------------------------------
//
// The sanitizer functions themselves (stripControl, sanitizeField,
// sanitizeContent) live in ./sanitize.js — the one hardened implementation
// shared with query-responder. Only the card-specific per-field caps stay here.

/**
 * Per-field render caps. `content` has its own {@link CONTENT_MAX}; every
 * *tag*-derived field is capped here too, so a 64 KB tag value can never push a
 * card past the 65,536-byte Buzz WS frame cap (§2 frame budget).
 */
export const FIELD_MAX = {
  /**
   * `d` display hint only. The address/footer/cache **key** is the *untruncated*
   * {@link normalizeDKey} value (see there for why truncating the key was wrong);
   * this width is retained for backward compat but no longer bounds the key.
   */
  d: 200,
  url: 512,
  short: 64,
  /**
   * Free-form pricing text. Wider than `short` because real listings price in
   * full sentences ("500 sats for ≤10 pages, +50 sats per additional page"),
   * and truncating a price mid-clause misstates the cost.
   */
  price: 160,
} as const;

// ---------------------------------------------------------------------------
// Tag parsing (spec §5 step 1-2; nips/agent-service-agreements.md kind 38400)
// ---------------------------------------------------------------------------

/**
 * Canonical `d` normalization for the address/footer/cache **key** (§7).
 *
 * Unlike {@link sanitizeField} it deliberately does NOT cut at the `@bridge`
 * grammar and does NOT truncate:
 *   - the `@bridge` cut turned a legitimate service id like `@bridge-monitor`
 *     into the empty string, dropping the whole listing as invalid (spec L-2);
 *   - a fixed-width truncation collided two distinct `d` values that shared a
 *     long common prefix onto one address (code-reviewer L1).
 * It still strips control/invisible chars and flattens newlines, so a `d` can
 * never forge extra card lines or smuggle a zero-width payload (Security §2).
 *
 * The full value is carried verbatim in the footer — the sole §7 recovery key —
 * so the address, the cache key, the footer and the header are one and the same
 * string by construction. A `d` that itself contains `@bridge` therefore appears
 * in the card; this is unavoidable (the footer must reproduce the key exactly)
 * and safe, because a message is only treated as a bridge command when its
 * *content starts with* `@bridge` and is not the bridge's own post — never for a
 * mid-line substring inside a card (see `query-responder.isAddressedToBridge`).
 */
export function normalizeDKey(raw: string | undefined): string {
  if (raw === undefined) return "";
  return stripControl(raw).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Join `items` with `sep`, rendering at most `max` and replacing the remainder
 * with a single `+K more` marker so the result is bounded by construction
 * regardless of how many tags a hostile listing carries (see {@link RENDER_MAX}).
 */
function capJoin(items: string[], max: number, sep: string): string {
  if (items.length <= max) return items.join(sep);
  return [...items.slice(0, max), `+${items.length - max} more`].join(sep);
}

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
    // Require an actual amount: `Number("") === 0` passes `Number.isFinite`, so
    // a bare `["negotiable","floor"]` used to fabricate a "floor 0 sats" the
    // publisher never stated (L-2). No amount → undefined → renders as `—`.
    const raw = (tag[2] ?? "").trim();
    const sats = Number(raw);
    if (raw.length > 0 && Number.isFinite(sats)) return { kind: "floor", sats };
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
  const d = normalizeDKey(firstTag(event.tags, "d")?.[1]);
  if (d.length === 0) return null;
  return `${LISTING_KIND}:${event.pubkey}:${d}`;
}

/** 64-hex Nostr pubkey. */
const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Parse a NIP-09 `a`-tag coordinate `38400:<pubkey>:<d>` into its parts and the
 * normalized mirror address (§3b). The `d` part may itself contain `:`, so only
 * the first two separators are split. Returns null unless the kind is 38400, the
 * pubkey is 64-hex, and `d` is non-empty after key-normalization — the same
 * normalization {@link addressOf} applies, so the rebuilt address matches the
 * mirrored key exactly.
 */
export function parseAddressCoordinate(
  coord: string | undefined,
): { pubkey: string; d: string; address: string } | null {
  if (coord === undefined) return null;
  const i1 = coord.indexOf(":");
  if (i1 < 0) return null;
  const i2 = coord.indexOf(":", i1 + 1);
  if (i2 < 0) return null;
  if (coord.slice(0, i1) !== String(LISTING_KIND)) return null;
  const rawPubkey = coord.slice(i1 + 1, i2);
  if (!HEX64.test(rawPubkey)) return null;
  // Normalize to lowercase so a coordinate written with uppercase hex still
  // matches the (lowercase) mirrored address and passes author binding against
  // the lowercase `event.pubkey` — otherwise a valid self-deletion is dropped.
  const pubkey = rawPubkey.toLowerCase();
  const d = normalizeDKey(coord.slice(i2 + 1));
  if (d.length === 0) return null;
  return { pubkey, d, address: `${LISTING_KIND}:${pubkey}:${d}` };
}

/** Options for {@link parseListing}. */
export interface ParseListingOptions {
  /**
   * Fall back to the dialect adapter when a listing lacks the NIP's required
   * tags (config `MIRROR_ACCEPT_DIALECTS`, default on). With this off the
   * parser is strictly NIP-A5 and most of the live relay is dropped.
   */
  acceptDialects?: boolean;
  /**
   * Current unix time (seconds) used for the future-timestamp sanity check.
   * Injectable so tests can pin it; defaults to the wall clock. An event dated
   * past `now + CURSOR_SKEW` is dropped (security H-1).
   */
  now?: number;
}

/**
 * Build a listing from an already-verified event's tags/content, or null when
 * the NIP's required tags (`d`, ≥1 `s`, ≥1 `price`) are absent.
 *
 * Split out from {@link parseListing} so the same construction runs over raw
 * tags and over dialect-normalized tags — the normalized path must not be a
 * second, drifting implementation of the canonical one.
 */
function buildListing(
  event: NostrEvent,
  tags: NostrTag[],
  content: string,
  dialect: string | undefined,
): ParsedListing | null {
  // Normalize once, here: `listing.d`, `listing.address`, the card header and
  // the card footer are all this one string, so the footer a recovery scan
  // reads is always exactly the key the live path looks up (§7).
  const d = normalizeDKey(firstTag(tags, "d")?.[1]);
  if (d.length === 0) return null;

  const s = tagValues(tags, "s")
    .map((t) => (t[1] ?? "").trim())
    .filter((v) => v.length > 0);
  if (s.length === 0) return null;

  const prices: PriceTier[] = tagValues(tags, "price")
    .filter((t) => t.length >= 2)
    .map((t) => {
      const tier: PriceTier = {
        amount: (t[1] ?? "").trim(),
        currency: (t[2] ?? "").trim(),
      };
      const freq = (t[3] ?? "").trim();
      if (freq.length > 0) tier.frequency = freq;
      // Slot 4 carries free-form pricing text the dialect adapter could not
      // reduce to amount+currency; canonical `price` tags never set it.
      const note = (t[4] ?? "").trim();
      if (note.length > 0) tier.note = note;
      return tier;
    })
    // A dialect tier with neither an amount nor a note says nothing.
    .filter((tier) => tier.amount.length > 0 || tier.note !== undefined);
  if (prices.length === 0) return null;

  const listing: ParsedListing = {
    event,
    address: `${LISTING_KIND}:${event.pubkey}:${d}`,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    d,
    s,
    prices,
    t: tagValues(tags, "t")
      .map((tag) => (tag[1] ?? "").trim())
      .filter((v) => v.length > 0),
    content,
  };
  if (dialect !== undefined) listing.dialect = dialect;

  const l402 = firstTag(tags, "l402")?.[1];
  if (l402 !== undefined && l402.length > 0) listing.l402 = l402;

  const endpointTag = firstTag(tags, "endpoint");
  if (endpointTag && (endpointTag[1] ?? "").length > 0) {
    const endpoint: EndpointInfo = { url: endpointTag[1] as string };
    const method = (endpointTag[2] ?? "").trim();
    if (method.length > 0) endpoint.method = method;
    listing.endpoint = endpoint;
  }

  const schema = firstTag(tags, "schema")?.[1];
  if (schema !== undefined && schema.length > 0) listing.schema = schema;

  const capacityTag = firstTag(tags, "capacity");
  if (capacityTag && (capacityTag[1] ?? "").length > 0) {
    const unit = (capacityTag[2] ?? "").trim();
    listing.capacity =
      unit.length > 0
        ? `${capacityTag[1] as string} ${unit}`
        : (capacityTag[1] as string);
  }

  const uptime = firstTag(tags, "uptime")?.[1];
  if (uptime !== undefined && uptime.length > 0) listing.uptime = uptime;

  // NIP-ASA: "If the `negotiable` tag is omitted, agents SHOULD assume the
  // price is negotiable (`true`)" — so an absent tag is materialized as `yes`
  // here. A *present but unparseable* tag stays undefined and renders as `—`.
  const negotiableTag = firstTag(tags, "negotiable");
  const negotiable = negotiableTag
    ? parseNegotiable(negotiableTag)
    : ({ kind: "yes" } as const);
  if (negotiable) listing.negotiable = negotiable;

  // NIP-A5 listing lifecycle (§3a). Only the two inactive states are recorded;
  // an absent tag, `"active"`, or any unrecognized value leaves `status`
  // undefined and the listing is treated as active — a typo must never silently
  // hide a live listing.
  const status = (firstTag(tags, "status")?.[1] ?? "").trim().toLowerCase();
  if (status === "inactive") listing.status = "inactive";
  else if (status === "removed") listing.status = "removed";

  // NIP-40 expiration (§3c). Non-negative integer unix seconds; anything else is
  // ignored (an unparseable expiration must not make a listing unavailable).
  const expirationRaw = (firstTag(tags, "expiration")?.[1] ?? "").trim();
  if (/^\d+$/.test(expirationRaw)) {
    const expiration = Number(expirationRaw);
    if (Number.isSafeInteger(expiration)) listing.expiration = expiration;
  }

  return listing;
}

/**
 * Parse and validate a raw kind:38400 into a {@link ParsedListing} (§5 step 1-2).
 *
 * §5 step 1: `verifyEvent` (BIP-340) — never trust an open relay's contents —
 * plus the NIP's required tags: non-empty `d`, at least one `s`, and a `price`.
 * Returns null (caller drops + logs) on any failure.
 *
 * NIP-A5 is tried first and always wins; only a listing the NIP cannot parse is
 * handed to the dialect adapter, so compliant publishers are never reinterpreted
 * (see `dialect.ts` for why the fallback exists at all).
 */
export function parseListing(
  event: NostrEvent,
  options: ParseListingOptions = {},
): ParsedListing | null {
  if (event.kind !== LISTING_KIND) return null;
  // Future-timestamp clamp (security H-1): one attacker-signed 38400 dated far
  // ahead would otherwise become `max(created_at)` and permanently push the
  // persisted wolfe cursor past real time, blinding the live sub (`since =
  // cursor − 300`). Same 300s skew the subscriber uses. Injectable clock for
  // tests; wall clock otherwise.
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (event.created_at > now + CURSOR_SKEW) return null;
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

  const canonical = buildListing(event, event.tags, event.content, undefined);
  if (canonical !== null) return canonical;

  if (options.acceptDialects !== true) return null;

  const normalized = normalizeDialect(event.tags, event.content);
  if (normalized === null) return null;

  return buildListing(
    event,
    normalized.tags,
    normalized.content,
    normalized.dialect,
  );
}

// ---------------------------------------------------------------------------
// Per-tag formatters (spec §5 step 4; Security §2 — never render raw)
// ---------------------------------------------------------------------------

function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * `50 sats per-request`; a non-numeric amount renders as `—` (Security §2).
 *
 * A dialect tier may carry the publisher's own free-form pricing text in
 * {@link PriceTier.note} ("500+ sats (dynamic, per-character)"). When present it
 * is rendered verbatim — sanitized like any other untrusted field — in place of
 * the structured form: the note is the complete statement, and pairing it with
 * the extracted number produces redundant, misleading output like
 * `500 sats (500+ sats (dynamic, per-character))`. The parsed amount stays on
 * the listing for search and comparison; only the display prefers the original.
 */
export function formatPriceTier(tier: PriceTier): string {
  const note = sanitizeField(tier.note, FIELD_MAX.price);
  if (note.length > 0) return note;
  // Strict decimal only, to agree with query-responder's `find` gate (spec L-7):
  // `Number.isFinite(Number(x))` also accepts `0x10`, `1e3` and ` 5 `, so the
  // card and `find` disagreed on what counts as a price. Anything else → `—`.
  if (!DECIMAL_AMOUNT.test(tier.amount)) return DASH;
  // A zero price reads as broken ("0 sats per-request"); say what it means.
  if (Number(tier.amount) === 0) {
    const freq = sanitizeField(tier.frequency, FIELD_MAX.short);
    return freq.length > 0 ? `Free ${freq}` : "Free";
  }
  const parts = [sanitizeField(tier.amount, FIELD_MAX.short)];
  const currency = sanitizeField(tier.currency, FIELD_MAX.short);
  if (currency.length > 0) parts.push(currency);
  const frequency = sanitizeField(tier.frequency, FIELD_MAX.short);
  if (frequency.length > 0) parts.push(frequency);
  return parts.join(" ");
}

/**
 * Provider identity as a truncated npub — the full 63-char bech32 is a wall of
 * text in a chat card. Middle-elided so both ends stay verifiable
 * (`npub1abcd…xyz789`); short/odd values render whole.
 */
export function formatProvider(pubkey: string): string {
  const npub = npubEncode(pubkey);
  return npub.length > 24 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub;
}

/**
 * Tiers joined with ` · ` (§5 step 4 "additional tiers"), rendering at most
 * {@link RENDER_MAX.prices} so a listing with thousands of `price` tags cannot
 * blow the frame budget; the remainder collapses to a `+K more` marker.
 */
export function formatPrices(tiers: PriceTier[]): string {
  if (tiers.length === 0) return DASH;
  const shown = tiers.slice(0, RENDER_MAX.prices).map(formatPriceTier);
  return tiers.length > RENDER_MAX.prices
    ? [...shown, `+${tiers.length - RENDER_MAX.prices} more`].join(" · ")
    : shown.join(" · ");
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
 * The tombstone card kinds — those rendered as a bare note (header + separator +
 * footer), dropped from the active cache. A category exit (`delisted`) and the
 * three lifecycle-inactive states (§3a-c) all render identically.
 */
const TOMBSTONE_KINDS: ReadonlySet<CardKind> = new Set([
  "delisted",
  "paused",
  "removed",
  "expired",
]);

export function isTombstoneCardKind(kind: CardKind): boolean {
  return TOMBSTONE_KINDS.has(kind);
}

/**
 * A tombstone note: `header + separator + footer` only (§5 step 3, §3a-c).
 *
 * Takes `pubkey`/`d` directly rather than a {@link ParsedListing} so a NIP-09
 * deletion (§3b) — which carries no listing fields, only the addressed
 * coordinate — can render a "Removed" note from the address alone. The final
 * line is the machine-readable footer `nw:38400:<pubkey>:<d>`, the sole recovery
 * key (§7), so `d` is key-normalized before it reaches header or footer.
 */
export function formatTombstoneNote(
  pubkey: string,
  d: string,
  kind: CardKind,
): string {
  const nd = normalizeDKey(d);
  const footer = `nw:${LISTING_KIND}:${pubkey}:${nd}`;
  return [formatCardHeader(kind, nd), SEPARATOR, footer].join("\n");
}

/**
 * Render a card body for the given listing and header kind (§5 step 4).
 *
 * Update cards are identical to new-listing cards in every field and line
 * except the header. Tombstone notes (delisted/paused/removed/expired) carry
 * only header + separator + footer. The final line is always the
 * machine-readable footer `nw:38400:<pubkey>:<d>` — the sole recovery key (§7),
 * which is why `d` is key-normalized (no newlines) before it reaches either the
 * header or the footer.
 */
export function formatCard(listing: ParsedListing, kind: CardKind): string {
  if (isTombstoneCardKind(kind)) {
    return formatTombstoneNote(listing.pubkey, listing.d, kind);
  }

  // `listing.d` is already the canonical key (parseListing → normalizeDKey);
  // re-normalizing is idempotent and keeps the footer byte-identical to
  // `listing.address`'s `d` part — the invariant footer recovery depends on (§7).
  const d = normalizeDKey(listing.d);
  const footer = `nw:${LISTING_KIND}:${listing.pubkey}:${d}`;
  const header = formatCardHeader(kind, d);

  const cats = listing.s
    .map((v) => sanitizeField(v, FIELD_MAX.short))
    .filter((v) => v.length > 0);
  const categories = capJoin(cats, RENDER_MAX.categories, ", ") || DASH;

  // Only show hashtags that add something beyond the categories — dialect
  // listings routinely mirror every category as a tag, which just doubles the
  // line. Drop the `Tags:` clause entirely when nothing distinct is left.
  const catLower = new Set(cats.map((c) => c.toLowerCase()));
  const distinctTags = listing.t
    .map((tag) => sanitizeField(tag, FIELD_MAX.short))
    .filter((v) => v.length > 0 && !catLower.has(v.toLowerCase()));
  const tags = capJoin(
    distinctTags.map((v) => `#${v}`),
    RENDER_MAX.hashtags,
    " ",
  );

  // The card is assembled as blank-line-separated *sections* so it reads as a
  // spaced block in the channel rather than a dense wall of text: title,
  // description, details, then the machine-readable footer. Header stays line 0
  // and the footer stays the last line — the two anchors footer recovery reads (§7).
  const details = [
    tags.length > 0
      ? `Categories: ${categories}  ·  Tags: ${tags}`
      : `Categories: ${categories}`,
    `Price: ${formatPrices(listing.prices)}  ·  Negotiable: ${formatNegotiable(listing.negotiable)}`,
    `Endpoint: ${formatEndpoint(listing)}`,
  ];

  // Uptime/Capacity are self-reported and usually absent — omit the whole line
  // rather than print `Uptime: — · Capacity: —`.
  const uptime = formatUptime(listing.uptime);
  const capacity = listing.capacity
    ? sanitizeField(listing.capacity, FIELD_MAX.short)
    : DASH;
  if (uptime !== DASH || capacity !== DASH) {
    details.push(`Uptime: ${uptime}  ·  Capacity: ${capacity}`);
  }

  // Provenance: a normalized listing must never look like a compliant one. The
  // label goes in a field line rather than the header, because footer recovery
  // (§7) matches headers exactly.
  if (listing.dialect !== undefined) {
    details.push(
      `Format: non-standard tags (${sanitizeField(listing.dialect, FIELD_MAX.short)}), normalized by bridge`,
    );
  }

  details.push(`Provider: ${formatProvider(listing.pubkey)}`);

  const sections: string[][] = [[header]];

  // Lead with the human-readable description (already sanitized) — it's the most
  // useful line for a person or an LLM skimming the channel.
  const content = sanitizeContent(listing.content);
  if (content.length > 0) sections.push([content]);

  sections.push(details, [SEPARATOR, footer]);

  // Lines within a section join with "\n"; sections join with a blank line.
  return sections.map((section) => section.join("\n")).join("\n\n");
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
    /**
     * Unix-seconds clock, injectable for tests. Feeds both the future-timestamp
     * drop in {@link parseListing} and the {@link advanceCursor} ceiling so a
     * forged far-future 38400 can never poison the persisted cursor (H-1).
     */
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.level = config.logLevel;
  }

  /**
   * Apply the §5 decision table to one incoming 38400 and return the outcome.
   *
   * Decision inputs: the *state* `mirrored` entry is the replace/skip clock
   * (footer recovery seeds `createdAt: 0`, §7), while the cap is measured
   * against the tracked `mirrored`-entry count (security M-1).
   */
  async handleListing(event: NostrEvent): Promise<MirrorOutcome> {
    // §5 step 1 — validate.
    const listing = parseListing(event, {
      acceptDialects: this.config.mirrorAcceptDialects,
      now: this.now(),
    });
    if (!listing) {
      log(this.level, "debug", "dropped invalid 38400", {
        id: event.id,
        kind: event.kind,
      });
      return { type: "skip", reason: "invalid" };
    }

    try {
      const outcome = await this.decide(listing);
      // §4 — the cursor is the max `created_at` *terminally* processed. It is
      // advanced only here, after `decide` returned without throwing: a card
      // publish that was rejected (CardPublishError) or a channel that is
      // mid-re-run must not move the cursor past an event the live sub would then
      // never redeliver (`since = cursor − 300`).
      this.advanceCursor(listing.createdAt);
      return outcome;
    } catch (err) {
      if (err instanceof FrameTooLargeError) {
        // The count caps in formatCard make this unreachable by construction,
        // but as defense in depth: a card that still exceeds the frame cap can
        // never be mirrored, so advance PAST it. Leaving the cursor parked would
        // make every reconnect (`since = cursor − 300`) reprocess the same
        // poison event forever, wedging the live sub behind it (security L-3).
        // Re-thrown so index.ts logs it as "never mirrorable".
        log(this.level, "error", "oversized card; advancing cursor past it", {
          address: listing.address,
          bytes: err.bytes,
        });
        this.advanceCursor(listing.createdAt);
        throw err;
      }
      // CardPublishError (transient relay rejection) must NOT advance the
      // cursor — the event has to stay redeliverable for the retry (§4).
      throw err;
    }
  }

  /**
   * Apply a NIP-09 kind:5 deletion (§3b). For each `["a","38400:<pubkey>:<d>"]`
   * tag whose pubkey equals the deletion's author (author binding — never a
   * cross-author take-down) and whose address is mirrored-and-live, post a
   * "Removed" note, tombstone the entry, and drop it from the cache.
   *
   * Idempotent: a replayed kind:5, or one over an already-tombstoned address, is
   * a no-op. Verifies the signature and future-clamps the timestamp before
   * touching anything, exactly like {@link parseListing}, so a forged kind:5 can
   * neither delete a listing nor poison the persisted cursor (Security §2, H-1).
   */
  async handleDeletion(event: NostrEvent): Promise<MirrorOutcome[]> {
    if (event.kind !== DELETION_KIND) return [];

    // Future-timestamp clamp (H-1): a forged far-future kind:5 must never push
    // the persisted wolfe cursor past real time.
    if (event.created_at > this.now() + CURSOR_SKEW) {
      log(this.level, "debug", "dropped future-dated deletion", {
        id: event.id,
      });
      return [];
    }

    // Re-verify a plain 7-field copy from scratch — the open relay is untrusted
    // and nostr-tools caches an "already verified" marker that must be bypassed.
    const plain = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    };
    if (!verifyEvent(plain as never)) {
      log(this.level, "debug", "dropped deletion with bad signature", {
        id: event.id,
      });
      return [];
    }

    const outcomes: MirrorOutcome[] = [];
    const acted = new Set<string>();
    for (const tag of event.tags) {
      if (tag[0] !== "a") continue;
      const parsed = parseAddressCoordinate(tag[1]);
      if (parsed === null) continue;
      // Author binding (mandatory): only the listing's own key may delete it.
      // The address embeds the listing pubkey, so this is the whole check.
      if (parsed.pubkey !== event.pubkey) {
        log(this.level, "warn", "ignoring cross-author deletion", {
          deletionAuthor: event.pubkey,
          listingPubkey: parsed.pubkey,
          address: parsed.address,
        });
        continue;
      }
      // One kind:5 may carry the same `a` twice; act at most once per address.
      if (acted.has(parsed.address)) continue;
      acted.add(parsed.address);

      const outcome = await this.applyDeletion(
        parsed.address,
        parsed.pubkey,
        parsed.d,
        event.created_at,
      );
      if (outcome) outcomes.push(outcome);
    }

    // NIP-09 also allows deletion by `e` tag (the 38400's event id). The `a`-tag
    // form is spec-correct for addressable events, but heterogeneous third-party
    // publishers do emit `e`-only deletions, and a dead card costs paying agents
    // sats — so honor them too, matched against the stored `eventId` of a
    // mirrored listing and bound to the same author (never a cross-author delete).
    const eTagIds = new Set(
      event.tags.filter((t) => t[0] === "e" && t[1]).map((t) => t[1] as string),
    );
    if (eTagIds.size > 0) {
      const mirrored = this.state.getState().mirrored;
      for (const [address, entry] of Object.entries(mirrored)) {
        if (entry.delisted || acted.has(address)) continue;
        if (entry.eventId === "" || !eTagIds.has(entry.eventId)) continue;
        const parsed = parseAddressCoordinate(address);
        if (parsed === null) continue;
        if (parsed.pubkey !== event.pubkey) {
          log(this.level, "warn", "ignoring cross-author e-tag deletion", {
            deletionAuthor: event.pubkey,
            listingPubkey: parsed.pubkey,
            address,
          });
          continue;
        }
        acted.add(address);
        const outcome = await this.applyDeletion(
          parsed.address,
          parsed.pubkey,
          parsed.d,
          event.created_at,
        );
        if (outcome) outcomes.push(outcome);
      }
    }

    // Advance only after the whole event processed without a card rejection — a
    // thrown CardPublishError leaves the cursor parked so the kind:5 is
    // redelivered and retried (already-tombstoned addresses are then no-ops).
    this.advanceCursor(event.created_at);
    return outcomes;
  }

  /**
   * Take an address down in response to a deletion, recording a durable removal
   * **high-water mark** at the deletion's `created_at` (§3b, NIP-09 addressable
   * semantics). Returns the "removed" outcome when a live card was taken down, or
   * null for the no-card paths (idempotent no-op, stale deletion, or a deletion
   * for an address never mirrored — which still records a tombstone).
   *
   * The high-water mark is what stops a stale active 38400 (one dated at or
   * before the deletion) from resurfacing the listing as a "New"/"Updated" card,
   * whether it arrives before its deletion during hydration (kinds are
   * interleaved newest-first) or after a state-loss restart. Only a genuinely
   * newer republish (`created_at` strictly after the deletion) restores it.
   */
  private async applyDeletion(
    address: string,
    pubkey: string,
    d: string,
    deletionCreatedAt: number,
  ): Promise<MirrorOutcome | null> {
    const entry = this.state.getState().mirrored[address];

    if (entry?.delisted) {
      // Already paused/removed/expired/delisted — idempotent no-op (a replayed
      // kind:5, or a kind:5 that follows a status:removed replacement). Still
      // raise the tombstone's high-water mark if this deletion is newer.
      if (deletionCreatedAt > entry.createdAt) {
        this.state.mutate((s) => {
          const e = s.mirrored[address];
          if (e) e.createdAt = deletionCreatedAt;
        });
      }
      return null;
    }

    if (!entry) {
      // Never mirrored (or pruned): there is no card to take down, but record a
      // removal tombstone so a later stale 38400 for this address is suppressed
      // rather than posted as a fresh "New" card.
      this.state.mutate((s) => {
        s.mirrored[address] ??= {
          eventId: "",
          createdAt: deletionCreatedAt,
          cardMsgId: "",
          delisted: true,
        };
        this.pruneTombstones(s.mirrored);
      });
      log(this.level, "debug", "deletion for un-mirrored address; tombstoned", {
        address,
      });
      return null;
    }

    // NIP-09: a deletion applies only to versions at or before it. A stale kind:5
    // older than the current live 38400 does not take it down.
    if (deletionCreatedAt < entry.createdAt) {
      log(
        this.level,
        "debug",
        "stale deletion older than live listing; ignoring",
        {
          address,
          deletionCreatedAt,
          entryCreatedAt: entry.createdAt,
        },
      );
      return null;
    }

    const cardMsgId = await this.postTombstoneNote(
      address,
      pubkey,
      d,
      "removed",
    );
    this.state.mutate((s) => {
      const e = s.mirrored[address];
      if (e) {
        e.delisted = true;
        e.cardMsgId = cardMsgId;
        // High-water mark: only a republish strictly newer than the deletion may
        // restore the listing (deletionCreatedAt >= e.createdAt here).
        e.createdAt = deletionCreatedAt;
        delete e.staleNotified;
      } else {
        s.mirrored[address] = {
          eventId: "",
          createdAt: deletionCreatedAt,
          cardMsgId,
          delisted: true,
        };
      }
      // Bound retained tombstones (M-1), same as the category-exit path.
      this.pruneTombstones(s.mirrored);
    });
    this.cache.delete(address);
    return { type: "removed", address, cardMsgId };
  }

  /**
   * Take down every mirrored listing whose NIP-40 `expiration` has passed (§3c).
   *
   * `availability()` only sees a listing's expiration when a 38400 arrives, so a
   * listing that expires *while mirrored* would otherwise keep a live card and a
   * cache entry indefinitely. This sweep — run on the daily timer — closes that
   * window: it posts an "Expired" note, tombstones the entry, and drops it from
   * the search cache. Idempotent (already-tombstoned entries are skipped) and
   * resilient (a rejected card is retried on the next sweep, not fatal).
   */
  async sweepExpired(): Promise<MirrorOutcome[]> {
    const now = this.now();
    const outcomes: MirrorOutcome[] = [];
    // cache.all() is a snapshot, so deleting during the loop is safe.
    for (const listing of this.cache.all()) {
      if (listing.expiration === undefined || listing.expiration > now)
        continue;

      const entry = this.state.getState().mirrored[listing.address];
      if (entry?.delisted) {
        // Already down; just make sure it isn't lingering in the search cache.
        this.cache.delete(listing.address);
        continue;
      }

      try {
        const cardMsgId = await this.postCard(listing, "expired");
        this.record(listing, cardMsgId, true);
        this.cache.delete(listing.address);
        outcomes.push({ type: "expired", address: listing.address, cardMsgId });
      } catch (err) {
        if (err instanceof CardPublishError) {
          log(
            this.level,
            "warn",
            "expired card rejected; retrying next sweep",
            {
              address: listing.address,
              message: err.result.message,
            },
          );
          continue;
        }
        throw err;
      }
    }
    if (outcomes.length > 0) {
      log(this.level, "info", "expiration sweep tombstoned listings", {
        count: outcomes.length,
      });
    }
    return outcomes;
  }

  /** The §5 decision table proper. Throws if the card publish is rejected. */
  private async decide(listing: ParsedListing): Promise<MirrorOutcome> {
    const { address } = listing;
    const matches = this.categoriesMatch(listing.s);
    // §3a-c — availability from the `status` tag and NIP-40 `expiration`.
    const availability = this.availability(listing);
    const entry = this.state.getState().mirrored[address];

    // Unknown address.
    if (!entry) {
      if (availability !== "active") {
        // Never mirrored while active, and it arrives already
        // paused/removed/expired — there is nothing on the channel to take down,
        // so post nothing (§3a-c). A NIP-33 replaceable relay only keeps the
        // latest 38400, so a removed listing hydrates straight to this branch.
        log(this.level, "debug", "ignoring never-seen inactive listing", {
          address,
          availability,
        });
        return { type: "skip", reason: "not-active", address };
      }
      if (!matches) {
        log(this.level, "debug", "ignoring listing outside MIRROR_CATEGORIES", {
          address,
        });
        return { type: "skip", reason: "category-mismatch" };
      }
      if (this.mirroredCount() >= this.config.mirrorMaxListings) {
        // §5 step 3 — no eviction in v1: skip + warn (Open question 5). Measured
        // against the `mirrored` map, NOT `cache.size`: delisted addresses are
        // deleted from the cache but retained in `mirrored` for dedupe, so a
        // cache-size cap let category-exit churn grow `mirrored` (and the state
        // file) without bound (security M-1).
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
        // Repopulate the search cache on the same-timestamp duplicate path.
        // On a normal restart the state file is intact, so hydration replays
        // every recorded event and each live address arrives here (its current
        // version matches the stored `created_at`). Without this the cache would
        // stay empty forever → `@bridge find` reports "0 listings cached" and
        // `mirroredCount`/`cache.size` never reach the cap (C-1 / H1).
        this.cacheIfLive(listing, matches, entry, availability);
        return { type: "skip", reason: "duplicate", address };
      }
    } else {
      // Out-of-order replay: this event is OLDER than the stored current
      // version, so it may only *seed* an empty cache slot, never clobber a
      // newer entry already there (guarded inside cacheIfLive).
      this.cacheIfLive(listing, matches, entry, availability);
      return { type: "skip", reason: "out-of-order", address };
    }

    if (!replaces) {
      this.cacheIfLive(listing, matches, entry, availability);
      return { type: "skip", reason: "duplicate", address };
    }

    // §3a-c — a replacement that is paused/removed/expired takes the listing
    // down. Reuses the delisted-tombstone machinery: dropped from the cache,
    // retained in `mirrored` for dedupe, restored later by an active matching
    // replacement.
    if (availability !== "active") {
      if (entry.delisted) {
        // Already tombstoned — do NOT re-post a note. This makes the
        // belt-and-suspenders removal idempotent (a `kind:5` and a
        // `status:removed` replacement both land here) and stops repeated
        // non-active replacements from spamming the channel. The clock still
        // advances so the newest state wins.
        this.record(listing, entry.cardMsgId, true);
        this.cache.delete(address);
        return { type: "skip", reason: "not-active", address };
      }
      const cardMsgId = await this.postCard(listing, availability);
      this.record(listing, cardMsgId, true);
      this.cache.delete(address);
      return { type: availability, address, cardMsgId };
    }

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

  /**
   * Availability of a listing from its `status` tag and NIP-40 `expiration`
   * (§3a-c). Expiration is terminal and checked first (a past `expiration`
   * overrides any `status`); then explicit removal; then pause. Anything else —
   * including an absent/`active`/unrecognized `status` — is active.
   */
  private availability(
    listing: ParsedListing,
  ): "active" | "paused" | "removed" | "expired" {
    if (listing.expiration !== undefined && listing.expiration <= this.now()) {
      return "expired";
    }
    if (listing.status === "removed") return "removed";
    if (listing.status === "inactive") return "paused";
    return "active";
  }

  /**
   * Put a listing into the search cache from a skip path iff it is *live* — its
   * categories still match, its `mirrored` entry is not a tombstone, and the
   * listing itself is active (not paused/removed/expired, §3a-c).
   *
   * The event whose id equals the stored `eventId` is the canonical current
   * version, so it always (re)sets the slot. Any other event (a same-second
   * loser or an older out-of-order replay) only fills an *empty* slot, so it can
   * never overwrite the canonical version once cached.
   */
  private cacheIfLive(
    listing: ParsedListing,
    matches: boolean,
    entry: MirroredEntry,
    availability: "active" | "paused" | "removed" | "expired",
  ): void {
    if (!matches || entry.delisted || availability !== "active") return;
    const isCanonical = listing.event.id === entry.eventId;
    if (isCanonical || !this.cache.has(listing.address)) {
      this.cache.set(listing.address, listing);
    }
  }

  /** Distinct addresses tracked in `mirrored` — the cap denominator (M-1). */
  private mirroredCount(): number {
    return Object.keys(this.state.getState().mirrored).length;
  }

  /**
   * Upper bound on retained delisted tombstones. Tombstones share the address
   * budget with live listings; without a sub-cap, category-exit churn could
   * fill the whole `MIRROR_MAX_LISTINGS` budget with tombstones and starve live
   * listings. Half the budget is a heuristic split (security M-1).
   */
  private delistedBudget(): number {
    return Math.max(1, Math.floor(this.config.mirrorMaxListings / 2));
  }

  /**
   * Drop delisted tombstones beyond {@link delistedBudget}. Only ever removes
   * *delisted* entries, so dedupe of live listings is untouched; a pruned address
   * that reappears simply posts a fresh "new" card.
   *
   * Eviction is **speculative-first**, not purely oldest-first. A "speculative"
   * tombstone is one with no card on the channel (`cardMsgId === ""`): the
   * removal high-water mark recorded when a kind:5 references an address the
   * bridge never mirrored (§3b). Author binding constrains only the pubkey, not
   * the `d`, so an attacker can mint many of these under their own key — and if
   * eviction were purely oldest-first, a burst dated far in the future would
   * evict every genuine (carded) removal high-water mark, re-opening the
   * resurrection those marks exist to prevent. Evicting speculative tombstones
   * before genuine ones (oldest-first within each class) means such a flood can
   * only churn its own bucket; a real removal a viewer was shown is never
   * evicted by it.
   */
  private pruneTombstones(mirrored: MirroredMap): void {
    const limit = this.delistedBudget();
    const tombstones = Object.entries(mirrored).filter(([, e]) => e.delisted);
    if (tombstones.length <= limit) return;
    tombstones
      .sort((a, b) => {
        // Speculative (no card) evicted before genuine (carded) removals…
        const aSpec = a[1].cardMsgId === "" ? 0 : 1;
        const bSpec = b[1].cardMsgId === "" ? 0 : 1;
        if (aSpec !== bSpec) return aSpec - bSpec;
        // …then oldest-first within each class.
        return a[1].createdAt - b[1].createdAt;
      })
      .slice(0, tombstones.length - limit)
      .forEach(([addr]) => {
        delete mirrored[addr];
      });
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
    return this.publishCard(formatCard(listing, kind), listing.address, kind);
  }

  /**
   * Post a tombstone note built from the address alone (§3b) — used by the
   * NIP-09 deletion path, which has no {@link ParsedListing} to render, only the
   * addressed coordinate.
   */
  private async postTombstoneNote(
    address: string,
    pubkey: string,
    d: string,
    kind: CardKind,
  ): Promise<string> {
    return this.publishCard(
      formatTombstoneNote(pubkey, d, kind),
      address,
      kind,
    );
  }

  /** Finalize a kind:9 card into the channel and return its id, or throw {@link CardPublishError}. */
  private async publishCard(
    content: string,
    address: string,
    kind: CardKind,
  ): Promise<string> {
    const event = finalizeEvent(
      {
        kind: CHAT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", this.getChannelId()]],
        content,
      },
      this.key(),
    ) as unknown as NostrEvent;

    const result = await this.buzz.publish(event);
    if (!result.ok) {
      log(this.level, "error", "card publish rejected", {
        address,
        cardKind: kind,
        message: result.message,
      });
      throw new CardPublishError(address, result);
    }
    log(this.level, "info", "card posted", {
      address,
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
      // Bound retained tombstones so category-exit churn can't squat the whole
      // address budget (security M-1). Only runs when we just wrote a tombstone.
      if (delisted) this.pruneTombstones(s.mirrored);
    });
  }

  private advanceCursor(createdAt: number): void {
    // Clamp to `now + skew` as defense in depth: parseListing already drops
    // future-dated events, but a clamp here means a bad `created_at` can never
    // push the persisted cursor ahead of real time and blind the live sub (H-1).
    const clamped = Math.min(createdAt, this.now() + CURSOR_SKEW);
    if (clamped <= this.state.getState().cursors.wolfe) return;
    this.state.mutate((s) => {
      if (clamped > s.cursors.wolfe) s.cursors.wolfe = clamped;
    });
  }

  private key(): Uint8Array {
    this.secretKey ??= secretKeyFrom(this.config.bridgeNsec);
    return this.secretKey;
  }
}

export { CURSOR_SKEW };
