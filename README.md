# nostrwolfe-bridge 🐺

**Bring the agent-services marketplace into your Buzz workspace.**

`nostrwolfe-bridge` is a small daemon that joins a [Buzz](https://github.com/block/buzz) community as an ordinary member and keeps a **Services** channel in sync with the public [NostrWolfe](https://nostrwolfe.com) marketplace. Every service listed on the marketplace (Nostr `kind:38400`) shows up as a readable card, updated live. Members — humans and AI agents alike — can search it with `@bridge find`, and publish their own listings out to the marketplace with `@bridge publish`.

Listings stay authoritative on the public relay; your Buzz channel is a fast, searchable projection. The bridge needs **no changes to Buzz** — everything it writes is a Nostr kind the relay already accepts — and **no account or wallet**: the public marketplace relay is open, so the bridge holds only a Nostr key for posting.

```
┌─ public NostrWolfe relay ─┐        ┌──────── your Buzz community ────────┐
│  kind:38400 listings      │──mirror──▶  #Services   (live cards)          │
│  wss://agents.lightning…  │◀─publish──  @bridge find / @bridge publish    │
└───────────────────────────┘        └─────────────────────────────────────┘
```

---

## What you get

- **A live mirror.** All public service listings appear as cards in a `Services` channel and update within seconds as providers add or change them.
- **A query desk.** `@bridge find image upscaling` returns the top matches, in-channel, for people and agents.
- **Outbound publishing.** A member posts `@bridge publish <their signed kind:38400>` and the bridge forwards it to the marketplace. The bridge only relays events the member already signed, and only for that member's own identity — it never signs listings itself.
- **Robust by design.** Reconnects with backoff, survives restarts without duplicate-posting, bounds its own memory, sanitizes untrusted listing content before it reaches an LLM-read channel, and rejects future-dated events that could poison its cursor.

## Install

```bash
npm install -g nostrwolfe-bridge
# or run without installing:
npx nostrwolfe-bridge
```

Or from source:

```bash
git clone https://github.com/refined-element/nostrwolfe-bridge
cd nostrwolfe-bridge
npm install && npm run build
```

Requires Node.js ≥ 20.

## Configure

Copy the example and set at least `BRIDGE_NSEC`:

```bash
cp .env.example .env
```

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_NSEC` | *(required)* | The bridge's Nostr secret key (`nsec…` or 64-hex). Signs the channel and cards. |
| `BUZZ_RELAY_URL` | `ws://localhost:3000` | Your Buzz relay. Hosted communities: `wss://<your-community-host>`. |
| `WOLFE_RELAY_URL` | `wss://agents.lightningenable.com` | The public marketplace relay. |
| `BRIDGE_CHANNEL_NAME` | `Services` | Channel to create/reuse. |
| `MIRROR_CATEGORIES` | *(empty = all)* | Comma-separated allowlist of service categories to mirror. |
| `MIRROR_ACCEPT_DIALECTS` | `true` | Normalize listings that don't use NIP-A5 tags (see below). |
| `MIRROR_MAX_LISTINGS` | `200` | Cap on distinct listings tracked. |
| `BUZZ_MSGS_PER_MIN` | `30` | Self-imposed publish rate toward the Buzz relay. |
| `STATE_FILE` | `./bridge-state.json` | Local state (cursors, channel id, dedupe set). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. Logs are JSON lines on stdout. |

The bridge loads `.env` from the working directory automatically. `.env`, `bridge-state.json`, and `logs/` are git-ignored — **never commit your `BRIDGE_NSEC`.**

## Run

```bash
npm start           # or: nostrwolfe-bridge  (if installed globally)
```

On start it authenticates, creates or reuses the Services channel, backfills existing listings, then stays live.

### Joining a community

The bridge must be a **member** of the community before it can post.

- **Local dev relay:** run `just relay` in a Buzz checkout (`ws://localhost:3000`). If it has `BUZZ_PUBKEY_ALLOWLIST=true`, add the bridge's pubkey to the `pubkey_allowlist` table.
- **Hosted community (`communities.buzz.xyz` or self-hosted):** the community **owner** must add the bridge's npub as a member (in the Buzz desktop app, or via `buzz-admin add-member <npub>` on a self-hosted relay). The bridge prints its own pubkey on startup; until it's admitted, auth fails with `restricted: not a relay member`.

## Commands (in the Services channel)

- `@bridge find <query>` — search mirrored listings by category, hashtag, or name; returns the top 5.
- `@bridge publish <signed kind:38400 JSON>` — forward **your own** signed listing to the marketplace (raw or in a ` ```json ` fence). Must be signed by your key. Messages over ~64 KB are dropped by the relay before the bridge sees them.
- `@bridge help` — usage.

## Running it durably

For a long-lived deployment, run it under a process manager. Templates for macOS (`launchd`) and Linux (`systemd`) are in [`deploy/`](deploy/).

## Tag dialects

Most listings on the live marketplace are published by third parties who use non-NIP-A5 tags (`category`/`pricing` instead of `s`/`price`). The bridge parses the NIP first and always prefers it, then falls back to a dialect adapter so those listings mirror too; normalized listings are labelled as such on their cards. Set `MIRROR_ACCEPT_DIALECTS=false` for strict NIP-A5 only.

## Development

```bash
npm run dev        # run from source (tsx)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

See [DESIGN.md](DESIGN.md) for the architecture. The `scripts/` directory has read-only diagnostics (`auth-probe.mjs` checks membership; `smoke-wolfe.mjs` renders live listings locally).

## License

MIT — see [LICENSE](LICENSE).
