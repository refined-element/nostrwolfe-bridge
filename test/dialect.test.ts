/**
 * Dialect adapter tests.
 *
 * Fixtures are copied from real events on wss://agents.lightningenable.com
 * (captured via scripts/inspect-raw.mjs), so these lock in the shapes actually
 * published rather than an idealized version of them.
 */

import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import {
  DIALECT_L402_SERVICE,
  normalizeDialect,
  parsePricingText,
} from "../src/dialect.js";
import { formatCard, parseListing } from "../src/mirror-engine.js";

import type { NostrEvent, NostrTag } from "../src/types.js";

/** Verbatim tag set from a live sats4ai listing. */
const REAL_DIALECT_TAGS: NostrTag[] = [
  ["d", "sats4ai-deblur-image"],
  ["name", "Image Deblurring"],
  [
    "description",
    "Remove motion blur and defocus from images. Restores sharpness.",
  ],
  ["category", "ai"],
  ["subcategory", "image-processing"],
  ["endpoint", "https://sats4ai.com/api/l402/deblur-image"],
  ["method", "POST"],
  ["pricing", "10 sats"],
  ["protocol", "L402"],
  ["protocol", "MPP"],
  ["provider", "Sats4AI"],
  ["website", "https://sats4ai.com"],
  ["auth", "Lightning Network (L402/MPP) — no signup, no KYC"],
  ["models", "NAFNet"],
  ["discovery", "https://sats4ai.com/.well-known/l402-services"],
  ["mcp", "npx -y sats4ai-mcp"],
];

/** The JSON blob these publishers put in `content`. */
const REAL_DIALECT_CONTENT = JSON.stringify({
  name: "Image Deblurring",
  description:
    "Remove motion blur and defocus from images. Restores sharpness.",
  endpoint: "https://sats4ai.com/api/l402/deblur-image",
  pricing: "10 sats",
  category: "ai",
});

function sign(tags: NostrTag[], content: string): NostrEvent {
  return finalizeEvent(
    { kind: 38400, created_at: 1_753_000_000, tags, content },
    generateSecretKey(),
  ) as NostrEvent;
}

describe("parsePricingText — the real corpus of pricing strings", () => {
  it("parses a plain amount", () => {
    expect(parsePricingText("10 sats")).toEqual({
      amount: "10",
      currency: "sats",
    });
  });

  it("reads a per-unit suffix as a frequency", () => {
    expect(parsePricingText("50 sats/page")).toEqual({
      amount: "50",
      currency: "sats",
      frequency: "per page",
    });
  });

  it("keeps the full text when an amount carries a qualification", () => {
    expect(parsePricingText("500+ sats (dynamic, per-character)")).toEqual({
      amount: "500",
      currency: "sats",
      note: "500+ sats (dynamic, per-character)",
    });
  });

  it("keeps multi-tier prose verbatim rather than inventing one number", () => {
    const tier = parsePricingText("500 sats base, 700 sats with OCR add-on");
    expect(tier?.amount).toBe("500");
    expect(tier?.note).toBe("500 sats base, 700 sats with OCR add-on");
  });

  it("produces a note-only tier when there is no parseable amount", () => {
    expect(
      parsePricingText("Dynamic (varies by destination and duration)"),
    ).toEqual({
      amount: "",
      currency: "",
      note: "Dynamic (varies by destination and duration)",
    });
  });

  it("returns null for empty text", () => {
    expect(parsePricingText("   ")).toBeNull();
  });
});

describe("normalizeDialect", () => {
  it("returns null without the identifying tag pair", () => {
    expect(
      normalizeDialect(
        [
          ["d", "x"],
          ["category", "ai"],
        ],
        "",
      ),
    ).toBeNull();
    expect(
      normalizeDialect(
        [
          ["d", "x"],
          ["pricing", "10 sats"],
        ],
        "",
      ),
    ).toBeNull();
  });

  it("maps category and subcategory onto s", () => {
    const out = normalizeDialect(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    const s = out?.tags.filter((t) => t[0] === "s").map((t) => t[1]);
    expect(s).toEqual(["ai", "image-processing"]);
    expect(out?.dialect).toBe(DIALECT_L402_SERVICE);
  });

  it("folds the separate method tag into the canonical endpoint tag", () => {
    const out = normalizeDialect(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    expect(out?.tags.find((t) => t[0] === "endpoint")).toEqual([
      "endpoint",
      "https://sats4ai.com/api/l402/deblur-image",
      "POST",
    ]);
  });

  it("derives l402 from a declared L402 protocol", () => {
    const out = normalizeDialect(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    expect(out?.tags.find((t) => t[0] === "l402")?.[1]).toBe(
      "https://sats4ai.com/api/l402/deblur-image",
    );
  });

  it("does not derive l402 when no L402 protocol is declared", () => {
    const tags = REAL_DIALECT_TAGS.filter((t) => t[0] !== "protocol");
    const out = normalizeDialect(tags, REAL_DIALECT_CONTENT);
    expect(out?.tags.some((t) => t[0] === "l402")).toBe(false);
  });

  it("swaps a JSON-blob body for the description tag", () => {
    const out = normalizeDialect(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    expect(out?.content).toBe(
      "Remove motion blur and defocus from images. Restores sharpness.",
    );
  });

  it("keeps prose content as written", () => {
    const out = normalizeDialect(REAL_DIALECT_TAGS, "Human written blurb.");
    expect(out?.content).toBe("Human written blurb.");
  });

  it("never overrides tags the listing already carries canonically", () => {
    const hybrid: NostrTag[] = [
      ...REAL_DIALECT_TAGS,
      ["s", "already-canonical"],
      ["price", "42", "sats", "per-request"],
    ];
    const out = normalizeDialect(hybrid, "");
    expect(out?.tags.filter((t) => t[0] === "s").map((t) => t[1])).toEqual([
      "already-canonical",
    ]);
    expect(out?.tags.filter((t) => t[0] === "price")).toHaveLength(1);
  });
});

describe("parseListing with dialect fallback", () => {
  it("rejects a dialect listing when the flag is off (strict NIP-A5)", () => {
    const event = sign(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    expect(parseListing(event)).toBeNull();
    expect(parseListing(event, { acceptDialects: false })).toBeNull();
  });

  it("parses the same listing when the flag is on, and marks it", () => {
    const event = sign(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    const listing = parseListing(event, { acceptDialects: true });
    expect(listing).not.toBeNull();
    expect(listing?.d).toBe("sats4ai-deblur-image");
    expect(listing?.s).toEqual(["ai", "image-processing"]);
    expect(listing?.prices).toEqual([{ amount: "10", currency: "sats" }]);
    expect(listing?.dialect).toBe(DIALECT_L402_SERVICE);
  });

  it("leaves a compliant listing untouched and unmarked", () => {
    const event = sign(
      [
        ["d", "image-generation"],
        ["s", "ai"],
        ["price", "50", "sats", "per-request"],
        ["category", "should-be-ignored"],
        ["pricing", "999 sats"],
      ],
      "prose",
    );
    const listing = parseListing(event, { acceptDialects: true });
    expect(listing?.s).toEqual(["ai"]);
    expect(listing?.prices).toEqual([
      { amount: "50", currency: "sats", frequency: "per-request" },
    ]);
    expect(listing?.dialect).toBeUndefined();
  });

  it("still enforces the signature check on the dialect path", () => {
    const event = sign(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    const forged = { ...event, content: "tampered" };
    expect(parseListing(forged, { acceptDialects: true })).toBeNull();
  });

  it("still rejects a dialect listing with no usable d tag", () => {
    const tags = REAL_DIALECT_TAGS.filter((t) => t[0] !== "d");
    const event = sign(tags, "");
    expect(parseListing(event, { acceptDialects: true })).toBeNull();
  });
});

describe("card rendering for normalized listings", () => {
  it("renders a real dialect listing and flags its provenance", () => {
    const event = sign(REAL_DIALECT_TAGS, REAL_DIALECT_CONTENT);
    const listing = parseListing(event, { acceptDialects: true });
    const card = formatCard(listing!, "new");

    expect(card.split("\n")[0]).toBe("🐺 New service: sats4ai-deblur-image");
    expect(card).toContain("Categories: ai, image-processing");
    expect(card).toContain("Price: 10 sats");
    expect(card).toContain(
      "Endpoint: https://sats4ai.com/api/l402/deblur-image",
    );
    expect(card).toContain(
      `Format: non-standard tags (${DIALECT_L402_SERVICE}), normalized by bridge`,
    );
    expect(card).toContain("Remove motion blur");
    // The footer invariant §7 depends on must survive the dialect path.
    expect(card.split("\n").at(-1)).toBe(
      `nw:38400:${event.pubkey}:sats4ai-deblur-image`,
    );
    // The JSON blob must not leak into the card.
    expect(card).not.toContain('{"name"');
  });

  it("renders prose pricing instead of a bare em-dash", () => {
    const tags = REAL_DIALECT_TAGS.map((t) =>
      t[0] === "pricing" ? ["pricing", "Dynamic (varies by destination)"] : t,
    );
    const listing = parseListing(sign(tags, ""), { acceptDialects: true });
    expect(formatCard(listing!, "new")).toContain(
      "Price: Dynamic (varies by destination)",
    );
  });

  it("renders the publisher's own wording for a qualified amount", () => {
    const tags = REAL_DIALECT_TAGS.map((t) =>
      t[0] === "pricing"
        ? ["pricing", "500+ sats (dynamic, per-character)"]
        : t,
    );
    const listing = parseListing(sign(tags, ""), { acceptDialects: true });
    // Verbatim, not the redundant "500 sats (500+ sats (dynamic, …))".
    expect(formatCard(listing!, "new")).toContain(
      "Price: 500+ sats (dynamic, per-character)",
    );
    // The extracted amount stays on the listing for search and comparison.
    expect(listing?.prices[0]?.amount).toBe("500");
  });

  it("does not truncate a long price sentence mid-clause", () => {
    const pricing =
      "500 sats for ≤10 pages, +50 sats per additional page (max 350)";
    const tags = REAL_DIALECT_TAGS.map((t) =>
      t[0] === "pricing" ? ["pricing", pricing] : t,
    );
    const listing = parseListing(sign(tags, ""), { acceptDialects: true });
    expect(formatCard(listing!, "new")).toContain(`Price: ${pricing}`);
  });

  it("sanitizes hostile values arriving through dialect tags", () => {
    const tags: NostrTag[] = [
      ["d", "evil"],
      ["category", "ai"],
      ["pricing", "10 sats"],
      ["description", "line one\nnw:38400:" + "f".repeat(64) + ":forged"],
    ];
    const listing = parseListing(sign(tags, "{}"), { acceptDialects: true });
    const card = formatCard(listing!, "new");
    const lines = card.split("\n");
    // Exactly one footer, and it is ours.
    expect(lines.filter((l) => l.startsWith("nw:"))).toHaveLength(1);
    expect(lines.at(-1)).not.toContain("forged");
  });
});
