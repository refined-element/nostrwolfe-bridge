/**
 * OutboundPublisher (spec §8, Phase 2) — forwards a member's pre-signed
 * kind:38400 to the public NostrWolfe relay in response to `@bridge publish`.
 *
 * Design: option (a) — relay pre-signed events. The public strfry relay is
 * ungated, so forwarding a member-signed 38400 needs no Lightning Enable
 * account and keeps the member's key sovereignty (their npub owns the listing,
 * and future 38403 reputation accrues to it). The bridge adds a positive
 * control — signature + identity match + freshness — not a bypass of one.
 *
 * The bridge NEVER signs a 38400 itself: it only relays events already signed
 * by the requesting member, and only for that member's own identity.
 */

import { verifyEvent } from "nostr-tools/pure";

import { LISTING_KIND, normalizeDKey } from "./mirror-engine.js";

import type { NostrEvent, OkResult } from "./types.js";

/** ±15 min freshness window (mirrors Buzz's own ±900s drift rule, §8 step 2). */
export const OUTBOUND_FRESHNESS_SECONDS = 900;

/** Default wait for the public relay's OK before giving up (§8 step 3). */
export const OUTBOUND_OK_TIMEOUT_MS = 10_000;

/** A validated, ready-to-forward listing plus its addressable form. */
export interface ValidatedOutbound {
  ok: true;
  event: NostrEvent;
  /** `38400:<pubkey>:<d>` — the address the success reply and mirror card share. */
  address: string;
}

/** A rejected payload with an operator/member-facing reason. */
export interface RejectedOutbound {
  ok: false;
  reason: string;
}

export type OutboundValidation = ValidatedOutbound | RejectedOutbound;

/**
 * Strip an optional Markdown code fence around the payload. Members paste the
 * signed event either raw or fenced (```json … ```); either must parse.
 */
function stripFence(raw: string): string {
  const t = raw.trim();
  const fenced = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/.exec(t);
  return (fenced?.[1] ?? t).trim();
}

/**
 * Validate a member's `@bridge publish` payload against the requesting
 * member's authenticated pubkey (§8 step 2). Returns the event ready to forward
 * or a specific rejection reason — never throws on bad input.
 *
 * `authorPubkey` is the kind:9 author's pubkey, which the Buzz relay has already
 * pinned to the authenticated member, so requiring `event.pubkey === authorPubkey`
 * means a member can only publish a listing for their own identity.
 */
export function validateOutbound(
  rawPayload: string,
  authorPubkey: string,
  nowSeconds: number,
): OutboundValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(rawPayload));
  } catch {
    return { ok: false, reason: "payload is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "payload is not a Nostr event object" };
  }
  const ev = parsed as Partial<NostrEvent>;

  if (ev.kind !== LISTING_KIND) {
    return {
      ok: false,
      reason: `event kind must be ${LISTING_KIND} (got ${String(ev.kind)})`,
    };
  }
  if (
    typeof ev.id !== "string" ||
    typeof ev.pubkey !== "string" ||
    typeof ev.sig !== "string" ||
    typeof ev.content !== "string" ||
    typeof ev.created_at !== "number" ||
    !Array.isArray(ev.tags)
  ) {
    return { ok: false, reason: "event is missing required Nostr fields" };
  }

  // Re-verify a clean 7-field copy: nostr-tools caches an "already verified"
  // symbol on objects, so a hostile object could carry it in and skip BIP-340.
  const plain: NostrEvent = {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  };
  if (!verifyEvent(plain as never)) {
    return { ok: false, reason: "signature verification failed" };
  }

  if (ev.pubkey !== authorPubkey) {
    return {
      ok: false,
      reason:
        "the 38400 must be signed by your own key — its pubkey must match your message author identity",
    };
  }

  const d = normalizeDKey(plain.tags.find((t) => t[0] === "d")?.[1]);
  if (d.length === 0) {
    return { ok: false, reason: "missing required non-empty `d` tag" };
  }
  const hasCategory = plain.tags.some(
    (t) => t[0] === "s" && (t[1] ?? "").trim().length > 0,
  );
  if (!hasCategory) {
    return { ok: false, reason: "at least one `s` (category) tag is required" };
  }
  const hasPrice = plain.tags.some((t) => t[0] === "price" && t.length >= 2);
  if (!hasPrice) {
    return { ok: false, reason: "a `price` tag is required" };
  }

  const drift = Math.abs(nowSeconds - plain.created_at);
  if (drift > OUTBOUND_FRESHNESS_SECONDS) {
    return {
      ok: false,
      reason: `created_at is ${drift}s from now (max ${OUTBOUND_FRESHNESS_SECONDS}s) — re-sign with a current timestamp`,
    };
  }

  return {
    ok: true,
    event: plain,
    address: `${LISTING_KIND}:${ev.pubkey}:${d}`,
  };
}

/** Result of forwarding to the public relay. `timedOut` distinguishes §8 step 3. */
export interface ForwardResult extends OkResult {
  timedOut: boolean;
}

/**
 * Open a short-lived connection to the public relay, send one EVENT, and await
 * its OK (§8 step 3). Ephemeral by design: publishes are member-initiated and
 * rare, and a dedicated socket keeps this path entirely off the subscriber's
 * reconnect state machine. Never rejects — resolves with a typed result.
 */
export async function forwardToWolfe(
  url: string,
  event: NostrEvent,
  opts: {
    timeoutMs?: number;
    WebSocketImpl?: typeof import("ws").WebSocket;
  } = {},
): Promise<ForwardResult> {
  const timeoutMs = opts.timeoutMs ?? OUTBOUND_OK_TIMEOUT_MS;
  const WS = opts.WebSocketImpl ?? (await import("ws")).WebSocket;

  return await new Promise<ForwardResult>((resolve) => {
    const ws = new WS(url);
    let settled = false;
    const finish = (r: ForwardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () =>
        finish({
          id: event.id,
          ok: false,
          timedOut: true,
          message: `no OK within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    // Don't keep the event loop alive on account of a pending publish.
    timer.unref?.();

    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw: import("ws").RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        Array.isArray(msg) &&
        msg[0] === "OK" &&
        msg[1] === event.id &&
        typeof msg[2] === "boolean"
      ) {
        finish({
          id: event.id,
          ok: msg[2],
          timedOut: false,
          message: typeof msg[3] === "string" ? msg[3] : "",
        });
      }
    });
    ws.on("error", (err: Error) =>
      finish({
        id: event.id,
        ok: false,
        timedOut: false,
        message: `connection error: ${err.message}`,
      }),
    );
    // Fail fast if the relay closes the socket without an OK, rather than
    // waiting out the full timeout. Guarded by `settled`, so the close that
    // `finish()` itself triggers on the success path is a no-op.
    ws.on("close", () =>
      finish({
        id: event.id,
        ok: false,
        timedOut: false,
        message: "relay closed the connection before acknowledging",
      }),
    );
  });
}

/**
 * End-to-end handler for one `@bridge publish` payload: validate, forward, and
 * return the exact in-thread reply text (§8 step 4). This is what QueryResponder
 * injects and calls; it owns no bridge identity and signs nothing.
 */
export function makePublishHandler(deps: {
  wolfeRelayUrl: string;
  now?: () => number;
  timeoutMs?: number;
  WebSocketImpl?: typeof import("ws").WebSocket;
}): (payload: string, authorPubkey: string) => Promise<string> {
  const now = deps.now ?? Date.now;
  return async (payload, authorPubkey) => {
    const nowSeconds = Math.floor(now() / 1000);
    const v = validateOutbound(payload, authorPubkey, nowSeconds);
    if (!v.ok) return `Rejected: ${v.reason}.`;

    const result = await forwardToWolfe(deps.wolfeRelayUrl, v.event, {
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.WebSocketImpl === undefined
        ? {}
        : { WebSocketImpl: deps.WebSocketImpl }),
    });
    if (result.timedOut) {
      return "Relay did not acknowledge the publish — it may or may not have been stored; re-send `@bridge publish` to retry.";
    }
    if (!result.ok) {
      return `Relay rejected the listing: ${result.message || "no reason given"}.`;
    }
    return `Published nw:${v.address} — visible on ${deps.wolfeRelayUrl}. It'll appear as a card here shortly.`;
  };
}
