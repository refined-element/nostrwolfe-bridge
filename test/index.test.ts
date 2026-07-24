import { describe, expect, it } from "vitest";

import { ChannelUnresolvedError, normalizeRecovery } from "../src/index.js";
import type { MirroredEntry } from "../src/types.js";

function entry(): MirroredEntry {
  return { eventId: "", createdAt: 0, cardMsgId: "m1", delisted: false };
}

// --- footer-recovery shape coordination (finding H-7) ----------------------

describe("normalizeRecovery (finding H-7)", () => {
  it("passes through the structured {mirrored, truncated} result", () => {
    const mirrored = { "38400:aa:d": entry() };
    const out = normalizeRecovery({ mirrored, truncated: true, pages: 3 });
    expect(out.mirrored).toBe(mirrored);
    expect(out.truncated).toBe(true);
  });

  it("treats a truncated structured result as truncated (warns → expect dup cards)", () => {
    const out = normalizeRecovery({ mirrored: {}, truncated: true });
    expect(out.truncated).toBe(true);
  });

  it("accepts the legacy plain MirroredMap return shape", () => {
    // The map's keys are addresses (`38400:<pubkey>:<d>`), never `mirrored` or
    // `truncated`, so it is unambiguously the legacy shape.
    const legacy = { "38400:aa:d": entry(), "38400:bb:e": entry() };
    const out = normalizeRecovery(legacy);
    expect(out.mirrored).toBe(legacy);
    // A legacy map carries no truncation signal → treated as complete.
    expect(out.truncated).toBe(false);
  });

  it("tolerates an empty/absent recovery result", () => {
    expect(normalizeRecovery({}).mirrored).toEqual({});
    expect(normalizeRecovery({}).truncated).toBe(false);
  });
});

// --- null-channel drop signalling (finding H-6/M-4) ------------------------

describe("ChannelUnresolvedError (finding H-6/M-4)", () => {
  it("is a distinct, self-describing error type", () => {
    const err = new ChannelUnresolvedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ChannelUnresolvedError");
    expect(err.message).toMatch(/not resolved/i);
    // `instanceof` is what lets onListing single out the null-channel drop from
    // a generic handling failure and count it distinctly.
    expect(err instanceof ChannelUnresolvedError).toBe(true);
  });
});
