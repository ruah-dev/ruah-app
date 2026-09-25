// Adapted from t3code apps/server/src/provider/acp/AcpSessionRuntime.ts (start,
// prompt, cancel with 15 s timeout + retire, mode handling, root-session
// filtering), apps/server/src/provider/Layers/CursorAdapter.ts (pending-approval
// map, settlePendingApprovalsAsCancelled before session/cancel) and
// acp/AcpAdapterSupport.ts (process-exited vs request error buckets) (MIT,
// eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/acp-bridge.ts — AcpProcessBridge: the real AcpBridge. Spawns any ACP
// agent from an AcpPreset (Claude via claude-agent-acp today; other ACP agents
// via other presets), runs initialize → session/new (cwd = root) and maps
// session/update to BridgeEvents. Effect-TS stripped: plain async/await over
// @agentclientprotocol/sdk's client() / ActiveSession. No fs/terminal client
// capabilities (PLAN decision 3). One process, one session, one turn at a time.
// Model selection (ruah's own): the agent's `model` session config option
// (session/set_config_option, kept in sync by config_option_update), or the
// older unstable `models` field + session/set_model; the chosen model is
// re-applied to every new session (reset, crash respawn, cancel-timeout respawn).
// Agents that offer modes only as a `mode` config option (OpenCode) get the
// same treatment for setMode.
// Usage (ruah's own): PromptResponse.usage (unstable; per turn in
// claude-agent-acp) → turn_finished.usage, the turn's cost = the change of the
// cumulative usage_update.cost during the turn, the model from
// `_meta.quota.model_usage` (claude-agent-acp / codex-acp) else the current
// model option; `_meta["_claude/rateLimit"]` on usage_update → rate_limit.
import {
  client,
  PROTOCOL_VERSION,
  RequestError,
  type ActiveSession,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason as AcpStopReason,
} from "@agentclientprotocol/sdk";
import path from "node:path";
import type { AgentState, ModeState, ModelState, PermissionOption, StopReason } from "../contracts/ws.js";
import type { AcpBridge, AcpPreset, BridgeEvent, BridgeOptions, RateLimitSample, SessionExtensions, StdioMcpServerSpec, TurnHandle, TurnUsage } from "./bridge.js";
import { BusyError } from "./bridge.js";
import {
  applyModeChange,
  parseLegacyModels,
  parseModeConfigOption,
  parseModeState,
  parseModelConfigOption,
  sameSelectState,
  sessionUpdateIsReplay,
  TurnNormalizer,
  type Selector,
} from "./acp-normalize.js";
import { AgentProcess, describeExit, type AgentExit } from "./acp-process.js";

// t3code defaultCancelTimeout.
export const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;

export interface AcpBridgeTuning {
  cancelTimeoutMs?: number;   // CONTRACTS §2.2 rule 5; tests shorten it
  killGraceMs?: number;       // SIGTERM → SIGKILL grace on stop/retire
}

type TurnResult = { stopReason: StopReason; error?: string };
type PermissionAnswer = { optionId: string } | { cancelled: true };

interface ActiveTurn {
  readonly turnId: string;
  readonly normalizer: TurnNormalizer;
  readonly done: Promise<TurnResult>;
  readonly resolve: (result: TurnResult) => void;
  cancelRequested: boolean;
  dispatched: boolean;
  finished: boolean;
  /** Cumulative session cost (usage_update.cost, USD) when the prompt was sent. */
  costAtStart: number | undefined;
}

interface PendingPermission {
  readonly requestId: string;
  readonly turnId: string;
  readonly optionIds: ReadonlySet<string>;
  readonly settle: (answer: PermissionAnswer) => void;
}

interface Runtime {
  readonly proc: AgentProcess;
  readonly conn: ClientConnection;
  init: InitializeResponse | undefined;
  session: ActiveSession | undefined;
  ready: boolean;     // start() completed; exits are reported by onExit from here on
  retiring: boolean;  // we are killing it on purpose (stop / cancel timeout / failed start)
  /** §15: extensions resolved for this process's launch, used by its first session (later sessions re-resolve). */
  extensions?: SessionExtensions | undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof RequestError) return `${err.message} (code ${err.code})`;
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The model with the most tokens in `_meta.quota.model_usage` (claude-agent-acp, codex-acp). */
function quotaModel(meta: unknown): string | undefined {
  const quota = isRecord(meta) ? meta.quota : undefined;
  const rows = isRecord(quota) && Array.isArray(quota.model_usage) ? quota.model_usage : [];
  let best: { model: string; total: number } | undefined;
  for (const row of rows) {
    if (!isRecord(row) || typeof row.model !== "string" || row.model.length === 0) continue;
    const tokens = isRecord(row.token_count) ? row.token_count : {};
    const total = tokenCount(tokens.totalTokens) || tokenCount(tokens.inputTokens) + tokenCount(tokens.outputTokens);
    if (best === undefined || total > best.total) best = { model: row.model, total };
  }
  return best?.model;
}

/** turn_finished.usage from an ACP prompt response; undefined when the agent reported neither tokens nor cost. */
export function acpTurnUsage(
  response: { usage?: unknown; _meta?: unknown } | undefined,
  costUsd: number | undefined,
  currentModel: string | undefined,
): TurnUsage | undefined {
  const usage = isRecord(response?.usage) ? response.usage : undefined;
  if (usage === undefined && costUsd === undefined) return undefined;
  const model = quotaModel(response?._meta) ?? currentModel;
  return {
    ...(model !== undefined ? { model } : {}),
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    cacheReadTokens: tokenCount(usage?.cachedReadTokens),
    cacheWriteTokens: tokenCount(usage?.cachedWriteTokens),
    ...(costUsd !== undefined ? { costUsd: Math.round(costUsd * 1e10) / 1e10 } : {}),
  };
}

function mapStopReason(reason: AcpStopReason | string): StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return reason;
    default:
      return "end_turn";
  }
}

export class AcpProcessBridge implements AcpBridge {
  private readonly root: string;
  private readonly cancelTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private readonly permissions = new Map<string, PendingPermission>();
  private state: AgentState = "stopped";
  private runtime: Runtime | undefined;
  private starting: Promise<void> | undefined;
  private turn: ActiveTurn | undefined;
  private agentInfo: { name: string; version: string } | undefined;
  /** promptCapabilities.image from the last initialize (kept across restarts). */
  private imageCapability: boolean | undefined;
  private sessionId: string | undefined;
  private modes: ModeState | undefined;
  private models: ModelState | undefined;
  private modelSelector: Selector | undefined;
  private modeSelector: Selector | undefined;
  /** The last setModel() choice; re-applied to every new session. */
  private chosenModel: string | undefined;
  private permCounter = 0;
  /** Cumulative cost of the current session from usage_update (USD only). */
  private sessionCostUsd: number | undefined;
  private crashRespawns = 0;
  private stopRequested = false;
  /** useSession(id): the session the next openSession() loads instead of creating one. */
  private requestedSession: string | undefined;

  constructor(private readonly options: BridgeOptions, tuning: AcpBridgeTuning = {}) {
    this.root = path.resolve(options.root);
    this.cancelTimeoutMs = tuning.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.killGraceMs = tuning.killGraceMs ?? 1_000;
  }

  // ---------- AcpBridge ----------

  start(): Promise<void> {
    if (this.starting !== undefined) return this.starting;
    if (this.runtime?.session !== undefined && (this.state === "idle" || this.state === "busy")) return Promise.resolve();
    this.stopRequested = false;
    const starting = this.startOnce().finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  status(): AgentState {
    return this.state;
  }

  supportsImages(): boolean | undefined {
    return this.imageCapability;
  }

  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle {
    if (this.turn !== undefined) throw new BusyError();
    let resolve: (result: TurnResult) => void = () => {};
    const done = new Promise<TurnResult>((r) => {
      resolve = r;
    });
    const turn: ActiveTurn = {
      turnId,
      normalizer: new TurnNormalizer(this.root),
      done,
      resolve,
      cancelRequested: false,
      dispatched: false,
      finished: false,
      costAtStart: undefined,
    };
    this.turn = turn;
    if (this.state === "idle") this.emitStatus("busy");
    void this.dispatch(turn, blocks);
    return { turnId, done };
  }

  async cancel(turnId: string): Promise<void> {
    const turn = this.turn;
    if (turn === undefined || turn.turnId !== turnId || turn.finished) return;
    if (turn.cancelRequested) {
      await turn.done;
      return;
    }
    turn.cancelRequested = true;
    // (a) answer every pending permission of the turn with cancelled first
    // (t3code settlePendingApprovalsAsCancelled), so the agent is not blocked.
    for (const pending of [...this.permissions.values()]) {
      if (pending.turnId === turnId) pending.settle({ cancelled: true });
    }
    const rt = this.runtime;
    const sessionId = this.sessionId;
    if (!turn.dispatched || rt?.session === undefined || sessionId === undefined) {
      // Still waiting for the agent to (re)start: nothing was sent yet.
      this.finishTurn(turn, "cancelled");
      return;
    }
    // The SDK writes permission responses a few microtasks after settle();
    // yield a macrotask so they reach the wire before session/cancel.
    await new Promise<void>((r) => setImmediate(r));
    // (b) session/cancel
    try {
      await rt.conn.agent.notify("session/cancel", { sessionId });
    } catch {
      // Connection already gone; the exit path finishes the turn.
    }
    // (c) wait for the prompt response, else retire and respawn.
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      turn.done.then(() => "done" as const),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), this.cancelTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === "timeout" && !turn.finished && this.runtime === rt) {
      await this.retireAfterCancelTimeout(rt, turn);
    }
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const pending = this.permissions.get(requestId);
    if (pending === undefined) return false;
    // Only relay option ids the agent offered (CONTRACTS §2.1: optionId must be one of the offered options).
    if ("optionId" in answer && !pending.optionIds.has(answer.optionId)) return false;
    pending.settle(answer);
    return true;
  }

  async setMode(modeId: string): Promise<void> {
    const rt = this.runtime;
    const sessionId = this.sessionId;
    if (rt?.session === undefined || sessionId === undefined) throw new Error(`agent is ${this.state}, no session`);
    // t3code: no-op when the requested mode is already active.
    if (this.modes?.currentModeId === modeId) return;
    const selector = this.modeSelector;
    if (selector?.kind === "config") {
      const response = await rt.conn.agent.request("session/set_config_option", { sessionId, configId: selector.configId, value: modeId });
      if (sessionId !== this.sessionId) return;
      const next = parseModeConfigOption(response.configOptions)?.state ?? applyModeChange(this.modes, modeId);
      if (next !== undefined) this.setModes(next);
      return;
    }
    await rt.conn.agent.request("session/set_mode", { sessionId, modeId });
    const next = applyModeChange(this.modes, modeId);
    if (next !== this.modes && next !== undefined) {
      this.modes = next;
      this.emitStatus(this.state);
    }
  }

  /**
   * Allowed mid-turn: claude-agent-acp applies set_config_option to its live
   * query (query.setModel), so the switch takes effect from the next model
   * request.
   */
  async setModel(modelId: string): Promise<void> {
    if (this.starting !== undefined) await this.starting.catch(() => {});
    const rt = this.runtime;
    const sessionId = this.sessionId;
    if (rt?.session === undefined || sessionId === undefined) throw new Error(`agent is ${this.state}, no session`);
    const models = this.models;
    if (models === undefined || this.modelSelector === undefined) throw new Error("agent does not offer model selection");
    if (modelId !== models.currentModelId && !models.available.some((model) => model.id === modelId)) throw new Error(`unknown model: ${modelId}`);
    if (models.currentModelId !== modelId) await this.applyModel(rt, sessionId, modelId);
    this.chosenModel = modelId;
  }

  async reset(): Promise<void> {
    if (this.turn !== undefined) await this.cancel(this.turn.turnId);
    if (this.starting !== undefined) await this.starting.catch(() => {});
    const rt = this.runtime;
    if (rt?.session === undefined || this.state === "error" || this.state === "stopped") {
      await this.start();
      return;
    }
    const oldSessionId = this.sessionId;
    rt.session.dispose();
    rt.session = undefined;
    this.sessionId = undefined;
    this.modes = undefined;
    this.modeSelector = undefined;
    this.models = undefined;
    this.modelSelector = undefined;
    if (oldSessionId !== undefined && this.canCloseSession(rt)) {
      try {
        await rt.conn.agent.request("session/close", { sessionId: oldSessionId });
      } catch {
        // Best effort; the old session simply stops receiving prompts.
      }
    }
    this.emitStatus("starting");
    try {
      await this.openSession(rt);
    } catch (err) {
      const message = `session reset failed: ${errorMessage(err)}`;
      this.emitStatus("error", message);
      throw new Error(message);
    }
    this.emitStatus(this.turn === undefined ? "idle" : "busy");
  }

  /**
   * Chats: continue session `sessionId` with `session/load` when the agent
   * advertises `agentCapabilities.loadSession` (the agent replays the history
   * as notifications, which are dropped: the viewer draws the stored turns),
   * otherwise a new session. undefined = a fresh session. A stopped bridge
   * only records the choice for start().
   */
  async useSession(sessionId: string | undefined): Promise<void> {
    if (this.turn !== undefined) await this.cancel(this.turn.turnId);
    if (this.starting !== undefined) await this.starting.catch(() => {});
    if (sessionId !== undefined && sessionId === this.sessionId && this.runtime?.session !== undefined) return;
    this.requestedSession = sessionId;
    const rt = this.runtime;
    if (rt === undefined || rt.session === undefined || this.state === "stopped" || this.state === "error") {
      // start() (now or later) opens the requested session.
      if (this.state !== "stopped") await this.start();
      return;
    }
    const oldSessionId = this.sessionId;
    rt.session.dispose();
    rt.session = undefined;
    this.sessionId = undefined;
    this.modes = undefined;
    this.modeSelector = undefined;
    this.models = undefined;
    this.modelSelector = undefined;
    if (oldSessionId !== undefined && this.canCloseSession(rt)) {
      try {
        await rt.conn.agent.request("session/close", { sessionId: oldSessionId });
      } catch {
        // Best effort.
      }
    }
    this.emitStatus("starting");
    try {
      await this.openSession(rt);
    } catch (err) {
      const message = `session switch failed: ${errorMessage(err)}`;
      this.emitStatus("error", message);
      throw new Error(message);
    }
    this.emitStatus(this.turn === undefined ? "idle" : "busy");
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    const rt = this.runtime;
    this.runtime = undefined;
    if (rt !== undefined) rt.retiring = true;
    this.state = "stopped";
    for (const pending of [...this.permissions.values()]) pending.settle({ cancelled: true });
    if (this.turn !== undefined) this.finishTurn(this.turn, "cancelled", "agent stopped");
    if (rt !== undefined) {
      rt.session?.dispose();
      rt.conn.close();
      await rt.proc.kill(this.killGraceMs);
    }
    this.sessionId = undefined;
    this.emitStatus("stopped");
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------- lifecycle ----------

  private async startOnce(): Promise<void> {
    this.emitStatus("starting");
    // §15: enabled extensions can change the launch (plugin folders, env); resolved before the spawn.
    const extensions = this.options.extensions !== undefined ? await this.resolveExtensions() : undefined;
    if (extensions !== undefined && this.stopRequested) throw new Error("agent stopped during start");
    const preset: AcpPreset = extensions?.acp?.preset ?? this.options.preset;
    const proc = new AgentProcess(preset, this.root, this.options.onStderr);
    const rt: Runtime = {
      proc,
      conn: client({ name: "ruah" })
        .onRequest("session/request_permission", ({ params, signal }) => this.onPermissionRequest(rt, params, signal))
        .connect(proc.stream),
      init: undefined,
      session: undefined,
      ready: false,
      retiring: false,
      extensions,
    };
    this.runtime = rt;
    void proc.exited.then((exit) => this.onExit(rt, exit));
    try {
      const init = await this.raceExit(rt, rt.conn.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ruah", version: this.options.clientVersion },
      }));
      rt.init = init;
      this.imageCapability = init.agentCapabilities?.promptCapabilities?.image === true;
      this.agentInfo = {
        name: init.agentInfo?.name ?? this.fallbackAgentName(),
        version: init.agentInfo?.version ?? "unknown",
      };
      // No authenticate step: agents that are already logged in (Claude adapter:
      // authMethods []) go straight to session/new. If session/new then fails
      // with auth_required, the error names the advertised methods.
      try {
        await this.openSession(rt);
      } catch (err) {
        if (err instanceof RequestError && err.code === -32000) {
          const methods = (init.authMethods ?? []).map((m) => (m.description ? `${m.name} (${m.description})` : m.name)).join(", ") || "none advertised";
          throw new Error(`authentication required: ${methods}`);
        }
        throw err;
      }
      if (this.runtime !== rt) throw new Error("agent stopped during start");
      rt.ready = true;
      this.emitStatus(this.turn === undefined ? "idle" : "busy");
    } catch (err) {
      // A CLI that refuses to start (e.g. Kiro when logged out) closes stdout a
      // moment before its exit is observed; wait briefly so the error carries
      // the exit code and its stderr instead of "ACP connection closed".
      const exit = await Promise.race([proc.exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))]);
      const message = exit !== undefined ? describeExit(exit, proc.stderrTail()) : errorMessage(err);
      rt.retiring = true;
      rt.session?.dispose();
      rt.conn.close();
      await proc.kill(this.killGraceMs);
      if (this.runtime === rt) {
        this.runtime = undefined;
        this.emitStatus("error", message);
      }
      throw new Error(message);
    }
  }

  private async openSession(rt: Runtime): Promise<void> {
    const load = this.requestedSession;
    this.requestedSession = undefined;
    let session: ActiveSession | undefined;
    if (load !== undefined && rt.init?.agentCapabilities?.loadSession === true) {
      try {
        session = await this.loadSession(rt, load);
      } catch (err) {
        if (rt.proc.hasExited) throw err;
        this.options.onStderr?.(`ruah: session/load ${load} failed (${errorMessage(err)}); starting a new session\n`);
      }
    }
    if (session === undefined) {
      const builder = rt.conn.agent.buildSession(this.root);
      const mcp = await this.mapToolsServer();
      if (mcp !== undefined) builder.withMcpServer(mcp);
      for (const server of await this.extensionServers(rt)) builder.withMcpServer(server);
      session = await this.raceExit(rt, builder.start());
    }
    rt.session = session;
    this.sessionId = session.sessionId;
    this.sessionCostUsd = undefined;
    this.readModes(session.newSessionResponse);
    this.readModels(session.newSessionResponse);
    void this.pump(rt, session);
    await this.reapplyModel(rt, session.sessionId);
  }

  /**
   * session/load, then the SDK's (TS-private) attachSession so the loaded
   * session gets the same ActiveSession update routing as session/new. The
   * history replay arrives before the response, i.e. before routing exists,
   * and is dropped.
   */
  private async loadSession(rt: Runtime, sessionId: string): Promise<ActiveSession> {
    const mcp = await this.mapToolsServer();
    const extra = await this.extensionServers(rt);
    const response = await this.raceExit(rt, rt.conn.agent.request("session/load", { sessionId, cwd: this.root, mcpServers: [...(mcp !== undefined ? [mcp] : []), ...extra] }));
    const agent = rt.conn.agent as unknown as { attachSession?: (response: NewSessionResponse) => ActiveSession };
    if (typeof agent.attachSession !== "function") throw new Error("the ACP SDK cannot attach a loaded session");
    return agent.attachSession.call(rt.conn.agent, { ...(response ?? {}), sessionId } as NewSessionResponse);
  }

  /** §15: the enabled extensions (never rejects; failures are logged and mean "none"). */
  private async resolveExtensions(): Promise<SessionExtensions | undefined> {
    const provider = this.options.extensions;
    if (provider === undefined) return undefined;
    try {
      const resolved = await provider.resolve(this.options.preset);
      for (const note of resolved.notes) this.options.onStderr?.(`ruah extensions: ${note}\n`);
      return resolved;
    } catch (err) {
      this.options.onStderr?.(`ruah: extensions unavailable (${errorMessage(err)})\n`);
      return undefined;
    }
  }

  /**
   * §15: extension MCP servers for session/new and session/load. The first
   * session of a process reuses what its launch resolved; later ones (reset,
   * load) re-resolve. Remote (http / sse) servers go only to agents that
   * advertise mcpCapabilities for them.
   */
  private async extensionServers(rt: Runtime): Promise<McpServer[]> {
    if (this.options.extensions === undefined) return [];
    let resolved = rt.extensions;
    rt.extensions = undefined;
    resolved ??= await this.resolveExtensions();
    const caps = rt.init?.agentCapabilities?.mcpCapabilities;
    const servers: McpServer[] = [];
    for (const server of resolved?.acp?.mcpServers ?? []) {
      const transport = "type" in server ? server.type : "stdio";
      if ((transport === "http" && caps?.http !== true) || (transport === "sse" && caps?.sse !== true)) {
        this.options.onStderr?.(`ruah extensions: ${server.name}: this agent does not support ${transport} MCP servers; skipped\n`);
        continue;
      }
      servers.push(server);
    }
    return servers;
  }

  /** The ruah_* map tools as a stdio MCP server for session/new and session/load (CONTRACTS §1.7). */
  private async mapToolsServer(): Promise<StdioMcpServerSpec | undefined> {
    const tools = this.options.mapTools;
    if (tools === undefined) return undefined;
    try {
      return await tools.stdio();
    } catch (err) {
      this.options.onStderr?.(`ruah: map tools unavailable (${errorMessage(err)})\n`);
      return undefined;
    }
  }

  private readModes(response: NewSessionResponse): void {
    const legacy = parseModeState(response.modes);
    if (legacy !== undefined) {
      this.modes = legacy;
      this.modeSelector = { kind: "legacy" };
      return;
    }
    const config = parseModeConfigOption(response.configOptions);
    this.modes = config?.state;
    this.modeSelector = config !== undefined ? { kind: "config", configId: config.configId } : undefined;
  }

  private readModels(response: NewSessionResponse): void {
    const config = parseModelConfigOption(response.configOptions);
    if (config !== undefined) {
      this.models = config.state;
      this.modelSelector = { kind: "config", configId: config.configId };
      return;
    }
    const legacy = parseLegacyModels((response as { models?: unknown }).models);
    this.models = legacy;
    this.modelSelector = legacy !== undefined ? { kind: "legacy" } : undefined;
  }

  /** Sends the switch to the agent and records the model state it reports back. */
  private async applyModel(rt: Runtime, sessionId: string, modelId: string): Promise<void> {
    const selector = this.modelSelector;
    if (selector === undefined) throw new Error("agent does not offer model selection");
    let next: ModelState | undefined;
    if (selector.kind === "config") {
      const response = await rt.conn.agent.request("session/set_config_option", { sessionId, configId: selector.configId, value: modelId });
      next = parseModelConfigOption(response.configOptions)?.state;
    } else {
      // Not in the 1.x method map; the untyped request() overload sends it as-is.
      await rt.conn.agent.request("session/set_model", { sessionId, modelId });
    }
    if (sessionId !== this.sessionId || this.models === undefined) return;
    this.setModels(next ?? { ...this.models, currentModelId: modelId });
  }

  /** After reset / respawn: put the user's chosen model back on the new session. Best effort. */
  private async reapplyModel(rt: Runtime, sessionId: string): Promise<void> {
    const chosen = this.chosenModel;
    const models = this.models;
    if (chosen === undefined || models === undefined || models.currentModelId === chosen) return;
    if (!models.available.some((model) => model.id === chosen)) return;
    try {
      await this.raceExit(rt, this.applyModel(rt, sessionId, chosen));
    } catch (err) {
      this.options.onStderr?.(`ruah: could not re-apply model ${chosen}: ${errorMessage(err)}\n`);
    }
  }

  private setModes(next: ModeState): void {
    if (sameSelectState(next, this.modes)) return;
    this.modes = next;
    if (this.state === "idle" || this.state === "busy") this.emitStatus(this.state);
  }

  private setModels(next: ModelState): void {
    if (sameSelectState(next, this.models)) return;
    this.models = next;
    // Starting/error states carry no models; the next idle/busy status does.
    if (this.state === "idle" || this.state === "busy") this.emitStatus(this.state);
  }

  /** Node-hosted adapters are named after their script, native CLIs after the binary. */
  private fallbackAgentName(): string {
    const { command, args } = this.options.preset;
    return path.basename(command === process.execPath ? (args[0] ?? command) : command);
  }

  private canCloseSession(rt: Runtime): boolean {
    const caps: unknown = rt.init?.agentCapabilities?.sessionCapabilities;
    return typeof caps === "object" && caps !== null && "close" in caps && (caps as { close?: unknown }).close != null;
  }

  /** Rejects as soon as the agent process exits, so no request hangs on a dead child. */
  private raceExit<T>(rt: Runtime, promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      rt.proc.exited.then((exit): never => {
        throw new Error(describeExit(exit, rt.proc.stderrTail()));
      }),
    ]);
  }

  private onExit(rt: Runtime, exit: AgentExit): void {
    // Startup failures and intentional kills are reported by their own paths.
    if (rt.retiring || !rt.ready || this.runtime !== rt) return;
    this.runtime = undefined;
    rt.session?.dispose();
    rt.conn.close();
    const message = describeExit(exit, rt.proc.stderrTail());
    this.state = "error";
    for (const pending of [...this.permissions.values()]) pending.settle({ cancelled: true });
    if (this.turn !== undefined) this.finishTurn(this.turn, "error", message);
    this.emitStatus("error", message);
    // CONTRACTS ErrorCode agent_exited: fatal until the daemon respawns; it retries once.
    if (!this.stopRequested && this.crashRespawns < 1) {
      this.crashRespawns += 1;
      this.start().catch(() => {});
    }
  }

  private async retireAfterCancelTimeout(rt: Runtime, turn: ActiveTurn): Promise<void> {
    rt.retiring = true;
    this.runtime = undefined;
    const message = `agent did not finish cancellation within ${Math.round(this.cancelTimeoutMs / 1000)} s; its process was stopped and restarted`;
    this.state = "error";
    for (const pending of [...this.permissions.values()]) pending.settle({ cancelled: true });
    this.finishTurn(turn, "error", message);
    this.emitStatus("error", message);
    rt.session?.dispose();
    rt.conn.close();
    await rt.proc.kill(this.killGraceMs);
    if (!this.stopRequested) await this.start().catch(() => {});
  }

  // ---------- turns ----------

  private async dispatch(turn: ActiveTurn, blocks: ContentBlock[]): Promise<void> {
    try {
      if (this.starting !== undefined) await this.starting;
      else if (this.runtime?.session === undefined) await this.start();
    } catch (err) {
      this.finishTurn(turn, "error", errorMessage(err));
      return;
    }
    if (turn.finished) return;
    const session = this.runtime?.session;
    if (session === undefined) {
      this.finishTurn(turn, "error", `agent is ${this.state}`);
      return;
    }
    if (turn.cancelRequested) {
      this.finishTurn(turn, "cancelled");
      return;
    }
    if (this.state !== "busy") this.emitStatus("busy");
    turn.dispatched = true;
    turn.costAtStart = this.sessionCostUsd;
    // The outcome (stop or JSON-RPC error) arrives in order through the session
    // queue that pump() drains; this promise only needs a handler.
    session.prompt(blocks).catch(() => {});
  }

  /** Drains the ActiveSession queue for the life of the session: updates in arrival order, then the prompt's stop. */
  private async pump(rt: Runtime, session: ActiveSession): Promise<void> {
    for (;;) {
      let message: Awaited<ReturnType<ActiveSession["nextUpdate"]>>;
      try {
        message = await session.nextUpdate();
      } catch (err) {
        // Disposed (reset/stop) or connection closed (exit path owns reporting).
        if (rt.session !== session || rt.conn.signal.aborted || rt.proc.hasExited) return;
        // session/prompt returned a JSON-RPC error (t3code mapAcpToAdapterError: request error bucket).
        if (this.turn !== undefined && this.turn.dispatched) this.finishTurn(this.turn, "error", errorMessage(err));
        continue;
      }
      if (rt.session !== session) return;
      if (message.kind === "stop") {
        const turn = this.turn;
        if (turn !== undefined && turn.dispatched) {
          const cost = this.sessionCostUsd === undefined ? undefined : this.sessionCostUsd - (turn.costAtStart ?? 0);
          const usage = acpTurnUsage(message.response, cost !== undefined && cost >= 0 ? cost : this.sessionCostUsd, this.models?.currentModelId);
          this.finishTurn(turn, mapStopReason(message.stopReason), undefined, usage);
        }
        continue;
      }
      this.onSessionUpdate(message.notification);
    }
  }

  private onSessionUpdate(notification: SessionNotification): void {
    // One bridge projects one root ACP session (t3code root-session filter); replays are skipped.
    if (notification.sessionId !== this.sessionId || sessionUpdateIsReplay(notification)) return;
    const update = notification.update;
    if (update.sessionUpdate === "usage_update") {
      if (update.cost?.currency === "USD" && Number.isFinite(update.cost.amount)) this.sessionCostUsd = update.cost.amount;
      const meta = update._meta ?? undefined;
      const info = meta !== undefined ? meta["_claude/rateLimit"] : undefined;
      if (isRecord(info)) {
        const sample: RateLimitSample = {
          ...(typeof info.status === "string" ? { status: info.status } : {}),
          ...(typeof info.rateLimitType === "string" ? { rateLimitType: info.rateLimitType } : {}),
          ...(typeof info.utilization === "number" ? { utilization: info.utilization } : {}),
          ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
        };
        this.emit({ type: "rate_limit", info: sample });
      }
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      const next = applyModeChange(this.modes, update.currentModeId);
      if (next !== undefined && next !== this.modes) {
        this.modes = next;
        this.emitStatus(this.state);
      }
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      // The agent can change the model itself (or the user via another client).
      const config = this.modelSelector?.kind === "legacy" ? undefined : parseModelConfigOption(update.configOptions);
      if (config !== undefined) {
        this.modelSelector = { kind: "config", configId: config.configId };
        this.setModels(config.state);
      }
      const modes = this.modeSelector?.kind === "config" ? parseModeConfigOption(update.configOptions) : undefined;
      if (modes !== undefined) this.setModes(modes.state);
      return;
    }
    const turn = this.turn;
    if (turn === undefined || turn.finished) return;
    for (const event of turn.normalizer.normalize(update)) {
      this.emit({ type: "stream", turnId: turn.turnId, event });
    }
  }

  private finishTurn(turn: ActiveTurn, stopReason: StopReason, error?: string, usage?: TurnUsage): void {
    if (turn.finished) return;
    turn.finished = true;
    if (this.turn === turn) this.turn = undefined;
    for (const pending of [...this.permissions.values()]) {
      if (pending.turnId === turn.turnId) pending.settle({ cancelled: true });
    }
    // Agents that ignore cancellation semantics may still answer end_turn.
    const reason: StopReason = turn.cancelRequested && stopReason !== "error" ? "cancelled" : stopReason;
    if (reason === "end_turn") this.crashRespawns = 0;
    const result: TurnResult = error !== undefined ? { stopReason: reason, error } : { stopReason: reason };
    this.emit({ type: "turn_finished", turnId: turn.turnId, ...result, ...(usage !== undefined ? { usage } : {}) });
    turn.resolve(result);
    if (this.state === "busy") this.emitStatus("idle");
  }

  // ---------- permissions (t3code CursorAdapter pending-approval map) ----------

  private onPermissionRequest(rt: Runtime, params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const turn = this.turn;
    if (rt !== this.runtime || turn === undefined || turn.finished || turn.cancelRequested || params.sessionId !== this.sessionId) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    // The ruah_* map tools (CONTRACTS §1.7) run without asking the user, as with Claude: they only
    // touch architecture.json through the daemon and a turn's map changes can be undone.
    const mapAllow = this.mapToolPermission(params);
    if (mapAllow !== undefined) return Promise.resolve({ outcome: { outcome: "selected", optionId: mapAllow } });
    this.permCounter += 1;
    const requestId = `perm_${this.permCounter}`;
    const toolCall = turn.normalizer.permissionView(params.toolCall);
    // Option ids are agent-defined: relay verbatim, never invent (BORROW §2.4).
    const options: PermissionOption[] = params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    return new Promise<RequestPermissionResponse>((resolve) => {
      const onAbort = (): void => pending.settle({ cancelled: true });
      const pending: PendingPermission = {
        requestId,
        turnId: turn.turnId,
        optionIds: new Set(options.map((o) => o.optionId)),
        settle: (answer) => {
          if (!this.permissions.delete(requestId)) return;
          signal.removeEventListener("abort", onAbort);
          if ("cancelled" in answer) {
            this.emit({ type: "permission_resolved", turnId: turn.turnId, requestId, cancelled: true });
            resolve({ outcome: { outcome: "cancelled" } });
          } else {
            this.emit({ type: "permission_resolved", turnId: turn.turnId, requestId, optionId: answer.optionId });
            resolve({ outcome: { outcome: "selected", optionId: answer.optionId } });
          }
        },
      };
      this.permissions.set(requestId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "permission", turnId: turn.turnId, requestId, toolCall, options });
    });
  }

  /**
   * The allow-once option when the request is for one of our map tools. Agents name MCP tools
   * after the server ("ruah-ruah_apply: …" in Cursor, "mcp__ruah__ruah_apply" in Claude's adapter).
   */
  private mapToolPermission(params: RequestPermissionRequest): string | undefined {
    const tools = this.options.mapTools;
    if (tools === undefined) return undefined;
    const title = params.toolCall.title ?? "";
    const match = /(?:^|\b)(?:mcp__)?ruah(?:__|[-_:.\s]+)(ruah_[a-z_]+)\b/.exec(title);
    if (match === null || !tools.allowedTools.includes(`mcp__ruah__${match[1]}`)) return undefined;
    return params.options.find((o) => o.kind === "allow_once")?.optionId ?? params.options.find((o) => o.kind === "allow_always")?.optionId;
  }

  // ---------- events ----------

  private emitStatus(state: AgentState, error?: string): void {
    this.state = state;
    const event: Extract<BridgeEvent, { type: "status" }> = { type: "status", state };
    // Ready states carry the full picture so a late subscriber (or a mode change
    // mid-turn) never needs an earlier frame.
    if (state === "idle" || state === "busy") {
      if (this.agentInfo !== undefined) event.agent = { ...this.agentInfo };
      if (this.sessionId !== undefined) event.sessionId = this.sessionId;
      if (this.modes !== undefined) event.modes = this.modes;
      if (this.models !== undefined) event.models = this.models;
    }
    if (error !== undefined) event.error = error;
    this.emit(event);
  }

  private emit(event: BridgeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty listener must not break the bridge.
      }
    }
  }
}
