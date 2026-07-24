/**
 * Dialect adapter — normalizes non-NIP-A5 kind:38400 listings.
 *
 * The NIP defines `s` / `price` / `l402` / `t` / `negotiable`, but most listings
 * on the live relay are published by third parties who never implemented it and
 * are outside anyone's control. A census of the public relay (see
 * `scripts/dialect-census.mjs`) found two-thirds of listings using a different
 * vocabulary entirely:
 *
 *   ["category","ai"] ["subcategory","image-processing"] ["pricing","10 sats"]
 *   ["endpoint","https://…"] ["method","POST"] ["protocol","L402"]
 *   ["name",…] ["description",…] ["provider",…] ["website",…]
 *
 * A strict parser mirrors ~1/3 of the market. This module maps such listings
 * onto the canonical vocabulary so the bridge can render them, marking the
 * result with a `dialect` label so a normalized listing is never mistaken for a
 * compliant one.
 *
 * Two rules keep this honest:
 *  1. **Never override.** Only tags the event lacks are synthesized, so a
 *     partially-compliant listing keeps every canonical tag it does carry.
 *  2. **Never invent a price.** These sources price in prose ("Dynamic (varies
 *     by destination)"), so unparseable text is preserved verbatim as a
 *     {@link PriceTier.note} rather than coerced into a number.
 */

import type { NostrTag } from "./types.js";

/** Label recorded on {@link ParsedListing.dialect} for listings this maps. */
export const DIALECT_L402_SERVICE = "l402-service";

/** Result of a successful normalization. */
export interface NormalizedDialect {
  /** Canonical tags: the originals plus synthesized `s`/`price`/`l402`. */
  tags: NostrTag[];
  /** Content to render — the `description` tag when the event body is a blob. */
  content: string;
  /** Which dialect matched. */
  dialect: string;
}

function firstValue(tags: NostrTag[], name: string): string | undefined {
  const v = tags.find((t) => t[0] === name)?.[1];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function hasTag(tags: NostrTag[], name: string): boolean {
  return tags.some((t) => t[0] === name);
}

/**
 * Split free-form pricing text into a canonical tier.
 *
 * Handles the shapes the live corpus actually uses:
 *   "10 sats"                  → 10 sats
 *   "50 sats/page"             → 50 sats, per page
 *   "500 sats base, 700 …"     → 500 sats, note keeps the full text
 *   "Dynamic (varies by …)"    → no amount; note only
 *
 * A leading number is only accepted when followed by a recognized currency, so
 * "500+ sats (dynamic, per-character)" yields 500 sats *and* keeps the caveat
 * in the note — the reader sees both the floor and the fact that it varies.
 */
export function parsePricingText(raw: string): {
  amount: string;
  currency: string;
  frequency?: string;
  note?: string;
} | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const m =
    /^([0-9]+(?:\.[0-9]+)?)\s*\+?\s*(sats?|btc|msats?|usd|eur)\b(.*)$/i.exec(
      text,
    );
  if (!m) return { amount: "", currency: "", note: text };

  const amount = m[1] ?? "";
  const currency = (m[2] ?? "").toLowerCase();
  const rest = (m[3] ?? "").trim();

  const tier: {
    amount: string;
    currency: string;
    frequency?: string;
    note?: string;
  } = { amount, currency: currency === "sat" ? "sats" : currency };

  // "/page", "/minute" — a bare unit suffix is a frequency, anything longer is
  // a qualification the reader needs to see in full.
  const perUnit = /^\/\s*([a-z-]{1,16})$/i.exec(rest);
  if (perUnit) {
    tier.frequency = `per ${(perUnit[1] ?? "").toLowerCase()}`;
  } else if (rest.length > 0) {
    tier.note = text;
  }
  return tier;
}

/**
 * Normalize a non-compliant listing's tags, or return null when the event shows
 * no dialect signal (in which case the caller's strict rejection stands).
 *
 * `content` is replaced by the `description` tag only when the event body is a
 * serialized object — these publishers put a JSON blob in `content`, which would
 * otherwise render as an unreadable wall of escaped braces in the card.
 */
export function normalizeDialect(
  tags: NostrTag[],
  content: string,
): NormalizedDialect | null {
  const category = firstValue(tags, "category");
  const pricing = firstValue(tags, "pricing");

  // The dialect is identified by the pair that replaces the NIP's required
  // tags. Requiring both avoids matching a compliant listing that happens to
  // carry an extra `category` tag.
  if (category === undefined || pricing === undefined) return null;

  const out: NostrTag[] = [...tags];

  // category + subcategory → s (the NIP allows multiple).
  if (!hasTag(tags, "s")) {
    out.push(["s", category]);
    const subcategory = firstValue(tags, "subcategory");
    if (subcategory !== undefined) out.push(["s", subcategory]);
  }

  // pricing (prose) → price (structured where possible, verbatim otherwise).
  if (!hasTag(tags, "price")) {
    const tier = parsePricingText(pricing);
    if (tier) {
      // The note rides in the 4th slot; parseListing reads it back positionally.
      out.push([
        "price",
        tier.amount,
        tier.currency,
        tier.frequency ?? "",
        tier.note ?? "",
      ]);
    }
  }

  const endpoint = firstValue(tags, "endpoint");
  const method = firstValue(tags, "method");

  // The dialect puts the HTTP method in its own tag; the NIP's `endpoint` tag
  // carries it positionally.
  if (endpoint !== undefined && method !== undefined) {
    const idx = out.findIndex((t) => t[0] === "endpoint");
    const existing = out[idx];
    if (idx >= 0 && existing !== undefined && existing[2] === undefined) {
      out[idx] = ["endpoint", endpoint, method];
    }
  }

  // protocol=L402 means the endpoint is the L402-gated URL. This is the one
  // inference made here, and it is explicit in the source data rather than
  // guessed from the URL shape.
  const declaresL402 = tags.some(
    (t) => t[0] === "protocol" && (t[1] ?? "").trim().toUpperCase() === "L402",
  );
  if (declaresL402 && endpoint !== undefined && !hasTag(tags, "l402")) {
    out.push(["l402", endpoint]);
  }

  let body = content;
  const description = firstValue(tags, "description");
  if (description !== undefined && isSerializedObject(content)) {
    body = description;
  }

  return { tags: out, content: body, dialect: DIALECT_L402_SERVICE };
}

/** True when `content` looks like a JSON object rather than prose. */
function isSerializedObject(content: string): boolean {
  const t = content.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  try {
    return typeof JSON.parse(t) === "object";
  } catch {
    return false;
  }
}
