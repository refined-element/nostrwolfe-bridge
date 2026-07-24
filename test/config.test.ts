import { describe, expect, it, vi, afterEach } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import {
  CONFIG_DEFAULTS,
  formatConfigErrors,
  loadConfig,
  parseCategories,
  resolveIdentity,
  validateConfig,
} from "../src/config.js";

const SK = generateSecretKey();
const HEX = Buffer.from(SK).toString("hex");
const NSEC = nip19.nsecEncode(SK);
const PUBKEY = getPublicKey(SK);
/**
 * A one-character mutation of NSEC, which always breaks the bech32 checksum.
 * The replacement char must differ from the original, or the "flipped" fixture
 * is silently the unmodified (valid) nsec.
 */
const FLIPPED_NSEC = `${NSEC.slice(0, -1)}${NSEC.endsWith("q") ? "p" : "q"}`;

/** Minimum viable environment: only BRIDGE_NSEC is required (spec §1). */
function env(overrides: Record<string, string | undefined> = {}) {
  return { BRIDGE_NSEC: NSEC, ...overrides } as NodeJS.ProcessEnv;
}

function ok(overrides: Record<string, string | undefined> = {}) {
  const { config, errors } = validateConfig(env(overrides));
  expect(errors).toEqual([]);
  if (config === null) throw new Error("expected a config");
  return config;
}

function errorsFor(overrides: Record<string, string | undefined>): string[] {
  const { config, errors } = validateConfig(env(overrides));
  expect(config).toBeNull();
  return errors;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveIdentity — BRIDGE_NSEC parsing (spec §1)", () => {
  it("accepts a bech32 nsec and derives the pubkey", () => {
    const id = resolveIdentity(NSEC);
    expect(id.publicKey).toBe(PUBKEY);
    expect(id.secretKey).toBeInstanceOf(Uint8Array);
    expect(id.secretKey).toHaveLength(32);
  });

  it("accepts 64-hex and derives the same pubkey", () => {
    expect(resolveIdentity(HEX).publicKey).toBe(PUBKEY);
  });

  it("accepts uppercase hex and surrounding whitespace", () => {
    expect(resolveIdentity(`  ${HEX.toUpperCase()}  `).publicKey).toBe(PUBKEY);
  });

  it("accepts an uppercase nsec (bech32 is case-insensitive)", () => {
    expect(resolveIdentity(NSEC.toUpperCase()).publicKey).toBe(PUBKEY);
  });

  it.each([
    ["empty", ""],
    ["63-hex (too short)", HEX.slice(0, 63)],
    ["65-hex (too long)", `${HEX}a`],
    ["non-hex chars", `${HEX.slice(0, 63)}z`],
    ["a plain word", "hunter2"],
    ["a truncated nsec", NSEC.slice(0, 20)],
    ["an nsec with a flipped char (bad checksum)", FLIPPED_NSEC],
  ])("rejects %s", (_label, value) => {
    expect(() => resolveIdentity(value)).toThrow(/BRIDGE_NSEC/);
  });

  it("rejects a valid bech32 entity that is not an nsec", () => {
    expect(() => resolveIdentity(nip19.npubEncode(PUBKEY))).toThrow(
      /BRIDGE_NSEC/,
    );
  });

  it("never echoes secret material in its error message", () => {
    const nearMiss = FLIPPED_NSEC;
    let message = "";
    try {
      resolveIdentity(nearMiss);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(nearMiss);
    expect(message).not.toContain(nearMiss.slice(5, 30));
  });
});

describe("validateConfig — defaults (spec §1 table)", () => {
  it("applies every documented default when only BRIDGE_NSEC is set", () => {
    expect(ok()).toEqual({
      bridgeNsec: NSEC,
      buzzRelayUrl: "ws://localhost:3000",
      wolfeRelayUrl: "wss://agents.lightningenable.com",
      channelName: "Services",
      channelAbout:
        "NostrWolfe marketplace mirror — public agent service listings",
      mirrorCategories: [],
      mirrorMaxListings: 200,
      backfillLimit: 100,
      buzzMsgsPerMin: 30,
      stateFile: "./bridge-state.json",
      logLevel: "info",
    });
  });

  it("keeps the .env.example defaults in sync with the spec table", () => {
    expect(CONFIG_DEFAULTS.BUZZ_RELAY_URL).toBe("ws://localhost:3000");
    expect(CONFIG_DEFAULTS.WOLFE_RELAY_URL).toBe(
      "wss://agents.lightningenable.com",
    );
    expect(CONFIG_DEFAULTS.MIRROR_MAX_LISTINGS).toBe("200");
    expect(CONFIG_DEFAULTS.BACKFILL_LIMIT).toBe("100");
    expect(CONFIG_DEFAULTS.BUZZ_MSGS_PER_MIN).toBe("30");
  });

  it("falls back to the default when a var is present but blank", () => {
    expect(ok({ BUZZ_RELAY_URL: "   ", LOG_LEVEL: "" }).buzzRelayUrl).toBe(
      "ws://localhost:3000",
    );
  });

  it("accepts hex for BRIDGE_NSEC and overridden values throughout", () => {
    const cfg = ok({
      BRIDGE_NSEC: HEX,
      BUZZ_RELAY_URL: "wss://community.example.com",
      WOLFE_RELAY_URL: "ws://127.0.0.1:7777",
      BRIDGE_CHANNEL_NAME: "Marketplace",
      BRIDGE_CHANNEL_ABOUT: "custom about",
      MIRROR_CATEGORIES: "translation, imaging",
      MIRROR_MAX_LISTINGS: "1",
      BACKFILL_LIMIT: "500",
      BUZZ_MSGS_PER_MIN: "60",
      STATE_FILE: "/var/lib/bridge/state.json",
      LOG_LEVEL: "DEBUG",
    });
    expect(cfg).toMatchObject({
      bridgeNsec: HEX,
      buzzRelayUrl: "wss://community.example.com",
      wolfeRelayUrl: "ws://127.0.0.1:7777",
      channelName: "Marketplace",
      channelAbout: "custom about",
      mirrorCategories: ["translation", "imaging"],
      mirrorMaxListings: 1,
      backfillLimit: 500,
      buzzMsgsPerMin: 60,
      stateFile: "/var/lib/bridge/state.json",
      logLevel: "debug",
    });
  });
});

describe("parseCategories — MIRROR_CATEGORIES CSV", () => {
  it.each([
    ["", []],
    ["   ", []],
    [",,,", []],
    ["a", ["a"]],
    ["a,b", ["a", "b"]],
    [" a , b ,, c ", ["a", "b", "c"]],
    ["a,a,b", ["a", "b"]],
  ])("parses %j", (csv, expected) => {
    expect(parseCategories(csv)).toEqual(expected);
  });
});

describe("validateConfig — validation matrix", () => {
  it("reports a missing BRIDGE_NSEC", () => {
    const { config, errors } = validateConfig({} as NodeJS.ProcessEnv);
    expect(config).toBeNull();
    expect(errors).toEqual([
      expect.stringMatching(/^BRIDGE_NSEC: required/) as unknown as string,
    ]);
  });

  it.each([
    ["BRIDGE_NSEC", "not-a-key"],
    ["BUZZ_RELAY_URL", "http://localhost:3000"],
    ["BUZZ_RELAY_URL", "localhost:3000"],
    ["WOLFE_RELAY_URL", "https://agents.lightningenable.com"],
    ["MIRROR_MAX_LISTINGS", "0"],
    ["MIRROR_MAX_LISTINGS", "-5"],
    ["MIRROR_MAX_LISTINGS", "12.5"],
    ["MIRROR_MAX_LISTINGS", "lots"],
    ["BACKFILL_LIMIT", "0"],
    ["BACKFILL_LIMIT", "abc"],
    ["BUZZ_MSGS_PER_MIN", "0"],
    ["BUZZ_MSGS_PER_MIN", "1e3"],
    ["LOG_LEVEL", "verbose"],
    ["LOG_LEVEL", "trace"],
  ])("rejects %s=%j", (name, value) => {
    const errors = errorsFor({ [name]: value });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(name);
  });

  it("rejects BUZZ_MSGS_PER_MIN above the relay's 60/min ceiling (§2)", () => {
    const errors = errorsFor({ BUZZ_MSGS_PER_MIN: "120" });
    expect(errors[0]).toContain("BUZZ_MSGS_PER_MIN");
    expect(errors[0]).toContain("60");
  });

  it("never yields an empty channel name (9007 requires a name tag, §3)", () => {
    expect(ok({ BRIDGE_CHANNEL_NAME: "  " }).channelName).toBe("Services");
    expect(ok({ BRIDGE_CHANNEL_NAME: "" }).channelName).toBe("Services");
    expect(ok({ STATE_FILE: "" }).stateFile).toBe("./bridge-state.json");
  });

  it("reports every problem at once rather than failing on the first", () => {
    const errors = errorsFor({
      BRIDGE_NSEC: "nope",
      BUZZ_RELAY_URL: "http://x",
      WOLFE_RELAY_URL: "!!!",
      MIRROR_MAX_LISTINGS: "-1",
      BACKFILL_LIMIT: "zero",
      BUZZ_MSGS_PER_MIN: "9999",
      LOG_LEVEL: "loud",
    });
    expect(errors).toHaveLength(7);
    for (const name of [
      "BRIDGE_NSEC",
      "BUZZ_RELAY_URL",
      "WOLFE_RELAY_URL",
      "MIRROR_MAX_LISTINGS",
      "BACKFILL_LIMIT",
      "BUZZ_MSGS_PER_MIN",
      "LOG_LEVEL",
    ]) {
      expect(errors.some((e) => e.startsWith(name))).toBe(true);
    }
  });
});

describe("formatConfigErrors", () => {
  it("renders one bullet per problem plus a pointer to .env.example", () => {
    const text = formatConfigErrors(["A: bad", "B: worse"]);
    expect(text).toContain("2 configuration problems");
    expect(text).toContain("  - A: bad");
    expect(text).toContain("  - B: worse");
    expect(text).toContain(".env.example");
  });

  it("uses the singular form for one problem", () => {
    expect(formatConfigErrors(["A: bad"])).toContain(
      "1 configuration problem:",
    );
  });
});

describe("loadConfig", () => {
  it("returns the config for a valid explicit environment", () => {
    expect(loadConfig(env()).logLevel).toBe("info");
  });

  it("exits(1) after printing every problem at once", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(() =>
      loadConfig({ LOG_LEVEL: "shout" } as NodeJS.ProcessEnv),
    ).toThrow("exit:1");

    expect(exit).toHaveBeenCalledWith(1);
    const printed = String(write.mock.calls[0]?.[0] ?? "");
    expect(printed).toContain("BRIDGE_NSEC");
    expect(printed).toContain("LOG_LEVEL");
  });

  it("does not read .env when an explicit environment is supplied", () => {
    // Hermetic: a developer .env in the repo root must not leak into results.
    const cfg = loadConfig(env({ STATE_FILE: "/tmp/explicit-state.json" }));
    expect(cfg.stateFile).toBe("/tmp/explicit-state.json");
  });
});
