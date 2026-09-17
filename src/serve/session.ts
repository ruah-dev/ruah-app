// src/serve/session.ts — per-socket state machine (CONTRACTS.md §2.2 rules
// 1–6, 8–9) plus the hub that owns the single AcpBridge and the one active
// turn. Several sockets may connect; all receive broadcasts.
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../contracts/ws.js";
import { ClientMessageSchema } from "../contracts/ws.js";
import type { AcpBridge, BridgeEvent } from "../acp/bridge.js";
import { BusyError } from "../acp/bridge.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { buildContextPack, buildPromptBlocks } from "../context/pack.js";
import { ArchIndex } from "../context/graph.js";
import type { ArchitectureStore } from "./architecture-store.js";

const MAX_FRAME_BYTES = 1_048_576;

export interface SessionHubOptions {
  version: string;
  links: boolean;
  debug: (line: string) => void;
  info: (line: string) => void;
}

// One per daemon: owns the bridge and the single active turn.
export class SessionHub {
  readonly sockets = new Set<WebSocket>();
  private readonly unsubscribe: () => void;
  private activeTurn: string | undefined;
  private currentState: "starting" | "idle" | "busy" | "error" | "stopped" = "starting";

  constructor(
    readonly store: ArchitectureStore,
    readonly bridge: AcpBridge,
    readonly options: SessionHubOptions,
  ) {
    this.unsubscribe = bridge.on((event) => this.onBridgeEvent(event));
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

  activeTurnId(): string | undefined {
    return this.activeTurn;
  }

  markTurnActive(turnId: string): void {
    this.activeTurn = turnId;
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

  close(): void {
    this.unsubscribe();
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  private onBridgeEvent(event: BridgeEvent): void {
    if (event.type === "status") {
      this.currentState = event.state;
      this.broadcast({
        type: "agent.status",
        state: event.state,
        ...(event.agent !== undefined ? { agent: event.agent } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        ...(event.modes !== undefined ? { modes: event.modes } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
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
    // turn_finished
    this.activeTurn = undefined;
    this.broadcast({ type: "turn.finished", turnId: event.turnId, stopReason: event.stopReason });
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
      hub.send(socket, { type: "agent.status", state: hub.agentState() });
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
      if (state !== "idle") {
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
      const pack = buildContextPack(index, message.nodeId, hub.store.root);
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
    case "architecture.save": {
      hub.store
        .save(message.architecture)
        .catch((err: Error) => hub.error(socket, "internal", `save failed: ${err.message}`));
      return;
    }
  }
}
