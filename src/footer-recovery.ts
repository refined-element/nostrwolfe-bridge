/** Footer-based dedupe recovery from channel history (spec §7). */

import { CARD_HEADERS_BY_KIND } from "./sanitize.js";
import type {
  CardKind,
  IBuzzClient,
  MirroredEntry,
  MirroredMap,
  NostrEvent,
  NostrFilter,
  RecoveredFooter,
} from "./types.js";

/**
 * The exact card headers (§5 step 4, §3a-c). A message is only considered a
 * bridge card if its FIRST line starts with one of these — this is what keeps
 * QueryResponder replies (whose bodies also contain `nw:` strings) out of the
 * recovered dedupe set. Derived from the one shared map so a new card kind is
 * recognized on restart automatically (the staleness digest is deliberately
 * absent: it carries no `nw:` footer and must never enter the dedupe set).
 */
const CARD_HEADERS = Object.entries(CARD_HEADERS_BY_KIND) as ReadonlyArray<
  readonly [CardKind, string]
>;

/**
 * A card kind is a **tombstone** (dropped from the active cache, retained for
 * dedupe) unless it is an active `new`/`updated` card. Recovering a paused,
 * removed, or expired card as a live entry would re-post it as "new" on the next
 * hydration, so all inactive kinds recover as `delisted: true` (§3a-c, §7).
 */
function isTombstoneKind(kind: CardKind): boolean {
  return kind !== "new" && kind !== "updated";
}

/**
 * The machine-readable footer grammar (§7). Anchored on both ends: the whole
 * final line must be the footer, the pubkey must be exactly 64 lowercase hex,
 * and the `d` part must be non-empty.
 */
const FOOTER_RE = /^nw:38400:[0-9a-f]{64}:.+$/;

/** Relay result cap per filter is 500 (§7); pages walk backwards with `until`. */
export const FOOTER_RECOVERY_PAGE_SIZE = 500;

/**
 * Safety valve on the `until` walk. 100 full pages is 50k cards — far beyond
 * any realistic Services channel — so hitting it means the relay is not
 * honouring `until` and we stop rather than loop forever.
 */
const MAX_PAGES = 100;

/** Strict single-message footer parse; null unless the card grammar matches (§7). */
export function parseCardFooter(event: {
  id: string;
  content: string;
}): RecoveredFooter | null {
  // Tolerate trailing newline/whitespace produced by serialization only; the
  // footer still has to be the last content-bearing line of the message.
  const lines = event.content.trimEnd().split("\n");
  if (lines.length < 2) return null;

  const first = lines[0];
  if (first === undefined) return null;

  let cardKind: CardKind | undefined;
  for (const [kind, prefix] of CARD_HEADERS) {
    if (first.startsWith(prefix)) {
      cardKind = kind;
      break;
    }
  }
  if (cardKind === undefined) return null;

  // ONLY the final line is ever considered — a forged `nw:` line in the middle
  // of provider content can never enter the dedupe set (§7, Security §2).
  const last = lines[lines.length - 1];
  if (last === undefined || !FOOTER_RE.test(last)) return null;

  return {
    address: last.slice("nw:".length),
    cardMsgId: event.id,
    cardKind,
  };
}

/** Page the channel's kind:9 history and rebuild the mirrored dedupe set (§7). */
export async function recoverMirroredFromChannel(
  buzz: IBuzzClient,
  channelId: string,
  bridgePubkey: string,
): Promise<MirroredMap> {
  const mirrored: MirroredMap = {};
  /** address → created_at of the card that produced the current entry. */
  const winnerAt = new Map<string, number>();
  const seenIds = new Set<string>();

  let until: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const filter: NostrFilter = {
      kinds: [9],
      "#h": [channelId],
      limit: FOOTER_RECOVERY_PAGE_SIZE,
    };
    if (until !== undefined) filter.until = until;

    const events: NostrEvent[] = await buzz.query(`footer-recover-${page}`, [
      filter,
    ]);
    if (events.length === 0) break;

    let fresh = 0;
    let oldest = Number.POSITIVE_INFINITY;

    for (const event of events) {
      if (event.created_at < oldest) oldest = event.created_at;
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      fresh++;

      // Only the bridge's own cards count — nobody else can author them
      // (buzz-relay pins event pubkey to the authed pubkey, Security §3), but
      // the REQ is channel-scoped, so members' messages arrive here too.
      if (event.pubkey !== bridgePubkey) continue;

      const footer = parseCardFooter(event);
      if (footer === null) continue;

      const previous = winnerAt.get(footer.address);
      if (previous !== undefined && previous >= event.created_at) continue;
      winnerAt.set(footer.address, event.created_at);

      const tombstone = isTombstoneKind(footer.cardKind);
      const entry: MirroredEntry = {
        // The card carries no source event id; recovery only needs the address.
        eventId: "",
        // For an ACTIVE card, createdAt is unknown → 0, so the next 38400 for the
        // address posts an "updated" card rather than a duplicate "new" card (§7).
        // For a TOMBSTONE (removed/paused/expired/delisted), seed the high-water
        // mark from the note's own timestamp — it is >= the removal, so a stale
        // pre-removal 38400 replayed by hydration can't resurrect the listing as a
        // live card; only a genuinely newer republish restores it (§3b).
        createdAt: tombstone ? event.created_at : 0,
        cardMsgId: footer.cardMsgId,
        delisted: tombstone,
      };
      mirrored[footer.address] = entry;
    }

    // Page-shortness is NOT a drain signal — a relay may cap any page below the
    // requested limit, and treating a short first page as "drained" silently
    // truncates the rebuilt dedupe set, which is exactly the duplicate-card
    // storm §7 exists to bound. Only an empty page, or a full page that yielded
    // no new ids, ends the walk (`until` is inclusive, so the id dedupe above
    // makes an overlapping page harmless).
    if (fresh === 0) {
      if (events.length < FOOTER_RECOVERY_PAGE_SIZE) break;
      // A whole page sharing one `created_at`: step strictly below the window
      // we just asked for rather than re-requesting it forever. `Math.min` with
      // the previous `until` keeps the walk monotonic even if the relay ignores
      // it and keeps replaying the same newest-first set.
      until = Math.min(oldest, until ?? oldest) - 1;
      continue;
    }

    until = oldest;
  }

  return mirrored;
}
