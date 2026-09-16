// src/acp/bridge.ts — shared by WP-A (implements) and WP-B (consumes). Verbatim
// from the WP-0 block in PROMPTS.md.
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentState, ModeState, PermissionOption, StopReason, StreamEvent, ToolCallView } from "../contracts/ws.js";

export interface AcpPreset { command: string; args: string[]; env?: Record<string, string> }

export interface BridgeOptions {
  root: string;                    // absolute repo dir; becomes the ACP session cwd
  preset: AcpPreset;
  clientVersion: string;           // sent as clientInfo.version
  onStderr?: (chunk: string) => void;
}

export type BridgeEvent =
  | { type: "status"; state: AgentState; agent?: { name: string; version: string }; sessionId?: string; modes?: ModeState; error?: string }
  | { type: "stream"; turnId: string; event: StreamEvent }
  | { type: "permission"; turnId: string; requestId: string; toolCall: ToolCallView; options: PermissionOption[] }
  | { type: "permission_resolved"; turnId: string; requestId: string; optionId?: string; cancelled?: true }
  | { type: "turn_finished"; turnId: string; stopReason: StopReason; error?: string };

export interface TurnHandle { turnId: string; done: Promise<{ stopReason: StopReason; error?: string }> }

export interface AcpBridge {
  start(): Promise<void>;                                                       // spawn → initialize → session/new; resolves when idle
  status(): AgentState;
  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle;                   // throws BusyError while a turn is active
  cancel(turnId: string): Promise<void>;                                        // no-op if turnId is not the active turn
  answerPermission(requestId: string, answer: { optionId: string } | { cancelled: true }): boolean; // false = unknown requestId
  setMode(modeId: string): Promise<void>;
  reset(): Promise<void>;                                                       // new ACP session, same process
  stop(): Promise<void>;                                                        // terminate the agent process
  on(listener: (event: BridgeEvent) => void): () => void;                       // returns unsubscribe
}

export class BusyError extends Error {
  constructor() {
    super("a turn is already active");
    this.name = "BusyError";
  }
}
