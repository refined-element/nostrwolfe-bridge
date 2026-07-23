/** BuzzClient — NIP-42 auth, rate-limited publish, subscriptions (spec §2). */

import type {
  Config,
  BridgeIdentity,
  EoseHandler,
  EventHandler,
  IBuzzClient,
  NostrEvent,
  NostrFilter,
  OkResult,
  Subscription,
} from "./types.js";

export class BuzzClient implements IBuzzClient {
  constructor(_config: Config, _identity: BridgeIdentity) {
    void _config;
    void _identity;
  }

  connect(): Promise<void> {
    throw new Error("not implemented");
  }

  publish(_event: NostrEvent): Promise<OkResult> {
    throw new Error("not implemented");
  }

  subscribe(
    _subId: string,
    _filters: NostrFilter[],
    _onEvent: EventHandler,
    _onEose?: EoseHandler,
  ): Subscription {
    throw new Error("not implemented");
  }

  query(_subId: string, _filters: NostrFilter[]): Promise<NostrEvent[]> {
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }
}
