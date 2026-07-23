/** StateStore — atomic debounced JSON persistence (spec §7). */

import type { BridgeState, IStateStore } from "./types.js";

export class StateStore implements IStateStore {
  constructor(_stateFile: string) {
    void _stateFile;
  }

  load(_expectedCommunity: string): Promise<BridgeState> {
    throw new Error("not implemented");
  }

  getState(): BridgeState {
    throw new Error("not implemented");
  }

  mutate(_fn: (state: BridgeState) => void): void {
    throw new Error("not implemented");
  }

  flush(): Promise<void> {
    throw new Error("not implemented");
  }

  reset(_community: string): void {
    throw new Error("not implemented");
  }
}
