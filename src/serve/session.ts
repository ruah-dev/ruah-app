// src/serve/session.ts — per-socket state machine (CONTRACTS.md §2.2 rules
// 1–6, 8–9) plus the hub: the open project (store + watcher, swappable at
// runtime, CONTRACTS §5), the current agent bridge (from a warm BridgePool,
// see bridge-pool.ts), the one active turn, and the chats of the open project
// (every turn is recorded into the active chat). Several sockets may connect;
// all receive broadcasts. agent.set swaps the bridge for another agent's
// (AgentSwitcher, e.g. AgentCatalog). Other agents are pre-warmed in the
// background (agent.prewarm, and the agents a project used before) so a switch
// is a swap; a prompt sent while the current agent starts waits in a one-slot
// queue. Saved defaults (settings.json: agent, model and mode per agent) are
// applied to every new agent session.
//
// Background agents (CONTRACTS §13.1): switching projects no longer cancels
// a running (or queued) turn. Its bridge stays pinned in the pool, its events
// are still recorded into its chat, and the activity feed (activity.ts)
// reports it to every viewer. Opening that project again re-attaches: the
// same agent becomes current, the turn's chat becomes active, chat.history
// carries the turn so far (`running: true`) and a pending permission request
// is sent again. At most maxBackgroundTurns run outside the open project;
// beyond that (or with settings.json backgroundAgents: false) a switch
// cancels as before.
import { createHash, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AgentChoiceState,
  AgentDefaults,
  AttachmentMeta,
  ClientMessage,
  ErrorCode,
  AgentState,
  AppFeatures,
  ModeState,
  ModelState,
  PermissionOption,
  ProjectInfo,
  ServerMessage,
  StopReason,
  ToolCallView,
  TurnRecord,
  WarmState,
} from "../contracts/ws.js";
import { DEFAULT_MAX_BACKGROUND_TURNS, editedFiles, type ActivityContext, type ActivityService } from "./activity.js";
import { DEFAULT_FEATURES, type FeaturesPatch } from "../projects/settings-store.js";
import { ClientMessageSchema } from "../contracts/ws.js";
import type { AcpBridge, BridgeEvent } from "../acp/bridge.js";
import { BusyError } from "../acp/bridge.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { buildContextPack, buildPromptBlocks } from "../context/pack.js";
import { resolveNodeScope } from "../expand/context.js";
import type { ArchitectureStore } from "./architecture-store.js";
import type { UsageSink } from "../usage/index.js";
import { BridgePool, DEFAULT_MAX_LIVE_BRIDGES, type BridgeStatus, type PooledBridge } from "./bridge-pool.js";
import { appendStreamEvent, type ChatStore } from "../projects/chat-store.js";
import type { AttachmentStore } from "../projects/attachment-store.js";
import type { SettingsStore } from "../projects/settings-store.js";
import { BUILT_IN_DEFAULT_MODES, builtInDefaultMode } from "../acp/default-modes.js";
import type { MapChange } from "../contracts/map.js";

const MAX_FRAME_BYTES = 1_048_576;
/** How long a running turn survives with no viewer connected (page reloads reconnect well within it). */
export const DISCONNECT_GRACE_MS = Number.parseInt(process.env.RUAH_DISCONNECT_GRACE_MS ?? "5000", 10);
/** Same id as src/acp/index.ts MOCK_AGENT_ID (not imported: index.ts pulls in every bridge). */
const MOCK_AGENT_ID = "mock";
export const NO_PROJECT_MESSAGE = "no project open";
/** Delay between a project opening (current agent idle) and pre-warming the agents it used before. */
export const DEFAULT_AUTO_PREWARM_DELAY_MS = 3000;
/** How many previously used agents a project open pre-warms. */
const AUTO_PREWARM_MAX = 2;
/** A pre-warm that failed (e.g. not logged in) is not tried again for this long (agent.set always tries). */
export const DEFAULT_PREWARM_RETRY_MS = 5 * 60_000;

/** Builds bridges for agent.set and project switches. AgentCatalog (src/acp/index.ts) implements it. */
export interface AgentSwitcher {
  choices(currentAgentId: string): AgentChoiceState;
  check(agentId: string): { ok: true } | { ok: false; code: ErrorCode; message: string };
  /** A new, not started bridge whose session cwd is `root`. */
  create(agentId: string, root?: string): AcpBridge;
}

/** An opened project: what the hub serves and where the agent works. */
export interface ProjectRuntime {
  info: ProjectInfo;
  store: ArchitectureStore;
  /** Why the architecture file did not load (sent as architecture.error). */
  loadError?: string | undefined;
}

export interface SessionHubOptions {
  version: string;
  links: boolean;
  debug: (line: string) => void;
  info: (line: string) => void;
  /** Id of the agent behind the initial bridge (agents.currentAgentId). */
  agentId?: string;
  /** Enables agent.set, agent.status.agents and bridges for newly opened projects. */
  agents?: AgentSwitcher;
  /** Receives every finished turn and streamed rate-limit reading (usage log + limits). */
  usage?: UsageSink;
  /** Runs ruah-verify after agent turns (optional). */
  engines?: { afterTurn(nodeId: string | undefined): void };
  /** Enables chats (CONTRACTS §5): turns are recorded into the active chat. */
  chats?: ChatStore;
  /** ProjectInfo for the store passed to the constructor (default: derived from store.root). */
  project?: ProjectInfo;
  /** How long a bridge the hub let go stays warm (default 0 = stop at once). */
  warmTtlMs?: number;
  /** Cap on live bridges, warm ones included (default 2). */
  maxLiveBridges?: number;
  /** Enables image attachments on prompts (CONTRACTS §5.6). */
  attachments?: AttachmentStore;
  /** Saved defaults (agent, model and mode per agent); without it only the built-in default modes apply. */
  settings?: SettingsStore;
  /** Pre-warming of other agents (agent.prewarm + automatic); needs warmTtlMs > 0. Default true. */
  prewarm?: boolean;
  /** Delay before a project open pre-warms its previously used agents (default 3 s; < 0 = never). */
  autoPrewarmDelayMs?: number;
  /** How long a failed pre-warm is not retried (default 5 min). */
  prewarmRetryMs?: number;
  /** Agents edit the map through the ruah_* tools (CONTRACTS §1.7): context-pack hint + per-turn undo. */
  mapOps?: { undoTurn(turnId: string): Promise<{ changes: MapChange[]; skipped: string[] }> };
  /** §9 cloud watch mode: `cloud.watch` frames (and closed sockets) register viewers; optional. */
  cloudWatch?: { watch(viewer: unknown, on: boolean): void; projectChanged?(): void };
  /** §13.2 activity feed: events, live counts, unread markers, snapshot after hello. */
  activity?: ActivityService;
  /** §13.1 turns allowed to keep running outside the open project (default 3; at most maxLiveBridges - 1). */
  maxBackgroundTurns?: number;
}

/** A daemon-started turn (runTaskTurn): its id at once (to cancel it), its answer when it finishes. */
export interface TaskTurn {
  turnId: string;
  result: Promise<TaskTurnResult>;
}

/** A permission request a running turn waits on (answered with permission.response). */
export interface PendingPermission {
  requestId: string;
  toolCall: ToolCallView;
  options: PermissionOption[];
}

/** What a daemon-started turn (runTaskTurn) answered. */
export interface TaskTurnResult {
  turnId: string;
  /** The agent's text, all text chunks joined. */
  text: string;
  stopReason: StopReason;
  error?: string;
}

/** A prompt that arrived while its agent was starting: sent once it is idle (one per bridge). */
interface QueuedTurn {
  turnId: string;
  entry: PooledBridge;
  blocks: ContentBlock[];
  socket: WebSocket;
  started: Extract<ServerMessage, { type: "turn.started" }>;
}


interface OpenProject extends ProjectRuntime {
  unsubscribe: (() => void)[];
}

/** A turn being recorded: stored in its chat when it finishes (or is detached). */
interface RecordingTurn {
  entry: PooledBridge;
  projectId: string;
  projectName: string;
  root: string;
  chatId: string | null;
  record: TurnRecord;
  startedAtMs: number;
  /** Persisted and announced already (detached by a switch); the bridge's own finish only records usage. */
  finalized: boolean;
  /** Permission requests waiting for an answer (re-sent when the viewer re-attaches, §13.1). */
  pending: Map<string, { toolCall: ToolCallView; options: PermissionOption[] }>;
}


/** ProjectInfo for a store opened without the projects service (tests, legacy callers). */
export function projectInfoForStore(store: ArchitectureStore): ProjectInfo {
  return {
    id: createHash("sha1").update(store.root).digest("hex").slice(0, 12),
    name: store.current()?.name ?? store.root.split(/[\\/]/).filter(Boolean).at(-1) ?? store.root,
    root: store.root,
    kind: "repo",
    lastOpenedAt: new Date().toISOString(),
  };
}

// One per daemon: owns the project, the bridge and the single active turn.
export class SessionHub {
  readonly sockets = new Set<WebSocket>();
  private readonly pool: BridgePool;
  private open: OpenProject | null = null;
  private entry: PooledBridge | undefined;
  /** Status shown while no bridge is attached (launcher state, failed creation). */
  private detachedStatus: BridgeStatus = { state: "stopped" };
  private currentAgentId: string;
  private switching = false;
  private activeTurn: string | undefined;
  private readonly turns = new Map<string, RecordingTurn>();
  private activeChatId: string | null = null;
  /** Active chat per project id, so switching back restores it. */
  private readonly lastChat = new Map<string, string | null>();
  /** Image support last reported by each agent's bridge (ACP: known after initialize). */
  private readonly imageSupport = new Map<string, boolean>();
  /** Agent the daemon started with (defaults.agentId when none is saved). */
  private readonly startupAgentId: string;
  /** This daemon session's model / mode choice per (project root, agent): wins over the saved default. */
  private readonly sessionModels = new Map<string, string>();
  private readonly sessionModes = new Map<string, string>();
  /** Models / modes last reported per agent (shown for agents that are not current). */
  private readonly knownModels = new Map<string, ModelState>();
  private readonly knownModes = new Map<string, ModeState>();
  /** Failed pre-warms per (root, agent): stay cold with the reason, no retry for prewarmRetryMs. */
  private readonly prewarmFailures = new Map<string, { error: string; at: number }>();
  private prewarmQueue: string[] = [];
  private prewarmRunning = false;
  private autoPrewarm: { projectId: string; timer: NodeJS.Timeout | undefined } | undefined;
  /** Prompts waiting for their agent to be idle, per bridge (the current one's, and background ones). */
  private readonly queue = new Map<PooledBridge, QueuedTurn>();
  /** Last state seen per bridge (agent.error is reported on the change to "error"). */
  private readonly lastStates = new WeakMap<PooledBridge, AgentState>();
  private readonly maxLive: number;
  /** Warm-state fingerprint of the last broadcast agent.status (re-broadcast when it changes). */
  private lastWarmSignature = "";
  /** Daemon-started turns (runTaskTurn) waiting for their answer. */
  private readonly taskWaiters = new Map<string, (result: TaskTurnResult) => void>();

  constructor(
    store: ArchitectureStore | null,
    bridge: AcpBridge | null,
    readonly options: SessionHubOptions,
  ) {
    this.currentAgentId = options.agentId ?? "unknown";
    this.startupAgentId = this.currentAgentId;
    this.maxLive = Math.max(1, options.maxLiveBridges ?? DEFAULT_MAX_LIVE_BRIDGES);
    this.pool = new BridgePool({
      create: (agentId, root) => {
        if (options.agents === undefined) throw new Error("agent switching is not available");
        return options.agents.create(agentId, root);
      },
      onEvent: (entry, event) => this.onBridgeEvent(entry, event),
      ttlMs: options.warmTtlMs ?? 0,
      maxLive: this.maxLive,
      debug: options.debug,
    });
    options.activity?.attach((message) => this.broadcast(message));
    if (store !== null) {
      const info = options.project ?? projectInfoForStore(store);
      this.open = this.attachProject({ info, store });
      this.activeChatId = this.initialChat(info.id);
    }
    if (bridge !== null) {
      // run-serve may start the bridge before the hub exists, so its initial
      // status event can be gone; the pool seeds from bridge.status().
      this.entry = this.pool.adopt(store?.root ?? "", this.currentAgentId, bridge);
      this.entry.chatId = this.activeChatId;
    }
  }

  version(): string {
    return this.options.version;
  }

  /** The open project's architecture store; null in the launcher state. */
  get store(): ArchitectureStore | null {
    return this.open?.store ?? null;
  }

  project(): ProjectInfo | null {
    return this.open?.info ?? null;
  }

  /** The current agent's bridge (changes on agent.set and project switches); undefined without a project. */
  get bridge(): AcpBridge | undefined {
    return this.entry?.bridge;
  }

  agentId(): string {
    return this.currentAgentId;
  }

  chatId(): string | null {
    return this.activeChatId;
  }

  /** Live bridges (the current one plus warm ones). */
  liveBridges(): number {
    return this.pool.size;
  }

  // ---------- projects (CONTRACTS §5) ----------

  /**
   * Swaps the open project (null = launcher state): the active turn keeps
   * running in the background (§13.1; else it is recorded and cancelled),
   * closes the old store and its watcher, parks the old bridge in the warm
   * pool, then broadcasts project, architecture, chats (+ the active chat's
   * history) and agent.status. The new project's agent starts in the
   * background (agent.status starting → idle); a warm one is reused. A
   * project with a background turn is re-attached: its agent becomes current
   * and the turn's chat active.
   */
  setProject(next: ProjectRuntime | null): void {
    this.parkActiveTurn();
    const previous = this.open;
    if (previous !== null) {
      for (const unsubscribe of previous.unsubscribe) unsubscribe();
      previous.store.close();
      this.lastChat.set(previous.info.id, this.activeChatId);
      this.options.activity?.markViewed(previous.info.id);
    }
    const previousEntry = this.entry;
    this.entry = undefined;
    if (previousEntry !== undefined) {
      void this.pool.release(previousEntry).catch((err: unknown) => this.options.debug(`bridge release failed: ${String(err)}`));
    }
    this.open = next !== null ? this.attachProject(next) : null;
    const resumed = next !== null ? this.backgroundTurns().find((r) => r.projectId === next.info.id) : undefined;
    if (resumed !== undefined) {
      // Re-attach (§13.1): the agent running the turn is current again, on the turn's chat.
      this.currentAgentId = resumed.entry.agentId;
      this.activeChatId = resumed.chatId;
      if (next !== null && resumed.chatId !== null) this.options.chats?.setActiveChat(next.info.id, resumed.chatId);
    } else {
      this.activeChatId = next !== null ? this.initialChat(next.info.id) : null;
    }
    this.detachedStatus = { state: "stopped" };
    this.prewarmQueue = [];
    this.cancelAutoPrewarm();

    this.broadcast({ type: "project", project: this.project() });
    if (next !== null) {
      const arch = this.architectureMessage("initial");
      if (arch !== undefined) this.broadcast(arch);
      else if (next.loadError !== undefined) this.broadcast({ type: "architecture.error", path: next.store.path, message: next.loadError });
    }
    this.broadcastChats();
    this.broadcastHistory();
    if (next !== null) this.activateBridge();
    if (resumed !== undefined && this.entry === resumed.entry) {
      this.activeTurn = resumed.record.turnId;
      this.options.debug(`turn ${resumed.record.turnId} re-attached`);
      for (const message of this.pendingPermissionMessages()) this.broadcast(message);
    }
    this.broadcastStatus();
    this.options.cloudWatch?.projectChanged?.();
    if (next !== null) {
      if (this.sockets.size > 0) this.options.activity?.markRead(next.info.id, this.activeChatId);
      this.autoPrewarm = { projectId: next.info.id, timer: undefined };
      this.maybeAutoPrewarm();
    }
  }

  // ---------- background turns (§13.1) ----------

  features(): AppFeatures {
    return this.options.settings?.features() ?? this.options.activity?.features() ?? DEFAULT_FEATURES;
  }

  /** How many turns may run outside the open project (0 = background agents off). */
  maxBackgroundTurns(): number {
    if (!this.features().backgroundAgents) return 0;
    const wanted = this.options.maxBackgroundTurns ?? this.options.activity?.maxBackgroundTurns() ?? DEFAULT_MAX_BACKGROUND_TURNS;
    return Math.max(0, Math.min(wanted, this.maxLive - 1));
  }

  /** Turns running or queued on a bridge that is not the current one (not finalized). */
  backgroundTurns(): RecordingTurn[] {
    return [...this.turns.values()].filter((r) => !r.finalized && r.entry !== this.entry);
  }

  /** Whether any turn runs or waits (current or background). */
  hasRunningTurns(): boolean {
    return [...this.turns.values()].some((r) => !r.finalized) || this.queue.size > 0;
  }

  /**
   * Leaving the project with a turn running (or queued): it goes on in the
   * background when allowed and under the limit, else it is detached
   * (stored and announced as cancelled) like before.
   */
  private parkActiveTurn(): void {
    const turnId = this.activeTurn;
    const recording = turnId !== undefined ? this.turns.get(turnId) : undefined;
    if (turnId === undefined || recording === undefined || recording.finalized || this.open === null) {
      this.detachActiveTurn();
      return;
    }
    const max = this.maxBackgroundTurns();
    if (max === 0) {
      this.detachActiveTurn();
      return;
    }
    if (this.backgroundTurns().length >= max) {
      this.options.info(`${max} turn(s) already run in the background; cancelling ${turnId}`);
      this.detachActiveTurn(`cancelled: ${max} turn${max === 1 ? "" : "s"} already run in other projects (background limit)`);
      return;
    }
    this.activeTurn = undefined;
    this.options.debug(`turn ${turnId} continues in the background (${recording.projectId})`);
  }

  /** Whether the user is not looking at the turn: another project or chat is open, or no viewer is connected. */
  private isBackground(recording: RecordingTurn): boolean {
    return recording.projectId !== this.open?.info.id || recording.chatId !== this.activeChatId || this.sockets.size === 0;
  }

  private activityContext(recording: RecordingTurn): ActivityContext {
    return {
      projectId: recording.projectId,
      projectName: recording.projectName,
      projectRoot: recording.root,
      chatId: recording.chatId,
      turnId: recording.record.turnId,
      agentId: recording.entry.agentId,
      prompt: recording.record.text,
    };
  }

  /** permission.request frames for the open project's running turns that wait for an answer. */
  private pendingPermissionMessages(): ServerMessage[] {
    const out: ServerMessage[] = [];
    for (const recording of this.turns.values()) {
      if (recording.finalized || recording.entry !== this.entry || recording.projectId !== this.open?.info.id) continue;
      for (const [requestId, request] of recording.pending) {
        out.push({ type: "permission.request", turnId: recording.record.turnId, requestId, toolCall: request.toolCall, options: request.options });
      }
    }
    return out;
  }

  /** permission.response: routed to the bridge whose turn asked (any project), else the current bridge. */
  answerPermission(requestId: string, answer: { optionId: string } | { cancelled: true }): boolean {
    for (const recording of this.turns.values()) {
      if (!recording.finalized && recording.pending.has(requestId)) return recording.entry.bridge.answerPermission(requestId, answer);
    }
    return this.entry?.bridge.answerPermission(requestId, answer) ?? false;
  }

  // ---------- activity, focus, view state, feature flags (§13) ----------

  /** focus.set: remembered as the project's last focused element (resume). */
  setFocus(nodeId: string | null): void {
    const open = this.open;
    if (open === null || nodeId === null) return;
    this.options.chats?.state.setFocus(open.info.id, nodeId);
  }

  /** view.save: the viewer's opaque view state for a project (≤ 16 KB). */
  saveView(projectId: string, view: unknown, socket?: WebSocket): void {
    const state = this.options.chats?.state;
    if (state === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", "view state is not available");
      return;
    }
    const problem = state.setView(projectId, view);
    if (problem !== undefined && socket !== undefined) this.error(socket, "bad_message", `view.save: ${problem}`);
  }

  /** activity.read: clears unread markers. */
  markRead(projectId: string, chatId?: string): void {
    this.options.activity?.markRead(projectId, chatId);
  }

  /** settings.set: feature flags in settings.json; every viewer gets a new activity.snapshot. */
  setFeatures(patch: FeaturesPatch, socket?: WebSocket): void {
    const settings = this.options.settings;
    if (settings === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", "settings are not available");
      return;
    }
    settings.updateFeatures(patch);
    this.options.activity?.broadcastSnapshot();
  }

  private attachProject(runtime: ProjectRuntime): OpenProject {
    const { store } = runtime;
    const unsubscribe = [
      store.onChange((event) => {
        if (this.open?.store !== store) return;
        this.broadcast({
          type: "architecture",
          reason: event.reason,
          revision: event.revision,
          root: store.root,
          path: store.path,
          architecture: event.architecture,
          ...(event.by !== undefined ? { by: event.by } : {}),
          ...(event.changes !== undefined ? { changes: event.changes } : {}),
        });
      }),
      store.onError((error) => {
        if (this.open?.store !== store) return;
        this.broadcast({ type: "architecture.error", path: error.path, message: error.message });
      }),
    ];
    return { ...runtime, unsubscribe };
  }

  private initialChat(projectId: string): string | null {
    const chats = this.options.chats;
    if (chats === undefined) return null;
    // Persisted in state.json (survives restarts; set ahead by "open project at chat").
    const persisted = chats.activeChat(projectId);
    if (persisted !== undefined) return persisted;
    const remembered = this.lastChat.get(projectId);
    if (remembered !== undefined && (remembered === null || chats.get(projectId, remembered) !== undefined)) return remembered;
    return chats.list(projectId)[0]?.id ?? null;
  }

  /** Takes (or creates) the current agent's bridge for the open project and starts it in the background. */
  private activateBridge(): void {
    const open = this.open;
    if (open === null) return;
    let acquired: { entry: PooledBridge; fresh: boolean };
    try {
      acquired = this.pool.acquire(open.store.root, this.currentAgentId);
    } catch (err) {
      this.detachedStatus = { state: "error", error: (err as Error).message };
      return;
    }
    const { entry, fresh } = acquired;
    this.entry = entry;
    void (async () => {
      if (entry.starting !== undefined) await entry.starting.catch(() => {});
      await this.bindSession(entry);
      const state = entry.bridge.status();
      if (fresh || state === "stopped" || state === "error") await this.pool.start(entry);
    })().catch((err: unknown) => {
      this.options.debug(`${entry.agentId} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Points the bridge's agent session at the active chat: the chat's stored
   * session for this agent is resumed; a chat without one gets a fresh session
   * unless the bridge's session is still empty.
   */
  private async bindSession(entry: PooledBridge, chatId: string | null = this.entry === entry ? this.activeChatId : entry.chatId ?? null): Promise<void> {
    if (entry.chatId === chatId) return;
    const projectId = this.open?.info.id;
    const desired = chatId !== null && projectId !== undefined ? this.options.chats?.get(projectId, chatId)?.sessions?.[entry.agentId] : undefined;
    entry.chatId = chatId;
    if (desired !== undefined) {
      entry.used = true;
      if (desired !== entry.status.sessionId && entry.bridge.useSession !== undefined) await entry.bridge.useSession(desired);
      return;
    }
    if (!entry.used) return;
    entry.used = false;
    if (entry.bridge.useSession !== undefined) await entry.bridge.useSession(undefined);
    else if (entry.bridge.status() !== "stopped") await entry.bridge.reset();
  }

  // ---------- agents ----------

  /**
   * agent.set: the current agent's active turn finishes "cancelled"; the agent
   * is parked warm (or stopped when the pool keeps nothing warm) and the new
   * one is taken from the pool — a pre-warmed, idle one becomes current at
   * once (agent.status idle in the same tick), one that is still starting is
   * attached to (no second process) — or started with a fresh session. An
   * unknown or uninstalled agent is rejected before anything is torn down. A
   * new agent that fails to start is left in state "error" (its status
   * carries the reason); the viewer can pick another agent. The choice is
   * saved as the default agent.
   */
  async switchAgent(agentId: string, socket?: WebSocket): Promise<void> {
    const agents = this.options.agents;
    const fail = (code: string, message: string): void => {
      if (socket !== undefined) this.error(socket, code, message);
    };
    if (agents === undefined) return fail("bad_message", "agent switching is not available");
    if (this.switching) return fail("busy", "an agent switch is already in progress");
    const check = agents.check(agentId);
    if (!check.ok) return fail(check.code, check.message);
    const state = this.agentState();
    if (agentId === this.currentAgentId && (state === "idle" || state === "busy")) {
      this.broadcastStatus();
      return;
    }
    const open = this.open;
    if (open === null) {
      // Launcher state: remembered for the next project.
      this.currentAgentId = agentId;
      this.saveDefaultAgent(agentId);
      this.broadcastStatus();
      return;
    }
    let acquired: { entry: PooledBridge; fresh: boolean };
    try {
      acquired = this.pool.acquire(open.store.root, agentId);
    } catch (err) {
      return fail("agent_spawn_failed", (err as Error).message);
    }
    this.switching = true;
    this.detachActiveTurn();
    const previous = this.entry;
    const next = acquired.entry;
    this.entry = next;
    this.currentAgentId = agentId;
    this.prewarmQueue = this.prewarmQueue.filter((id) => id !== agentId);
    this.prewarmFailures.delete(this.key(open.store.root, agentId));
    this.saveDefaultAgent(agentId);
    this.broadcastStatus();
    const how = acquired.fresh ? "cold start" : next.status.state === "idle" ? "warm, ready" : `warm, ${next.status.state}`;
    this.options.info(`switching agent to ${agentId} (${how})`);
    try {
      if (previous !== undefined && previous !== next) {
        try {
          await this.pool.release(previous);
        } catch (err) {
          this.options.debug(`releasing the previous agent failed: ${(err as Error).message}`);
        }
      }
      try {
        // A pre-warm still starting this agent: attach to it instead of spawning another process.
        if (next.starting !== undefined) await next.starting.catch(() => {});
        await this.bindSession(next);
        const nextState = next.bridge.status();
        if (acquired.fresh || nextState === "stopped" || nextState === "error") await this.pool.start(next);
      } catch (err) {
        fail("agent_spawn_failed", `${agentId} failed to start: ${(err as Error).message}`);
      }
    } finally {
      this.switching = false;
    }
  }

  private key(root: string, agentId: string): string {
    return `${root}\u0000${agentId}`;
  }

  private saveDefaultAgent(agentId: string): void {
    if (agentId === MOCK_AGENT_ID) return;
    this.options.settings?.update({ defaultAgentId: agentId });
  }

  // ---------- saved defaults: model and mode per agent ----------

  /** The model a new session of `entry` should use: this daemon session's choice in the project, else the saved default. */
  private desiredModel(entry: PooledBridge): string | undefined {
    return this.sessionModels.get(this.key(entry.root, entry.agentId)) ?? this.options.settings?.get().models[entry.agentId];
  }

  /** The mode a new session should use: session choice, else saved default, else the built-in edit-without-asking mode. */
  private desiredMode(entry: PooledBridge, modes: ModeState | undefined): string | undefined {
    return (
      this.sessionModes.get(this.key(entry.root, entry.agentId)) ??
      this.options.settings?.get().modes[entry.agentId] ??
      builtInDefaultMode(entry.agentId, modes)
    );
  }

  /** Saved defaults + built-in modes, as agent.status.defaults carries them. */
  defaults(): AgentDefaults {
    const saved = this.options.settings?.get();
    const modes: Record<string, string> = {};
    for (const [agentId, preferred] of Object.entries(BUILT_IN_DEFAULT_MODES)) {
      if (preferred[0] !== undefined) modes[agentId] = preferred[0];
    }
    return {
      agentId: saved?.defaultAgentId ?? this.startupAgentId,
      models: { ...(saved?.models ?? {}) },
      modes: { ...modes, ...(saved?.modes ?? {}) },
    };
  }

  /**
   * Once per agent session (new bridge, reset, resumed chat): applies the
   * desired model and mode when the agent offers them and they differ.
   * Prompts wait while it runs (entry.configuring). Later changes the agent
   * makes itself (e.g. leaving plan mode) are not fought.
   */
  private configure(entry: PooledBridge): void {
    const { state, sessionId, models, modes } = entry.status;
    if (state !== "idle" || entry.configuring !== undefined) return;
    const session = sessionId ?? "";
    if (entry.configuredSession === session) return;
    entry.configuredSession = session;
    const model = this.desiredModel(entry);
    const mode = this.desiredMode(entry, modes);
    const setModel = model !== undefined && models !== undefined && models.currentModelId !== model && models.available.some((m) => m.id === model);
    const setMode = mode !== undefined && modes !== undefined && modes.currentModeId !== mode && modes.available.some((m) => m.id === mode);
    if (!setModel && !setMode) return;
    const run = (async () => {
      // Out of the bridge's status emit.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (setModel) {
        await entry.bridge.setModel(model).catch((err: unknown) => this.options.debug(`${entry.agentId}: model ${model} not applied: ${String(err)}`));
      }
      if (setMode) {
        await entry.bridge.setMode(mode).catch((err: unknown) => this.options.debug(`${entry.agentId}: mode ${mode} not applied: ${String(err)}`));
      }
    })();
    entry.configuring = run.finally(() => {
      entry.configuring = undefined;
      this.pumpQueue(entry);
      this.broadcastWarmChange();
    });
  }

  /** model.set: applied to the current agent, remembered for this project and saved as the agent's default model. */
  setModel(modelId: string, socket?: WebSocket): void {
    const entry = this.entry;
    if (entry === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", NO_PROJECT_MESSAGE);
      return;
    }
    // Not gated on idle: both real bridges forward a mid-turn switch to the
    // agent, which applies it from the next model request (the Claude SDK's
    // query.setModel; claude-agent-acp's session/set_config_option does the
    // same through its own query). The bridge re-emits agent.status with the
    // new models.currentModelId once the agent accepted it.
    void entry.bridge.setModel(modelId).then(
      () => {
        this.sessionModels.set(this.key(entry.root, entry.agentId), modelId);
        this.saveDefaults({ models: { [entry.agentId]: modelId } }, entry.agentId);
      },
      (err: unknown) => {
        if (socket !== undefined) this.error(socket, "internal", `model change failed: ${(err as Error).message}`);
      },
    );
  }

  /** mode.set: like model.set, for the permission mode. */
  setMode(modeId: string, socket?: WebSocket): void {
    const entry = this.entry;
    if (entry === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", NO_PROJECT_MESSAGE);
      return;
    }
    void entry.bridge.setMode(modeId).then(
      () => {
        this.sessionModes.set(this.key(entry.root, entry.agentId), modeId);
        this.saveDefaults({ modes: { [entry.agentId]: modeId } }, entry.agentId);
      },
      (err: unknown) => {
        if (socket !== undefined) this.error(socket, "internal", `mode change failed: ${(err as Error).message}`);
      },
    );
  }

  private saveDefaults(patch: { models?: Record<string, string>; modes?: Record<string, string> }, agentId: string): void {
    const settings = this.options.settings;
    if (settings === undefined || agentId === MOCK_AGENT_ID) return;
    const before = JSON.stringify(settings.get());
    settings.update(patch);
    if (JSON.stringify(settings.get()) !== before) this.broadcastStatus();
  }

  /**
   * defaults.set (Settings → Agents): saves the defaults, drops this
   * session's per-project choices for the agents it names (the saved default
   * wins again) and applies them to those agents' live bridges in the open
   * project (current and warm) that are idle.
   */
  setDefaults(message: Extract<ClientMessage, { type: "defaults.set" }>, socket?: WebSocket): void {
    const settings = this.options.settings;
    if (settings === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", "saved defaults are not available");
      return;
    }
    if (message.agentId !== undefined) {
      const check = this.options.agents?.check(message.agentId) ?? { ok: false as const, code: "bad_message" as const, message: `unknown agent: ${message.agentId}` };
      if (!check.ok) {
        if (socket !== undefined) this.error(socket, check.code, check.message);
        return;
      }
    }
    settings.update({
      ...(message.agentId !== undefined ? { defaultAgentId: message.agentId } : {}),
      ...(message.models !== undefined ? { models: message.models } : {}),
      ...(message.modes !== undefined ? { modes: message.modes } : {}),
    });
    const touched = new Set([...Object.keys(message.models ?? {}), ...Object.keys(message.modes ?? {})]);
    for (const key of [...this.sessionModels.keys()]) if (touched.has(key.split("\u0000")[1] ?? "")) this.sessionModels.delete(key);
    for (const key of [...this.sessionModes.keys()]) if (touched.has(key.split("\u0000")[1] ?? "")) this.sessionModes.delete(key);
    const root = this.open?.store.root;
    for (const entry of this.pool.list()) {
      if (entry.root !== root || !touched.has(entry.agentId)) continue;
      entry.configuredSession = undefined;
      this.configure(entry);
    }
    this.broadcastStatus();
  }

  // ---------- pre-warming (speculative agent start) ----------

  private prewarmEnabled(): boolean {
    return this.options.prewarm !== false && this.options.agents !== undefined && (this.options.warmTtlMs ?? 0) > 0;
  }

  /** Installed agents by id, from the catalog's last probe. */
  private installedAgents(): Set<string> {
    const choices = this.options.agents?.choices(this.currentAgentId).available ?? [];
    return new Set(choices.filter((a) => a.installed).map((a) => a.id));
  }

  /** Agents the project's chats used, most recent chat first (excluding the current agent). */
  private usedAgents(projectId: string): string[] {
    const chats = this.options.chats;
    if (chats === undefined) return [];
    const out: string[] = [];
    for (const chat of chats.list(projectId)) {
      const header = chats.get(projectId, chat.id);
      for (const id of [chat.agentId, ...Object.keys(header?.sessions ?? {})]) {
        if (id !== this.currentAgentId && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /**
   * agent.prewarm: starts the agents (default: every installed agent but the
   * current one, those this project used first) in the background for the
   * open project, one at a time, after the current agent is up; never changes
   * the current agent. Live ones are only touched (their idle TTL restarts).
   * A failed one stays cold with its error and is not retried for
   * prewarmRetryMs.
   */
  prewarm(agentIds?: readonly string[], why = "viewer"): void {
    const open = this.open;
    if (!this.prewarmEnabled() || open === null) return;
    const installed = this.installedAgents();
    const root = open.store.root;
    const ids = agentIds ?? [...new Set([...this.usedAgents(open.info.id), ...installed])];
    const retryMs = this.options.prewarmRetryMs ?? DEFAULT_PREWARM_RETRY_MS;
    for (const agentId of ids) {
      if (agentId === this.currentAgentId || !installed.has(agentId)) continue;
      if (agentId === MOCK_AGENT_ID) continue;
      const failure = this.prewarmFailures.get(this.key(root, agentId));
      if (failure !== undefined && Date.now() - failure.at < retryMs) continue;
      const live = this.pool.find(root, agentId);
      if (live !== undefined) {
        if (!live.inUse) this.pool.prewarm(root, agentId);
        continue;
      }
      if (!this.prewarmQueue.includes(agentId)) {
        this.options.debug(`pre-warm ${agentId} queued (${why})`);
        this.prewarmQueue.push(agentId);
      }
    }
    void this.runPrewarmQueue();
  }

  private async runPrewarmQueue(): Promise<void> {
    if (this.prewarmRunning) return;
    this.prewarmRunning = true;
    try {
      while (this.prewarmQueue.length > 0) {
        // Lowest priority: the current agent starts first.
        await this.currentSettled();
        const agentId = this.prewarmQueue.shift();
        const open = this.open;
        if (agentId === undefined || open === null) break;
        if (agentId === this.currentAgentId) continue;
        await this.prewarmOne(open.store.root, agentId);
      }
    } finally {
      this.prewarmRunning = false;
    }
  }

  /** Resolves once the current agent is not starting / configuring (at most ~60 s). */
  private async currentSettled(): Promise<void> {
    for (let i = 0; i < 1200; i += 1) {
      const entry = this.entry;
      if (entry === undefined || (entry.status.state !== "starting" && entry.starting === undefined && entry.configuring === undefined)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50).unref?.());
    }
  }

  private async prewarmOne(root: string, agentId: string): Promise<void> {
    let got: { entry: PooledBridge; fresh: boolean } | undefined;
    try {
      got = this.pool.prewarm(root, agentId);
    } catch (err) {
      this.recordPrewarmFailure(root, agentId, (err as Error).message);
      return;
    }
    if (got === undefined) {
      this.options.debug(`pre-warm ${agentId}: pool full`);
      return;
    }
    if (!got.fresh) return;
    const { entry } = got;
    const t0 = Date.now();
    this.broadcastWarmChange();
    let failure: string | undefined;
    try {
      await this.bindSession(entry, this.activeChatId);
      await this.pool.start(entry);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    // Taken by agent.set meanwhile: its outcome is the current agent's.
    if (entry.inUse) return;
    // Evicted meanwhile (pool cap, project closed): not a failure of the agent.
    if (this.pool.find(root, agentId) !== entry) return;
    const state = entry.status.state;
    if (state === "error" || state === "stopped" || failure !== undefined) {
      this.recordPrewarmFailure(root, agentId, entry.status.error ?? failure ?? `${agentId} did not start`);
      await this.pool.discard(entry, "pre-warm failed");
      this.broadcastWarmChange();
      return;
    }
    this.options.info(`pre-warmed ${agentId} in ${Date.now() - t0} ms`);
    this.broadcastWarmChange();
  }

  private recordPrewarmFailure(root: string, agentId: string, error: string): void {
    this.options.info(`pre-warming ${agentId} failed: ${error}`);
    this.prewarmFailures.set(this.key(root, agentId), { error, at: Date.now() });
  }

  /** After a project opened and its agent is idle: pre-warm the agents it used before (max 2), after a short delay. */
  private maybeAutoPrewarm(): void {
    const pending = this.autoPrewarm;
    const open = this.open;
    if (pending === undefined || pending.timer !== undefined || open === null || pending.projectId !== open.info.id) return;
    if (this.agentState() !== "idle") return;
    const delay = this.options.autoPrewarmDelayMs ?? DEFAULT_AUTO_PREWARM_DELAY_MS;
    if (delay < 0 || !this.prewarmEnabled()) {
      this.autoPrewarm = undefined;
      return;
    }
    pending.timer = setTimeout(() => {
      if (this.autoPrewarm !== pending) return;
      this.autoPrewarm = undefined;
      if (this.open?.info.id !== pending.projectId) return;
      const installed = this.installedAgents();
      const ids = this.usedAgents(pending.projectId).filter((id) => installed.has(id)).slice(0, AUTO_PREWARM_MAX);
      if (ids.length > 0) this.prewarm(ids, "project used them");
    }, delay);
    pending.timer.unref?.();
  }

  private cancelAutoPrewarm(): void {
    if (this.autoPrewarm?.timer !== undefined) clearTimeout(this.autoPrewarm.timer);
    this.autoPrewarm = undefined;
  }

  /** Warm state of `agentId` for the open project. */
  private warmOf(agentId: string): { warm: WarmState; warmError?: string } {
    const root = this.open?.store.root;
    if (root === undefined) return { warm: "cold" };
    const entry = this.pool.find(root, agentId);
    if (entry !== undefined) {
      const state = entry.status.state;
      if ((state === "idle" || state === "busy") && entry.configuring === undefined) return { warm: "ready" };
      if (state === "starting" || entry.starting !== undefined || entry.configuring !== undefined) return { warm: "starting" };
    }
    const failure = this.prewarmFailures.get(this.key(root, agentId));
    return failure !== undefined ? { warm: "cold", warmError: failure.error } : { warm: "cold" };
  }

  agentState(): "starting" | "idle" | "busy" | "error" | "stopped" {
    return (this.entry?.status ?? this.detachedStatus).state;
  }

  /**
   * Whether `agentId` takes images: its live bridge's answer when known (and
   * remembered), else the last answer seen, else the catalog's static entry.
   */
  imagesSupported(agentId: string = this.currentAgentId): boolean | undefined {
    const entry = this.entry;
    const live = entry !== undefined && entry.agentId === agentId ? entry.bridge.supportsImages?.() : undefined;
    if (live !== undefined) this.imageSupport.set(agentId, live);
    return (
      this.imageSupport.get(agentId) ??
      this.options.agents?.choices(this.currentAgentId).available.find((a) => a.id === agentId)?.images
    );
  }

  private agentName(agentId: string): string {
    return (
      this.options.agents?.choices(this.currentAgentId).available.find((a) => a.id === agentId)?.name ??
      this.entry?.status.agent?.name ??
      agentId
    );
  }

  agentStatusMessage(): Extract<ServerMessage, { type: "agent.status" }> {
    const { state, agent, sessionId, modes, models, error } = this.entry?.status ?? this.detachedStatus;
    const choices = this.options.agents?.choices(this.currentAgentId);
    const hasProject = this.open !== null;
    const agents = choices === undefined ? undefined : {
      ...choices,
      available: choices.available.map((choice) => {
        const images = this.imagesSupported(choice.id);
        const other = choice.id !== this.currentAgentId;
        const knownModels = other ? this.knownModels.get(choice.id) : undefined;
        const knownModes = other ? this.knownModes.get(choice.id) : undefined;
        return {
          ...choice,
          ...(images !== undefined ? { images } : {}),
          ...(choice.installed && hasProject ? this.warmOf(choice.id) : {}),
          ...(knownModels !== undefined ? { models: knownModels } : {}),
          ...(knownModes !== undefined ? { modes: knownModes } : {}),
        };
      }),
    };
    return {
      type: "agent.status",
      state,
      ...(agent !== undefined ? { agent } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(modes !== undefined ? { modes } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(agents !== undefined ? { agents } : {}),
      ...(error !== undefined && state === "error" ? { error } : {}),
      ...(agents !== undefined ? { defaults: this.defaults() } : {}),
    };
  }

  /** What makes a pre-warm change worth a broadcast (warm states, errors, other agents' model lists). */
  private warmSignature(message: Extract<ServerMessage, { type: "agent.status" }>): string {
    return JSON.stringify(
      (message.agents?.available ?? []).map((a) => [a.id, a.warm, a.warmError, a.models?.currentModelId, a.models?.available.length, a.modes?.currentModeId]),
    );
  }

  private broadcastStatus(): void {
    const message = this.agentStatusMessage();
    this.lastWarmSignature = this.warmSignature(message);
    this.broadcast(message);
  }

  /** Re-sends agent.status when another agent's warm state changed (the current agent's state is unchanged). */
  private broadcastWarmChange(): void {
    const message = this.agentStatusMessage();
    const signature = this.warmSignature(message);
    if (signature === this.lastWarmSignature) return;
    this.lastWarmSignature = signature;
    this.broadcast(message);
  }

  // ---------- turns ----------

  activeTurnId(): string | undefined {
    return this.activeTurn;
  }

  markTurnActive(turnId: string): void {
    this.activeTurn = turnId;
  }

  /** The current bridge's queued prompt, if any. */
  private get queued(): QueuedTurn | undefined {
    return this.entry !== undefined ? this.queue.get(this.entry) : undefined;
  }

  /** cancel: the open project's turn, or a background turn of any project (e.g. from the activity feed). */
  async cancelTurn(turnId: string, socket?: WebSocket): Promise<void> {
    for (const [entry, queued] of this.queue) {
      if (queued.turnId === turnId) {
        this.dropQueued(entry, "cancelled");
        return;
      }
    }
    if (this.activeTurn === turnId && this.entry !== undefined) {
      await this.entry.bridge.cancel(turnId);
      return;
    }
    const recording = this.turns.get(turnId);
    if (recording !== undefined && !recording.finalized) {
      await recording.entry.bridge.cancel(turnId);
      return;
    }
    if (socket !== undefined) this.error(socket, "no_turn", `unknown turn: ${turnId}`);
  }

  /** §2.2 rule 6 (no viewer left): every queued prompt is dropped and every running turn cancelled. */
  async cancelActive(_why: string): Promise<void> {
    for (const entry of [...this.queue.keys()]) this.dropQueued(entry, "cancelled");
    const running = [...this.turns.values()].filter((r) => !r.finalized);
    await Promise.all(running.map((r) => r.entry.bridge.cancel(r.record.turnId).catch(() => {})));
  }

  /**
   * prompt (§2.2 rule 3): builds the context pack, sends it, records the turn
   * into the active chat. While the current agent is starting (or applying its
   * saved model / mode) the prompt is queued — one at a time — and sent once
   * the agent is idle (turn.started{queued:true} now, turn.started again then).
   */
  startTurn(socket: WebSocket, message: Extract<ClientMessage, { type: "prompt" }>): void {
    const open = this.open;
    const entry = this.entry;
    if (open === null) {
      this.error(socket, "bad_message", NO_PROJECT_MESSAGE, { turnId: message.turnId });
      return;
    }
    const state = this.agentState();
    const waiting = entry !== undefined && (state === "starting" || entry.configuring !== undefined);
    if (waiting && this.activeTurn !== undefined) {
      this.error(socket, "busy", `a prompt is already waiting for ${this.agentName(this.currentAgentId)} to start`, { turnId: message.turnId });
      return;
    }
    // "error" is allowed: both real bridges restart the agent on the next prompt.
    if (entry === undefined || (!waiting && state !== "idle" && state !== "error")) {
      this.error(socket, "busy", `agent is ${state}, not idle`, { turnId: message.turnId });
      return;
    }
    const arch = open.store.current();
    const nodeId = message.nodeId;
    // A map that did not load (architecture.error) still allows plain chats; a prompt about an
    // element gets an answer instead of silence (the composer would wait forever).
    if (arch === null && nodeId !== undefined) {
      this.error(socket, "unknown_node", `the map is not loaded, so ${nodeId} has no context; ask without an element or fix architecture.json`, { turnId: message.turnId });
      return;
    }
    // Stored nodes, and expanded folders / files / symbols (CONTRACTS §1.6). No nodeId = a plain
    // chat on the project: the agent gets the question as typed, no context pack.
    const scope = nodeId === undefined || arch === null ? undefined : resolveNodeScope(open.store, arch, nodeId);
    if (scope === null) {
      this.error(socket, "unknown_node", `unknown node: ${nodeId}`, { turnId: message.turnId });
      return;
    }
    const images = this.loadAttachments(socket, message, open.info.id);
    if (images === undefined) return;
    let pack = "";
    let textBlocks: ContentBlock[] = [{ type: "text", text: message.text }];
    if (scope !== undefined && nodeId !== undefined) {
      pack = buildContextPack(scope.index, nodeId, open.store.root, message.text, {
        mapTools: this.options.mapOps !== undefined && this.currentAgentId !== MOCK_AGENT_ID,
      });
      const resolvePath = open.store.resolvePath?.bind(open.store);
      textBlocks = buildPromptBlocks(pack, scope.node.files ?? [], open.store.root, this.options.links, resolvePath) as ContentBlock[];
    }
    // Images first: the text block (ending with the user's question) stays last (CONTRACTS §3.3).
    const blocks = [...images.blocks, ...textBlocks] as ContentBlock[];
    if (!waiting) {
      let handle;
      try {
        handle = entry.bridge.prompt(message.turnId, blocks);
      } catch (err) {
        if (err instanceof BusyError) {
          this.error(socket, "busy", err.message, { turnId: message.turnId });
          return;
        }
        this.error(socket, "internal", (err as Error).message, { turnId: message.turnId });
        return;
      }
      void handle.done.catch(() => {});
    }
    const chatId = this.ensureChatForTurn(message.text, entry);
    this.markTurnActive(message.turnId);
    // Pinned in the pool while it runs (§13.1): never evicted, even after a project switch.
    entry.turnId = message.turnId;
    const recording: RecordingTurn = {
      entry,
      projectId: open.info.id,
      projectName: open.info.name,
      root: open.store.root,
      chatId,
      record: {
        turnId: message.turnId,
        ...(nodeId !== undefined ? { nodeId } : {}),
        text: message.text,
        contextPack: pack,
        ...(images.meta.length > 0 ? { attachments: images.meta } : {}),
        events: [],
        startedAt: new Date().toISOString(),
      },
      startedAtMs: Date.now(),
      finalized: false,
      pending: new Map(),
    };
    this.turns.set(message.turnId, recording);
    this.options.activity?.turnStarted(this.activityContext(recording), false);
    const started: Extract<ServerMessage, { type: "turn.started" }> = {
      type: "turn.started",
      turnId: message.turnId,
      ...(nodeId !== undefined ? { nodeId } : {}),
      contextPack: pack,
      text: message.text,
      ...(images.meta.length > 0 ? { attachments: images.meta } : {}),
    };
    if (waiting) {
      this.queue.set(entry, { turnId: message.turnId, entry, blocks, socket, started });
      this.options.debug(`prompt ${message.turnId} queued until ${entry.agentId} is ready`);
      this.send(socket, { ...started, queued: true });
      return;
    }
    this.send(socket, started);
  }

  /**
   * A turn the daemon starts itself on the current agent (CONTRACTS §12.5,
   * "Suggest connections"): recorded in the active chat and broadcast like a
   * viewer prompt (turn.started with `text` as the bubble and `prompt` as the
   * context pack, then stream / turn.finished), counted in usage, and resolved
   * with the agent's answer text when the turn finishes. Throws (at once, not
   * as a rejection) when no project is open or the agent is not idle (no
   * queueing), so a caller can answer "busy" before anything starts.
   */
  runTaskTurn(task: { text: string; prompt: string }): TaskTurn {
    const open = this.open;
    const entry = this.entry;
    if (open === null) throw new Error(NO_PROJECT_MESSAGE);
    const state = this.agentState();
    const busy = this.activeTurn !== undefined || this.queued !== undefined;
    if (entry === undefined || busy || entry.configuring !== undefined || (state !== "idle" && state !== "error")) {
      throw new Error(`${this.agentName(this.currentAgentId)} is ${busy ? "busy" : state}; try again when it is idle`);
    }
    const turnId = `task-${randomUUID()}`;
    const handle = entry.bridge.prompt(turnId, [{ type: "text", text: task.prompt }]);
    void handle.done.catch(() => {});
    const result = new Promise<TaskTurnResult>((resolve) => this.taskWaiters.set(turnId, resolve));
    const chatId = this.ensureChatForTurn(task.text, entry);
    this.markTurnActive(turnId);
    // Pinned in the pool while it runs, like a viewer prompt (§13.1).
    entry.turnId = turnId;
    const recording: RecordingTurn = {
      entry,
      projectId: open.info.id,
      projectName: open.info.name,
      root: open.store.root,
      chatId,
      record: { turnId, text: task.text, contextPack: task.prompt, events: [], startedAt: new Date().toISOString() },
      startedAtMs: Date.now(),
      finalized: false,
      pending: new Map(),
    };
    this.turns.set(turnId, recording);
    this.options.activity?.turnStarted(this.activityContext(recording), false);
    this.broadcast({ type: "turn.started", turnId, contextPack: task.prompt, text: task.text });
    return { turnId, result };
  }

  /**
   * A turn of `projectId` that is running or waiting for its agent (any chat,
   * foreground or background), or undefined. Changes that rewrite the
   * project's stored chats (a system repo rename, §12.4) wait for it: the
   * turn would store its old element ids when it finishes.
   */
  runningTurn(projectId: string): { turnId: string; text: string } | undefined {
    for (const recording of this.turns.values()) {
      if (!recording.finalized && recording.projectId === projectId) return { turnId: recording.record.turnId, text: recording.record.text };
    }
    return undefined;
  }

  /** The permission requests `turnId` waits on (oldest first); empty when none or unknown. */
  pendingPermissions(turnId: string): PendingPermission[] {
    const recording = this.turns.get(turnId);
    if (recording === undefined || recording.finalized) return [];
    return [...recording.pending].map(([requestId, request]) => ({ requestId, toolCall: request.toolCall, options: request.options }));
  }

  /**
   * Sends `entry`'s queued prompt once its agent is idle; fails it when the
   * agent could not start. A background one (§13.1) is sent too; only the
   * open project's viewer gets its turn.started.
   */
  private pumpQueue(entry: PooledBridge): void {
    const queued = this.queue.get(entry);
    if (queued === undefined) return;
    const state = entry.status.state;
    if (state === "starting" || state === "busy" || entry.configuring !== undefined) return;
    if (state === "error" || state === "stopped") {
      const reason = entry.status.error;
      this.dropQueued(entry, "error", `${this.agentName(entry.agentId)} did not start${reason !== undefined ? `: ${reason}` : ""}`);
      return;
    }
    this.queue.delete(entry);
    let handle;
    try {
      handle = entry.bridge.prompt(queued.turnId, queued.blocks);
    } catch (err) {
      this.queue.set(entry, queued);
      this.dropQueued(entry, "error", (err as Error).message);
      return;
    }
    void handle.done.catch(() => {});
    const recording = this.turns.get(queued.turnId);
    if (recording !== undefined) recording.startedAtMs = Date.now();
    this.options.debug(`queued prompt ${queued.turnId} sent to ${entry.agentId}`);
    if (entry === this.entry) this.send(queued.socket, queued.started);
  }

  /** Ends `entry`'s queued turn without it reaching the agent (cancel, switch, failed start). */
  private dropQueued(entry: PooledBridge, stopReason: StopReason, error?: string): void {
    const queued = this.queue.get(entry);
    if (queued === undefined) return;
    this.queue.delete(entry);
    if (this.activeTurn === queued.turnId) this.activeTurn = undefined;
    const recording = this.turns.get(queued.turnId);
    this.turns.delete(queued.turnId);
    if (recording !== undefined) this.finalizeTurn(recording, stopReason, error);
    else {
      if (entry.turnId === queued.turnId) void this.pool.turnEnded(entry);
      this.broadcast({ type: "turn.finished", turnId: queued.turnId, stopReason, ...(error !== undefined ? { error } : {}) });
    }
  }

  /**
   * The prompt's images as ACP image blocks (base64), plus what the turn
   * records about them. Undefined after an error was sent: the agent cannot
   * read images (rejected rather than silently dropped), attachments are not
   * available, or a referenced file is missing.
   */
  private loadAttachments(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: "prompt" }>,
    projectId: string,
  ): { blocks: ContentBlock[]; meta: AttachmentMeta[] } | undefined {
    const refs = message.attachments ?? [];
    if (refs.length === 0) return { blocks: [], meta: [] };
    const fail = (text: string): undefined => {
      this.error(socket, "bad_message", text, { turnId: message.turnId });
      return undefined;
    };
    const store = this.options.attachments;
    if (store === undefined) return fail("image attachments are not available");
    if (this.imagesSupported() !== true) {
      return fail(`${this.agentName(this.currentAgentId)} can't read images — switch to Claude Code or remove the image`);
    }
    const blocks: ContentBlock[] = [];
    const meta: AttachmentMeta[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const image = store.read(projectId, ref.id);
      if (image === undefined) return fail(`attachment not found: ${ref.name} — attach it again`);
      blocks.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
      meta.push({ id: ref.id, name: ref.name, mimeType: image.mimeType });
    }
    return { blocks, meta };
  }

  /** The active chat, created (titled after the prompt) when there is none. */
  private ensureChatForTurn(text: string, entry: PooledBridge): string | null {
    const chats = this.options.chats;
    const open = this.open;
    if (chats === undefined || open === null) return null;
    if (this.activeChatId !== null && chats.get(open.info.id, this.activeChatId) !== undefined) return this.activeChatId;
    const model = entry.status.models?.currentModelId;
    const chat = chats.create(open.info.id, { agentId: this.currentAgentId, model, title: text });
    this.activeChatId = chat.id;
    chats.setActiveChat(open.info.id, chat.id);
    // The bridge's session was bound to "no chat", i.e. it is empty or was reset: it now belongs to this chat.
    if (entry.chatId === null || entry.chatId === undefined) entry.chatId = chat.id;
    this.broadcastChats();
    return chat.id;
  }

  /**
   * A switch (project, agent, chat) while a turn runs: the turn is stored and
   * announced as cancelled now, and its bridge is asked to cancel in the
   * background (its own finish then only records usage). Keeps switches fast.
   */
  private detachActiveTurn(error?: string): void {
    if (this.queued !== undefined && this.entry !== undefined) {
      this.dropQueued(this.entry, "cancelled", error);
      return;
    }
    const turnId = this.activeTurn;
    if (turnId === undefined) return;
    this.activeTurn = undefined;
    const recording = this.turns.get(turnId);
    if (recording === undefined) {
      void this.entry?.bridge.cancel(turnId).catch(() => {});
      return;
    }
    this.finalizeTurn(recording, "cancelled", error);
    void recording.entry.bridge.cancel(turnId).catch((err: unknown) => this.options.debug(`cancel failed: ${String(err)}`));
  }

  /**
   * Persists the turn into its chat and announces it (once): turn.finished to
   * the open project's viewers, an activity event to all. Unpins its bridge.
   */
  private finalizeTurn(recording: RecordingTurn, stopReason: StopReason, error: string | undefined): void {
    if (recording.finalized) return;
    recording.finalized = true;
    const { record } = recording;
    record.stopReason = stopReason;
    record.finishedAt = new Date().toISOString();
    const background = this.isBackground(recording);
    if (recording.projectId === this.open?.info.id) {
      this.broadcast({ type: "turn.finished", turnId: record.turnId, stopReason, ...(error !== undefined ? { error } : {}) });
    }
    this.persistTurn(recording);
    recording.pending.clear();
    if (recording.entry.turnId === record.turnId) {
      void this.pool.turnEnded(recording.entry).catch((err: unknown) => this.options.debug(`bridge release failed: ${String(err)}`));
    }
    this.options.activity?.turnFinished(
      this.activityContext(recording),
      { stopReason, error, files: editedFiles(record), mapChanges: record.mapChanges?.length ?? 0 },
      background,
    );
  }

  private persistTurn(recording: RecordingTurn): void {
    const { record } = recording;
    const chats = this.options.chats;
    if (chats === undefined || recording.chatId === null) return;
    try {
      const status = recording.entry.status;
      const header = chats.appendTurn(recording.projectId, recording.chatId, record, {
        agentId: recording.entry.agentId,
        sessionId: status.sessionId,
        model: status.models?.currentModelId,
      });
      if (header !== undefined) {
        recording.entry.used = true;
        if (recording.entry.chatId === undefined || recording.entry.chatId === null) recording.entry.chatId = recording.chatId;
      }
      if (header !== undefined && recording.projectId === this.open?.info.id) this.broadcastChats();
    } catch (err) {
      this.options.info(`storing turn ${record.turnId} failed: ${(err as Error).message}`);
    }
  }

  // ---------- map edits by agents (CONTRACTS §1.7) ----------

  /** Adds map changes an agent made to the running turn's record (stored with the chat). */
  recordMapChanges(turnId: string, changes: MapChange[]): void {
    const recording = this.turns.get(turnId);
    if (recording === undefined || recording.finalized || changes.length === 0) return;
    recording.record.mapChanges = [...(recording.record.mapChanges ?? []), ...changes];
    this.options.activity?.mapChanged(this.activityContext(recording), changes.map((c) => c.name || c.id), this.isBackground(recording));
  }

  /** arch.undo: restores what the turn's map ops changed; the result is broadcast as `architecture`. */
  undoMapTurn(turnId: string, socket?: WebSocket): void {
    const mapOps = this.options.mapOps;
    if (mapOps === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", "map undo is not available");
      return;
    }
    if (this.open === null) {
      if (socket !== undefined) this.error(socket, "bad_message", NO_PROJECT_MESSAGE);
      return;
    }
    mapOps.undoTurn(turnId).catch((err: unknown) => {
      if (socket !== undefined) this.error(socket, "bad_message", `undo failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ---------- chats (CONTRACTS §5.2) ----------

  private chatsAvailable(socket: WebSocket | undefined): { chats: ChatStore; projectId: string } | undefined {
    const chats = this.options.chats;
    if (chats === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", "chats are not available");
      return undefined;
    }
    if (this.open === null) {
      if (socket !== undefined) this.error(socket, "bad_message", NO_PROJECT_MESSAGE);
      return undefined;
    }
    return { chats, projectId: this.open.info.id };
  }

  private setActiveChat(chatId: string | null): void {
    this.activeChatId = chatId;
    if (this.open !== null) {
      this.lastChat.set(this.open.info.id, chatId);
      this.options.chats?.setActiveChat(this.open.info.id, chatId);
      if (this.sockets.size > 0) this.options.activity?.markRead(this.open.info.id, chatId);
    }
    const entry = this.entry;
    if (entry !== undefined) {
      void this.bindSession(entry).catch((err: unknown) => this.options.debug(`session switch failed: ${String(err)}`));
    }
  }

  /** chat.new: an empty active chat is reused, otherwise a new one becomes active. */
  newChat(socket?: WebSocket): void {
    const ctx = this.chatsAvailable(socket);
    if (ctx === undefined) return;
    this.detachActiveTurn();
    const current = this.activeChatId !== null ? ctx.chats.get(ctx.projectId, this.activeChatId) : undefined;
    const chat = current !== undefined && current.turnCount === 0
      ? current
      : ctx.chats.create(ctx.projectId, { agentId: this.currentAgentId, model: this.entry?.status.models?.currentModelId });
    this.setActiveChat(chat.id);
    this.broadcastChats();
    this.broadcast({ type: "chat.history", chatId: chat.id, turns: [] });
  }

  openChat(chatId: string, socket?: WebSocket): void {
    const ctx = this.chatsAvailable(socket);
    if (ctx === undefined) return;
    if (ctx.chats.get(ctx.projectId, chatId) === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", `unknown chat: ${chatId}`);
      return;
    }
    if (chatId !== this.activeChatId) {
      this.detachActiveTurn();
      this.setActiveChat(chatId);
      this.broadcastChats();
    } else if (this.sockets.size > 0) this.options.activity?.markRead(ctx.projectId, chatId);
    this.broadcast({ type: "chat.history", chatId, turns: this.historyTurns(ctx.projectId, chatId) });
  }

  renameChat(chatId: string, title: string, socket?: WebSocket): void {
    const ctx = this.chatsAvailable(socket);
    if (ctx === undefined) return;
    if (ctx.chats.rename(ctx.projectId, chatId, title) === undefined) {
      if (socket !== undefined) this.error(socket, "bad_message", `unknown chat: ${chatId}`);
      return;
    }
    this.broadcastChats();
  }

  deleteChat(chatId: string, socket?: WebSocket): void {
    const ctx = this.chatsAvailable(socket);
    if (ctx === undefined) return;
    if (chatId === this.activeChatId) this.detachActiveTurn();
    if (!ctx.chats.delete(ctx.projectId, chatId)) {
      if (socket !== undefined) this.error(socket, "bad_message", `unknown chat: ${chatId}`);
      return;
    }
    if (chatId === this.activeChatId) this.setActiveChat(null);
    this.broadcastChats();
  }

  private chatsMessage(): ServerMessage | undefined {
    const chats = this.options.chats;
    const open = this.open;
    if (chats === undefined || open === null) return undefined;
    return { type: "chats", projectId: open.info.id, chats: chats.list(open.info.id), activeChatId: this.activeChatId };
  }

  private historyMessage(): ServerMessage | undefined {
    const chats = this.options.chats;
    const open = this.open;
    if (chats === undefined || open === null || this.activeChatId === null) return undefined;
    return { type: "chat.history", chatId: this.activeChatId, turns: this.historyTurns(open.info.id, this.activeChatId) };
  }

  /**
   * A chat's stored turns plus the turn still running in it (§13.1: re-attach
   * after a project switch or a page reload), marked `running: true` and
   * carrying its events so far; stream frames continue it.
   */
  private historyTurns(projectId: string, chatId: string): TurnRecord[] {
    const turns = this.options.chats?.history(projectId, chatId) ?? [];
    for (const recording of this.turns.values()) {
      if (recording.finalized || recording.projectId !== projectId || recording.chatId !== chatId) continue;
      if (turns.some((t) => t.turnId === recording.record.turnId)) continue;
      turns.push({ ...recording.record, events: [...recording.record.events], running: true });
    }
    return turns;
  }

  private broadcastChats(): void {
    const message = this.chatsMessage();
    if (message !== undefined) this.broadcast(message);
  }

  private broadcastHistory(): void {
    const message = this.historyMessage();
    if (message !== undefined) this.broadcast(message);
  }

  // ---------- messages ----------

  architectureMessage(reason: "initial" | "changed" | "saved"): ServerMessage | undefined {
    const store = this.store;
    const arch = store?.current() ?? null;
    if (store === null || arch === null) return undefined;
    return { type: "architecture", reason, revision: store.revision, root: store.root, path: store.path, architecture: arch };
  }

  /** After hello: project, architecture, agent.status, chats, active chat history. */
  sendHello(socket: WebSocket): void {
    this.send(socket, { type: "project", project: this.project() });
    const arch = this.architectureMessage("initial");
    if (arch !== undefined) this.send(socket, arch);
    this.send(socket, this.agentStatusMessage());
    const chats = this.chatsMessage();
    if (chats !== undefined) this.send(socket, chats);
    const history = this.historyMessage();
    if (history !== undefined) this.send(socket, history);
    for (const message of this.pendingPermissionMessages()) this.send(socket, message);
    const activity = this.options.activity;
    if (activity !== undefined) {
      this.send(socket, activity.snapshotMessage());
      if (this.open !== null) activity.markRead(this.open.info.id, this.activeChatId);
    }
  }

  /** Stops listening (tests). */
  close(): void {
    for (const unsubscribe of this.open?.unsubscribe ?? []) unsubscribe();
  }

  /** Daemon shutdown: store the active turn, close the store, stop every bridge. */
  async shutdown(): Promise<void> {
    this.detachActiveTurn();
    // Background turns (§13.1) are stored as cancelled too; the pool then stops their agents.
    for (const entry of [...this.queue.keys()]) this.dropQueued(entry, "cancelled");
    for (const recording of [...this.turns.values()]) {
      if (recording.finalized) continue;
      this.finalizeTurn(recording, "cancelled", "Ruah stopped");
      void recording.entry.bridge.cancel(recording.record.turnId).catch(() => {});
    }
    if (this.open !== null) this.options.activity?.markViewed(this.open.info.id);
    this.prewarmQueue = [];
    this.cancelAutoPrewarm();
    this.close();
    this.open?.store.close();
    await this.pool.stopAll();
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  private onBridgeEvent(entry: PooledBridge, event: BridgeEvent): void {
    const current = entry === this.entry;
    if (event.type === "status") {
      if (entry.status.models !== undefined) this.knownModels.set(entry.agentId, entry.status.models);
      if (entry.status.modes !== undefined) this.knownModes.set(entry.agentId, entry.status.modes);
      if (entry.status.state === "idle") this.configure(entry);
      this.noteAgentError(entry, current);
      // A queued prompt (current or background bridge) goes out once its agent is idle.
      if (this.queue.has(entry)) setImmediate(() => this.pumpQueue(entry));
      // A parked or retired bridge's state is not the agent's state; only its warm state is shown.
      if (!current) {
        this.broadcastWarmChange();
        return;
      }
      this.broadcastStatus();
      this.maybeAutoPrewarm();
      return;
    }
    if (event.type === "stream") {
      const recording = this.turns.get(event.turnId);
      if (recording?.finalized === true) return;
      if (recording !== undefined) appendStreamEvent(recording.record.events, event.event);
      if (current) this.broadcast({ type: "stream", turnId: event.turnId, event: event.event });
      return;
    }
    if (event.type === "permission") {
      // Kept until answered, so a viewer that re-attaches (§13.1) can still answer it.
      const recording = this.turns.get(event.turnId);
      if (recording !== undefined && !recording.finalized) {
        recording.pending.set(event.requestId, { toolCall: event.toolCall, options: event.options });
        this.options.activity?.permissionRequested(this.activityContext(recording), event.requestId, event.toolCall.title, this.isBackground(recording));
      }
      if (!current) return;
      this.broadcast({
        type: "permission.request",
        turnId: event.turnId,
        requestId: event.requestId,
        toolCall: event.toolCall,
        options: event.options,
      });
      return;
    }
    if (event.type === "permission_resolved") {
      const recording = this.turns.get(event.turnId);
      const request = recording?.pending.get(event.requestId);
      if (recording !== undefined && request !== undefined) {
        recording.pending.delete(event.requestId);
        const option = request.options.find((o) => o.optionId === event.optionId);
        const answer = event.cancelled === true ? "cancelled" : `"${option?.name ?? event.optionId ?? "answered"}"`;
        this.options.activity?.permissionAnswered(this.activityContext(recording), event.requestId, `${answer}: ${request.toolCall.title}`, this.isBackground(recording));
      }
      if (!current) return;
      this.broadcast({
        type: "permission.resolved",
        turnId: event.turnId,
        requestId: event.requestId,
        ...(event.optionId !== undefined ? { optionId: event.optionId } : {}),
        ...(event.cancelled !== undefined ? { cancelled: event.cancelled } : {}),
      });
      return;
    }
    if (event.type === "rate_limit") {
      this.options.usage?.rateLimit(entry.agentId, event.info);
      return;
    }
    // turn_finished
    if (this.activeTurn === event.turnId) this.activeTurn = undefined;
    const recording = this.turns.get(event.turnId);
    this.turns.delete(event.turnId);
    this.recordUsage(entry, event, recording);
    if (recording !== undefined) {
      // ruah-verify runs on the open project: not after a background turn of another one.
      if (recording.projectId === this.open?.info.id) this.options.engines?.afterTurn(recording.record.nodeId);
      this.finalizeTurn(recording, event.stopReason, event.error);
    } else if (current) this.broadcast({ type: "turn.finished", turnId: event.turnId, stopReason: event.stopReason });
    const waiter = this.taskWaiters.get(event.turnId);
    if (waiter !== undefined) {
      this.taskWaiters.delete(event.turnId);
      const text = (recording?.record.events ?? []).map((e) => (e.kind === "text" ? e.text : "")).join("");
      waiter({ turnId: event.turnId, text, stopReason: event.stopReason, ...(event.error !== undefined ? { error: event.error } : {}) });
    }
    // A turn the hub no longer tracks (detached, finalized) still unpins its bridge.
    if (entry.turnId === event.turnId) void this.pool.turnEnded(entry).catch(() => {});
  }

  /** agent.error activity (§13.2) when a bridge that runs a turn, or the current one, goes to "error". */
  private noteAgentError(entry: PooledBridge, current: boolean): void {
    const state = entry.status.state;
    const before = this.lastStates.get(entry);
    this.lastStates.set(entry, state);
    const activity = this.options.activity;
    if (activity === undefined || state !== "error" || before === "error" || entry.speculative) return;
    const recording = entry.turnId !== undefined ? this.turns.get(entry.turnId) : undefined;
    const message = entry.status.error ?? "the agent stopped";
    if (recording !== undefined && !recording.finalized) {
      activity.agentError(this.activityContext(recording), message, this.isBackground(recording));
    } else if (current && this.open !== null) {
      activity.agentError(
        { projectId: this.open.info.id, projectName: this.open.info.name, projectRoot: this.open.info.root, chatId: this.activeChatId, agentId: entry.agentId },
        message,
        this.sockets.size === 0,
      );
    }
  }

  private recordUsage(entry: PooledBridge, event: Extract<BridgeEvent, { type: "turn_finished" }>, recording: RecordingTurn | undefined): void {
    const usage = this.options.usage;
    // The scripted mock agent spends nothing; keep it out of the real log.
    if (usage === undefined || entry.agentId === MOCK_AGENT_ID) return;
    try {
      usage.recordTurn({
        repoRoot: recording?.root ?? entry.root,
        agentId: entry.agentId,
        model: entry.status.models?.currentModelId,
        turnId: event.turnId,
        stopReason: event.stopReason,
        usage: event.usage,
        elapsedMs: recording !== undefined ? Date.now() - recording.startedAtMs : 0,
        ...(recording?.record.nodeId !== undefined ? { nodeId: recording.record.nodeId } : {}),
      });
    } catch (err) {
      this.options.debug(`usage record failed: ${(err as Error).message}`);
    }
  }

  send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  error(socket: WebSocket, code: string, message: string, extra: { turnId?: string; requestId?: string } = {}): void {
    this.send(socket, {
      type: "error",
      code: code as never,
      message,
      ...(extra.turnId !== undefined ? { turnId: extra.turnId } : {}),
      ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    });
  }
}

interface SocketSession {
  socket: WebSocket;
  hello: boolean;
  alive: boolean;
}

export function attachSession(hub: SessionHub, socket: WebSocket): void {
  const session: SocketSession = { socket, hello: false, alive: true };
  hub.sockets.add(socket);

  socket.on("close", () => {
    session.alive = false;
    hub.sockets.delete(socket);
    hub.options.cloudWatch?.watch(socket, false);
    // §2.2 rule 6: cancel a running turn only when the LAST viewer is gone and
    // none reconnects within the grace period (another tab, or a page reload,
    // keeps the turn alive). Background turns (§13.1) go too: nobody is left
    // to answer their permission requests or see their notifications.
    if (hub.hasRunningTurns() && hub.sockets.size === 0) {
      setTimeout(() => {
        if (hub.sockets.size === 0 && hub.hasRunningTurns()) void hub.cancelActive("last viewer disconnected");
      }, DISCONNECT_GRACE_MS).unref();
    }
  });

  socket.on("message", (data) => {
    if (!session.alive) return;
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (raw.length > MAX_FRAME_BYTES) {
      hub.error(socket, "bad_message", `frame exceeds 1 MiB (${raw.length} bytes)`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      hub.error(socket, "bad_message", "frame is not valid JSON");
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      hub.error(socket, "bad_message", `frame failed validation: ${result.error.issues[0]?.message ?? "unknown"}`);
      return;
    }
    const message = result.data;

    if (!session.hello) {
      if (message.type !== "hello") {
        // §2.2 rule 1: any other frame before hello -> bad_message + close.
        hub.error(socket, "bad_message", "expected hello as the first frame");
        socket.close(1002, "hello required");
        return;
      }
      session.hello = true;
      hub.options.debug(`hello from ${message.client}`);
      hub.sendHello(socket);
      return;
    }

    handleClientMessage(hub, socket, message);
  });
}

export function handleClientMessage(hub: SessionHub, socket: WebSocket, message: ClientMessage): void {
  switch (message.type) {
    case "hello":
      return;
    case "architecture.get": {
      const arch = hub.architectureMessage("initial");
      if (arch !== undefined) hub.send(socket, arch);
      return;
    }
    case "focus.set": {
      hub.options.debug(`focus.set ${message.nodeId ?? "(null)"}`);
      hub.setFocus(message.nodeId);
      return;
    }
    case "prompt": {
      hub.startTurn(socket, message);
      return;
    }
    case "permission.response": {
      const ok = hub.answerPermission(message.requestId, "cancelled" in message ? { cancelled: true } : { optionId: message.optionId });
      if (!ok) hub.error(socket, "no_turn", `unknown permission request: ${message.requestId}`);
      return;
    }
    case "cancel": {
      void hub.cancelTurn(message.turnId, socket);
      return;
    }
    case "session.reset": {
      const bridge = hub.bridge;
      if (bridge === undefined) {
        hub.error(socket, "bad_message", NO_PROJECT_MESSAGE);
        return;
      }
      void bridge.reset().catch((err: unknown) => {
        hub.error(socket, "internal", `session reset failed: ${(err as Error).message}`);
      });
      return;
    }
    case "mode.set": {
      hub.setMode(message.modeId, socket);
      return;
    }
    case "model.set": {
      hub.setModel(message.modelId, socket);
      return;
    }
    case "agent.set": {
      void hub.switchAgent(message.agentId, socket);
      return;
    }
    case "agent.prewarm": {
      hub.prewarm(message.agentIds);
      return;
    }
    case "defaults.set": {
      hub.setDefaults(message, socket);
      return;
    }
    case "architecture.save": {
      const store = hub.store;
      if (store === null) {
        hub.error(socket, "save_rejected", `save failed: ${NO_PROJECT_MESSAGE}`);
        return;
      }
      store.save(message.architecture, { by: { kind: "user" } }).catch((err: Error) => hub.error(socket, "save_rejected", `save failed: ${err.message}`));
      return;
    }
    case "chat.new": {
      hub.newChat(socket);
      return;
    }
    case "chat.open": {
      hub.openChat(message.chatId, socket);
      return;
    }
    case "chat.rename": {
      hub.renameChat(message.chatId, message.title, socket);
      return;
    }
    case "chat.delete": {
      hub.deleteChat(message.chatId, socket);
      return;
    }
    case "arch.undo": {
      hub.undoMapTurn(message.turnId, socket);
      return;
    }
    case "cloud.watch": {
      hub.options.cloudWatch?.watch(socket, message.on);
      return;
    }
    case "activity.read": {
      hub.markRead(message.projectId, message.chatId);
      return;
    }
    case "view.save": {
      hub.saveView(message.projectId, message.view, socket);
      return;
    }
    case "settings.set": {
      hub.setFeatures(
        {
          ...(message.backgroundAgents !== undefined ? { backgroundAgents: message.backgroundAgents } : {}),
          ...(message.notifications !== undefined ? { notifications: message.notifications } : {}),
          ...(message.usage?.readAppLogins !== undefined ? { usage: { readAppLogins: message.usage.readAppLogins } } : {}),
        },
        socket,
      );
      return;
    }
  }
}
