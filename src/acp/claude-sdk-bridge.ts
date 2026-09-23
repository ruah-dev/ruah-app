// Adapted from t3code apps/server/src/provider/Layers/ClaudeAdapter.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/claude-sdk-bridge.ts — AcpBridge driven by the Claude Agent SDK
// (`@anthropic-ai/claude-agent-sdk` query()) instead of an ACP subprocess, so
// the agent runs with the user's own Claude Code setup: settingSources
// user/project/local load ~/.claude and <root>/.claude (skills, plugins, MCP
// servers, subagents, CLAUDE.md, permission rules).
//
// Shape taken from t3code's ClaudeAdapter, with Effect-TS replaced by plain
// promises and listeners:
// - one long-lived query() per session, fed by a streaming-input queue of
//   SDKUserMessages, so the conversation persists across prompts;
// - includePartialMessages text/thinking deltas, with a backfill from the
//   assistant snapshot when a block was not streamed;
// - tool_use blocks → tool_call, tool_result blocks → tool_result, TodoWrite
//   → plan, Edit/MultiEdit/Write → diff;
// - canUseTool → permission event, answered by answerPermission();
//   "always allow" is rescoped to the session (toSessionPermissionUpdates);
// - result → turn_finished (resultOutcome / isInterruptedResult /
//   terminalResultError);
// - resume after the CLI exits unexpectedly (`resume: sessionId`).
// Model selection is archmap's own (t3code's model catalog is not used): the
// list is query.supportedModels(), setModel() calls query.setModel(), and the
// choice is passed as options.model to every respawned/resumed query. Until
// the user picks one, the current model shown is ANTHROPIC_MODEL, else the
// `model` of the Claude settings files the CLI loads, else "default".
// Usage: each result's cumulative modelUsage / total_cost_usd is differenced
// against the previous reading of the same query() (resumed queries start
// fresh) and sent as turn_finished.usage; rate_limit_event → rate_limit;
// claudePlanUsage() asks the live query for get_usage (usage/claude-limits.ts).
// Dropped: orchestration, thread persistence/rollback, telemetry,
// task/workflow tracking, effort selection.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  query as sdkQuery,
  type CanUseTool,
  type ModelInfo,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, BridgeOptions, ClaudePlanUsage, RateLimitSample, TurnHandle, TurnUsage } from "./bridge.js";
import { BusyError } from "./bridge.js";
import { resolveClaudeSdkExecutablePath } from "./claude-executable.js";
import { claudeSignedOutMessage, makeClaudeEnvironment } from "./claude-home.js";
import { planClaudeSkillDispatch } from "./claude-skill-dispatch.js";
import type { AgentState, ModeState, ModelState, PermissionOption, PlanEntry, StopReason, StreamEvent, ToolCallView } from "../contracts/ws.js";

export interface ClaudeSdkBridgeDeps {
  /** Injected in tests; defaults to the SDK's query(). */
  queryImpl?: typeof sdkQuery;
  /** CONTRACTS §2.2 rule 5: how long cancel waits for the interrupted result. Default 15 s. */
  cancelTimeoutMs?: number;
  /** How long start()/reset() wait for the CLI's initialize response. Default 60 s. */
  startTimeoutMs?: number;
}

const AGENT_NAME = "claude-agent-sdk";
const OUTPUT_CAP = 4096;
const TRUNCATION_SUFFIX = " …[truncated]";

const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const satisfies ReadonlyArray<SettingSource>;

// Names/descriptions match @agentclientprotocol/claude-agent-acp so the viewer
// shows the same labels whichever bridge is running.
const AVAILABLE_MODES: ModeState["available"] = [
  { id: "default", name: "Manual", description: "Always ask before making changes" },
  { id: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
  { id: "plan", name: "Plan", description: "Create a plan before making changes" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Accepts all permissions" },
];
const MODE_IDS: ReadonlySet<string> = new Set(AVAILABLE_MODES.map((mode) => mode.id));

/** The CLI's own "use the default model" entry in supportedModels(). */
const DEFAULT_MODEL_ID = "default";

const PERMISSION_OPTIONS = {
  allow: { optionId: "allow", name: "Allow", kind: "allow_once" },
  allowAlways: { optionId: "allow_always", name: "Always allow in this session", kind: "allow_always" },
  reject: { optionId: "reject", name: "Reject", kind: "reject_once" },
} as const satisfies Record<string, PermissionOption>;

const SUPPORTED_IMAGE_MIME_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;
type ImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

type UserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];
type PermissionAnswer = { optionId: string } | { cancelled: true };

// ---------- session / turn state ----------

/** Streaming-input queue: the async iterable query() reads user messages from (t3code's promptQueue). */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude session input is closed");
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolveNext) => this.waiters.push(resolveNext));
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface SessionRuntime {
  readonly sessionId: string;
  readonly query: Query;
  readonly prompts: PromptQueue;
  closed: boolean;
  /** Running totals of the last result of this query() (they are cumulative per query). */
  usageReading: UsageReading;
}

interface UsageCounters {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface UsageReading {
  readonly models: ReadonlyMap<string, UsageCounters>;
  readonly costUsd: number;
}

export const EMPTY_USAGE_READING: UsageReading = { models: new Map(), costUsd: 0 };

interface ToolState {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  view: ToolCallView;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly resolveDone: (value: { stopReason: StopReason; error?: string }) => void;
  cancelled: boolean;
  cancelTimer: NodeJS.Timeout | undefined;
  /** Assistant message ids whose text / thinking arrived as stream deltas. */
  readonly streamedText: Set<string>;
  readonly streamedThinking: Set<string>;
  currentMessageId: string | undefined;
  readonly tools: Map<string, ToolState>;
  authenticationFailureMessage: string | undefined;
  /** `model` of the latest top-level assistant message. */
  model: string | undefined;
}

interface PendingPermission {
  readonly turnId: string;
  readonly resolve: (answer: PermissionAnswer) => void;
}

// ---------- helpers (adapted from ClaudeAdapter.ts) ----------

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function capOutput(text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) + TRUNCATION_SUFFIX : text;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => extractTextContent(entry)).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  return extractTextContent(value.content);
}

function sdkVersion(): string {
  try {
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const pkg: unknown = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
    return isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Permission updates applied for an "Always allow in this session" decision.
 * Claude Code's suggestions are reused when present but rescoped to
 * `destination: "session"` — echoing them verbatim would persist the
 * session-only choice as a permanent rule. When Claude Code offers no
 * suggestion (common for MCP tools), fall back to a whole-tool session allow
 * rule so the decision still sticks for the session.
 */
function toSessionPermissionUpdates(toolName: string, suggestions: ReadonlyArray<PermissionUpdate> | undefined): PermissionUpdate[] {
  const sessionScoped = (suggestions ?? []).map((suggestion): PermissionUpdate => ({ ...suggestion, destination: "session" }));
  if (sessionScoped.length > 0) return sessionScoped;
  return [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors) ? result.errors.join(" ").toLowerCase() : "";
}

/** Failure text for structured terminal reasons, including success-tagged failures. */
function terminalResultError(reason: SDKResultMessage["terminal_reason"], failureHint?: string): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      return "Claude stopped: a usage limit blocked the request.";
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":
      return "Claude stopped: the prompt exceeds the model's context window.";
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  // The CLI stamps user aborts explicitly: interrupting mid-tool-call yields
  // "aborted_tools", interrupting mid-stream yields "aborted_streaming".
  if (result.terminal_reason === "aborted_tools" || result.terminal_reason === "aborted_streaming") return true;
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) return true;
  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") || errors.includes("interrupted by user") || errors.includes("aborted"))
  );
}

/** t3code's resultOutcome, mapped onto ACP stop reasons. */
function resultStopReason(result: SDKResultMessage, failureHint: string | undefined): { stopReason: StopReason; error?: string } {
  // A success result flagged is_error only fails when the turn already
  // reported its cause (expired login, rejected usage window).
  const successTaggedFailure = result.subtype === "success" && result.is_error;
  const overloaded = result.subtype === "success" && result.api_error_status === 529;
  const structuredError = overloaded
    ? "Claude API is overloaded (529). Try again shortly."
    : (terminalResultError(result.terminal_reason, failureHint) ?? (successTaggedFailure ? failureHint : undefined));
  // CLI diagnostic entries ("[ede_diagnostic] …") must not become the error text.
  const listedError = result.subtype === "success" && !successTaggedFailure
    ? undefined
    : ("errors" in result ? result.errors : []).find((error) => typeof error === "string" && !error.startsWith("[ede_diagnostic]"));
  const errorMessage = listedError ?? structuredError;
  if (structuredError !== undefined) return { stopReason: "error", error: errorMessage ?? structuredError };
  if (isInterruptedResult(result)) return { stopReason: "cancelled" };
  if (result.subtype === "error_max_turns" || result.terminal_reason === "max_turns") return { stopReason: "max_turn_requests" };
  if (result.subtype === "success") {
    if (result.stop_reason === "max_tokens") return { stopReason: "max_tokens" };
    if (result.stop_reason === "refusal") return { stopReason: "refusal" };
    return { stopReason: "end_turn" };
  }
  return { stopReason: "error", error: errorMessage ?? `Claude turn failed (${result.subtype}).` };
}

// ---------- usage accounting ----------

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function roundCost(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

function countersOf(modelUsage: unknown): UsageCounters {
  const usage = isRecord(modelUsage) ? modelUsage : {};
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadInputTokens),
    cacheWriteTokens: count(usage.cacheCreationInputTokens),
  };
}

function counterTotal(counters: UsageCounters): number {
  return counters.inputTokens + counters.outputTokens + counters.cacheReadTokens + counters.cacheWriteTokens;
}

/** cur − prev, or cur itself when the running total went backwards (/clear resets it). */
function counterDelta(cur: UsageCounters, prev: UsageCounters | undefined): UsageCounters {
  if (prev === undefined) return cur;
  const monotonic = cur.inputTokens >= prev.inputTokens && cur.outputTokens >= prev.outputTokens && cur.cacheReadTokens >= prev.cacheReadTokens && cur.cacheWriteTokens >= prev.cacheWriteTokens;
  if (!monotonic) return cur;
  return {
    inputTokens: cur.inputTokens - prev.inputTokens,
    outputTokens: cur.outputTokens - prev.outputTokens,
    cacheReadTokens: cur.cacheReadTokens - prev.cacheReadTokens,
    cacheWriteTokens: cur.cacheWriteTokens - prev.cacheWriteTokens,
  };
}

/**
 * What one result added to the query's running totals. `modelUsage` and
 * `total_cost_usd` are cumulative per query() (main loop + subagents +
 * compaction), so the turn is the difference to the previous reading;
 * `usage` (main loop only, per turn) is the fallback when modelUsage is
 * missing. A zeroed result (crash/startup error) reports nothing and leaves
 * the reading alone. The primary model is the top-level assistant's, else the
 * one that produced the most output.
 */
export function resultUsage(
  result: Pick<SDKResultMessage, "modelUsage" | "total_cost_usd" | "usage" | "duration_ms">,
  reading: UsageReading,
  assistantModel: string | undefined,
): { usage: TurnUsage | undefined; reading: UsageReading } {
  const raw = result as unknown as Record<string, unknown>;
  const modelUsage = isRecord(raw.modelUsage) ? raw.modelUsage : {};
  const current = new Map(Object.entries(modelUsage).map(([model, usage]) => [model, countersOf(usage)] as const));
  const cost = typeof raw.total_cost_usd === "number" && Number.isFinite(raw.total_cost_usd) && raw.total_cost_usd >= 0 ? raw.total_cost_usd : undefined;
  const mainLoop = isRecord(raw.usage)
    ? {
        inputTokens: count(raw.usage.input_tokens),
        outputTokens: count(raw.usage.output_tokens),
        cacheReadTokens: count(raw.usage.cache_read_input_tokens),
        cacheWriteTokens: count(raw.usage.cache_creation_input_tokens),
      }
    : undefined;
  const modelTotal = [...current.values()].reduce((sum, counters) => sum + counterTotal(counters), 0);
  if (modelTotal === 0 && (mainLoop === undefined || counterTotal(mainLoop) === 0) && (cost ?? 0) === 0) {
    return { usage: undefined, reading };
  }

  let tokens: UsageCounters = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let primary: { model: string; output: number } | undefined;
  if (modelTotal > 0) {
    for (const [model, counters] of current) {
      const delta = counterDelta(counters, reading.models.get(model));
      tokens = {
        inputTokens: tokens.inputTokens + delta.inputTokens,
        outputTokens: tokens.outputTokens + delta.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens + delta.cacheReadTokens,
        cacheWriteTokens: tokens.cacheWriteTokens + delta.cacheWriteTokens,
      };
      if (counterTotal(delta) > 0 && (primary === undefined || delta.outputTokens > primary.output)) primary = { model, output: delta.outputTokens };
    }
  } else if (mainLoop !== undefined) {
    tokens = mainLoop;
  }
  const costDelta = cost === undefined ? undefined : cost >= reading.costUsd ? cost - reading.costUsd : cost;
  const model = assistantModel ?? primary?.model;
  const durationMs = typeof raw.duration_ms === "number" && Number.isFinite(raw.duration_ms) ? Math.max(0, Math.round(raw.duration_ms)) : undefined;
  return {
    usage: {
      ...(model !== undefined ? { model } : {}),
      ...tokens,
      ...(costDelta !== undefined ? { costUsd: roundCost(costDelta) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    reading: {
      models: modelTotal > 0 ? current : reading.models,
      costUsd: cost ?? reading.costUsd,
    },
  };
}

function rateLimitSample(info: unknown): RateLimitSample | undefined {
  if (!isRecord(info)) return undefined;
  return {
    ...(typeof info.status === "string" ? { status: info.status } : {}),
    ...(typeof info.rateLimitType === "string" ? { rateLimitType: info.rateLimitType } : {}),
    ...(typeof info.utilization === "number" ? { utilization: info.utilization } : {}),
    ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
  };
}

// ---------- tool views ----------

/** ToolCallView.kind for an SDK tool name (t3code's classifyToolItemType, onto ACP kinds). */
export function toolKind(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
      return "execute";
    case "Grep":
    case "Glob":
    case "LS":
    case "ToolSearch":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    case "TodoWrite":
      return "think";
    case "ExitPlanMode":
    case "EnterPlanMode":
      return "switch_mode";
    case "Task":
    case "Agent":
      return "other";
  }
  const normalized = toolName.toLowerCase();
  if (normalized.startsWith("mcp__")) return "other";
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("shell") || normalized.includes("terminal")) return "execute";
  if (normalized.includes("delete") || normalized.includes("remove")) return "delete";
  if (normalized.includes("move") || normalized.includes("rename")) return "move";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch") || normalized.includes("replace")) return "edit";
  if (normalized.includes("search") || normalized.includes("grep") || normalized.includes("glob")) return "search";
  if (normalized.includes("fetch") || normalized.includes("web")) return "fetch";
  if (normalized.includes("read") || normalized.includes("view")) return "read";
  return "other";
}

function toolTitle(toolName: string, input: Record<string, unknown>, displayPath: (path: string) => string): string {
  const filePath = readString(input.file_path) ?? readString(input.notebook_path);
  switch (toolName) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return filePath !== undefined ? `${toolName} ${displayPath(filePath)}` : toolName;
    case "Bash": {
      const description = readString(input.description);
      const command = readString(input.command);
      return description ?? (command !== undefined ? `Run ${command.slice(0, 200)}` : "Run command");
    }
    case "Grep":
    case "Glob": {
      const pattern = readString(input.pattern);
      const path = readString(input.path);
      return [toolName, pattern !== undefined ? JSON.stringify(pattern) : undefined, path !== undefined ? `in ${displayPath(path)}` : undefined]
        .filter((part) => part !== undefined)
        .join(" ");
    }
    case "WebFetch":
      return `Fetch ${readString(input.url) ?? ""}`.trim();
    case "WebSearch":
      return `Search web: ${readString(input.query) ?? ""}`.trim();
    case "TodoWrite":
      return "Update plan";
    case "ExitPlanMode":
      return "Ready to code?";
    case "Task":
    case "Agent":
      return readString(input.description) ?? readString(input.prompt)?.slice(0, 200) ?? "Subagent task";
  }
  // t3code's summarizeToolRequest fallback, shortened for a title.
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = "";
  }
  const summary = serialized.length > 0 && serialized !== "{}" ? `${toolName}: ${serialized}` : toolName;
  return summary.length <= 200 ? summary : `${summary.slice(0, 197)}...`;
}

function extractPlanEntriesFromTodoInput(input: Record<string, unknown>): PlanEntry[] | undefined {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  return todos.filter(isRecord).map((todo) => ({
    content: readString(todo.content)?.trim() ?? "Task",
    priority: "medium",
    status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
  }));
}

// ---------- the bridge ----------

export class ClaudeSdkBridge implements AcpBridge {
  private readonly root: string;
  private readonly additionalDirectories: readonly string[];
  private readonly env: Record<string, string | undefined>;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly queryImpl: typeof sdkQuery;
  private readonly cancelTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly agent = { name: AGENT_NAME, version: sdkVersion() };
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private state: AgentState = "stopped";
  private mode: PermissionMode = "default";
  private session: SessionRuntime | undefined;
  private opening: Promise<SessionRuntime> | undefined;
  private sessionId: string = randomUUID();
  /** True once the CLI has persisted a transcript for sessionId, so it can be resumed. */
  private hasHistory = false;
  /** Set by useSession(id): if resuming that transcript fails at start, fall back to a fresh session. */
  private resumeFallback = false;
  private active: ActiveTurn | undefined;
  private skillNames: ReadonlySet<string> = new Set();
  /** Explicitly chosen model (setModel or ANTHROPIC_MODEL); undefined = the CLI default. */
  private modelId: string | undefined;
  /** supportedModels() of the latest query. */
  private modelInfos: ModelInfo[] = [];
  /** `model` from the settings files the CLI loads (display only; the CLI applies it itself). */
  private settingsModel: string | undefined;

  constructor(options: BridgeOptions, deps: ClaudeSdkBridgeDeps = {}) {
    this.root = resolve(options.root);
    this.additionalDirectories = (options.additionalDirectories ?? []).map((dir) => resolve(dir));
    this.env = makeClaudeEnvironment(options.preset.env);
    const envModel = this.env.ANTHROPIC_MODEL?.trim();
    this.modelId = envModel !== undefined && envModel.length > 0 ? envModel : undefined;
    this.onStderr = options.onStderr;
    this.queryImpl = deps.queryImpl ?? sdkQuery;
    this.cancelTimeoutMs = deps.cancelTimeoutMs ?? 15_000;
    this.startTimeoutMs = deps.startTimeoutMs ?? 60_000;
  }

  // ----- AcpBridge -----

  async start(): Promise<void> {
    if (this.state === "idle" || this.state === "busy" || this.state === "starting") return;
    this.setState("starting");
    try {
      try {
        await this.ensureSession();
      } catch (cause) {
        // useSession(id): the transcript may be gone (deleted, other machine);
        // start a fresh session instead of leaving the agent in error.
        if (!this.resumeFallback) throw cause;
        this.onStderr?.(`claude resume of ${this.sessionId} failed (${toMessage(cause, "unknown error")}); starting a new session\n`);
        this.resumeFallback = false;
        this.sessionId = randomUUID();
        this.hasHistory = false;
        await this.ensureSession();
      }
      this.resumeFallback = false;
    } catch (cause) {
      const error = toMessage(cause, "Failed to start Claude.");
      this.setState("error", { error });
      throw cause instanceof Error ? cause : new Error(error);
    }
    this.state = "idle";
    const models = this.models();
    this.emit({ type: "status", state: "idle", agent: { ...this.agent }, sessionId: this.sessionId, modes: this.modes(), ...(models !== undefined ? { models } : {}) });
  }

  status(): AgentState {
    return this.state;
  }

  /** The SDK takes base64 image blocks (PNG, JPEG, GIF, WebP) in the user message. */
  supportsImages(): boolean {
    return true;
  }

  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle {
    if (this.active !== undefined) throw new BusyError();
    if (this.state === "stopped" || this.state === "starting") throw new Error(`Claude bridge is ${this.state}`);

    let resolveDone: (value: { stopReason: StopReason; error?: string }) => void = () => {};
    const done = new Promise<{ stopReason: StopReason; error?: string }>((resolveTurn) => {
      resolveDone = resolveTurn;
    });
    const turn: ActiveTurn = {
      turnId,
      resolveDone,
      cancelled: false,
      cancelTimer: undefined,
      streamedText: new Set(),
      streamedThinking: new Set(),
      currentMessageId: undefined,
      tools: new Map(),
      authenticationFailureMessage: undefined,
      model: undefined,
    };
    this.active = turn;
    this.setState("busy");

    const message = this.buildUserMessage(blocks);
    this.ensureSession().then(
      (session) => {
        if (this.active !== turn || turn.cancelled) {
          if (this.active === turn) this.finishTurn(turn, { stopReason: "cancelled" });
          return;
        }
        session.prompts.push(message);
      },
      (cause: unknown) => {
        this.finishTurn(turn, { stopReason: "error", error: toMessage(cause, "Failed to start Claude.") }, "error");
      },
    );
    return { turnId, done };
  }

  async cancel(turnId: string): Promise<void> {
    const turn = this.active;
    if (turn === undefined || turn.turnId !== turnId || turn.cancelled) return;
    turn.cancelled = true;
    this.cancelPendingPermissions(turnId);
    const session = this.session;
    if (session === undefined || session.closed) {
      // The prompt has not reached a live query yet; prompt()'s continuation finishes it.
      if (this.opening === undefined) this.finishTurn(turn, { stopReason: "cancelled" });
      return;
    }
    // CONTRACTS §2.2 rule 5: wait for the interrupted result; if the CLI does
    // not answer in time, kill it (t3code's interruptTurn always does this)
    // and finish with "error". The next prompt resumes the session.
    turn.cancelTimer = setTimeout(() => {
      if (this.active !== turn) return;
      this.closeSession(session);
      this.finishTurn(turn, { stopReason: "error", error: `Claude did not stop within ${this.cancelTimeoutMs} ms; the process was restarted.` });
    }, this.cancelTimeoutMs);
    try {
      await session.query.interrupt();
    } catch (cause) {
      // interrupt() fails when the process is already gone; the stream exit
      // (or the timer above) finishes the turn.
      this.onStderr?.(`claude interrupt failed: ${toMessage(cause, "unknown error")}\n`);
    }
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined) return false;
    this.pendingPermissions.delete(requestId);
    if ("cancelled" in answer) this.emit({ type: "permission_resolved", turnId: pending.turnId, requestId, cancelled: true });
    else this.emit({ type: "permission_resolved", turnId: pending.turnId, requestId, optionId: answer.optionId });
    pending.resolve(answer);
    return true;
  }

  async setMode(modeId: string): Promise<void> {
    if (!MODE_IDS.has(modeId)) throw new Error(`unknown mode: ${modeId}`);
    const mode = modeId as PermissionMode;
    const session = this.session;
    if (session !== undefined && !session.closed) await session.query.setPermissionMode(mode);
    this.mode = mode;
    this.emit({ type: "status", state: this.state, sessionId: this.sessionId, modes: this.modes() });
  }

  /**
   * Switches the live query's model (query.setModel; also mid-turn, where the
   * CLI applies it from the next model request) and remembers it for every
   * later query (reset, resume after a crash or cancel timeout).
   */
  async setModel(modelId: string): Promise<void> {
    const id = modelId.trim();
    if (id.length === 0) throw new Error("model id is empty");
    await this.waitForOpening();
    if (this.modelInfos.length > 0 && !this.modelInfos.some((model) => model.value === id)) throw new Error(`unknown model: ${id}`);
    const session = this.session;
    if (session !== undefined && !session.closed) await session.query.setModel(id);
    this.modelId = id;
    const models = this.models();
    this.emit({ type: "status", state: this.state, sessionId: this.sessionId, ...(models !== undefined ? { models } : {}) });
  }

  async reset(): Promise<void> {
    const turn = this.active;
    if (turn !== undefined) {
      turn.cancelled = true;
      this.cancelPendingPermissions(turn.turnId);
      this.finishTurn(turn, { stopReason: "cancelled" }, "starting");
    }
    await this.waitForOpening();
    if (this.session !== undefined) this.closeSession(this.session);
    this.sessionId = randomUUID();
    this.hasHistory = false;
    this.state = "stopped";
    await this.start();
  }

  /**
   * Resumes Claude session `sessionId` (the SDK's `resume`; the CLI reloads
   * its transcript) or starts a fresh one (undefined). A stopped bridge only
   * records the choice; start() opens it.
   */
  async useSession(sessionId: string | undefined): Promise<void> {
    if (sessionId !== undefined && sessionId === this.sessionId && (this.session !== undefined || this.state === "stopped")) return;
    const turn = this.active;
    if (turn !== undefined) {
      turn.cancelled = true;
      this.cancelPendingPermissions(turn.turnId);
      this.finishTurn(turn, { stopReason: "cancelled" }, this.state === "stopped" ? "stopped" : "starting");
    }
    await this.waitForOpening();
    if (this.session !== undefined) this.closeSession(this.session);
    this.sessionId = sessionId ?? randomUUID();
    this.hasHistory = sessionId !== undefined;
    this.resumeFallback = sessionId !== undefined;
    if (this.state === "stopped") return;
    this.state = "stopped";
    await this.start();
  }

  async stop(): Promise<void> {
    const turn = this.active;
    if (turn !== undefined) {
      turn.cancelled = true;
      this.cancelPendingPermissions(turn.turnId);
      this.finishTurn(turn, { stopReason: "cancelled" }, "stopped");
    }
    await this.waitForOpening();
    if (this.session !== undefined) this.closeSession(this.session);
    if (this.state !== "stopped") this.setState("stopped");
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Plan usage windows from the live query's get_usage control request (no
   * model turn, skips the transcript scan). Undefined without a live query.
   */
  async claudePlanUsage(): Promise<ClaudePlanUsage | undefined> {
    const session = this.session;
    if (session === undefined || session.closed) return undefined;
    const query = session.query as Partial<Query>;
    if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return undefined;
    const response = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.call(session.query, { skipBehaviors: true });
    return { rate_limits_available: response.rate_limits_available, rate_limits: response.rate_limits as Record<string, unknown> | null };
  }

  // ----- session lifecycle -----

  private ensureSession(): Promise<SessionRuntime> {
    if (this.session !== undefined && !this.session.closed) return Promise.resolve(this.session);
    if (this.opening !== undefined) return this.opening;
    const opening = this.openSession().finally(() => {
      if (this.opening === opening) this.opening = undefined;
    });
    this.opening = opening;
    return opening;
  }

  private async waitForOpening(): Promise<void> {
    if (this.opening === undefined) return;
    try {
      await this.opening;
    } catch {
      // reported by the caller that started it
    }
  }

  private async openSession(): Promise<SessionRuntime> {
    const resume = this.hasHistory;
    const prompts = new PromptQueue();
    const executable = this.env.CLAUDE_CODE_EXECUTABLE;
    const options: ClaudeQueryOptions = {
      cwd: this.root,
      ...(this.additionalDirectories.length > 0 ? { additionalDirectories: [...this.additionalDirectories] } : {}),
      ...(executable !== undefined && executable.length > 0
        ? { pathToClaudeCodeExecutable: resolveClaudeSdkExecutablePath(executable, this.env) }
        : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [...CLAUDE_SETTING_SOURCES],
      permissionMode: this.mode,
      // Lets setMode() switch into bypassPermissions later; the mode itself
      // stays whatever the user picked.
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      env: this.env,
      // "default" is the CLI's own default; leaving it out lets ANTHROPIC_MODEL /
      // settings.json pick it, exactly as a fresh CLI would.
      ...(this.modelId !== undefined && this.modelId !== DEFAULT_MODEL_ID ? { model: this.modelId } : {}),
      ...(this.onStderr !== undefined ? { stderr: this.onStderr } : {}),
      ...(resume ? { resume: this.sessionId } : { sessionId: this.sessionId }),
    };
    const query = this.queryImpl({ prompt: prompts, options });
    const session: SessionRuntime = { sessionId: this.sessionId, query, prompts, closed: false, usageReading: EMPTY_USAGE_READING };
    this.session = session;
    void this.pump(session);

    let timer: NodeJS.Timeout | undefined;
    const initialize = async (): Promise<{ commands: ReadonlyArray<{ name: string }>; models: ModelInfo[] }> => {
      const init = await query.initializationResult();
      let models: ModelInfo[] = init.models ?? [];
      try {
        const supported = await query.supportedModels();
        if (supported.length > 0) models = supported;
      } catch (cause) {
        this.onStderr?.(`claude supportedModels failed: ${toMessage(cause, "unknown error")}\n`);
      }
      return { commands: init.commands, models };
    };
    try {
      const init = await Promise.race([
        initialize(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Claude did not initialize within ${this.startTimeoutMs} ms`)), this.startTimeoutMs);
        }),
      ]);
      this.skillNames = new Set(init.commands.map((command) => command.name));
      this.modelInfos = init.models;
      this.settingsModel = this.readSettingsModel();
      // An explicit "default" must beat a settings.json model on a new query
      // too; options.model is left out for it, so apply it the way the picker does.
      if (this.modelId === DEFAULT_MODEL_ID && this.settingsModel !== undefined) {
        await query.setModel(DEFAULT_MODEL_ID).catch((cause: unknown) => {
          this.onStderr?.(`claude setModel(default) failed: ${toMessage(cause, "unknown error")}\n`);
        });
      }
    } catch (cause) {
      this.closeSession(session);
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (session.closed) throw new Error("Claude exited during startup.");
    return session;
  }

  private closeSession(session: SessionRuntime): void {
    if (session.closed) return;
    session.closed = true;
    if (this.session === session) this.session = undefined;
    session.prompts.close();
    try {
      // The SDK closes stdin, then escalates from SIGTERM to SIGKILL.
      session.query.close();
    } catch (cause) {
      this.onStderr?.(`claude close failed: ${toMessage(cause, "unknown error")}\n`);
    }
  }

  private async pump(session: SessionRuntime): Promise<void> {
    let failure: string | undefined;
    try {
      for await (const message of session.query) {
        if (session.closed) return;
        this.handleSdkMessage(message, session);
      }
    } catch (cause) {
      failure = toMessage(cause, "Claude runtime stream failed.");
    }
    this.onSessionExit(session, failure);
  }

  /** The CLI went away without us closing it (crash, auth exit, killed). */
  private onSessionExit(session: SessionRuntime, failure: string | undefined): void {
    if (session.closed) return;
    session.closed = true;
    if (this.session === session) this.session = undefined;
    session.prompts.close();
    const error = failure ?? "Claude process exited.";
    const turn = this.active;
    if (turn !== undefined) {
      const stopReason: StopReason = turn.cancelled ? "cancelled" : "error";
      this.finishTurn(turn, stopReason === "cancelled" ? { stopReason } : { stopReason, error: turn.authenticationFailureMessage ?? error }, "error");
    } else if (this.state !== "stopped" && this.opening === undefined) {
      this.setState("error", { error });
    }
  }

  // ----- SDK message handling (ClaudeAdapter handleSdkMessage and friends) -----

  private handleSdkMessage(message: SDKMessage, session: SessionRuntime): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.hasHistory = true;
          this.syncMode(message.permissionMode);
        } else if (message.subtype === "status" && message.permissionMode !== undefined) {
          this.syncMode(message.permissionMode);
        }
        return;
      case "result": {
        this.hasHistory = true;
        // The reading advances for every result (also autonomous ones with no
        // archmap turn), so the next turn's difference is only its own spend.
        const { usage, reading } = resultUsage(message, session.usageReading, this.active?.model);
        session.usageReading = reading;
        this.handleResult(message, usage);
        return;
      }
      case "rate_limit_event": {
        const info = rateLimitSample(message.rate_limit_info);
        if (info !== undefined) this.emit({ type: "rate_limit", info });
        return;
      }
      case "stream_event":
        this.handleStreamEvent(message);
        return;
      case "assistant":
        this.handleAssistant(message);
        return;
      case "user":
        this.handleUser(message);
        return;
      default:
        // Telemetry, hooks, tasks, rate limits, prompt suggestions: no archmap surface.
        return;
    }
  }

  private syncMode(mode: PermissionMode): void {
    if (mode === this.mode || !MODE_IDS.has(mode)) return;
    this.mode = mode;
    this.emit({ type: "status", state: this.state, sessionId: this.sessionId, modes: this.modes() });
  }

  private handleStreamEvent(message: Extract<SDKMessage, { type: "stream_event" }>): void {
    const turn = this.active;
    if (turn === undefined || turn.cancelled) return;
    // Subagent narration (parent_tool_use_id set) must not write into the
    // parent transcript; subagent tool calls arrive via assistant snapshots.
    if (message.parent_tool_use_id !== null) return;
    const event = message.event;
    if (event.type === "message_start") {
      turn.currentMessageId = event.message.id;
      return;
    }
    if (event.type !== "content_block_delta") return;
    const messageId = turn.currentMessageId ?? "";
    if (event.delta.type === "text_delta" && event.delta.text.length > 0) {
      turn.streamedText.add(messageId);
      this.emitStream(turn, { kind: "text", text: event.delta.text });
    } else if (event.delta.type === "thinking_delta" && event.delta.thinking.length > 0) {
      turn.streamedThinking.add(messageId);
      this.emitStream(turn, { kind: "thought", text: event.delta.thinking });
    }
  }

  private handleAssistant(message: Extract<SDKMessage, { type: "assistant" }>): void {
    const turn = this.active;
    if (turn === undefined || turn.cancelled) return;
    const isSubagent = message.parent_tool_use_id !== null;
    // The CLI can report authentication failure before ending the turn as a
    // generic API error, so retain that evidence for the result.
    if (message.error === "authentication_failed") {
      turn.authenticationFailureMessage = claudeSignedOutMessage({ configDir: this.env.CLAUDE_CONFIG_DIR, cwd: this.root });
    }
    const messageId = message.message.id;
    if (!isSubagent && typeof message.message.model === "string" && message.message.model.length > 0) turn.model = message.message.model;
    const content: unknown = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && !isSubagent && typeof block.text === "string" && block.text.length > 0) {
        // Backfill text that did not arrive as stream deltas.
        if (!turn.streamedText.has(messageId)) this.emitStream(turn, { kind: "text", text: block.text });
      } else if (block.type === "thinking" && !isSubagent && typeof block.thinking === "string" && block.thinking.length > 0) {
        if (!turn.streamedThinking.has(messageId)) this.emitStream(turn, { kind: "thought", text: block.thinking });
      } else if ((block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "tool";
        this.ensureTool(turn, block.id, name, isRecord(block.input) ? block.input : {});
      }
    }
  }

  private handleUser(message: Extract<SDKMessage, { type: "user" }>): void {
    const turn = this.active;
    if (turn === undefined || turn.cancelled) return;
    const content: unknown = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = turn.tools.get(block.tool_use_id);
      if (tool === undefined) continue;
      const text = extractTextContent(block.content);
      const view: ToolCallView = {
        ...tool.view,
        status: block.is_error === true ? "failed" : "completed",
        ...(text.length > 0 ? { output: capOutput(text) } : {}),
      };
      tool.view = view;
      this.emitStream(turn, { kind: "tool_result", toolCall: view });
    }
  }

  private handleResult(result: SDKResultMessage, usage: TurnUsage | undefined): void {
    const turn = this.active;
    if (turn === undefined) return;
    if (turn.cancelled) {
      this.finishTurn(turn, { stopReason: "cancelled" }, "idle", usage);
      return;
    }
    this.finishTurn(turn, resultStopReason(result, turn.authenticationFailureMessage), "idle", usage);
  }

  private ensureTool(turn: ActiveTurn, toolUseId: string, toolName: string, input: Record<string, unknown>): ToolState {
    const existing = turn.tools.get(toolUseId);
    if (existing !== undefined) return existing;
    const filePath = readString(input.file_path) ?? readString(input.notebook_path) ?? (toolName === "Grep" || toolName === "Glob" ? undefined : readString(input.path));
    const offset = typeof input.offset === "number" && toolName === "Read" ? input.offset : undefined;
    const command = readString(input.command);
    const kind = toolKind(toolName);
    const view: ToolCallView = {
      toolCallId: toolUseId,
      title: toolTitle(toolName, input, (path) => this.displayPath(path)),
      kind,
      status: "pending",
      locations: filePath !== undefined ? [{ path: this.displayPath(filePath), ...(offset !== undefined ? { line: offset } : {}) }] : [],
      ...(kind === "execute" && command !== undefined ? { command } : {}),
      ...(toolName === "ExitPlanMode" && readString(input.plan) !== undefined ? { output: capOutput(String(input.plan)) } : {}),
    };
    const tool: ToolState = { toolName, input, view };
    turn.tools.set(toolUseId, tool);
    this.emitStream(turn, { kind: "tool_call", toolCall: view });
    for (const diff of this.diffsFor(toolUseId, toolName, input)) this.emitStream(turn, diff);
    if (toolName === "TodoWrite") {
      const entries = extractPlanEntriesFromTodoInput(input);
      if (entries !== undefined) this.emitStream(turn, { kind: "plan", entries });
    }
    return tool;
  }

  private diffsFor(toolCallId: string, toolName: string, input: Record<string, unknown>): StreamEvent[] {
    const filePath = readString(input.file_path);
    if (filePath === undefined) return [];
    const path = this.displayPath(filePath);
    if (toolName === "Write" && typeof input.content === "string") {
      return [{ kind: "diff", toolCallId, path, oldText: null, newText: input.content }];
    }
    if (toolName === "Edit" && typeof input.new_string === "string") {
      return [{ kind: "diff", toolCallId, path, oldText: typeof input.old_string === "string" ? input.old_string : null, newText: input.new_string }];
    }
    if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
      return input.edits.filter(isRecord).flatMap((edit): StreamEvent[] =>
        typeof edit.new_string === "string"
          ? [{ kind: "diff", toolCallId, path, oldText: typeof edit.old_string === "string" ? edit.old_string : null, newText: edit.new_string }]
          : [],
      );
    }
    return [];
  }

  // ----- permissions (ClaudeAdapter canUseTool) -----

  private readonly canUseTool: CanUseTool = async (toolName, toolInput, callbackOptions): Promise<PermissionResult> => {
    const turn = this.active;
    if (turn === undefined || turn.cancelled) {
      return { behavior: "deny", message: "No active archmap turn.", interrupt: true };
    }
    // archmap has no surface for clarifying questions; steer the model to plain text.
    if (toolName === "AskUserQuestion") {
      return {
        behavior: "deny",
        message: "This client cannot show interactive questions. Ask the question in plain text and end your turn.",
      };
    }

    const tool = this.ensureTool(turn, callbackOptions.toolUseID, toolName, toolInput);
    const requestId = `perm_${randomUUID()}`;
    const options: PermissionOption[] = callbackOptions.suppressAlwaysAllowRule === true
      ? [PERMISSION_OPTIONS.allow, PERMISSION_OPTIONS.reject]
      : [PERMISSION_OPTIONS.allow, PERMISSION_OPTIONS.allowAlways, PERMISSION_OPTIONS.reject];

    const answer = await new Promise<PermissionAnswer>((resolveAnswer) => {
      this.pendingPermissions.set(requestId, { turnId: turn.turnId, resolve: resolveAnswer });
      const onAbort = (): void => {
        this.answerPermission(requestId, { cancelled: true });
      };
      callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "permission", turnId: turn.turnId, requestId, toolCall: tool.view, options });
      // The signal may already have aborted while the request was emitted.
      if (callbackOptions.signal.aborted) onAbort();
    });

    if ("cancelled" in answer) {
      return { behavior: "deny", message: "User cancelled tool execution.", interrupt: true };
    }
    if (answer.optionId === PERMISSION_OPTIONS.allow.optionId || answer.optionId === PERMISSION_OPTIONS.allowAlways.optionId) {
      if (this.active === turn && !turn.cancelled) {
        tool.view = { ...tool.view, status: "in_progress" };
        this.emitStream(turn, { kind: "tool_call", toolCall: tool.view });
      }
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(answer.optionId === PERMISSION_OPTIONS.allowAlways.optionId
          ? { updatedPermissions: toSessionPermissionUpdates(toolName, callbackOptions.suggestions) }
          : {}),
      };
    }
    return { behavior: "deny", message: "User declined tool execution." };
  };

  private cancelPendingPermissions(turnId: string): void {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.turnId === turnId) this.answerPermission(requestId, { cancelled: true });
    }
  }

  // ----- prompt construction -----

  private buildUserMessage(blocks: readonly ContentBlock[]): SDKUserMessage {
    const content: UserContentBlock[] = [];
    let lastTextIndex = -1;
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          lastTextIndex = content.length;
          content.push({ type: "text", text: block.text });
          break;
        case "resource_link":
          // Same rendering as claude-agent-acp's formatUriAsLink, but with the
          // repo-relative name archmap puts in `name`.
          content.push({ type: "text", text: `[@${block.name}](${block.uri})` });
          break;
        case "resource":
          if ("text" in block.resource) {
            content.push({ type: "text", text: `[@${block.resource.uri}](${block.resource.uri})\n<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>` });
          }
          break;
        case "image": {
          const mimeType = SUPPORTED_IMAGE_MIME_TYPES.find((type) => type === block.mimeType);
          if (mimeType !== undefined) content.push({ type: "image", source: { type: "base64", media_type: mimeType satisfies ImageMimeType, data: block.data } });
          break;
        }
        default:
          break;
      }
    }

    // `$skill` → `/skill …` as the message's last text block (ClaudeSkillDispatch).
    const lastText = lastTextIndex >= 0 ? content[lastTextIndex] : undefined;
    if (lastText !== undefined && lastText.type === "text") {
      const dispatch = planClaudeSkillDispatch(lastText.text, this.skillNames);
      if (dispatch !== undefined) {
        content.splice(lastTextIndex, 1, ...(dispatch.leadingText !== undefined ? [{ type: "text" as const, text: dispatch.leadingText }] : []));
        content.push({ type: "text", text: dispatch.commandText });
      }
    }

    return {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      origin: { kind: "human" },
      message: { role: "user", content },
    };
  }

  // ----- plumbing -----

  private finishTurn(turn: ActiveTurn, outcome: { stopReason: StopReason; error?: string }, nextState: AgentState = "idle", usage?: TurnUsage): void {
    if (this.active !== turn) return;
    if (turn.cancelTimer !== undefined) clearTimeout(turn.cancelTimer);
    this.cancelPendingPermissions(turn.turnId);
    this.active = undefined;
    this.emit({
      type: "turn_finished",
      turnId: turn.turnId,
      stopReason: outcome.stopReason,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(usage !== undefined ? { usage } : {}),
    });
    this.setState(nextState, outcome.stopReason === "error" && nextState === "error" && outcome.error !== undefined ? { error: outcome.error } : {});
    turn.resolveDone(outcome);
  }

  private setState(state: AgentState, extra: { error?: string } = {}): void {
    this.state = state;
    this.emit({
      type: "status",
      state,
      ...(state === "stopped" ? {} : { sessionId: this.sessionId }),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    });
  }

  private modes(): ModeState {
    return { currentModeId: this.mode, available: AVAILABLE_MODES.map((mode) => ({ ...mode })) };
  }

  /**
   * The picker: supportedModels() rows, current = the chosen model (or the
   * row an ANTHROPIC_MODEL id resolves to), "default" when nothing was chosen.
   * A chosen model the CLI does not list is appended so it stays visible.
   */
  private models(): ModelState | undefined {
    if (this.modelInfos.length === 0 && this.modelId === undefined) return undefined;
    const available: ModelState["available"] = this.modelInfos.map((info) => {
      const description = info.description.trim();
      const name = modelDisplayName(info.value, info.displayName, description);
      return description.length > 0 ? { id: info.value, name, description } : { id: info.value, name };
    });
    const chosen = this.modelId ?? this.settingsModel ?? DEFAULT_MODEL_ID;
    const row = this.modelInfos.find((info) => info.value === chosen) ?? this.modelInfos.find((info) => info.resolvedModel === chosen);
    const currentModelId = row?.value ?? chosen;
    if (!available.some((model) => model.id === currentModelId)) {
      available.push({ id: currentModelId, name: currentModelId === DEFAULT_MODEL_ID ? "Default" : currentModelId });
    }
    return { currentModelId, available };
  }

  /**
   * `model` from the settings the CLI loads (settingSources local > project >
   * user), for showing the current model before the user picks one.
   */
  private readSettingsModel(): string | undefined {
    const configDir = this.env.CLAUDE_CONFIG_DIR ?? join(this.env.HOME ?? homedir(), ".claude");
    const files = [join(this.root, ".claude", "settings.local.json"), join(this.root, ".claude", "settings.json"), join(configDir, "settings.json")];
    for (const file of files) {
      try {
        const settings: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (isRecord(settings)) {
          const model = readString(settings.model);
          if (model !== undefined) return model.trim();
        }
      } catch {
        // missing or unreadable: next source
      }
    }
    return undefined;
  }

  /** Repo-relative when inside root, else absolute (CONTRACTS §2.1 ToolCallView.locations). */
  private displayPath(path: string): string {
    const absolute = isAbsolute(path) ? path : resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absolute;
    return rel.split(sep).join("/");
  }

  private emitStream(turn: ActiveTurn, event: StreamEvent): void {
    this.emit({ type: "stream", turnId: turn.turnId, event });
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * The CLI names aliases generically ("Opus (1M context)") and puts the
 * concrete model in the description ("Opus 5.5 with 1M context · …"). Show
 * the version in the name so the picker says which model you get:
 * "Opus 5.5 · 1M". "Default" keeps its name; unknown formats pass through.
 */
export function modelDisplayName(id: string, displayName: string, description: string): string {
  if (id === "default") return displayName;
  const match = /^([A-Z][A-Za-z]+ \d+(?:\.\d+)?)/.exec(description);
  if (match === null) return displayName;
  const version = match[1] ?? displayName;
  return /\[1m\]$/.test(id) || /1M context/.test(description) ? `${version} · 1M` : version;
}
