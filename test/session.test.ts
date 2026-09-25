// test/session.test.ts — SessionHub + attachSession with a fake bridge and a
// fake socket: agent.status replay after hello carries models and agents,
// model.set reaches the bridge, agent.set swaps bridges (and rejects unknown /
// uninstalled agents without touching the current one).
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { AgentChoiceState, AgentState, ModelState, ServerMessage, StopReason } from "../src/contracts/ws.js";
import type { ArchitectureStore } from "../src/serve/architecture-store.js";
import { attachSession, SessionHub, type AgentSwitcher } from "../src/serve/session.js";

const MODELS: ModelState = {
  currentModelId: "default",
  available: [
    { id: "default", name: "Default" },
    { id: "haiku", name: "Haiku" },
  ],
};

class FakeBridge implements AcpBridge {
  readonly calls: string[] = [];
  state: AgentState = "stopped";
  startError: Error | undefined;
  setModelError: Error | undefined;
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private turn: { turnId: string; resolve: (r: { stopReason: StopReason }) => void } | undefined;

  constructor(readonly name: string) {}

  async start(): Promise<void> {
    this.calls.push("start");
    this.emit({ type: "status", state: "starting" });
    if (this.startError !== undefined) {
      this.state = "error";
      this.emit({ type: "status", state: "error", error: this.startError.message });
      throw this.startError;
    }
    this.state = "idle";
    this.emit({ type: "status", state: "idle", agent: { name: this.name, version: "1" }, sessionId: `${this.name}-s1`, models: MODELS });
  }

  status(): AgentState {
    return this.state;
  }

  lastBlocks: ContentBlock[] = [];

  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle {
    this.lastBlocks = blocks;
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      this.turn = { turnId, resolve };
    });
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    return { turnId, done };
  }

  async cancel(): Promise<void> {}

  answerPermission(): boolean {
    return false;
  }

  async setMode(modeId: string): Promise<void> {
    this.calls.push(`setMode:${modeId}`);
  }

  async setModel(modelId: string): Promise<void> {
    this.calls.push(`setModel:${modelId}`);
    if (this.setModelError !== undefined) throw this.setModelError;
    this.emit({ type: "status", state: this.state, models: { ...MODELS, currentModelId: modelId } });
  }

  async reset(): Promise<void> {}

  async stop(): Promise<void> {
    this.calls.push("stop");
    const turn = this.turn;
    this.turn = undefined;
    if (turn !== undefined) {
      this.emit({ type: "turn_finished", turnId: turn.turnId, stopReason: "cancelled" });
      turn.resolve({ stopReason: "cancelled" });
    }
    this.state = "stopped";
    this.emit({ type: "status", state: "stopped" });
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  statuses(): Extract<ServerMessage, { type: "agent.status" }>[] {
    return this.sent.flatMap((m) => (m.type === "agent.status" ? [m] : []));
  }
  errors(): Extract<ServerMessage, { type: "error" }>[] {
    return this.sent.flatMap((m) => (m.type === "error" ? [m] : []));
  }
}

const store = {
  root: "/repo",
  path: "/repo/architecture.json",
  revision: 0,
  current: () => ({ version: 1, name: "fixture", nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }),
  onChange: () => () => {},
  onError: () => () => {},
} as unknown as ArchitectureStore;

class FakeSwitcher implements AgentSwitcher {
  readonly created: FakeBridge[] = [];
  startError: Error | undefined;
  choices(currentAgentId: string): AgentChoiceState {
    return {
      currentAgentId,
      available: [
        { id: "alpha", name: "Alpha", installed: true },
        { id: "beta", name: "Beta", installed: true },
        { id: "gamma", name: "Gamma", installed: false, installHint: "install gamma" },
      ],
    };
  }
  check(agentId: string): { ok: true } | { ok: false; code: "bad_message" | "agent_spawn_failed"; message: string } {
    if (agentId === "gamma") return { ok: false, code: "agent_spawn_failed", message: "Gamma is not installed — install gamma" };
    if (agentId !== "alpha" && agentId !== "beta") return { ok: false, code: "bad_message", message: `unknown agent: ${agentId}` };
    return { ok: true };
  }
  create(agentId: string): AcpBridge {
    const bridge = new FakeBridge(agentId);
    bridge.startError = this.startError;
    this.created.push(bridge);
    return bridge;
  }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(withSwitcher = true) {
  const bridge = new FakeBridge("alpha");
  const switcher = new FakeSwitcher();
  const hub = new SessionHub(store, bridge, {
    version: "0.0.0-test",
    links: false,
    debug: () => {},
    info: () => {},
    agentId: "alpha",
    ...(withSwitcher ? { agents: switcher } : {}),
  });
  await bridge.start();
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  return { hub, bridge, switcher, socket };
}

describe("SessionHub: a map that did not load", () => {
  // Regression: startTurn returned silently when store.current() was null (invalid
  // architecture.json), so every prompt, even a plain chat, left the composer waiting.
  it("still runs plain chats and answers element prompts with an error", async () => {
    const broken = { ...store, current: () => null } as unknown as ArchitectureStore;
    const bridge = new FakeBridge("alpha");
    const hub = new SessionHub(broken, bridge, { version: "t", links: false, debug: () => {}, info: () => {}, agentId: "alpha" });
    await bridge.start();
    const socket = new FakeSocket();
    attachSession(hub, socket as unknown as WebSocket);
    socket.receive({ type: "hello", protocol: 1, client: "test/0" });
    socket.receive({ type: "prompt", turnId: "t1", text: "hello" });
    expect(socket.sent.some((m) => m.type === "turn.started" && m.turnId === "t1")).toBe(true);
    bridge.emit({ type: "turn_finished", turnId: "t1", stopReason: "end_turn" });
    bridge.state = "idle";
    bridge.emit({ type: "status", state: "idle" });
    socket.receive({ type: "prompt", turnId: "t2", text: "and this?", nodeId: "api" });
    expect(socket.errors().at(-1)).toMatchObject({ turnId: "t2", code: "unknown_node" });
  });
});

describe("SessionHub", () => {
  it("replays agent.status after hello with models and agents", async () => {
    const { socket } = await setup();
    const status = socket.statuses().at(-1);
    expect(status).toMatchObject({
      state: "idle",
      agent: { name: "alpha" },
      models: MODELS,
      agents: { currentAgentId: "alpha", available: [{ id: "alpha" }, { id: "beta" }, { id: "gamma", installed: false }] },
    });
  });

  it("model.set reaches the bridge and later statuses carry the new model", async () => {
    const { bridge, socket } = await setup();
    socket.receive({ type: "model.set", modelId: "haiku" });
    await until(() => bridge.calls.includes("setModel:haiku"));
    expect(socket.statuses().at(-1)).toMatchObject({ state: "idle", models: { currentModelId: "haiku" }, agents: { currentAgentId: "alpha" } });
    // Carried forward: a later bare status still has the model.
    bridge.emit({ type: "status", state: "busy" });
    expect(socket.statuses().at(-1)).toMatchObject({ state: "busy", models: { currentModelId: "haiku" }, sessionId: "alpha-s1" });
  });

  it("model.set failure is reported as internal", async () => {
    const { bridge, socket } = await setup();
    bridge.setModelError = new Error("unknown model: gpt-9");
    socket.receive({ type: "model.set", modelId: "gpt-9" });
    await until(() => socket.errors().length > 0);
    expect(socket.errors()[0]).toMatchObject({ code: "internal", message: "model change failed: unknown model: gpt-9" });
  });

  it("a prompt without nodeId is a plain chat: the question as typed, no context pack", async () => {
    const { hub, bridge, socket } = await setup();
    socket.receive({ type: "prompt", turnId: "t0", text: "how is this project built?" });
    expect(hub.activeTurnId()).toBe("t0");
    expect(socket.errors()).toEqual([]);
    expect(bridge.lastBlocks).toEqual([{ type: "text", text: "how is this project built?" }]);
    const started = socket.sent.find((m) => m.type === "turn.started");
    expect(started).toEqual({ type: "turn.started", turnId: "t0", contextPack: "", text: "how is this project built?" });
  });

  it("a prompt about an element still carries its context pack", async () => {
    const { bridge, socket } = await setup();
    socket.receive({ type: "prompt", turnId: "t0", nodeId: "api", text: "what is this?" });
    const text = bridge.lastBlocks.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("[ruah context]");
    expect(text.trimEnd().endsWith("what is this?")).toBe(true);
  });

  it("agent.set stops the current agent (finishing its turn) and starts the new one", async () => {
    const { hub, bridge, switcher, socket } = await setup();
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "hi" });
    expect(hub.activeTurnId()).toBe("t1");
    socket.receive({ type: "agent.set", agentId: "beta" });
    await until(() => switcher.created[0]?.calls.includes("start") === true && hub.agentState() === "idle");
    expect(bridge.calls).toContain("stop");
    expect(hub.bridge).toBe(switcher.created[0]);
    expect(hub.activeTurnId()).toBeUndefined();
    expect(socket.sent).toContainEqual({ type: "turn.finished", turnId: "t1", stopReason: "cancelled" });
    // The old bridge's "stopped" never reaches the viewer.
    expect(socket.statuses().map((s) => s.state)).not.toContain("stopped");
    const last = socket.statuses().at(-1);
    expect(last).toMatchObject({ state: "idle", agent: { name: "beta" }, sessionId: "beta-s1", agents: { currentAgentId: "beta" } });
    // Status events of the retired bridge are ignored.
    bridge.emit({ type: "status", state: "error", error: "late" });
    expect(hub.agentState()).toBe("idle");
    // model.set now goes to the new agent.
    socket.receive({ type: "model.set", modelId: "haiku" });
    await until(() => switcher.created[0]?.calls.includes("setModel:haiku") === true);
    expect(bridge.calls).not.toContain("setModel:haiku");
  });

  it("agent.set rejects unknown and uninstalled agents without touching the current one", async () => {
    const { hub, bridge, switcher, socket } = await setup();
    socket.receive({ type: "agent.set", agentId: "nope" });
    socket.receive({ type: "agent.set", agentId: "gamma" });
    await until(() => socket.errors().length === 2);
    expect(socket.errors()).toEqual([
      { type: "error", code: "bad_message", message: "unknown agent: nope" },
      { type: "error", code: "agent_spawn_failed", message: "Gamma is not installed — install gamma" },
    ]);
    expect(switcher.created).toHaveLength(0);
    expect(bridge.calls).not.toContain("stop");
    expect(hub.bridge).toBe(bridge);
    expect(hub.agentState()).toBe("idle");
  });

  it("agent.set to an agent that fails to start leaves it in error with the reason", async () => {
    const { hub, switcher, socket } = await setup();
    switcher.startError = new Error("authentication required");
    socket.receive({ type: "agent.set", agentId: "beta" });
    await until(() => socket.errors().length > 0);
    expect(socket.errors()[0]).toMatchObject({ code: "agent_spawn_failed", message: "beta failed to start: authentication required" });
    expect(hub.agentState()).toBe("error");
    expect(socket.statuses().at(-1)).toMatchObject({ state: "error", error: "authentication required", agents: { currentAgentId: "beta" } });
  });

  it("agent.set without a switcher is rejected", async () => {
    const { socket } = await setup(false);
    expect(socket.statuses().at(-1)?.agents).toBeUndefined();
    socket.receive({ type: "agent.set", agentId: "beta" });
    await until(() => socket.errors().length > 0);
    expect(socket.errors()[0]).toMatchObject({ code: "bad_message", message: "agent switching is not available" });
  });
});
