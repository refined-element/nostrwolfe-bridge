/** WolfeSubscriber — paged hydration + live sub on the public relay (spec §4). */

import type { Config, IWolfeSubscriber, NostrEvent } from "./types.js";

export class WolfeSubscriber implements IWolfeSubscriber {
  constructor(_config: Config, _getCursor: () => number) {
    void _config;
    void _getCursor;
  }

  hydrate(
    _onListing: (event: NostrEvent) => Promise<void> | void,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  subscribeLive(_onListing: (event: NostrEvent) => Promise<void> | void): void {
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }
}
