# Architecture

A single Node process with two WebSocket connections: one to the **public marketplace relay** (read, plus member-initiated publishes) and one to a **Buzz community relay** (authenticated read/write). No database — a flat JSON state file plus the channel history itself.

```
 wolfe relay ──kind:38400──▶ WolfeSubscriber ─▶ MirrorEngine ─▶ cards ─▶ BuzzClient ─▶ Buzz relay
 (public)      (hydrate+live)                 (dedupe/format)                (NIP-42)     #Services
      ▲                                                                                     │
      └────────────── OutboundPublisher ◀── QueryResponder ◀── @bridge mentions ◀───────────┘
                       (@bridge publish)      (find / help)
```

## Components (`src/`)

- **config.ts** — load + validate env; derive the signing identity from `BRIDGE_NSEC`.
- **buzz-client.ts** — the authenticated Buzz socket: NIP-42 proactive-AUTH handshake, rate-limited publish with OK tracking and the full relay error matrix, subscriptions that resubscribe on reconnect, a keepalive watchdog, and a bounded publish queue.
- **wolfe-subscriber.ts** — the public relay socket: full paged hydration on every startup, then a live subscription; reconnect gap-draining; treats a relay `CLOSED` as a failure to retry, not an empty result.
- **mirror-engine.ts** — the core: validate (BIP-340 + required tags), the dedupe/replace decision table, and card rendering. Rebuilds the in-memory cache on every restart.
- **dialect.ts** — normalizes non-NIP-A5 listings (`category`/`pricing` → `s`/`price`). NIP-A5 is always tried first.
- **sanitize.ts** — the shared hardening for untrusted listing text rendered into an LLM-read channel: strips invisible/bidi/confusable codepoints, cuts the bridge's own command grammar, rejects forged card chrome and footers. Codepoint-safe, idempotent.
- **channel-manager.ts** — discover / create / join the Services channel; a deterministic UUIDv5 keyed on the bridge pubkey + channel name makes create races converge.
- **query-responder.ts** — answers `@bridge find` / `help` / `publish` mentions; staleness cutoff, per-sender cooldown, reconnect-replay dedupe.
- **outbound-publisher.ts** — validates a member's pre-signed `kind:38400` (re-verifies the signature on a clean copy, requires `event.pubkey === author`, freshness, required tags) and forwards it to the public relay with a bounded OK timeout.
- **footer-recovery.ts** — rebuilds the dedupe set from card footers in channel history when the state file is lost.
- **state-store.ts** — atomic, debounced JSON persistence; full reset on a community mismatch.
- **index.ts** — wiring + startup ordering (AUTH → channel → recovery → hydrate → live subs).

## Invariants worth knowing

- **The bridge signs nothing on the marketplace.** Mirror cards are Buzz messages; the only marketplace writes are members' own pre-signed events, forwarded verbatim.
- **One string for identity.** A listing's address, its card header, its machine footer (`nw:38400:<pubkey>:<d>`), and the dedupe key are all derived from one normalization, so footer-based recovery always matches the live path.
- **At-least-once, deduped.** A crash between posting a card and flushing state can re-post at most a couple of cards; the address-keyed footer makes duplicates recoverable, and NIP-33 replacement makes re-publishes idempotent.
- **Untrusted in, sanitized out.** Everything from the public relay is treated as hostile before it reaches the channel.

## Testing

`npm test` runs the vitest suite (unit + mock-relay integration, including adversarial sanitizer and validation cases). The mocks in `test/mocks/` model the two relays' wire behavior, including the exact error strings the code branches on.
