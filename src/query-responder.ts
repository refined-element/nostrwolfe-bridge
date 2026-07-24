/** QueryResponder — answers `@bridge` mentions in the channel (spec §6). */

import { finalizeEvent } from "nostr-tools/pure";

import { sanitizeInline } from "./sanitize.js";

import type {
  BridgeCommand,
  BridgeIdentity,
  Config,
  IBuzzClient,
  IListingCache,
  IQueryResponder,
  LogLevel,
  NostrEvent,
  ParsedListing,
  SearchResult,
  Subscription,
} from "./types.js";

/** Buzz channel message. */
const KIND_CHANNEL_MESSAGE = 9;
/** Clock-skew allowance applied to every `since` (§6, §2). */
const CURSOR_SKEW_SECONDS = 300;
/** Mentions older than this are ignored — no necromancing stale threads (§6). */
const STALE_MENTION_SECONDS = 3600;
/** Per-sender cooldown, prevents agent↔bridge request loops (§6). */
const COOLDOWN_MS = 5_000;
/** Reply with at most this many hits (§6). */
const MAX_RESULTS = 5;

const SCORE_CATEGORY = 3;
const SCORE_HASHTAG = 2;
const SCORE_SUBSTRING = 1;

/**
 * Mention ids already answered. A reconnect re-issues the mentions REQ with
 * `since = cursor − 300` (§2), so the relay legitimately replays up to five
 * minutes of channel messages — without this, every socket flap posts a second
 * identical reply. Bounded so a long-lived daemon cannot grow without limit.
 */
const HANDLED_MAX = 2_000;
/** Bound on {@link QueryResponder.helpedThreads} (once-per-thread help, §6). */
const HELPED_THREADS_MAX = 1_000;

/** Insertion-ordered bounded set: oldest entries evicted first. */
class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly max: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  add(key: string): void {
    this.items.add(key);
    while (this.items.size > this.max) {
      const oldest = this.items.values().next();
      if (oldest.done === true) break;
      this.items.delete(oldest.value);
    }
  }

  get size(): number {
    return this.items.size;
  }
}

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
        component: "query-responder",
        msg,
        ...fields,
      }),
    );
  };
}

// --- Pure helpers ----------------------------------------------------------

/**
 * Mention detection (§6): a `["p","<bridge>"]` tag **or** a content starting
 * with `@bridge` (case-insensitive). The bridge's own messages never count.
 */
export function isAddressedToBridge(
  event: NostrEvent,
  bridgePubkey: string,
): boolean {
  if (event.pubkey === bridgePubkey) return false;
  for (const t of event.tags) {
    if (t[0] === "p" && t[1] === bridgePubkey) return true;
  }
  return event.content.trimStart().toLowerCase().startsWith("@bridge");
}

/**
 * Thread key for the once-per-thread help rule (§6): the NIP-10 root when the
 * mention is itself a reply, otherwise the mention starts its own thread.
 */
export function threadIdOf(event: NostrEvent): string {
  let firstE: string | undefined;
  for (const t of event.tags) {
    if (t[0] !== "e" || typeof t[1] !== "string") continue;
    firstE ??= t[1];
    if (t[3] === "root") return t[1];
  }
  return firstE ?? event.id;
}

// `sanitizeInline` now lives in ./sanitize.js — the one hardened sanitizer
// shared with mirror-engine (Security §2). Re-exported so existing importers of
// this name from query-responder keep working.
export { sanitizeInline };

/**
 * One-line price summary for `find` results; non-numeric amounts render as `—`
 * (§ security 2).
 *
 * A dialect tier may price in prose ({@link PriceTier.note}, e.g. "Dynamic
 * (varies by destination)"). The card renders that note verbatim (sanitized) in
 * place of the structured form, so this summary must too — otherwise the same
 * listing shows the publisher's wording on its card but a bare `—` in find
 * results (spec L-7). The numeric gate is the strict decimal regex shared with
 * the card side: `Number()` would accept `0x10`/`1e3`/`Infinity` as "numbers",
 * which is not what a price is.
 */
export function formatPriceSummary(listing: ParsedListing): string {
  const tier = listing.prices[0];
  if (!tier) return "—";
  const note = sanitizeInline(tier.note ?? "", 64);
  if (note.length > 0) return note;
  const amount = /^\d+(\.\d+)?$/.test(tier.amount.trim())
    ? tier.amount.trim()
    : "—";
  const parts = [amount, sanitizeInline(tier.currency, 16)];
  if (tier.frequency) parts.push(sanitizeInline(tier.frequency, 24));
  return parts.filter((p) => p.length > 0).join(" ");
}

/**
 * Score one listing against pre-tokenized query terms (§6):
 * exact `s`-category 3/term, `t`-hashtag 2/term, substring in `d`/content 1/term.
 * Dimensions are additive per term, which preserves the 3 > 2 > 1 ordering.
 */
export function scoreListing(listing: ParsedListing, terms: string[]): number {
  let score = 0;
  const categories = listing.s.map((s) => s.toLowerCase());
  const hashtags = listing.t.map((t) => t.toLowerCase().replace(/^#/, ""));
  const haystack = `${listing.d} ${listing.content}`.toLowerCase();
  for (const term of terms) {
    if (categories.includes(term)) score += SCORE_CATEGORY;
    if (hashtags.includes(term.replace(/^#/, ""))) score += SCORE_HASHTAG;
    if (haystack.includes(term)) score += SCORE_SUBSTRING;
  }
  return score;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_+#./-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Compact one-line `find` entry (§6).
 *
 * Every segment — the address included — goes through {@link sanitizeInline}.
 * MirrorEngine already normalizes `d` before it becomes part of the address, so
 * this is defense in depth: a raw address here would let a newline inside `d`
 * split the reply into a second line whose text the attacker chooses, signed by
 * the bridge's own pubkey (Security §2). The 400-char budget is above the
 * longest legitimate address (`38400:` + 64 hex + a 200-char `d`), so a real
 * address is never truncated.
 */
export function formatResultLine(result: SearchResult): string {
  const categories = result.categories.map((c) => sanitizeInline(c, 32));
  return [
    sanitizeInline(result.d, 80),
    categories.length > 0 ? categories.join(", ") : "—",
    sanitizeInline(result.price, 64),
    `nw:${sanitizeInline(result.address, 400)}`,
  ].join(" — ");
}

/** Exact no-match reply (§6). */
export function noMatchMessage(cachedCount: number): string {
  return `No matching services. ${cachedCount} listings cached; try \`@bridge find <category>\`.`;
}

/**
 * `@bridge help` text. Deliberately does not end on a line starting with `nw:`
 * so footer-based recovery (§7) can never mistake it for a card.
 */
export const HELP_TEXT = [
  "🐺 nostrwolfe-bridge — commands:",
  "• `@bridge find <query>` — search mirrored NostrWolfe listings; replies with the top 5 matches.",
  "• `@bridge publish <signed 38400 JSON>` — forward YOUR own signed kind:38400 to the public relay (must be signed by your key). Paste it raw or in a ```json fence.",
  "• `@bridge help` — this message.",
  "Note: a message larger than ~64 KB is dropped by the relay before the bridge sees it, so an oversized publish gets no reply.",
  "Cards in this channel mirror public kind:38400 service listings; each card ends with its `nw:38400:<pubkey>:<d>` address.",
].join("\n");

/** Options bag — everything optional so the scaffolded constructor still fits. */
export interface QueryResponderOptions {
  /** Injectable clock in ms (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Persisted `buzz` cursor in unix seconds; 0/absent = first run (§6). */
  getCursor?: () => number;
  /** Invoked with each handled mention's `created_at` so the caller can persist it. */
  onCursorAdvance?: (createdAt: number) => void;
  /**
   * Handles `@bridge publish <payload>` (§8): validates the member's signed
   * 38400 against `authorPubkey` and forwards it to the public relay, returning
   * the in-thread reply text. Absent = publishing disabled.
   */
  publishHandler?: (payload: string, authorPubkey: string) => Promise<string>;
}

export class QueryResponder implements IQueryResponder {
  private readonly log: ReturnType<typeof makeLogger>;
  private readonly now: () => number;
  /** Last reply time per sender pubkey (ms) — the 5s cooldown (§6). Pruned. */
  private readonly cooldowns = new Map<string, number>();
  /** Threads that already received the unknown-command help (§6). Bounded. */
  private readonly helpedThreads = new BoundedSet(HELPED_THREADS_MAX);
  /** Mention ids already answered — the reconnect-replay guard (§2/§6). */
  private readonly handled = new BoundedSet(HANDLED_MAX);

  constructor(
    private readonly config: Config,
    private readonly identity: BridgeIdentity,
    private readonly buzz: IBuzzClient,
    private readonly cache: IListingCache,
    private readonly getChannelId: () => string,
    private readonly options: QueryResponderOptions = {},
  ) {
    this.log = makeLogger(config);
    this.now = options.now ?? Date.now;
  }

  /**
   * `since` for the mentions subscription (§6): `cursor − 300`, or `now − 300`
   * on a first run / missing cursor. **Never 0** — that would replay the whole
   * channel history and mass-reply to it.
   */
  mentionSince(): number {
    const nowSec = Math.floor(this.now() / 1000);
    const cursor = this.options.getCursor?.() ?? 0;
    if (!Number.isFinite(cursor) || cursor <= 0) {
      return nowSec - CURSOR_SKEW_SECONDS;
    }
    return cursor - CURSOR_SKEW_SECONDS;
  }

  /**
   * Open the mentions subscription `{kinds:[9], "#h":[uuid], since}` (§6, flow #7).
   *
   * `since` is supplied as a **cursor callback**, not baked into the filter, so
   * BuzzClient recomputes `cursor − 300` on every resubscribe after a reconnect
   * (§2). A static `since` would replay an ever-growing window as the process
   * ages. This is the same wiring `index.ts` uses.
   */
  start(): Subscription {
    const channelId = this.getChannelId();
    this.log("info", "mentions subscription starting", {
      channelId,
      since: this.mentionSince(),
    });
    return this.buzz.subscribe(
      `ch-${channelId}`,
      [{ kinds: [KIND_CHANNEL_MESSAGE], "#h": [channelId] }],
      (event) => {
        void this.handleMention(event).catch((err: unknown) => {
          this.log("error", "mention handling failed", {
            id: event.id,
            err: String(err),
          });
        });
      },
      undefined,
      // BuzzClient subtracts the 300s skew itself, so hand it the raw cursor —
      // and `now` on a first run, never 0 (§6).
      () => this.mentionSince() + CURSOR_SKEW_SECONDS,
    );
  }

  async handleMention(event: NostrEvent): Promise<void> {
    if (!isAddressedToBridge(event, this.identity.publicKey)) {
      // Not a mention: nothing to publish, but the cursor still advances so it
      // tracks the channel head and the reconnect replay window stays bounded.
      this.options.onCursorAdvance?.(event.created_at);
      return;
    }

    // Every reconnect re-issues the mentions REQ with `since = cursor − 300`
    // (§2), so the relay replays up to 5 minutes of channel messages. Without
    // an id-level guard a socket flap posts a second identical reply — the
    // mirror side has the same at-least-once discipline via the §5 id compare.
    if (this.handled.has(event.id)) {
      this.log("debug", "mention already handled; skipping replay", {
        id: event.id,
      });
      return;
    }
    this.pruneCooldowns();

    const nowSec = Math.floor(this.now() / 1000);
    if (nowSec - event.created_at > STALE_MENTION_SECONDS) {
      this.log("info", "ignoring stale mention", {
        id: event.id,
        ageSeconds: nowSec - event.created_at,
      });
      // A decision *was* made — the mention is too old to ever answer — so
      // record it (and advance the cursor) to keep replays from re-litigating.
      this.recordHandled(event);
      return;
    }

    const last = this.cooldowns.get(event.pubkey);
    if (last !== undefined && this.now() - last < COOLDOWN_MS) {
      this.log("debug", "sender on cooldown, ignoring mention", {
        id: event.id,
        sender: event.pubkey,
      });
      // Deliberately dropped — record it so a replay does not re-answer it.
      this.recordHandled(event);
      return;
    }
    // Commit the cooldown *synchronously*, the instant the gate passes — before
    // any await. `handleMention` is dispatched fire-and-forget, and the publish
    // path then awaits a forward of up to OUTBOUND_OK_TIMEOUT_MS. If the cooldown
    // were only written after that await (in reply()), a burst of concurrent
    // `@bridge publish` from one sender would all pass this check with the map
    // still empty and each open an unmetered outbound socket (TOCTOU). Writing
    // here closes that race and still throttles a sender whose reply bounced.
    this.cooldowns.set(event.pubkey, this.now());

    const command = this.parseCommand(event.content);
    let reply: string;
    // For a first-time unknown command the thread is committed to
    // `helpedThreads` only *after* the help actually publishes — otherwise a
    // failed publish would mark the thread helped, and the retry (see below)
    // would go silent and never deliver the help it owes.
    let markHelpedThread: string | undefined;
    if (command.type === "find") {
      const results = this.search(command.query);
      reply =
        results.length > 0
          ? results.map(formatResultLine).join("\n")
          : noMatchMessage(this.cache.size);
    } else if (command.type === "publish") {
      // §8: validate + forward the member's own signed 38400 to the public
      // relay. `event.pubkey` is the authenticated author (Buzz pins it), so the
      // handler enforces the listing is signed by that same identity. If no
      // handler is wired (publish disabled), say so rather than silently ignore.
      reply = this.options.publishHandler
        ? await this.options.publishHandler(command.payload, event.pubkey)
        : "Publishing is not enabled on this bridge.";
    } else if (command.type === "help") {
      reply = HELP_TEXT;
    } else {
      const thread = threadIdOf(event);
      if (this.helpedThreads.has(thread)) {
        this.log("debug", "unknown command already helped in thread", {
          thread,
        });
        this.recordHandled(event);
        return;
      }
      markHelpedThread = thread;
      reply = HELP_TEXT;
    }

    const published = await this.reply(event, reply);
    if (!published) {
      // The relay rejected the reply. Leave the mention OUT of `handled` and do
      // NOT advance the cursor, so a reconnect within the 300s replay window
      // re-delivers it and we retry. The cooldown set inside reply() still
      // throttles a sender whose replies keep bouncing. (§6, silent-failure H-4)
      return;
    }
    if (markHelpedThread !== undefined)
      this.helpedThreads.add(markHelpedThread);
    this.recordHandled(event);
  }

  /**
   * Mark a mention finally dealt with: add it to the replay-dedupe set and
   * advance the buzz cursor to its `created_at`. Called only once the outcome is
   * settled — a successful publish or a deliberate no-reply — never for a
   * mention whose reply the relay rejected (that stays retriable).
   */
  private recordHandled(event: NostrEvent): void {
    this.handled.add(event.id);
    this.options.onCursorAdvance?.(event.created_at);
  }

  /**
   * Drop cooldown entries that can no longer gate anything. Without this the
   * map keeps one entry per sender pubkey that ever addressed the bridge, for
   * the lifetime of a daemon designed to run indefinitely.
   */
  private pruneCooldowns(): void {
    const cutoff = this.now() - COOLDOWN_MS;
    for (const [pubkey, at] of this.cooldowns) {
      if (at <= cutoff) this.cooldowns.delete(pubkey);
    }
  }

  /**
   * Parse `@bridge <command>` (§6). The `@bridge` prefix is optional because
   * p-tagged mentions may carry the bare command.
   * A bare `find` with no query is treated as `unknown` → help.
   */
  parseCommand(content: string): BridgeCommand {
    const stripped = content.trim().replace(/^@bridge\b[\s:,]*/i, "");
    const trimmed = stripped.trim();
    if (trimmed.length === 0) return { type: "unknown" };
    const spaceAt = trimmed.search(/\s/);
    const word = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt))
      .toLowerCase()
      .replace(/[:,]+$/, "");
    const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
    if (word === "help") return { type: "help" };
    if (word === "find") {
      if (rest.length === 0) return { type: "unknown" };
      return { type: "find", query: rest };
    }
    if (word === "publish") {
      if (rest.length === 0) return { type: "unknown" };
      return { type: "publish", payload: rest };
    }
    return { type: "unknown" };
  }

  /** Score the cache for a `find` query and return the top {@link MAX_RESULTS} (§6). */
  search(query: string): SearchResult[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    // Defense in depth for NIP-40 expiry (§3c/§4): the expiration sweep runs on a
    // daily timer, so between a listing's expiration and the next sweep it may
    // still sit in the cache. Never return an expired listing from `find` — a
    // paying agent must not be handed a dead endpoint.
    const nowSec = Math.floor(this.now() / 1000);
    const scored: { result: SearchResult; listing: ParsedListing }[] = [];
    for (const listing of this.cache.all()) {
      if (listing.expiration !== undefined && listing.expiration <= nowSec) {
        continue;
      }
      const score = scoreListing(listing, terms);
      if (score <= 0) continue;
      scored.push({
        listing,
        result: {
          address: listing.address,
          d: listing.d,
          categories: listing.s,
          price: formatPriceSummary(listing),
          score,
        },
      });
    }
    scored.sort(
      (a, b) =>
        b.result.score - a.result.score ||
        b.listing.createdAt - a.listing.createdAt ||
        (a.result.address < b.result.address ? -1 : 1),
    );
    return scored.slice(0, MAX_RESULTS).map((s) => s.result);
  }

  /**
   * Threaded kind:9 reply: `["h",uuid]` + NIP-10 `["e",parent,"","reply"]` (§6).
   *
   * Returns `true` only if the relay accepted the event. On rejection
   * (rate-limited / invalid / restricted) it logs at `error` — a dropped reply
   * is a user-visible failure, not a warning — naming the consequence and the
   * relay's message, and returns `false` so the caller leaves the mention
   * unhandled and retriable (silent-failure H-4). The sender's cooldown was
   * already committed at the gate in `handleMention` (synchronously, before any
   * await), so a bounced reply is still throttled and the publish path can't be
   * raced past the cooldown.
   */
  private async reply(parent: NostrEvent, content: string): Promise<boolean> {
    const event = finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(this.now() / 1000),
        tags: [
          ["h", this.getChannelId()],
          ["e", parent.id, "", "reply"],
        ],
        content,
      },
      this.identity.secretKey,
    ) as NostrEvent;
    const ok = await this.buzz.publish(event);
    if (!ok.ok) {
      this.log(
        "error",
        "reply rejected by relay; mention left unhandled, will retry within the 300s replay window",
        {
          parent: parent.id,
          sender: parent.pubkey,
          message: ok.message,
        },
      );
      return false;
    }
    return true;
  }
}
