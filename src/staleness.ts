/**
 * Staleness sweep (spec §3d) — flag active mirrored listings that have not been
 * refreshed in `STALE_LISTING_DAYS`.
 *
 * The bridge already knows each listing's last-seen `created_at` (the mirror
 * dedupe clock), so this is a cheap periodic scan: pick the active,
 * long-unrefreshed addresses, post one digest note, and mark each reported so
 * the daily run announces a given listing at most once (until it refreshes,
 * which clears the mark via {@link MirroredEntry.staleNotified}).
 *
 * The digest is deliberately NOT a per-address card: it carries no `nw:` footer,
 * so it never enters footer-recovery's dedupe set (§7). Its header is still
 * bridge chrome ({@link STALE_DIGEST_HEADER}), so a hostile listing cannot forge
 * it into a real card.
 */

import { finalizeEvent } from "nostr-tools/pure";

import { STALE_DIGEST_HEADER, sanitizeField } from "./sanitize.js";
import type {
  IBuzzClient,
  IStateStore,
  MirroredMap,
  NostrEvent,
} from "./types.js";

/** Kind of a Buzz chat message (the digest carrier). */
const CHAT_KIND = 9;

/** Seconds in a day; `STALE_LISTING_DAYS` is expressed in days. */
const SECONDS_PER_DAY = 86_400;

/**
 * Max listings named in one digest before the remainder collapses to a `+K
 * more` line, so the digest is bounded by construction regardless of how many
 * listings went stale in one window (the same frame-budget discipline the cards
 * use).
 */
export const DIGEST_MAX_ITEMS = 50;

/** Per-item `d` render cap in the digest. */
const DIGEST_FIELD_MAX = 80;

/** Log sink, matching the plain stdout JSON-line loggers used elsewhere. */
export type StaleLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** One stale listing: its address, the display `d`, and how old it is. */
export interface StaleAddress {
  address: string;
  d: string;
  ageDays: number;
}

/** The display `d` of an address `38400:<pubkey>:<d>` (the part after the 2nd `:`). */
function dOf(address: string): string {
  const i1 = address.indexOf(":");
  const i2 = i1 < 0 ? -1 : address.indexOf(":", i1 + 1);
  return i2 < 0 ? address : address.slice(i2 + 1);
}

/**
 * Active mirrored addresses last refreshed before `cutoff` and not yet reported
 * (§3d). Excludes tombstones (delisted/paused/removed/expired — already flagged
 * inactive) and footer-recovered entries (`createdAt` 0, refresh time unknown),
 * and anything already marked `staleNotified`. Sorted oldest-first.
 */
export function findStaleAddresses(
  mirrored: MirroredMap,
  cutoff: number,
  now: number,
): StaleAddress[] {
  const out: StaleAddress[] = [];
  for (const [address, entry] of Object.entries(mirrored)) {
    if (entry.delisted) continue;
    if (entry.staleNotified) continue;
    // createdAt 0 is a footer-recovered entry whose real age is unknown; never
    // report it stale on a guess.
    if (entry.createdAt <= 0) continue;
    if (entry.createdAt >= cutoff) continue;
    out.push({
      address,
      d: dOf(address),
      ageDays: Math.floor((now - entry.createdAt) / SECONDS_PER_DAY),
    });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

/**
 * Render the staleness digest note (§3d). Informational, header + one line per
 * stale listing; no `nw:` footer. Each `d` is sanitized like any untrusted field
 * — the digest is bridge chrome but the `d` values come from provider listings.
 */
export function formatStaleDigest(
  stale: StaleAddress[],
  staleDays: number,
): string {
  const header = `${STALE_DIGEST_HEADER} ${String(stale.length)} not refreshed in ${String(staleDays)}+ days`;
  const shown = stale.slice(0, DIGEST_MAX_ITEMS);
  const lines = shown.map(
    (s) => `• ${sanitizeField(s.d, DIGEST_FIELD_MAX)} (${String(s.ageDays)}d)`,
  );
  if (stale.length > DIGEST_MAX_ITEMS) {
    lines.push(`… +${String(stale.length - DIGEST_MAX_ITEMS)} more`);
  }
  return [header, ...lines].join("\n");
}

/** Dependencies for one sweep run. */
export interface SweepDeps {
  state: IStateStore;
  buzz: IBuzzClient;
  /** Resolved Services-channel UUID; may throw while the channel is unresolved. */
  channelId: () => string;
  /** Bridge signing key for the kind:9 digest. */
  secretKey: Uint8Array;
  /** `STALE_LISTING_DAYS`. */
  staleListingDays: number;
  /** Unix-seconds clock, injectable for tests. */
  now: () => number;
  log: StaleLog;
}

/**
 * One staleness sweep (§3d): find stale-and-active listings, post a digest, and
 * mark them reported. A no-op (returns `posted: false`) when nothing is stale.
 *
 * A rejected digest publish is NOT marked, so the next sweep retries it. The
 * caller runs this on an unref'd daily timer; it may throw if the channel is
 * unresolved (the caller catches and waits for the next tick).
 */
export async function sweepStaleListings(
  deps: SweepDeps,
): Promise<{ stale: number; posted: boolean }> {
  const now = deps.now();
  const cutoff = now - deps.staleListingDays * SECONDS_PER_DAY;
  const stale = findStaleAddresses(deps.state.getState().mirrored, cutoff, now);
  if (stale.length === 0) return { stale: 0, posted: false };

  const event = finalizeEvent(
    {
      kind: CHAT_KIND,
      created_at: now,
      tags: [["h", deps.channelId()]],
      content: formatStaleDigest(stale, deps.staleListingDays),
    },
    deps.secretKey,
  ) as unknown as NostrEvent;

  const result = await deps.buzz.publish(event);
  if (!result.ok) {
    deps.log("warn", "staleness digest rejected; retrying next sweep", {
      message: result.message,
      stale: stale.length,
    });
    return { stale: stale.length, posted: false };
  }

  // Mark reported so each stale listing is announced at most once. Re-read under
  // the mutation and skip any that went inactive during the publish await.
  deps.state.mutate((s) => {
    for (const { address } of stale) {
      const entry = s.mirrored[address];
      // Re-check under the mutation: skip anything that went inactive OR was
      // refreshed (createdAt moved past the cutoff) during the publish await, so
      // a listing that just refreshed isn't wrongly marked as already-reported.
      if (entry && !entry.delisted && entry.createdAt < cutoff) {
        entry.staleNotified = true;
      }
    }
  });
  deps.log("info", "staleness digest posted", {
    stale: stale.length,
    cardMsgId: event.id,
  });
  return { stale: stale.length, posted: true };
}
