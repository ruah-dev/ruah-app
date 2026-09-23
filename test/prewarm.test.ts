// test/prewarm.test.ts — instant agent switching (CONTRACTS §2.2 rule 3, §5.5):
// pre-warming other agents in the background (agent.prewarm + automatic after
// a project opens), switch = swap for a ready agent, attaching to an in-flight
// start, the one-slot prompt queue while an agent starts, failed pre-warms,
// pool limits (LRU, TTL, cap; the current agent is never evicted), and the
// saved defaults (settings.json: model / mode per agent, built-in modes).
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { AgentChoiceState, AgentState, ModeState, ModelState, ProjectInfo, ServerMessage, StopReason } from "../src/contracts/ws.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { attachSession, SessionHub, type AgentSwitcher, type ProjectRuntime } from "../src/serve/session.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { SettingsStore } from "../src/projects/settings-store.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import { builtInDefaultMode, isPermissiveMode } from "../src/acp/default-modes.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MODELS: ModelState = { currentModelId: "m1", available: [{ id: "m1", name: "Model 1" }, { id: "m2", name: "Model 2" }] };
const MODES: Record<string, ModeState> = {
  claude: {
    currentModeId: "default",
    available: [
      { id: "default", name: "Manual" },
      { id: "acceptEdits", name: "Accept edits" },
      { id: "plan", name: "Plan" },
      { id: "bypassPermissions", name: "Bypass permissions" },
    ],
  },
  cursor: { currentModeId: "agent", available: [{ id: "agent", name: "Agent" }, { id: "ask", name: "Ask" }] },
};

class FakeBridge implements AcpBridge {
  readonly calls: string[] = [];
  state: AgentState = "stopped";
  sessionId: string;
  models: ModelState = { ...MODELS };
  modes: ModeState | undefined;
  /** start() waits for this (a slow CLI). */
  gate: Promise<void> | undefined;
  /** start() fails with this message (e.g. not logged in). */
  failWith: string | undefined;
  private sessions = 0;
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private turn: { turnId: string; resolve: (r: { stopReason: StopReason }) => void } | undefined;

  constructor(readonly agentId: string, readonly name: string) {
    this.sessionId = this.nextSessionId();
    this.modes = MODES[agentId];
  }

  private nextSessionId(): string {
    this.sessions += 1;
    return `${this.name}-s${this.sessions}`;
  }

  async start(): Promise<void> {
    this.calls.push("start");
    this.state = "starting";
    this.emit({ type: "status", state: "starting" });
    if (this.gate !== undefined) await this.gate;
    if ((this.state as AgentState) === "stopped") throw new Error("agent stopped during start");
    if (this.failWith !== undefined) {
      this.state = "error";
      this.emit({ type: "status", state: "error", error: this.failWith });
      throw new Error(this.failWith);
    }
    this.state = "idle";
    this.emit({
      type: "status",
      state: "idle",
      agent: { name: this.name, version: "1" },
      sessionId: this.sessionId,
      models: this.models,
      ...(this.modes !== undefined ? { modes: this.modes } : {}),
    });
  }

  status(): AgentState {
    return this.state;
  }

  prompt(turnId: string, _blocks: ContentBlock[]): TurnHandle {
    this.calls.push(`prompt:${turnId}`);
    if (this.state !== "idle") throw new Error(`fake bridge is ${this.state}`);
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      this.turn = { turnId, resolve };
    });
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    return { turnId, done };
  }

  finish(stopReason: StopReason = "end_turn"): void {
    const turn = this.turn;
    if (turn === undefined) return;
    this.turn = undefined;
    this.state = "idle";
    this.emit({ type: "turn_finished", turnId: turn.turnId, stopReason });
    this.emit({ type: "status", state: "idle", sessionId: this.sessionId });
    turn.resolve({ stopReason });
  }

  async cancel(turnId: string): Promise<void> {
    this.calls.push(`cancel:${turnId}`);
    if (this.turn?.turnId === turnId) this.finish("cancelled");
  }

  answerPermission(): boolean {
    return false;
  }

  async setMode(modeId: string): Promise<void> {
    this.calls.push(`mode:${modeId}`);
    if (this.modes === undefined || !this.modes.available.some((m) => m.id === modeId)) throw new Error(`unknown mode: ${modeId}`);
    this.modes = { ...this.modes, currentModeId: modeId };
    this.emit({ type: "status", state: this.state, modes: this.modes });
  }

  async setModel(modelId: string): Promise<void> {
    this.calls.push(`model:${modelId}`);
    if (!this.models.available.some((m) => m.id === modelId)) throw new Error(`unknown model: ${modelId}`);
    this.models = { ...this.models, currentModelId: modelId };
    this.emit({ type: "status", state: this.state, models: this.models });
  }

  async reset(): Promise<void> {
    this.calls.push("reset");
  }

  async useSession(sessionId: string | undefined): Promise<void> {
    this.calls.push(`use:${sessionId ?? "fresh"}`);
    this.sessionId = sessionId ?? this.nextSessionId();
    if (this.state !== "stopped") this.emit({ type: "status", state: "idle", sessionId: this.sessionId });
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    this.finish("cancelled");
    this.state = "stopped";
    this.emit({ type: "status", state: "stopped" });
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: BridgeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", cursor: "Cursor Agent", grok: "Grok Build", opencode: "OpenCode", kiro: "Kiro CLI" };

class FakeSwitcher implements AgentSwitcher {
  readonly created: { agentId: string; root: string | undefined; bridge: FakeBridge }[] = [];
  /** Applied to the next bridge created for that agent. */
  readonly next: Record<string, { gate?: Promise<void>; failWith?: string }> = {};
  constructor(private readonly ids: string[] = ["claude", "cursor", "kiro"]) {}
  choices(currentAgentId: string): AgentChoiceState {
    return { currentAgentId, available: this.ids.map((id) => ({ id, name: AGENT_NAMES[id] ?? id, installed: true })) };
  }
  check(agentId: string): { ok: true } | { ok: false; code: "bad_message"; message: string } {
    return this.ids.includes(agentId) ? { ok: true } : { ok: false, code: "bad_message", message: `unknown agent: ${agentId}` };
  }
  create(agentId: string, root?: string): AcpBridge {
    const bridge = new FakeBridge(agentId, `${agentId}@${path.basename(root ?? "?")}`);
    const tweak = this.next[agentId];
    if (tweak?.gate !== undefined) bridge.gate = tweak.gate;
    if (tweak?.failWith !== undefined) bridge.failWith = tweak.failWith;
    this.created.push({ agentId, root, bridge });
    return bridge;
  }
  count(agentId: string): number {
    return this.created.filter((c) => c.agentId === agentId).length;
  }
  bridge(agentId: string): FakeBridge {
    const found = this.created.filter((c) => c.agentId === agentId).at(-1);
    if (found === undefined) throw new Error(`no bridge for ${agentId}`);
    return found.bridge;
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  /** performance.now() of each received frame. */
  at: number[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
    this.at.push(performance.now());
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  all<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.all(type).at(-1);
  }
  warm(agentId: string): { warm?: string | undefined; warmError?: string | undefined } | undefined {
    return this.last("agent.status")?.agents?.available.find((a) => a.id === agentId);
  }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function projectRuntime(name: string): { root: string; runtime: () => ProjectRuntime } {
  const root = tempDir(`ruah-${name}-`);
  writeFileSync(
    path.join(root, "architecture.json"),
    JSON.stringify({ version: 1, name, nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }),
  );
  return {
    root,
    runtime: () => {
      const store = createArchitectureStore(path.join(root, "architecture.json"), { watch: false });
      void store.load();
      const info: ProjectInfo = { id: projectIdFor(root), name, root, kind: "repo", lastOpenedAt: new Date().toISOString() };
      return { info, store };
    },
  };
}

interface SetupOptions {
  agents?: string[];
  warmTtlMs?: number;
  maxLiveBridges?: number;
  autoPrewarmDelayMs?: number;
  settings?: boolean;
  current?: string;
}

async function setup(opts: SetupOptions = {}) {
  const home = tempDir("ruah-home-");
  const chats = new ChatStore(home);
  const settings = opts.settings === false ? undefined : new SettingsStore(home);
  const switcher = new FakeSwitcher(opts.agents);
  const hub = new SessionHub(null, null, {
    version: "0.0.0-test",
    links: false,
    debug: () => {},
    info: () => {},
    agentId: opts.current ?? "claude",
    agents: switcher,
    chats,
    ...(settings !== undefined ? { settings } : {}),
    warmTtlMs: opts.warmTtlMs ?? 60_000,
    maxLiveBridges: opts.maxLiveBridges ?? 4,
    autoPrewarmDelayMs: opts.autoPrewarmDelayMs ?? -1,
  });
  cleanups.push(() => hub.shutdown());
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  const project = projectRuntime("repo");
  hub.setProject(project.runtime());
  await until(() => hub.agentState() === "idle");
  return { hub, chats, settings, switcher, socket, home, project };
}

describe("pre-warming", () => {
  it("starts non-current agents in the background, one at a time, without changing the current agent", async () => {
    const { hub, switcher, socket } = await setup();
    const cursorGate = deferred();
    switcher.next.cursor = { gate: cursorGate.promise };
    socket.sent = [];
    socket.receive({ type: "agent.prewarm" });
    await until(() => switcher.count("cursor") === 1);
    expect(hub.agentId()).toBe("claude");
    expect(hub.agentState()).toBe("idle");
    await until(() => socket.warm("cursor")?.warm === "starting");
    // Staggered: kiro waits until cursor's start has finished.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(switcher.count("kiro")).toBe(0);
    cursorGate.resolve();
    await until(() => socket.warm("cursor")?.warm === "ready");
    await until(() => socket.warm("kiro")?.warm === "ready");
    expect(switcher.count("kiro")).toBe(1);
    // Every broadcast kept describing the current agent.
    expect(socket.all("agent.status").every((m) => m.agents?.currentAgentId === "claude" && m.state === "idle")).toBe(true);
    expect(hub.liveBridges()).toBe(3);
    // A second request for live agents starts nothing new.
    socket.receive({ type: "agent.prewarm", agentIds: ["cursor"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(switcher.count("cursor")).toBe(1);
  });

  it("switching to a ready agent is a swap: idle in the same tick, no new process", async () => {
    const { hub, switcher, socket } = await setup();
    socket.receive({ type: "agent.prewarm", agentIds: ["cursor"] });
    await until(() => socket.warm("cursor")?.warm === "ready");
    const cursor = switcher.bridge("cursor");
    socket.sent = [];
    socket.at = [];
    const t0 = performance.now();
    socket.receive({ type: "agent.set", agentId: "cursor" });
    const index = socket.sent.findIndex((m) => m.type === "agent.status" && m.state === "idle" && m.agents?.currentAgentId === "cursor");
    expect(index).toBeGreaterThanOrEqual(0);
    const ms = (socket.at[index] ?? Number.POSITIVE_INFINITY) - t0;
    expect(ms).toBeLessThan(100);
    expect(socket.sent[index]).toMatchObject({ agent: { name: cursor.name }, models: { currentModelId: "m1" } });
    expect(switcher.count("cursor")).toBe(1);
    expect(cursor.calls.filter((c) => c === "start")).toHaveLength(1);
    expect(hub.bridge).toBe(cursor);
    // The previous agent is parked warm, ready for the way back.
    await until(() => socket.warm("claude")?.warm === "ready");
    socket.receive({ type: "agent.set", agentId: "claude" });
    expect(hub.agentState()).toBe("idle");
    expect(switcher.count("claude")).toBe(1);
  });

  it("switching to an agent that is still starting attaches to that start", async () => {
    const { hub, switcher, socket } = await setup();
    const gate = deferred();
    switcher.next.cursor = { gate: gate.promise };
    socket.receive({ type: "agent.prewarm", agentIds: ["cursor"] });
    await until(() => socket.warm("cursor")?.warm === "starting");
    socket.receive({ type: "agent.set", agentId: "cursor" });
    expect(hub.agentId()).toBe("cursor");
    expect(hub.agentState()).toBe("starting");
    gate.resolve();
    await until(() => hub.agentState() === "idle");
    expect(switcher.count("cursor")).toBe(1);
    expect(switcher.bridge("cursor").calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("a failed pre-warm stays cold with its error, never touches the current agent, and is not retried in a loop", async () => {
    const { hub, switcher, socket } = await setup();
    switcher.next.kiro = { failWith: "authentication required: kiro-cli login" };
    socket.receive({ type: "agent.prewarm", agentIds: ["kiro"] });
    await until(() => socket.warm("kiro")?.warmError !== undefined);
    expect(socket.warm("kiro")).toMatchObject({ warm: "cold", warmError: "authentication required: kiro-cli login" });
    const status = socket.last("agent.status");
    expect(status).toMatchObject({ state: "idle", agents: { currentAgentId: "claude" } });
    expect(status?.error).toBeUndefined();
    expect(socket.all("error")).toEqual([]);
    await until(() => switcher.bridge("kiro").calls.includes("stop"));
    expect(hub.liveBridges()).toBe(1);
    // Picker opened again: kiro is not started again (retry window), cursor is.
    socket.receive({ type: "agent.prewarm" });
    await until(() => socket.warm("cursor")?.warm === "ready");
    expect(switcher.count("kiro")).toBe(1);
    // An explicit switch does try again (and its error is then the current agent's).
    switcher.next.kiro = { failWith: "still logged out" };
    await hub.switchAgent("kiro");
    expect(switcher.count("kiro")).toBe(2);
    expect(socket.last("agent.status")).toMatchObject({ state: "error", error: "still logged out" });
  });

  it("pre-warms the agents this project used before, after the current agent is idle", async () => {
    const home = tempDir("ruah-home-");
    const chats = new ChatStore(home);
    const project = projectRuntime("used");
    const projectId = projectIdFor(project.root);
    chats.create(projectId, { agentId: "kiro", title: "old kiro chat" });
    chats.create(projectId, { agentId: "cursor", title: "newer cursor chat" });
    const switcher = new FakeSwitcher(["claude", "cursor", "kiro", "grok"]);
    const hub = new SessionHub(null, null, {
      version: "0",
      links: false,
      debug: () => {},
      info: () => {},
      agentId: "claude",
      agents: switcher,
      chats,
      warmTtlMs: 60_000,
      autoPrewarmDelayMs: 20,
    });
    cleanups.push(() => hub.shutdown());
    hub.setProject(project.runtime());
    await until(() => hub.agentState() === "idle");
    expect(switcher.count("cursor")).toBe(0);
    await until(() => switcher.count("cursor") === 1 && switcher.count("kiro") === 1);
    expect(switcher.count("grok")).toBe(0);
    expect(hub.agentId()).toBe("claude");
  });
});

describe("prompt queue while an agent starts (§2.2 rule 3)", () => {
  it("queues a prompt sent right after switching to a cold agent and sends it once idle", async () => {
    const { hub, switcher, socket } = await setup();
    const gate = deferred();
    switcher.next.cursor = { gate: gate.promise };
    socket.receive({ type: "agent.set", agentId: "cursor" });
    expect(hub.agentState()).toBe("starting");
    socket.sent = [];
    socket.receive({ type: "prompt", turnId: "q1", nodeId: "api", text: "Explain the API" });
    expect(socket.last("turn.started")).toMatchObject({ turnId: "q1", queued: true, text: "Explain the API" });
    expect(socket.all("error")).toEqual([]);
    // One at a time.
    socket.receive({ type: "prompt", turnId: "q2", nodeId: "api", text: "again" });
    expect(socket.last("error")).toMatchObject({ code: "busy", turnId: "q2" });
    const cursor = switcher.bridge("cursor");
    expect(cursor.calls.some((c) => c.startsWith("prompt:"))).toBe(false);
    gate.resolve();
    await until(() => cursor.calls.includes("prompt:q1"));
    const started = socket.all("turn.started").filter((m) => m.turnId === "q1");
    expect(started).toHaveLength(2);
    expect(started[1]?.queued).toBeUndefined();
    cursor.finish();
    await until(() => socket.last("turn.finished")?.turnId === "q1");
    expect(socket.last("turn.finished")).toMatchObject({ turnId: "q1", stopReason: "end_turn" });
    expect(hub.activeTurnId()).toBeUndefined();
  });

  it("cancel drops the queued turn; it never reaches the agent", async () => {
    const { hub, chats, switcher, socket, project } = await setup();
    const gate = deferred();
    switcher.next.cursor = { gate: gate.promise };
    socket.receive({ type: "agent.set", agentId: "cursor" });
    socket.receive({ type: "prompt", turnId: "q1", nodeId: "api", text: "never mind" });
    expect(socket.last("turn.started")).toMatchObject({ queued: true });
    socket.receive({ type: "cancel", turnId: "q1" });
    expect(socket.last("turn.finished")).toEqual({ type: "turn.finished", turnId: "q1", stopReason: "cancelled" });
    expect(hub.activeTurnId()).toBeUndefined();
    gate.resolve();
    await until(() => hub.agentState() === "idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(switcher.bridge("cursor").calls.some((c) => c.startsWith("prompt:"))).toBe(false);
    // Stored in the chat as cancelled, like any cancelled turn.
    const chatId = hub.chatId() ?? "";
    expect(chats.history(projectIdFor(project.root), chatId).map((t) => [t.turnId, t.stopReason])).toEqual([["q1", "cancelled"]]);
    // The agent is free for the next prompt.
    socket.receive({ type: "prompt", turnId: "q3", nodeId: "api", text: "now" });
    expect(switcher.bridge("cursor").calls).toContain("prompt:q3");
  });

  it("a queued prompt fails with the reason when the agent cannot start", async () => {
    const { switcher, socket } = await setup();
    const gate = deferred();
    switcher.next.kiro = { gate: gate.promise, failWith: "authentication required" };
    socket.receive({ type: "agent.set", agentId: "kiro" });
    socket.receive({ type: "prompt", turnId: "q1", nodeId: "api", text: "hi" });
    gate.resolve();
    await until(() => socket.last("turn.finished")?.turnId === "q1");
    expect(socket.last("turn.finished")).toMatchObject({ stopReason: "error", error: "Kiro CLI did not start: authentication required" });
  });
});

describe("pool limits", () => {
  it("evicts the least recently used warm agent first and never the current one", async () => {
    const { hub, switcher, socket } = await setup({ agents: ["claude", "cursor", "grok", "opencode"], maxLiveBridges: 3 });
    socket.receive({ type: "agent.prewarm", agentIds: ["cursor", "grok"] });
    await until(() => socket.warm("grok")?.warm === "ready");
    expect(hub.liveBridges()).toBe(3);
    // Full: a pre-warm never displaces another warm agent of the same project.
    socket.receive({ type: "agent.prewarm", agentIds: ["opencode"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(switcher.count("opencode")).toBe(0);
    // Touch cursor (hover): grok becomes the least recently used.
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.receive({ type: "agent.prewarm", agentIds: ["cursor"] });
    // An explicit switch makes room: the LRU warm agent (grok) goes, current + cursor stay.
    await hub.switchAgent("opencode");
    await until(() => switcher.bridge("grok").calls.includes("stop"));
    expect(switcher.bridge("cursor").calls).not.toContain("stop");
    expect(switcher.bridge("claude").calls).not.toContain("stop");
    expect(hub.liveBridges()).toBe(3);
    expect(hub.agentId()).toBe("opencode");
  });

  it("with a cap of 1 nothing is pre-warmed (the current agent is never evicted)", async () => {
    const { hub, switcher, socket } = await setup({ maxLiveBridges: 1 });
    socket.receive({ type: "agent.prewarm" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(switcher.count("cursor")).toBe(0);
    expect(switcher.bridge("claude").calls).not.toContain("stop");
    expect(hub.liveBridges()).toBe(1);
  });

  it("stops a pre-warmed agent when its idle TTL runs out", async () => {
    const { hub, switcher, socket } = await setup({ warmTtlMs: 40 });
    socket.receive({ type: "agent.prewarm", agentIds: ["cursor"] });
    await until(() => switcher.count("cursor") === 1);
    await until(() => switcher.bridge("cursor").calls.includes("stop"));
    expect(hub.liveBridges()).toBe(1);
    expect(switcher.bridge("claude").calls).not.toContain("stop");
    await until(() => socket.warm("cursor")?.warm === "cold");
  });
});

describe("model and mode choices", () => {
  it("re-applies the chosen model when an agent becomes current again (also after its process was stopped)", async () => {
    const { hub, switcher, socket } = await setup({ maxLiveBridges: 2 });
    socket.receive({ type: "model.set", modelId: "m2" });
    await until(() => socket.last("agent.status")?.models?.currentModelId === "m2");
    // Warm round trip: the parked bridge kept its model.
    await hub.switchAgent("cursor");
    await hub.switchAgent("claude");
    expect(socket.last("agent.status")?.models?.currentModelId).toBe("m2");
    // Cold round trip: claude's bridge is evicted (cap 2), a new one starts on m2.
    await hub.switchAgent("cursor");
    await hub.switchAgent("kiro");
    await until(() => switcher.bridge("claude").calls.includes("stop"));
    await hub.switchAgent("claude");
    expect(switcher.count("claude")).toBe(2);
    const fresh = switcher.bridge("claude");
    await until(() => fresh.calls.includes("model:m2"));
    await until(() => socket.last("agent.status")?.models?.currentModelId === "m2");
  });

  it("applies the built-in edit-without-asking mode to a new session, and a saved mode wins over it", async () => {
    const { hub, switcher, socket, settings } = await setup();
    const claude = switcher.bridge("claude");
    await until(() => claude.calls.includes("mode:acceptEdits"));
    await until(() => socket.last("agent.status")?.modes?.currentModeId === "acceptEdits");
    // Cursor's default ("agent") already edits: nothing to change.
    await hub.switchAgent("cursor");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(switcher.bridge("cursor").calls.filter((c) => c.startsWith("mode:"))).toEqual([]);
    // The user picks "Ask before edits": applied, saved, and used by the next session.
    await hub.switchAgent("claude");
    socket.receive({ type: "mode.set", modeId: "default" });
    await until(() => settings?.get().modes.claude === "default");
    expect(socket.last("agent.status")?.defaults?.modes.claude).toBe("default");
  });

  it("saved defaults: startup model, per-project session choice wins, defaults.set applies and clears it", async () => {
    const home = tempDir("ruah-home-");
    const settings = new SettingsStore(home);
    settings.update({ models: { claude: "m2" } });
    const switcher = new FakeSwitcher();
    const hub = new SessionHub(null, null, {
      version: "0",
      links: false,
      debug: () => {},
      info: () => {},
      agentId: "claude",
      agents: switcher,
      chats: new ChatStore(home),
      settings,
      warmTtlMs: 60_000,
      autoPrewarmDelayMs: -1,
    });
    cleanups.push(() => hub.shutdown());
    const socket = new FakeSocket();
    attachSession(hub, socket as unknown as WebSocket);
    socket.receive({ type: "hello", protocol: 1, client: "t" });
    hub.setProject(projectRuntime("defaults").runtime());
    await until(() => socket.last("agent.status")?.models?.currentModelId === "m2");
    expect(socket.last("agent.status")?.defaults).toMatchObject({ agentId: "claude", models: { claude: "m2" }, modes: { claude: "acceptEdits", cursor: "agent" } });
    // model.set: remembered for the project and saved.
    socket.receive({ type: "model.set", modelId: "m1" });
    await until(() => settings.get().models.claude === "m1");
    // defaults.set from Settings: saved, the session choice is dropped, the live idle agent follows.
    socket.receive({ type: "defaults.set", models: { claude: "m2" }, modes: { claude: "plan" } });
    expect(settings.get()).toMatchObject({ models: { claude: "m2" }, modes: { claude: "plan" } });
    await until(() => socket.last("agent.status")?.models?.currentModelId === "m2" && socket.last("agent.status")?.modes?.currentModeId === "plan");
    // Default agent: agent.set saves it; defaults.set validates it.
    await hub.switchAgent("cursor");
    expect(settings.get().defaultAgentId).toBe("cursor");
    socket.receive({ type: "defaults.set", agentId: "nope" });
    expect(socket.last("error")).toMatchObject({ code: "bad_message" });
    expect(settings.get().defaultAgentId).toBe("cursor");
  });
});

describe("settings store", () => {
  it("round-trips, keeps unknown keys, treats a corrupt file as empty, clears with null", () => {
    const home = tempDir("ruah-settings-");
    const file = path.join(home, "settings.json");
    expect(new SettingsStore(home).get()).toEqual({ models: {}, modes: {} });
    writeFileSync(file, JSON.stringify({ theme: "dark", models: { claude: "opus", bad: 3 } }));
    const store = new SettingsStore(home);
    expect(store.get()).toEqual({ models: { claude: "opus" }, modes: {} });
    store.update({ defaultAgentId: "cursor", modes: { claude: "acceptEdits" }, models: { cursor: "gpt-5" } });
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ theme: "dark", version: 1, defaultAgentId: "cursor", models: { claude: "opus", cursor: "gpt-5" }, modes: { claude: "acceptEdits" } });
    expect(new SettingsStore(home).get()).toEqual({ defaultAgentId: "cursor", models: { claude: "opus", cursor: "gpt-5" }, modes: { claude: "acceptEdits" } });
    store.update({ models: { claude: null } });
    expect(new SettingsStore(home).get().models).toEqual({ cursor: "gpt-5" });
    writeFileSync(file, "{ not json");
    const errors: string[] = [];
    expect(new SettingsStore(home, { onError: (line) => errors.push(line) }).get()).toEqual({ models: {}, modes: {} });
    expect(errors).toHaveLength(1);
  });
});

describe("built-in default modes", () => {
  const modes = (...ids: [string, string][]): ModeState => ({ currentModeId: ids[0]?.[0] ?? "", available: ids.map(([id, name]) => ({ id, name })) });
  it("picks the agent's edit-without-asking mode, never a bypass / trust-all one", () => {
    const claudeModes = modes(["default", "Manual"], ["acceptEdits", "Accept edits"], ["plan", "Plan"], ["bypassPermissions", "Bypass permissions"]);
    expect(builtInDefaultMode("claude", claudeModes)).toBe("acceptEdits");
    expect(builtInDefaultMode("claude-acp", claudeModes)).toBe("acceptEdits");
    expect(builtInDefaultMode("cursor", modes(["agent", "Agent"], ["ask", "Ask"], ["plan", "Plan"]))).toBe("agent");
    expect(builtInDefaultMode("opencode", modes(["plan", "plan"], ["build", "build"]))).toBe("build");
    expect(builtInDefaultMode("grok", modes(["default", "Default"], ["auto-edit", "Auto edit"]))).toBeUndefined();
    expect(builtInDefaultMode("kiro", modes(["default", "Default"], ["trust-all", "Trust all tools"], ["accept-edits", "Accept edits"]))).toBe("accept-edits");
    expect(builtInDefaultMode("kiro", modes(["default", "Default"], ["yolo", "Auto accept edits (yolo)"]))).toBeUndefined();
    expect(builtInDefaultMode("kiro", modes(["default", "Default"]))).toBeUndefined();
    expect(builtInDefaultMode("claude", undefined)).toBeUndefined();
    expect(isPermissiveMode({ id: "bypassPermissions", name: "Bypass permissions" })).toBe(true);
  });
});
