// src/serve/session.ts — per-socket state machine (CONTRACTS.md §2.2 rules
// 1–6, 8–9) plus the hub that owns the current AcpBridge and the one active
// turn. Several sockets may connect; all receive broadcasts. agent.set swaps
// the bridge for another agent's (AgentSwitcher, e.g. AgentCatalog).
import type { WebSocket } from "ws";
import type { AgentChoiceState, ClientMessage, ErrorCode, ServerMessage } from "../contracts/ws.js";
import { ClientMessageSchema } from "../contracts/ws.js";
import type { AcpBridge, BridgeEvent } from "../acp/bridge.js";
import type { ModeState, ModelState } from "../contracts/ws.js";
import { BusyError } from "../acp/bridge.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { buildContextPack, buildPromptBlocks } from "../context/pack.js";
import { ArchIndex } from "../context/graph.js";
import type { ArchitectureStore } from "./architecture-store.js";
import type { UsageSink } from "../usage/index.js";

const MAX_FRAME_BYTES = 1_048_576;
/** Same id as src/acp/index.ts MOCK_AGENT_ID (not imported: index.ts pulls in every bridge). */
const MOCK_AGENT_ID = "mock";

/** Builds bridges for agent.set. AgentCatalog (src/acp/index.ts) implements it. */
export interface AgentSwitcher {
  choices(currentAgentId: string): AgentChoiceState;
  check(agentId: string): { ok: true } | { ok: false; code: ErrorCode; message: string };
  create(agentId: string): AcpBridge;
}

export interface SessionHubOptions {
  version: string;
  links: boolean;
  debug: (line: string) => void;
  info: (line: string) => void;
  /** Id of the agent behind the initial bridge (agents.currentAgentId). */
  agentId?: string;
  /** Enables agent.set and agent.status.agents. */
  agents?: AgentSwitcher;
  /** Receives every finished turn and streamed rate-limit reading (usage log + limits). */
  usage?: UsageSink;
}

// One per daemon: owns the bridge and the single active turn.
export class SessionHub {
  readonly sockets = new Set<WebSocket>();
  private unsubscribe: () => void;
  private currentBridge: AcpBridge;
  private currentAgentId: string;
  private switching = false;
  private activeTurn: string | undefined;
  /** When each accepted prompt started (usage durations); cleared on turn_finished. */
  private readonly turnStarts = new Map<string, number>();
  private currentState: "starting" | "idle" | "busy" | "error" | "stopped" = "starting";
  private lastStatus: {
    agent?: { name: string; version: string };
    sessionId?: string;
    modes?: ModeState;
    models?: ModelState;
    error?: string;
  } = {};

  constructor(
    readonly store: ArchitectureStore,
    bridge: AcpBridge,
    readonly options: SessionHubOptions,
  ) {
    this.currentBridge = bridge;
    this.currentAgentId = options.agentId ?? "unknown";
    // run-serve may start the bridge before the hub exists, so its initial
    // status event can be gone; seed from the bridge instead of assuming "starting".
    if (bridge.status() !== "stopped") this.currentState = bridge.status();
    const initialAgentId = this.currentAgentId;
    this.unsubscribe = bridge.on((event) => this.onBridgeEvent(bridge, event, initialAgentId));
    store.onChange((event) => {
      this.broadcast({
        type: "architecture",
        reason: event.reason,
        revision: event.revision,
        root: store.root,
        path: store.path,
        architecture: event.architecture,
      });
    });
    store.onError((error) => {
      this.broadcast({ type: "architecture.error", path: error.path, message: error.message });
    });
  }

  version(): string {
    return this.options.version;
  }

  /** The current agent's bridge (changes on agent.set). */
  get bridge(): AcpBridge {
    return this.currentBridge;
  }

  agentId(): string {
    return this.currentAgentId;
  }

  /**
   * agent.set: stops the current agent (its active turn finishes "cancelled"),
   * then starts the new one with a fresh session. An unknown or uninstalled
   * agent is rejected before anything is torn down. A new agent that fails to
   * start is left in state "error" (its status carries the reason); the viewer
   * can pick another agent.
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
    if (agentId === this.currentAgentId && (this.currentState === "idle" || this.currentState === "busy")) {
      this.broadcast(this.agentStatusMessage());
      return;
    }
    let next: AcpBridge;
    try {
      next = agents.create(agentId);
    } catch (err) {
      return fail("agent_spawn_failed", (err as Error).message);
    }
    this.switching = true;
    const previous = this.currentBridge;
    const unsubscribePrevious = this.unsubscribe;
    this.currentBridge = next;
    this.currentAgentId = agentId;
    this.unsubscribe = next.on((event) => this.onBridgeEvent(next, event, agentId));
    // agent/session/modes/models belonged to the previous agent.
    this.lastStatus = {};
    this.currentState = "starting";
    this.broadcast(this.agentStatusMessage());
    this.options.info(`switching agent to ${agentId}`);
    try {
      try {
        await previous.stop();
      } catch (err) {
        this.options.debug(`stopping the previous agent failed: ${(err as Error).message}`);
      } finally {
        unsubscribePrevious();
      }
      this.activeTurn = undefined;
      try {
        await next.start();
      } catch (err) {
        fail("agent_spawn_failed", `${agentId} failed to start: ${(err as Error).message}`);
      }
    } finally {
      this.switching = false;
    }
  }

  activeTurnId(): string | undefined {
    return this.activeTurn;
  }

  markTurnActive(turnId: string): void {
    this.activeTurn = turnId;
    this.turnStarts.set(turnId, Date.now());
  }

  async cancelTurn(turnId: string, socket?: WebSocket): Promise<void> {
    if (this.activeTurn !== turnId) {
      if (socket !== undefined) this.error(socket, "no_turn", `unknown turn: ${turnId}`);
      return;
    }
    await this.bridge.cancel(turnId);
  }

  async cancelActive(_why: string): Promise<void> {
    if (this.activeTurn === undefined) return;
    await this.bridge.cancel(this.activeTurn);
  }

  agentState(): "starting" | "idle" | "busy" | "error" | "stopped" {
    return this.currentState;
  }

  agentStatusMessage(): ServerMessage {
    const { agent, sessionId, modes, models, error } = this.lastStatus;
    const agents = this.options.agents?.choices(this.currentAgentId);
    return {
      type: "agent.status",
      state: this.currentState,
      ...(agent !== undefined ? { agent } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(modes !== undefined ? { modes } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(agents !== undefined ? { agents } : {}),
      ...(error !== undefined && this.currentState === "error" ? { error } : {}),
    };
  }

  close(): void {
    this.unsubscribe();
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  private onBridgeEvent(source: AcpBridge, event: BridgeEvent, agentId: string): void {
    if (event.type === "status") {
      // A bridge being replaced by agent.set still finishes its turn below,
      // but its state is no longer the agent's state.
      if (source !== this.currentBridge) return;
      this.currentState = event.state;
      // Bridges send agent/sessionId/modes/models only when they change; carry
      // them forward so every agent.status (and the one sent after hello) is whole.
      const { agent, sessionId, modes, models } = this.lastStatus;
      this.lastStatus = {
        ...(agent !== undefined ? { agent } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(modes !== undefined ? { modes } : {}),
        ...(models !== undefined ? { models } : {}),
        ...(event.agent !== undefined ? { agent: event.agent } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        ...(event.modes !== undefined ? { modes: event.modes } : {}),
        ...(event.models !== undefined ? { models: event.models } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
      this.broadcast(this.agentStatusMessage());
      return;
    }
    if (event.type === "stream") {
      this.broadcast({ type: "stream", turnId: event.turnId, event: event.event });
      return;
    }
    if (event.type === "permission") {
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
      this.options.usage?.rateLimit(agentId, event.info);
      return;
    }
    // turn_finished
    this.activeTurn = undefined;
    this.recordUsage(source, event, agentId);
    this.broadcast({ type: "turn.finished", turnId: event.turnId, stopReason: event.stopReason });
  }

  private recordUsage(source: AcpBridge, event: Extract<BridgeEvent, { type: "turn_finished" }>, agentId: string): void {
    const startedAt = this.turnStarts.get(event.turnId);
    this.turnStarts.delete(event.turnId);
    const usage = this.options.usage;
    // The scripted mock agent spends nothing; keep it out of the real log.
    if (usage === undefined || agentId === MOCK_AGENT_ID) return;
    const currentModel = source === this.currentBridge ? this.lastStatus.models?.currentModelId : undefined;
    try {
      usage.recordTurn({
        repoRoot: this.store.root,
        agentId,
        model: currentModel,
        turnId: event.turnId,
        stopReason: event.stopReason,
        usage: event.usage,
        elapsedMs: startedAt !== undefined ? Date.now() - startedAt : 0,
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
    // §2.2 rule 6: viewer disconnect during a turn = cancel.
    if (hub.activeTurnId() !== undefined) {
      void hub.cancelActive("socket closed");
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
      const arch = hub.store.current();
      if (arch !== null) {
        hub.send(socket, {
          type: "architecture",
          reason: "initial",
          revision: hub.store.revision,
          root: hub.store.root,
          path: hub.store.path,
          architecture: arch,
        });
      }
      hub.send(socket, hub.agentStatusMessage());
      return;
    }

    handleClientMessage(hub, socket, message);
  });
}

export function handleClientMessage(hub: SessionHub, socket: WebSocket, message: ClientMessage): void {
  switch (message.type) {
    case "architecture.get": {
      const arch = hub.store.current();
      if (arch !== null) {
        hub.send(socket, {
          type: "architecture",
          reason: "initial",
          revision: hub.store.revision,
          root: hub.store.root,
          path: hub.store.path,
          architecture: arch,
        });
      }
      return;
    }
    case "focus.set": {
      hub.options.debug(`focus.set ${message.nodeId ?? "(null)"}`);
      return;
    }
    case "prompt": {
      const state = hub.agentState();
      // "error" is allowed: both real bridges restart the agent on the next prompt.
      if (state !== "idle" && state !== "error") {
        hub.error(socket, "busy", `agent is ${state}, not idle`, { turnId: message.turnId });
        return;
      }
      const arch = hub.store.current();
      if (arch === null) return;
      const index = new ArchIndex(arch, hub.store.root);
      if (index.byId(message.nodeId) === undefined) {
        hub.error(socket, "unknown_node", `unknown node: ${message.nodeId}`, { turnId: message.turnId });
        return;
      }
      const node = index.byId(message.nodeId);
      const pack = buildContextPack(index, message.nodeId, hub.store.root, message.text);
      const blocks = buildPromptBlocks(pack, node?.files ?? [], hub.store.root, hub.options.links);
      try {
        const handle = hub.bridge.prompt(message.turnId, blocks as ContentBlock[]);
        hub.markTurnActive(message.turnId);
        hub.send(socket, {
          type: "turn.started",
          turnId: message.turnId,
          nodeId: message.nodeId,
          contextPack: pack,
          text: message.text,
        });
        void handle.done.catch(() => {});
      } catch (err) {
        if (err instanceof BusyError) {
          hub.error(socket, "busy", err.message, { turnId: message.turnId });
          return;
        }
        hub.error(socket, "internal", (err as Error).message, { turnId: message.turnId });
      }
      return;
    }
    case "permission.response": {
      if (message.type === "permission.response" && "cancelled" in message && message.cancelled === true) {
        const okCancelled = hub.bridge.answerPermission(message.requestId, { cancelled: true });
        if (!okCancelled) hub.error(socket, "no_turn", `unknown permission request: ${message.requestId}`);
        return;
      }
      if (message.type === "permission.response" && "optionId" in message) {
        const okOption = hub.bridge.answerPermission(message.requestId, { optionId: message.optionId });
        if (!okOption) hub.error(socket, "no_turn", `unknown permission request: ${message.requestId}`);
      }
      return;
    }
    case "cancel": {
      void hub.cancelTurn(message.turnId, socket);
      return;
    }
    case "session.reset": {
      void hub.bridge.reset().catch((err: unknown) => {
        hub.error(socket, "internal", `session reset failed: ${(err as Error).message}`);
      });
      return;
    }
    case "mode.set": {
      void hub.bridge.setMode(message.modeId).catch((err: unknown) => {
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
      void hub.bridge.setModel(message.modelId).catch((err: unknown) => {
        hub.error(socket, "internal", `model change failed: ${(err as Error).message}`);
      });
      return;
    }
    case "agent.set": {
      void hub.switchAgent(message.agentId, socket);
      return;
    }
    case "architecture.save": {
      hub.store
        .save(message.architecture)
        .catch((err: Error) => hub.error(socket, "save_rejected", `save failed: ${err.message}`));
      return;
    }
  }
}
