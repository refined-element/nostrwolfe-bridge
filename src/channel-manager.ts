/** ChannelManager — discover / create / join the Services channel (spec §3). */

import type {
  BridgeIdentity,
  Config,
  IBuzzClient,
  IChannelManager,
  IStateStore,
} from "./types.js";

export class ChannelManager implements IChannelManager {
  constructor(
    _config: Config,
    _identity: BridgeIdentity,
    _buzz: IBuzzClient,
    _state: IStateStore,
  ) {
    void _config;
    void _identity;
    void _buzz;
    void _state;
  }

  ensureChannel(): Promise<string> {
    throw new Error("not implemented");
  }

  verifyChannelExists(_channelId: string): Promise<boolean> {
    throw new Error("not implemented");
  }

  deterministicChannelId(): string {
    throw new Error("not implemented");
  }
}
