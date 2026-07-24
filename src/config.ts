/** Config loading and validation (spec §1). */

import { config as loadDotenv } from "dotenv";
import { getPublicKey, nip19 } from "nostr-tools";

import type { BridgeIdentity, Config, LogLevel } from "./types.js";

/** Defaults straight from the spec §1 table. */
export const CONFIG_DEFAULTS = {
  BUZZ_RELAY_URL: "ws://localhost:3000",
  WOLFE_RELAY_URL: "wss://agents.lightningenable.com",
  BRIDGE_CHANNEL_NAME: "Services",
  BRIDGE_CHANNEL_ABOUT:
    "NostrWolfe marketplace mirror — public agent service listings",
  MIRROR_CATEGORIES: "",
  MIRROR_MAX_LISTINGS: "200",
  BACKFILL_LIMIT: "100",
  BUZZ_MSGS_PER_MIN: "30",
  STATE_FILE: "./bridge-state.json",
  LOG_LEVEL: "info",
} as const;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * The relay enforces 60 msgs/min for identities without a NIP-OA owner
 * attestation (spec §2), so a self-imposed budget above that is guaranteed to
 * run into `rate-limited:` rejections rather than avoid them.
 */
const MAX_BUZZ_MSGS_PER_MIN = 60;

const HEX64 = /^[0-9a-f]{64}$/i;

/** Outcome of pure (non-exiting) config validation. */
export interface ConfigValidation {
  /** Fully resolved config, or `null` when `errors` is non-empty. */
  config: Config | null;
  /** One human-readable line per invalid/missing var; empty when valid. */
  errors: string[];
}

function pick(
  env: NodeJS.ProcessEnv,
  key: keyof typeof CONFIG_DEFAULTS,
): string {
  const raw = env[key];
  if (raw === undefined) return CONFIG_DEFAULTS[key];
  const trimmed = raw.trim();
  // An explicitly-empty var falls back to the default, except where empty is
  // itself meaningful (MIRROR_CATEGORIES, whose default is empty anyway).
  return trimmed === "" ? CONFIG_DEFAULTS[key] : trimmed;
}

function validateRelayUrl(
  value: string,
  name: string,
  errors: string[],
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${name}: not a valid URL (got ${JSON.stringify(value)})`);
    return value;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    errors.push(
      `${name}: must be a ws:// or wss:// URL (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function validatePositiveInt(
  value: string,
  name: string,
  errors: string[],
  opts: { max?: number; maxHint?: string } = {},
): number {
  if (!/^\d+$/.test(value)) {
    errors.push(
      `${name}: must be a positive integer (got ${JSON.stringify(value)})`,
    );
    return 0;
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    errors.push(
      `${name}: must be a positive integer (got ${JSON.stringify(value)})`,
    );
    return 0;
  }
  if (opts.max !== undefined && n > opts.max) {
    errors.push(
      `${name}: must be <= ${String(opts.max)}${
        opts.maxHint === undefined ? "" : ` (${opts.maxHint})`
      } (got ${JSON.stringify(value)})`,
    );
    return 0;
  }
  return n;
}

/** Parse `MIRROR_CATEGORIES` CSV: trimmed, de-duped, empties dropped. */
export function parseCategories(csv: string): string[] {
  const out: string[] = [];
  for (const part of csv.split(",")) {
    const c = part.trim();
    if (c !== "" && !out.includes(c)) out.push(c);
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Derive the signing identity from `BRIDGE_NSEC` (bech32 nsec or 64-hex).
 * Throws on anything else. The secret is never logged or persisted (§security 1).
 */
export function resolveIdentity(bridgeNsec: string): BridgeIdentity {
  const raw = bridgeNsec.trim();
  let secretKey: Uint8Array;

  if (HEX64.test(raw)) {
    secretKey = hexToBytes(raw.toLowerCase());
  } else if (raw.toLowerCase().startsWith("nsec1")) {
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(raw.toLowerCase());
    } catch {
      // Never echo the (possibly partially valid) secret material.
      throw new Error("BRIDGE_NSEC: malformed bech32 nsec");
    }
    if (decoded.type !== "nsec") {
      throw new Error(
        `BRIDGE_NSEC: expected an nsec, got a ${decoded.type} bech32 entity`,
      );
    }
    secretKey = decoded.data;
  } else {
    throw new Error(
      "BRIDGE_NSEC: expected a bech32 nsec1… or 64-hex secret key",
    );
  }

  if (secretKey.length !== 32) {
    throw new Error("BRIDGE_NSEC: secret key must be 32 bytes");
  }

  let publicKey: string;
  try {
    publicKey = getPublicKey(secretKey);
  } catch {
    // e.g. a 32-byte value outside the secp256k1 scalar range.
    throw new Error("BRIDGE_NSEC: not a valid secp256k1 secret key");
  }

  return { secretKey, publicKey };
}

/**
 * Pure validation: resolve defaults, validate every var, and collect **all**
 * problems rather than failing on the first (spec §1: "exits with a clear
 * message on missing/invalid values" — one message listing everything).
 */
export function validateConfig(env: NodeJS.ProcessEnv): ConfigValidation {
  const errors: string[] = [];

  const nsecRaw = env.BRIDGE_NSEC?.trim() ?? "";
  if (nsecRaw === "") {
    errors.push(
      "BRIDGE_NSEC: required — set a bech32 nsec1… or 64-hex secret key",
    );
  } else {
    try {
      // Validate now so a bad key is reported alongside every other problem;
      // the value itself is never included in the error (§security 1).
      resolveIdentity(nsecRaw);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const buzzRelayUrl = validateRelayUrl(
    pick(env, "BUZZ_RELAY_URL"),
    "BUZZ_RELAY_URL",
    errors,
  );
  const wolfeRelayUrl = validateRelayUrl(
    pick(env, "WOLFE_RELAY_URL"),
    "WOLFE_RELAY_URL",
    errors,
  );

  // `pick` maps a blank override back to the default, which keeps
  // BRIDGE_CHANNEL_NAME non-empty — buzz-relay rejects a 9007 without a
  // non-empty `name` tag (§3).
  const channelName = pick(env, "BRIDGE_CHANNEL_NAME");
  const channelAbout = pick(env, "BRIDGE_CHANNEL_ABOUT");

  const mirrorCategories = parseCategories(
    env.MIRROR_CATEGORIES ?? CONFIG_DEFAULTS.MIRROR_CATEGORIES,
  );

  const mirrorMaxListings = validatePositiveInt(
    pick(env, "MIRROR_MAX_LISTINGS"),
    "MIRROR_MAX_LISTINGS",
    errors,
  );
  const backfillLimit = validatePositiveInt(
    pick(env, "BACKFILL_LIMIT"),
    "BACKFILL_LIMIT",
    errors,
  );
  const buzzMsgsPerMin = validatePositiveInt(
    pick(env, "BUZZ_MSGS_PER_MIN"),
    "BUZZ_MSGS_PER_MIN",
    errors,
    {
      max: MAX_BUZZ_MSGS_PER_MIN,
      maxHint: "the relay caps non-owner-attested identities at 60 msgs/min",
    },
  );

  const stateFile = pick(env, "STATE_FILE");

  const logLevelRaw = pick(env, "LOG_LEVEL").toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    errors.push(
      `LOG_LEVEL: must be one of ${LOG_LEVELS.join(" | ")} (got ${JSON.stringify(
        logLevelRaw,
      )})`,
    );
  }

  if (errors.length > 0) return { config: null, errors };

  return {
    config: {
      bridgeNsec: nsecRaw,
      buzzRelayUrl,
      wolfeRelayUrl,
      channelName,
      channelAbout,
      mirrorCategories,
      mirrorMaxListings,
      backfillLimit,
      buzzMsgsPerMin,
      stateFile,
      logLevel: logLevelRaw as LogLevel,
    },
    errors: [],
  };
}

/** Render the collected validation errors as one operator-facing message. */
export function formatConfigErrors(errors: string[]): string {
  return [
    `nostrwolfe-bridge: ${String(errors.length)} configuration problem${
      errors.length === 1 ? "" : "s"
    }:`,
    ...errors.map((e) => `  - ${e}`),
    "See .env.example for every supported variable and its default.",
  ].join("\n");
}

/**
 * Load `.env`, validate every var, and return the resolved config.
 *
 * On any invalid/missing value this prints **all** problems at once and
 * `process.exit(1)`s — a daemon with a half-valid config is worse than one
 * that refuses to start.
 *
 * `.env` is only read when no explicit `env` is supplied, so callers (and
 * tests) that pass their own environment stay hermetic.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) {
    loadDotenv();
  }

  const { config, errors } = validateConfig(env);
  if (config === null) {
    process.stderr.write(`${formatConfigErrors(errors)}\n`);
    process.exit(1);
  }
  return config;
}
