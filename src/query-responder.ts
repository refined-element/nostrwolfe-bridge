/** QueryResponder — answers `@bridge` mentions in the channel (spec §6). */

import { finalizeEvent } from "nostr-tools/pure";

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

/** Strip control characters/newlines from untrusted text rendered inline (§ security 2). */
export function sanitizeInline(text: string, max = 120): string {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** One-line price summary; non-numeric amounts render as `—` (§ security 2). */
export function formatPriceSummary(listing: ParsedListing): string {
  const tier = listing.prices[0];
  if (!tier) return "—";
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

/** Compact one-line `find` entry (§6). */
export function formatResultLine(result: SearchResult): string {
  const categories = result.categories.map((c) => sanitizeInline(c, 32));
  return [
    sanitizeInline(result.d, 80),
    categories.length > 0 ? categories.join(", ") : "—",
    result.price,
    `nw:${result.address}`,
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
  "• `@bridge help` — this message.",
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
}

export class QueryResponder implements IQueryResponder {
  private readonly log: ReturnType<typeof makeLogger>;
  private readonly now: () => number;
  /** Last reply time per sender pubkey (ms) — the 5s cooldown (§6). */
  private readonly cooldowns = new Map<string, number>();
  /** Threads that already received the unknown-command help (§6). */
  private readonly helpedThreads = new Set<string>();

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

  /** Open the mentions subscription `{kinds:[9], "#h":[uuid], since}` (§6, flow #7). */
  start(): Subscription {
    const channelId = this.getChannelId();
    const since = this.mentionSince();
    this.log("info", "mentions subscription starting", { channelId, since });
    return this.buzz.subscribe(
      `ch-${channelId}`,
      [{ kinds: [KIND_CHANNEL_MESSAGE], "#h": [channelId], since }],
      (event) => {
        void this.handleMention(event).catch((err: unknown) => {
          this.log("error", "mention handling failed", {
            id: event.id,
            err: String(err),
          });
        });
      },
    );
  }

  async handleMention(event: NostrEvent): Promise<void> {
    this.options.onCursorAdvance?.(event.created_at);

    if (!isAddressedToBridge(event, this.identity.publicKey)) return;

    const nowSec = Math.floor(this.now() / 1000);
    if (nowSec - event.created_at > STALE_MENTION_SECONDS) {
      this.log("info", "ignoring stale mention", {
        id: event.id,
        ageSeconds: nowSec - event.created_at,
      });
      return;
    }

    const last = this.cooldowns.get(event.pubkey);
    if (last !== undefined && this.now() - last < COOLDOWN_MS) {
      this.log("debug", "sender on cooldown, ignoring mention", {
        id: event.id,
        sender: event.pubkey,
      });
      return;
    }

    const command = this.parseCommand(event.content);
    let reply: string;
    if (command.type === "find") {
      const results = this.search(command.query);
      reply =
        results.length > 0
          ? results.map(formatResultLine).join("\n")
          : noMatchMessage(this.cache.size);
    } else if (command.type === "help") {
      reply = HELP_TEXT;
    } else {
      const thread = threadIdOf(event);
      if (this.helpedThreads.has(thread)) {
        this.log("debug", "unknown command already helped in thread", {
          thread,
        });
        return;
      }
      this.helpedThreads.add(thread);
      reply = HELP_TEXT;
    }

    await this.reply(event, reply);
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
    return { type: "unknown" };
  }

  /** Score the cache for a `find` query and return the top {@link MAX_RESULTS} (§6). */
  search(query: string): SearchResult[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const scored: { result: SearchResult; listing: ParsedListing }[] = [];
    for (const listing of this.cache.all()) {
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

  /** Threaded kind:9 reply: `["h",uuid]` + NIP-10 `["e",parent,"","reply"]` (§6). */
  private async reply(parent: NostrEvent, content: string): Promise<void> {
    this.cooldowns.set(parent.pubkey, this.now());
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
      this.log("warn", "reply rejected", {
        parent: parent.id,
        message: ok.message,
      });
    }
  }
}
