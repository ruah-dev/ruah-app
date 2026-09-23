// src/acp/bridge.ts — shared by WP-A (implements) and WP-B (consumes). Verbatim
// from the WP-0 block in PROMPTS.md.
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentState, ModeState, ModelState, PermissionOption, StopReason, StreamEvent, ToolCallView } from "../contracts/ws.js";

export interface AcpPreset { command: string; args: string[]; env?: Record<string, string> }

export interface BridgeOptions {
  root: string;                    // absolute repo dir; becomes the ACP session cwd
  preset: AcpPreset;
  clientVersion: string;           // sent as clientInfo.version
  onStderr?: (chunk: string) => void;
}

export type BridgeEvent =
  | { type: "status"; state: AgentState; agent?: { name: string; version: string }; sessionId?: string; modes?: ModeState; models?: ModelState; error?: string }
  | { type: "stream"; turnId: string; event: StreamEvent }
  | { type: "permission"; turnId: string; requestId: string; toolCall: ToolCallView; options: PermissionOption[] }
  | { type: "permission_resolved"; turnId: string; requestId: string; optionId?: string; cancelled?: true }
  | { type: "turn_finished"; turnId: string; stopReason: StopReason; error?: string; usage?: TurnUsage }
  | { type: "rate_limit"; info: RateLimitSample };

/**
 * What a finished turn spent, as far as the agent reported it (Claude SDK
 * result / ACP PromptResponse.usage + usage_update cost). Absent on
 * turn_finished when the agent reported nothing; the usage log then records
 * zeros so turn counts still work.
 */
export interface TurnUsage {
  /** The model that did the work (primary model when several were used). */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Agent-reported estimate in USD; absent = the agent reported no cost. */
  costUsd?: number;
  durationMs?: number;
}

/**
 * One plan rate-limit reading streamed during a turn — the Claude SDK's
 * `rate_limit_event.rate_limit_info` (also relayed by claude-agent-acp as
 * usage_update `_meta["_claude/rateLimit"]`): a 0–1 utilization fraction and
 * an epoch-seconds reset for one window.
 */
export interface RateLimitSample {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
}

/** The SDK's get_usage answer, reduced to the plan windows (usage/claude-limits.ts). */
export interface ClaudePlanUsage {
  rate_limits_available: boolean;
  rate_limits: Record<string, unknown> | null;
}

export interface TurnHandle { turnId: string; done: Promise<{ stopReason: StopReason; error?: string }> }

export interface AcpBridge {
  start(): Promise<void>;                                                       // spawn → initialize → session/new; resolves when idle
  status(): AgentState;
  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle;                   // throws BusyError while a turn is active
  cancel(turnId: string): Promise<void>;                                        // no-op if turnId is not the active turn
  answerPermission(requestId: string, answer: { optionId: string } | { cancelled: true }): boolean; // false = unknown requestId
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;                                     // allowed mid-turn; applies to the next model request
  reset(): Promise<void>;                                                       // new ACP session, same process
  stop(): Promise<void>;                                                        // terminate the agent process
  on(listener: (event: BridgeEvent) => void): () => void;                       // returns unsubscribe
  /** Claude SDK only: plan usage via the live query's get_usage control request (no model turn); undefined when there is no live query. */
  claudePlanUsage?(): Promise<ClaudePlanUsage | undefined>;
}

export class BusyError extends Error {
  constructor() {
    super("a turn is already active");
    this.name = "BusyError";
  }
}
