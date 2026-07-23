# nostrwolfe-bridge

A standalone daemon that joins a [Buzz](https://github.com/block/buzz) community as an ordinary member and maintains a **Services channel**: a live mirror of the NostrWolfe public marketplace (kind:38400 capability advertisements on `wss://agents.lightningenable.com`) rendered as chat messages, plus a query desk that answers `@bridge find <query>` mentions in-channel. Listings stay authoritative on the public relay — the Buzz channel is a read-optimized projection. The bridge requires no changes to Buzz, because everything it writes is a kind the relay already accepts.

## Quickstart

```bash
npm install
cp .env.example .env      # set BRIDGE_NSEC at minimum
npm run dev               # or: npm run build && npm start
```

The bridge needs a reachable Buzz relay. For local development, run `just relay` in a Buzz checkout (listens on `ws://localhost:3000`). If that relay has `BUZZ_PUBKEY_ALLOWLIST=true`, add the bridge's pubkey to the `pubkey_allowlist` table before starting.

## Commands

- `@bridge find <query>` — search mirrored listings by category, hashtag, or name.
- `@bridge help` — usage.

## Design

Full design spec, including the wire-level details and the decision tables this implementation follows:
`../nostrwolfe/docs/superpowers/specs/2026-07-23-bridge-agent-design.md`
