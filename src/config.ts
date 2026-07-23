/** Config loading and validation (spec §1). */

import type { BridgeIdentity, Config } from "./types.js";

/** Load `.env`, validate every var, and return the resolved config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  void env;
  throw new Error("not implemented");
}

/** Derive the signing identity from `BRIDGE_NSEC` (bech32 nsec or 64-hex). */
export function resolveIdentity(bridgeNsec: string): BridgeIdentity {
  void bridgeNsec;
  throw new Error("not implemented");
}
