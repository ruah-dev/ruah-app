// src/acp/bridge.ts — shared by WP-A (implements) and WP-B (consumes). Verbatim
// from the WP-0 block in PROMPTS.md.
import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { AgentState, ModeState, ModelState, PermissionOption, StopReason, StreamEvent, ToolCallView } from "../contracts/ws.js";

export interface AcpPreset { command: string; args: string[]; env?: Record<string, string> }

export interface BridgeOptions {
  root: string;                    // absolute repo dir; becomes the ACP session cwd
  preset: AcpPreset;
  clientVersion: string;           // sent as clientInfo.version
  onStderr?: (chunk: string) => void;
  /** Extra working directories (multi-repo systems: every repo root). Claude SDK only; ACP has cwd only. */
  additionalDirectories?: string[];
  /** Ruah map tools (ruah_* MCP server, CONTRACTS §1.7) for this agent's sessions. */
  mapTools?: AgentMapTools;
  /** Extensions enabled for this agent (CONTRACTS §15), resolved when a process / session starts. */
  extensions?: AgentExtensions;
}

/**
 * What Ruah's extensions add to one agent session (CONTRACTS §15.5).
 * Resolved fresh at every process start (ACP) and session open, so enabling
 * or disabling an extension applies to the next session without a restart.
 */
export interface SessionExtensions {
  /** Claude Agent SDK: extra mcpServers (the map tools' "ruah" server wins), local plugin folders, text appended to the system prompt. */
  sdk?: { mcpServers: Record<string, unknown>; plugins: string[]; append?: string };
  /** ACP: extra mcpServers for session/new and session/load; `preset` replaces the launch (plugin folders, env) when the process starts. */
  acp?: { mcpServers: McpServer[]; preset?: AcpPreset };
  /** Things that were skipped, for the debug log. */
  notes: string[];
}

export interface AgentExtensions {
  /** Never rejects (a failure resolves to no extensions + a note). ACP bridges pass their base preset. */
  resolve(preset?: AcpPreset): Promise<SessionExtensions>;
}

/** A stdio MCP server for ACP session/new `mcpServers` (ACP McpServerStdio). */
export interface StdioMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** How a bridge offers the ruah_* map tools to its agent (src/serve/map-ops.ts builds it). */
export interface AgentMapTools {
  /** Appended to the system prompt where the agent has one (Claude Agent SDK). */
  instructions: string;
  /** Claude Agent SDK: a fresh in-process MCP server config (createSdkMcpServer) — one per query(). */
  sdkServer(): unknown;
  /** Fully qualified tool names the Claude Agent SDK's canUseTool allows without asking (they only touch architecture.json, undoable per turn). */
  allowedTools: string[];
  /** ACP: the stdio MCP server to pass in session/new; undefined while the daemon URL is unknown. */
  stdio(): Promise<StdioMcpServerSpec | undefined>;
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
  /**
   * Makes `sessionId` the agent session (Claude SDK: `resume`; ACP:
   * `session/load` when the agent advertises `loadSession`, else a new
   * session), or a fresh session when undefined. On a stopped bridge it only
   * records the choice for the next start(); on a running one it replaces the
   * live session (an active turn is cancelled first). Chats use it to resume
   * their conversation.
   */
  useSession?(sessionId: string | undefined): Promise<void>;
  /**
   * Whether prompts may carry ACP `image` blocks: Claude SDK true; ACP agents
   * per `initialize` → `agentCapabilities.promptCapabilities.image`; undefined
   * while not known (an ACP agent that has not been initialized yet).
   */
  supportsImages?(): boolean | undefined;
  /** Claude SDK only: plan usage via the live query's get_usage control request (no model turn); undefined when there is no live query. */
  claudePlanUsage?(): Promise<ClaudePlanUsage | undefined>;
}

export class BusyError extends Error {
  constructor() {
    super("a turn is already active");
    this.name = "BusyError";
  }
}
