/**
 * In-process fake buzz-relay for tests (spec "Testing strategy" → integration
 * vs mock relays).
 *
 * Speaks the proactive-AUTH handshake (`["AUTH","<challenge>"]` on connect,
 * `crates/buzz-relay/src/connection.rs:157`) and returns the **exact** OK /
 * CLOSED prefix strings from the spec's Error handling table, so the full
 * error matrix can be exercised without Docker.
 *
 * Reused by the integration phase — keep the surface stable.
 */

import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  finalizeEvent,
  generateSecretKey,
  verifyEvent,
} from "nostr-tools/pure";
import { WebSocketServer, type WebSocket } from "ws";

import type { NostrEvent, NostrFilter } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Exact relay messages (spec Error handling table)
// ---------------------------------------------------------------------------

export const OK_MESSAGES = {
  /** Generic `auth-required:` rejection. */
  AUTH_REQUIRED: "auth-required: authentication required",
  /** Ambiguous by design: allowlist miss *or* fail-closed DB error (NOSTR.md:97). */
  AUTH_VERIFICATION_FAILED: "auth-required: verification failed",
  RESTRICTED_NOT_RELAY_MEMBER: "restricted: not a relay member",
  RESTRICTED_NOT_CHANNEL_MEMBER: "restricted: not a channel member",
  RESTRICTED_CHANNEL_PRIVATE: "restricted: channel is private",
  DUPLICATE_CHANNEL_EXISTS: "duplicate: channel already exists",
  INVALID_CHANNEL_NOT_FOUND: "invalid: channel not found",
  RATE_LIMITED_CONCURRENT: "rate-limited: too many concurrent requests",
  /** `invalid:` (anything else) — buzz-relay's unknown-kind rejection. */
  INVALID_UNKNOWN_KIND: "invalid: unknown event kind",
} as const;

/** `rate-limited: quota exceeded; retry in Ns` with the seconds interpolated. */
export function rateLimitedRetryIn(seconds: number): string {
  return `rate-limited: quota exceeded; retry in ${seconds}s`;
}

/**
 * Sentinel an {@link BuzzMockRelay.onEvent} responder can return to model a
 * relay that accepts the frame but never sends an OK — the head-of-line stall
 * the publish send-cap defends against (H-5).
 */
export const NO_ACK = "__no_ack__" as const;

// ---------------------------------------------------------------------------
// Scripting
// ---------------------------------------------------------------------------

export interface ScriptedOk {
  ok: boolean;
  message: string;
}

export interface EventContext {
  /** 1-based index of this EVENT frame across the whole mock's lifetime. */
  index: number;
  /** How many times this exact event id has been received. */
  attempt: number;
  connection: MockConnection;
}

export interface AuthContext {
  index: number;
  connection: MockConnection;
  /** Challenge this connection issued. */
  challenge: string;
  /** Populated when the auth event failed local NIP-42 validation. */
  validationError?: string;
}

export interface ReqRecord {
  subId: string;
  filters: NostrFilter[];
  connection: MockConnection;
}

export interface BuzzMockOptions {
  /**
   * Reject EVENT/REQ frames received before a successful AUTH with
   * {@link OK_MESSAGES.AUTH_REQUIRED} (default: true — mirrors buzz-relay).
   */
  requireAuth?: boolean;
  /** Withhold the AUTH OK until {@link BuzzMockRelay.releaseAuth} is called. */
  holdAuthOk?: boolean;
  /** Events returned (kind-filtered) for every REQ before EOSE. */
  stored?: NostrEvent[];
  /**
   * Model the relay's channel lifecycle (spec §3): a kind:9007 with a client
   * `["h",uuid]` creates a channel and synthesizes the relay-signed kind:39000
   * metadata + kind:39002 member list; a second create for the same UUID is
   * rejected with `duplicate: channel already exists`; kind:9021 adds a member.
   * Accepted kind:9 / kind:0 events are stored and pushed to matching live subs.
   */
  channelAware?: boolean;
  /**
   * Never send the proactive `["AUTH", <challenge>]` — models a plain relay, a
   * TLS-terminating proxy, or a dropped challenge frame. The socket is open and
   * healthy but the handshake never starts (spec §2).
   */
  withholdAuthChallenge?: boolean;
  /**
   * Disable the server's automatic pong reply to client pings — models a
   * half-open TCP connection where the socket stays OPEN but nothing answers.
   * Drives the keepalive watchdog (H-1). Default true (normal behavior).
   */
  autoPong?: boolean;
  /**
   * Hard per-REQ result cap, applied AFTER newest-first ordering, regardless of
   * the client's `limit` — models the relay's own 500-event ceiling (§4/§7) so
   * the footer-recovery `until` walk can be exercised across pages. Default
   * Infinity (no server cap; the client's `limit` still applies).
   */
  maxEventsPerReq?: number;
}

export interface MockConnection {
  readonly socket: WebSocket;
  readonly challenge: string;
  authenticated: boolean;
  authedPubkey: string | null;
}

// ---------------------------------------------------------------------------
// Mock relay
// ---------------------------------------------------------------------------

export class BuzzMockRelay {
  readonly url: string;

  /** Every AUTH event received, in order (across all connections). */
  readonly authEvents: NostrEvent[] = [];
  /** Every EVENT frame's event, in order (retries appear multiple times). */
  readonly published: NostrEvent[] = [];
  readonly reqs: ReqRecord[] = [];
  readonly closes: string[] = [];
  readonly rawFrames: string[] = [];
  readonly connections: MockConnection[] = [];
  /** Challenges issued, one per connection, in order. */
  readonly challenges: string[] = [];

  private readonly wss: WebSocketServer;
  private readonly options: BuzzMockOptions;
  private stored: NostrEvent[];

  private okScript: ScriptedOk[] = [];
  private authScript: ScriptedOk[] = [];
  private closedScript = new Map<string, string>();
  private readonly persistentClosed = new Set<string>();
  private eventResponder:
    | ((
        event: NostrEvent,
        ctx: EventContext,
      ) => ScriptedOk | typeof NO_ACK | undefined)
    | null = null;
  private authResponder:
    ((event: NostrEvent, ctx: AuthContext) => ScriptedOk | undefined) | null =
    null;

  private readonly eventCounts = new Map<string, number>();
  private heldAuth: Array<() => void> = [];
  private holdAuthOk: boolean;
  private eoseSuppressed = false;

  /** Open subscriptions, for pushing newly accepted events (live delivery). */
  private readonly liveSubs: Array<{
    conn: MockConnection;
    subId: string;
    filters: NostrFilter[];
  }> = [];
  /** Key the synthesized relay-signed 39000/39002 events are signed with. */
  private readonly relayKey = generateSecretKey();
  /** Channel lifecycle state, only used when `channelAware` is on. */
  private readonly channels = new Map<
    string,
    { name: string; about: string; members: Set<string>; createdAt: number }
  >();

  private constructor(
    wss: WebSocketServer,
    url: string,
    options: BuzzMockOptions,
  ) {
    this.wss = wss;
    this.url = url;
    this.options = options;
    this.stored = options.stored ? [...options.stored] : [];
    this.holdAuthOk = options.holdAuthOk ?? false;
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  static async start(options: BuzzMockOptions = {}): Promise<BuzzMockRelay> {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      autoPong: options.autoPong ?? true,
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const address = wss.address() as AddressInfo;
    return new BuzzMockRelay(wss, `ws://127.0.0.1:${address.port}`, options);
  }

  // -- scripting ------------------------------------------------------------

  /** Queue OK responses for the next EVENT frames (default is OK-true). */
  scriptOk(...responses: ScriptedOk[]): this {
    this.okScript.push(...responses);
    return this;
  }

  /** Queue OK responses for the next AUTH frames (default is OK-true). */
  scriptAuth(...responses: ScriptedOk[]): this {
    this.authScript.push(...responses);
    return this;
  }

  /**
   * Respond to the REQ with sub id `subId` with `["CLOSED", subId, message]`.
   * One-shot by default; `persistent` closes every re-issue of the same sub.
   */
  scriptClosed(subId: string, message: string, persistent = false): this {
    this.closedScript.set(subId, message);
    if (persistent) this.persistentClosed.add(subId);
    return this;
  }

  /**
   * Full control over EVENT replies; return undefined to fall back to the
   * queue, or {@link NO_ACK} to accept the frame but send no OK at all.
   */
  onEvent(
    fn: (
      event: NostrEvent,
      ctx: EventContext,
    ) => ScriptedOk | typeof NO_ACK | undefined,
  ): this {
    this.eventResponder = fn;
    return this;
  }

  /** Full control over AUTH replies; return undefined for default handling. */
  onAuth(
    fn: (event: NostrEvent, ctx: AuthContext) => ScriptedOk | undefined,
  ): this {
    this.authResponder = fn;
    return this;
  }

  setStored(events: NostrEvent[]): this {
    this.stored = [...events];
    return this;
  }

  /** Answer REQs with events but no EOSE (query-timeout tests). */
  suppressEose(value = true): this {
    this.eoseSuppressed = value;
    return this;
  }

  /** Release AUTH OKs withheld by `holdAuthOk`, and stop withholding. */
  releaseAuth(): void {
    this.holdAuthOk = false;
    const held = this.heldAuth;
    this.heldAuth = [];
    for (const release of held) release();
  }

  // -- inspection -----------------------------------------------------------

  /** Challenge tags carried by every AUTH event received. */
  authChallenges(): string[] {
    return this.authEvents.map(
      (e) => e.tags.find((t) => t[0] === "challenge")?.[1] ?? "",
    );
  }

  /** Relay tags carried by every AUTH event received. */
  authRelayTags(): string[] {
    return this.authEvents.map(
      (e) => e.tags.find((t) => t[0] === "relay")?.[1] ?? "",
    );
  }

  publishedIds(): string[] {
    return this.published.map((e) => e.id);
  }

  /** Every event the relay has accepted and stored (channel-aware mode). */
  storedEvents(): NostrEvent[] {
    return [...this.stored];
  }

  /** UUIDs of every channel created through a kind:9007. */
  channelIds(): string[] {
    return [...this.channels.keys()];
  }

  /** Members of a channel (relay-side view). */
  channelMembers(channelId: string): string[] {
    return [...(this.channels.get(channelId)?.members ?? [])];
  }

  /**
   * Inject an event as if another member had published it: store it and push it
   * to every matching live subscription (mention delivery).
   */
  deliver(event: NostrEvent): void {
    this.stored.push(event);
    this.broadcast(event);
  }

  /** Number of times an event id was pushed over the wire (retry counting). */
  sendCount(eventId: string): number {
    return this.published.filter((e) => e.id === eventId).length;
  }

  // -- control --------------------------------------------------------------

  /** Hard-drop every open connection (reconnect / resubscribe tests). */
  dropConnections(): void {
    for (const conn of this.connections) {
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.terminate();
    }
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      try {
        conn.socket.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // -- protocol -------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    const challenge = randomBytes(32).toString("hex");
    const conn: MockConnection = {
      socket,
      challenge,
      authenticated: false,
      authedPubkey: null,
    };
    this.connections.push(conn);
    this.challenges.push(challenge);

    socket.on("message", (data) => {
      this.onFrame(conn, data.toString());
    });
    // Proactive AUTH: the relay speaks first (connection.rs:157).
    if (this.options.withholdAuthChallenge !== true) {
      this.send(conn, ["AUTH", challenge]);
    }
  }

  private send(conn: MockConnection, payload: unknown): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify(payload));
  }

  private onFrame(conn: MockConnection, raw: string): void {
    this.rawFrames.push(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(conn, ["NOTICE", "invalid json"]);
      return;
    }
    if (!Array.isArray(parsed)) return;
    const arr = parsed as unknown[];
    switch (arr[0]) {
      case "AUTH":
        this.handleAuth(conn, arr[1] as NostrEvent);
        return;
      case "EVENT":
        this.handleEvent(conn, arr[1] as NostrEvent);
        return;
      case "REQ":
        this.handleReq(conn, arr);
        return;
      case "CLOSE":
        this.closes.push(String(arr[1]));
        this.closeSub(conn, String(arr[1]));
        return;
      default:
        return;
    }
  }

  private handleAuth(conn: MockConnection, event: NostrEvent): void {
    this.authEvents.push(event);
    const validationError = validateAuthEvent(event, conn.challenge);
    const ctx: AuthContext = {
      index: this.authEvents.length,
      connection: conn,
      challenge: conn.challenge,
      ...(validationError ? { validationError } : {}),
    };

    let response =
      this.authResponder?.(event, ctx) ?? this.authScript.shift() ?? undefined;
    if (!response) {
      response = validationError
        ? { ok: false, message: `auth-required: ${validationError}` }
        : { ok: true, message: "" };
    }
    const emit = () => {
      // Only counts as authenticated once the OK is actually on the wire, so a
      // withheld OK (holdAuthOk) still gates EVENT/REQ like the real relay.
      if (response.ok) {
        conn.authenticated = true;
        conn.authedPubkey = event.pubkey;
      }
      this.send(conn, ["OK", event.id, response.ok, response.message]);
    };
    if (this.holdAuthOk) this.heldAuth.push(emit);
    else emit();
  }

  private handleEvent(conn: MockConnection, event: NostrEvent): void {
    this.published.push(event);
    const attempt = (this.eventCounts.get(event.id) ?? 0) + 1;
    this.eventCounts.set(event.id, attempt);

    if ((this.options.requireAuth ?? true) && !conn.authenticated) {
      this.send(conn, ["OK", event.id, false, OK_MESSAGES.AUTH_REQUIRED]);
      return;
    }

    const ctx: EventContext = {
      index: this.published.length,
      attempt,
      connection: conn,
    };
    const scripted = this.eventResponder?.(event, ctx) ?? this.okScript.shift();
    if (scripted === NO_ACK) return; // relay accepts the frame but never OKs it
    const channelAware = this.options.channelAware ?? false;
    const response =
      scripted ??
      (channelAware
        ? this.applyChannelRules(event)
        : { ok: true, message: "" });

    this.send(conn, ["OK", event.id, response.ok, response.message]);

    if (channelAware && response.ok && scripted === undefined) {
      // The relay stores what it accepts; live subs see it immediately.
      if (event.kind !== 9007 && event.kind !== 9021) this.deliver(event);
    }
  }

  /**
   * Channel lifecycle the real relay implements (spec §3 / ingest.rs): a
   * client-supplied `["h",uuid]` on a 9007 is what makes the create race
   * detectable, and the relay-signed 39000/39002 events are the only way a
   * client can discover a channel or its membership.
   */
  private applyChannelRules(event: NostrEvent): ScriptedOk {
    const h = event.tags.find((t) => t[0] === "h")?.[1];

    if (event.kind === 9007) {
      if (!h) return { ok: false, message: "invalid: missing h tag" };
      if (this.channels.has(h)) {
        return { ok: false, message: OK_MESSAGES.DUPLICATE_CHANNEL_EXISTS };
      }
      const name = event.tags.find((t) => t[0] === "name")?.[1] ?? "";
      if (name.length === 0) {
        return { ok: false, message: "invalid: channel name is required" };
      }
      this.channels.set(h, {
        name,
        about: event.tags.find((t) => t[0] === "about")?.[1] ?? "",
        members: new Set([event.pubkey]),
        createdAt: event.created_at,
      });
      this.syncChannelEvents(h);
      return { ok: true, message: "" };
    }

    if (event.kind === 9021) {
      if (!h || !this.channels.has(h)) {
        return { ok: false, message: OK_MESSAGES.INVALID_CHANNEL_NOT_FOUND };
      }
      this.channels.get(h)?.members.add(event.pubkey);
      this.syncChannelEvents(h);
      return { ok: true, message: "" };
    }

    if (event.kind === 9) {
      if (!h || !this.channels.has(h)) {
        return { ok: false, message: OK_MESSAGES.INVALID_CHANNEL_NOT_FOUND };
      }
      return { ok: true, message: "" };
    }

    return { ok: true, message: "" };
  }

  /** Re-emit the relay-signed 39000 metadata + 39002 member list for a channel. */
  private syncChannelEvents(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.stored = this.stored.filter(
      (e) =>
        !(
          (e.kind === 39000 || e.kind === 39002) &&
          e.tags.find((t) => t[0] === "d")?.[1] === channelId
        ),
    );
    const sign = (kind: number, tags: string[][]): NostrEvent =>
      finalizeEvent(
        { kind, created_at: channel.createdAt, tags, content: "" },
        this.relayKey,
      ) as unknown as NostrEvent;

    this.stored.push(
      sign(39000, [
        ["d", channelId],
        ["name", channel.name],
        ["about", channel.about],
        ["visibility", "open"],
      ]),
      sign(39002, [
        ["d", channelId],
        ...[...channel.members].map((m) => ["p", m]),
      ]),
    );
  }

  /** Push an event to every open subscription whose filters match it. */
  private broadcast(event: NostrEvent): void {
    for (const sub of this.liveSubs) {
      if (sub.conn.socket.readyState !== sub.conn.socket.OPEN) continue;
      if (matchesAny(event, sub.filters)) {
        this.send(sub.conn, ["EVENT", sub.subId, event]);
      }
    }
  }

  private handleReq(conn: MockConnection, arr: unknown[]): void {
    const subId = String(arr[1]);
    const filters = arr.slice(2) as NostrFilter[];
    this.reqs.push({ subId, filters, connection: conn });

    if ((this.options.requireAuth ?? true) && !conn.authenticated) {
      this.send(conn, ["CLOSED", subId, OK_MESSAGES.AUTH_REQUIRED]);
      return;
    }
    const scripted = this.closedScript.get(subId);
    if (scripted !== undefined) {
      if (!this.persistentClosed.has(subId)) this.closedScript.delete(subId);
      this.send(conn, ["CLOSED", subId, scripted]);
      return;
    }
    for (const event of this.selectForReq(filters)) {
      this.send(conn, ["EVENT", subId, event]);
    }
    if (!this.eoseSuppressed) this.send(conn, ["EOSE", subId]);
    // Stays open past EOSE like a real persistent sub, so later events are
    // pushed to it (see `deliver`).
    this.liveSubs.push({ conn, subId, filters });
  }

  /**
   * Relay-faithful REQ selection: each filter's matches are ordered newest-first
   * (created_at desc, id asc as the deterministic tie-break) and truncated to
   * `min(filter.limit, maxEventsPerReq)`, then unioned across filters with id
   * dedupe. This is what lets the footer-recovery `until` walk page correctly —
   * the previous "emit every stored match in insertion order" ignored `limit`,
   * so a single page always returned everything and the walk never ran.
   */
  private selectForReq(filters: NostrFilter[]): NostrEvent[] {
    const serverCap = this.options.maxEventsPerReq ?? Infinity;
    const seen = new Set<string>();
    const out: NostrEvent[] = [];
    const source = filters.length === 0 ? [{}] : filters;
    for (const filter of source as NostrFilter[]) {
      const hits = this.stored
        .filter((e) => matches(e, filter))
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const cap = Math.min(filter.limit ?? Infinity, serverCap);
      for (const event of hits.slice(0, cap)) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        out.push(event);
      }
    }
    return out;
  }

  private closeSub(conn: MockConnection, subId: string): void {
    for (let i = this.liveSubs.length - 1; i >= 0; i--) {
      const sub = this.liveSubs[i];
      if (sub && sub.conn === conn && sub.subId === subId) {
        this.liveSubs.splice(i, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** NIP-42 validation the real relay performs (buzz-auth/src/nip42.rs). */
function validateAuthEvent(
  event: NostrEvent | undefined,
  challenge: string,
): string | undefined {
  if (!event || typeof event !== "object") return "missing auth event";
  if (event.kind !== 22242) return `wrong kind ${event.kind}`;
  const gotChallenge = event.tags.find((t) => t[0] === "challenge")?.[1];
  if (gotChallenge !== challenge) return "challenge mismatch";
  const relay = event.tags.find((t) => t[0] === "relay")?.[1];
  if (!relay) return "missing relay tag";
  const drift = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
  if (drift > 60) return `created_at drift ${drift}s`;
  if (!verifyEvent(event as never)) return "verification failed";
  return undefined;
}

function matchesAny(event: NostrEvent, filters: NostrFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => matches(event, f));
}

function matches(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    const tagValues = event.tags
      .filter((t) => t[0] === name)
      .map((t) => t[1] ?? "");
    if (!tagValues.some((v) => (values as string[]).includes(v))) return false;
  }
  return true;
}

/** Poll `predicate` until true or the timeout elapses. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
