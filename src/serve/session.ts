// src/serve/session.ts — per-socket state machine (CONTRACTS.md §2.2 rules
// 1–6, 8–9) plus the hub: the open project (store + watcher, swappable at
// runtime, CONTRACTS §5), the current agent bridge (from a warm BridgePool,
// see bridge-pool.ts), the one active turn, and the chats of the open project
// (every turn is recorded into the active chat). Several sockets may connect;
// all receive broadcasts. agent.set swaps the bridge for another agent's
// (AgentSwitcher, e.g. AgentCatalog).
import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import type { AgentChoiceState, ClientMessage, ErrorCode, ProjectInfo, ServerMessage, StopReason, TurnRecord } from "../contracts/ws.js";
import { ClientMessageSchema } from "../contracts/ws.js";
import type { AcpBridge, BridgeEvent } from "../acp/bridge.js";
import { BusyError } from "../acp/bridge.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { buildContextPack, buildPromptBlocks } from "../context/pack.js";
import { ArchIndex } from "../context/graph.js";
import type { ArchitectureStore } from "./architecture-store.js";
import type { UsageSink } from "../usage/index.js";
import { BridgePool, DEFAULT_MAX_LIVE_BRIDGES, type BridgeStatus, type PooledBridge } from "./bridge-pool.js";
import { appendStreamEvent, type ChatStore } from "../projects/chat-store.js";

const MAX_FRAME_BYTES = 1_048_576;
/** How long a running turn survives with no viewer connected (page reloads reconnect well within it). */
export const DISCONNECT_GRACE_MS = Number.parseInt(process.env.RUAH_DISCONNECT_GRACE_MS ?? "5000", 10);
/** Same id as src/acp/index.ts MOCK_AGENT_ID (not imported: index.ts pulls in every bridge). */
const MOCK_AGENT_ID = "mock";
export const NO_PROJECT_MESSAGE = "no project open";

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
  /** Enables chats (CONTRACTS §5): turns are recorded into the active chat. */
  chats?: ChatStore;
  /** ProjectInfo for the store passed to the constructor (default: derived from store.root). */
  project?: ProjectInfo;
  /** How long a bridge the hub let go stays warm (default 0 = stop at once). */
  warmTtlMs?: number;
  /** Cap on live bridges, warm ones included (default 2). */
  maxLiveBridges?: number;
}

interface OpenProject extends ProjectRuntime {
  unsubscribe: (() => void)[];
}

/** A turn being recorded: stored in its chat when it finishes (or is detached). */
interface RecordingTurn {
  entry: PooledBridge;
  projectId: string;
  root: string;
  chatId: string | null;
  record: TurnRecord;
  startedAtMs: number;
  /** Persisted and announced already (detached by a switch); the bridge's own finish only records usage. */
  finalized: boolean;
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

  constructor(
    store: ArchitectureStore | null,
    bridge: AcpBridge | null,
    readonly options: SessionHubOptions,
  ) {
    this.currentAgentId = options.agentId ?? "unknown";
    this.pool = new BridgePool({
      create: (agentId, root) => {
        if (options.agents === undefined) throw new Error("agent switching is not available");
        return options.agents.create(agentId, root);
      },
      onEvent: (entry, event) => this.onBridgeEvent(entry, event),
      ttlMs: options.warmTtlMs ?? 0,
      maxLive: Math.max(1, options.maxLiveBridges ?? DEFAULT_MAX_LIVE_BRIDGES),
      debug: options.debug,
    });
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
   * Swaps the open project (null = launcher state): records and cancels the
   * active turn, closes the old store and its watcher, parks the old bridge
   * in the warm pool, then broadcasts project, architecture, chats (+ the
   * active chat's history) and agent.status. The new project's agent starts in
   * the background (agent.status starting → idle); a warm one is reused.
   */
  setProject(next: ProjectRuntime | null): void {
    this.detachActiveTurn();
    const previous = this.open;
    if (previous !== null) {
      for (const unsubscribe of previous.unsubscribe) unsubscribe();
      previous.store.close();
      this.lastChat.set(previous.info.id, this.activeChatId);
    }
    const previousEntry = this.entry;
    this.entry = undefined;
    if (previousEntry !== undefined) {
      void this.pool.release(previousEntry).catch((err: unknown) => this.options.debug(`bridge release failed: ${String(err)}`));
    }
    this.open = next !== null ? this.attachProject(next) : null;
    this.activeChatId = next !== null ? this.initialChat(next.info.id) : null;
    this.detachedStatus = { state: "stopped" };

    this.broadcast({ type: "project", project: this.project() });
    if (next !== null) {
      const arch = this.architectureMessage("initial");
      if (arch !== undefined) this.broadcast(arch);
      else if (next.loadError !== undefined) this.broadcast({ type: "architecture.error", path: next.store.path, message: next.loadError });
    }
    this.broadcastChats();
    this.broadcastHistory();
    if (next !== null) this.activateBridge();
    this.broadcast(this.agentStatusMessage());
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
      await this.bindSession(entry);
      const state = entry.bridge.status();
      if (fresh || state === "stopped" || state === "error") await entry.bridge.start();
    })().catch((err: unknown) => {
      this.options.debug(`${entry.agentId} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Points the bridge's agent session at the active chat: the chat's stored
   * session for this agent is resumed; a chat without one gets a fresh session
   * unless the bridge's session is still empty.
   */
  private async bindSession(entry: PooledBridge): Promise<void> {
    const chatId = this.entry === entry ? this.activeChatId : entry.chatId ?? null;
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
   * one is taken from the pool or started with a fresh session. An unknown or
   * uninstalled agent is rejected before anything is torn down. A new agent
   * that fails to start is left in state "error" (its status carries the
   * reason); the viewer can pick another agent.
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
      this.broadcast(this.agentStatusMessage());
      return;
    }
    const open = this.open;
    if (open === null) {
      // Launcher state: remembered for the next project.
      this.currentAgentId = agentId;
      this.broadcast(this.agentStatusMessage());
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
    this.broadcast(this.agentStatusMessage());
    this.options.info(`switching agent to ${agentId}${acquired.fresh ? "" : " (warm)"}`);
    try {
      if (previous !== undefined && previous !== next) {
        try {
          await this.pool.release(previous);
        } catch (err) {
          this.options.debug(`releasing the previous agent failed: ${(err as Error).message}`);
        }
      }
      try {
        await this.bindSession(next);
        const nextState = next.bridge.status();
        if (acquired.fresh || nextState === "stopped" || nextState === "error") await next.bridge.start();
      } catch (err) {
        fail("agent_spawn_failed", `${agentId} failed to start: ${(err as Error).message}`);
      }
    } finally {
      this.switching = false;
    }
  }

  agentState(): "starting" | "idle" | "busy" | "error" | "stopped" {
    return (this.entry?.status ?? this.detachedStatus).state;
  }

  agentStatusMessage(): ServerMessage {
    const { state, agent, sessionId, modes, models, error } = this.entry?.status ?? this.detachedStatus;
    const agents = this.options.agents?.choices(this.currentAgentId);
    return {
      type: "agent.status",
      state,
      ...(agent !== undefined ? { agent } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(modes !== undefined ? { modes } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(agents !== undefined ? { agents } : {}),
      ...(error !== undefined && state === "error" ? { error } : {}),
    };
  }

  // ---------- turns ----------

  activeTurnId(): string | undefined {
    return this.activeTurn;
  }

  markTurnActive(turnId: string): void {
    this.activeTurn = turnId;
  }

  async cancelTurn(turnId: string, socket?: WebSocket): Promise<void> {
    if (this.activeTurn !== turnId || this.entry === undefined) {
      if (socket !== undefined) this.error(socket, "no_turn", `unknown turn: ${turnId}`);
      return;
    }
    await this.entry.bridge.cancel(turnId);
  }

  async cancelActive(_why: string): Promise<void> {
    if (this.activeTurn === undefined) return;
    const recording = this.turns.get(this.activeTurn);
    await (recording?.entry.bridge ?? this.entry?.bridge)?.cancel(this.activeTurn);
  }

  /** prompt (§2.2 rule 3): builds the context pack, sends it, records the turn into the active chat. */
  startTurn(socket: WebSocket, message: Extract<ClientMessage, { type: "prompt" }>): void {
    const open = this.open;
    const entry = this.entry;
    if (open === null) {
      this.error(socket, "bad_message", NO_PROJECT_MESSAGE, { turnId: message.turnId });
      return;
    }
    const state = this.agentState();
    // "error" is allowed: both real bridges restart the agent on the next prompt.
    if (entry === undefined || (state !== "idle" && state !== "error")) {
      this.error(socket, "busy", `agent is ${state}, not idle`, { turnId: message.turnId });
      return;
    }
    const arch = open.store.current();
    if (arch === null) return;
    const index = new ArchIndex(arch, open.store.root);
    const node = index.byId(message.nodeId);
    if (node === undefined) {
      this.error(socket, "unknown_node", `unknown node: ${message.nodeId}`, { turnId: message.turnId });
      return;
    }
    const pack = buildContextPack(index, message.nodeId, open.store.root, message.text);
    const resolvePath = open.store.resolvePath?.bind(open.store);
    const blocks = buildPromptBlocks(pack, node.files ?? [], open.store.root, this.options.links, resolvePath);
    let handle;
    try {
      handle = entry.bridge.prompt(message.turnId, blocks as ContentBlock[]);
    } catch (err) {
      if (err instanceof BusyError) {
        this.error(socket, "busy", err.message, { turnId: message.turnId });
        return;
      }
      this.error(socket, "internal", (err as Error).message, { turnId: message.turnId });
      return;
    }
    void handle.done.catch(() => {});
    const chatId = this.ensureChatForTurn(message.text, entry);
    this.markTurnActive(message.turnId);
    this.turns.set(message.turnId, {
      entry,
      projectId: open.info.id,
      root: open.store.root,
      chatId,
      record: {
        turnId: message.turnId,
        nodeId: message.nodeId,
        text: message.text,
        contextPack: pack,
        events: [],
        startedAt: new Date().toISOString(),
      },
      startedAtMs: Date.now(),
      finalized: false,
    });
    this.send(socket, { type: "turn.started", turnId: message.turnId, nodeId: message.nodeId, contextPack: pack, text: message.text });
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
  private detachActiveTurn(): void {
    const turnId = this.activeTurn;
    if (turnId === undefined) return;
    this.activeTurn = undefined;
    const recording = this.turns.get(turnId);
    if (recording === undefined) {
      void this.entry?.bridge.cancel(turnId).catch(() => {});
      return;
    }
    this.finalizeTurn(recording, "cancelled", undefined);
    void recording.entry.bridge.cancel(turnId).catch((err: unknown) => this.options.debug(`cancel failed: ${String(err)}`));
  }

  /** Persists the turn into its chat and broadcasts turn.finished (once). */
  private finalizeTurn(recording: RecordingTurn, stopReason: StopReason, error: string | undefined): void {
    if (recording.finalized) return;
    recording.finalized = true;
    const { record } = recording;
    record.stopReason = stopReason;
    record.finishedAt = new Date().toISOString();
    this.broadcast({ type: "turn.finished", turnId: record.turnId, stopReason, ...(error !== undefined ? { error } : {}) });
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
    if (this.open !== null) this.lastChat.set(this.open.info.id, chatId);
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
    }
    this.broadcast({ type: "chat.history", chatId, turns: ctx.chats.history(ctx.projectId, chatId) });
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
    return { type: "chat.history", chatId: this.activeChatId, turns: chats.history(open.info.id, this.activeChatId) };
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
  }

  /** Stops listening (tests). */
  close(): void {
    for (const unsubscribe of this.open?.unsubscribe ?? []) unsubscribe();
  }

  /** Daemon shutdown: store the active turn, close the store, stop every bridge. */
  async shutdown(): Promise<void> {
    this.detachActiveTurn();
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
      // A parked or retired bridge's state is not the agent's state.
      if (current) this.broadcast(this.agentStatusMessage());
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
    if (recording !== undefined) this.finalizeTurn(recording, event.stopReason, event.error);
    else if (current) this.broadcast({ type: "turn.finished", turnId: event.turnId, stopReason: event.stopReason });
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
    // §2.2 rule 6: cancel a running turn only when the LAST viewer is gone and
    // none reconnects within the grace period (another tab, or a page reload,
    // keeps the turn alive).
    if (hub.activeTurnId() !== undefined && hub.sockets.size === 0) {
      const turnId = hub.activeTurnId();
      setTimeout(() => {
        if (hub.sockets.size === 0 && turnId !== undefined && hub.activeTurnId() === turnId) {
          void hub.cancelActive("last viewer disconnected");
        }
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
      return;
    }
    case "prompt": {
      hub.startTurn(socket, message);
      return;
    }
    case "permission.response": {
      const bridge = hub.bridge;
      const ok = bridge !== undefined && ("cancelled" in message
        ? bridge.answerPermission(message.requestId, { cancelled: true })
        : bridge.answerPermission(message.requestId, { optionId: message.optionId }));
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
      const bridge = hub.bridge;
      if (bridge === undefined) {
        hub.error(socket, "bad_message", NO_PROJECT_MESSAGE);
        return;
      }
      void bridge.setMode(message.modeId).catch((err: unknown) => {
        hub.error(socket, "internal", `mode change failed: ${(err as Error).message}`);
      });
      return;
    }
    case "model.set": {
      // Not gated on idle: both real bridges forward a mid-turn switch to the
      // agent, which applies it from the next model request (the Claude SDK's
      // query.setModel; claude-agent-acp's session/set_config_option does the
      // same through its own query). The bridge re-emits agent.status with the
      // new models.currentModelId once the agent accepted it.
      const bridge = hub.bridge;
      if (bridge === undefined) {
        hub.error(socket, "bad_message", NO_PROJECT_MESSAGE);
        return;
      }
      void bridge.setModel(message.modelId).catch((err: unknown) => {
        hub.error(socket, "internal", `model change failed: ${(err as Error).message}`);
      });
      return;
    }
    case "agent.set": {
      void hub.switchAgent(message.agentId, socket);
      return;
    }
    case "architecture.save": {
      const store = hub.store;
      if (store === null) {
        hub.error(socket, "save_rejected", `save failed: ${NO_PROJECT_MESSAGE}`);
        return;
      }
      store.save(message.architecture).catch((err: Error) => hub.error(socket, "save_rejected", `save failed: ${err.message}`));
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
  }
}
