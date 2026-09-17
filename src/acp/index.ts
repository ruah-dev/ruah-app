// src/acp/index.ts — bridge factory for the serve command. WP-A's real bridge
// (acp-bridge.ts / agent-process.ts) does not exist on this branch yet, so the
// factory throws until it lands. Tests and --mock use MockBridge directly.
import type { AcpBridge, BridgeOptions } from "./bridge.js";
import { MockBridge, type MockBridgeOptions } from "./mock-bridge.js";

export type { AcpBridge, BridgeOptions, BridgeEvent, TurnHandle } from "./bridge.js";
export { BusyError } from "./bridge.js";
export { MockBridge, type MockBridgeOptions } from "./mock-bridge.js";

export function createBridge(opts: BridgeOptions & { mock?: boolean }): AcpBridge {
  if (opts.mock === true) {
    return new MockBridge({ ...opts, chunkDelayMs: 40 });
  }
  throw new Error("real bridge not available: WP-A's ACP bridge is not implemented yet");
}
