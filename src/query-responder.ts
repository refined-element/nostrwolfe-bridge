/** QueryResponder — answers `@bridge` mentions in the channel (spec §6). */

import type {
  BridgeCommand,
  BridgeIdentity,
  Config,
  IBuzzClient,
  IListingCache,
  IQueryResponder,
  NostrEvent,
  SearchResult,
} from "./types.js";

export class QueryResponder implements IQueryResponder {
  constructor(
    _config: Config,
    _identity: BridgeIdentity,
    _buzz: IBuzzClient,
    _cache: IListingCache,
    _getChannelId: () => string,
  ) {
    void _config;
    void _identity;
    void _buzz;
    void _cache;
    void _getChannelId;
  }

  handleMention(_event: NostrEvent): Promise<void> {
    throw new Error("not implemented");
  }

  parseCommand(_content: string): BridgeCommand {
    throw new Error("not implemented");
  }

  search(_query: string): SearchResult[] {
    throw new Error("not implemented");
  }
}
