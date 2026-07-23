/** Footer-based dedupe recovery from channel history (spec §7). */

import type { IBuzzClient, MirroredMap, RecoveredFooter } from "./types.js";

/** Strict single-message footer parse; null unless the card grammar matches (§7). */
export function parseCardFooter(_event: {
  content: string;
}): RecoveredFooter | null {
  throw new Error("not implemented");
}

/** Page the channel's kind:9 history and rebuild the mirrored dedupe set (§7). */
export function recoverMirroredFromChannel(
  _buzz: IBuzzClient,
  _channelId: string,
  _bridgePubkey: string,
): Promise<MirroredMap> {
  throw new Error("not implemented");
}
