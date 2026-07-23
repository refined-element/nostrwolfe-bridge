/** MirrorEngine — decision table, card formatting, sanitization (spec §5). */

import type {
  CardKind,
  Config,
  IBuzzClient,
  IListingCache,
  IMirrorEngine,
  IStateStore,
  MirrorOutcome,
  NostrEvent,
  ParsedListing,
} from "./types.js";

/** Parse and validate a raw kind:38400 into a {@link ParsedListing} (§5 step 1-2). */
export function parseListing(_event: NostrEvent): ParsedListing | null {
  throw new Error("not implemented");
}

/** Render a card body for the given listing and header kind (§5 step 4). */
export function formatCard(_listing: ParsedListing, _kind: CardKind): string {
  throw new Error("not implemented");
}

export class MirrorEngine implements IMirrorEngine {
  constructor(
    _config: Config,
    _buzz: IBuzzClient,
    _cache: IListingCache,
    _state: IStateStore,
    _getChannelId: () => string,
  ) {
    void _config;
    void _buzz;
    void _cache;
    void _state;
    void _getChannelId;
  }

  handleListing(_event: NostrEvent): Promise<MirrorOutcome> {
    throw new Error("not implemented");
  }
}
