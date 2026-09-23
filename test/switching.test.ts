// test/switching.test.ts — SessionHub runtime switching (CONTRACTS §5) with
// fake bridges and a fake socket: project swap (store closed, broadcast
// order, active turn stored as cancelled, switch time), the warm bridge pool
// (reuse on switch back, cap of 2 live bridges, TTL stop), chats (auto-created
// chat titled by the first prompt, turns persisted, chat.new/open/rename/
// delete, session resume plumbing through useSession) and the launcher state.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { AgentChoiceState, AgentState, ProjectInfo, ServerMessage, StopReason } from "../src/contracts/ws.js";
import { createArchitectureStore, type ArchitectureStore } from "../src/serve/architecture-store.js";
import { attachSession, SessionHub, type AgentSwitcher, type ProjectRuntime } from "../src/serve/session.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { projectIdFor } from "../src/projects/fs-util.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeBridge implements AcpBridge {
  readonly calls: string[] = [];
  state: AgentState = "stopped";
  sessionId: string;
  private sessions = 0;
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private turn: { turnId: string; resolve: (r: { stopReason: StopReason }) => void } | undefined;

  constructor(readonly name: string) {
    this.sessionId = this.nextSessionId();
  }

  private nextSessionId(): string {
    this.sessions += 1;
    return `${this.name}-s${this.sessions}`;
  }

  async start(): Promise<void> {
    this.calls.push("start");
    this.emit({ type: "status", state: "starting" });
    this.state = "idle";
    this.emit({ type: "status", state: "idle", agent: { name: this.name, version: "1" }, sessionId: this.sessionId });
  }

  status(): AgentState {
    return this.state;
  }

  prompt(turnId: string, _blocks: ContentBlock[]): TurnHandle {
    this.calls.push(`prompt:${turnId}`);
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      this.turn = { turnId, resolve };
    });
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    return { turnId, done };
  }

  /** Streams one text chunk into the running turn. */
  say(text: string): void {
    if (this.turn !== undefined) this.emit({ type: "stream", turnId: this.turn.turnId, event: { kind: "text", text } });
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
  }

  answerPermission(): boolean {
    return false;
  }

  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}

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

class FakeSwitcher implements AgentSwitcher {
  readonly created: { agentId: string; root: string | undefined; bridge: FakeBridge }[] = [];
  choices(currentAgentId: string): AgentChoiceState {
    return {
      currentAgentId,
      available: [
        { id: "alpha", name: "Alpha", installed: true },
        { id: "beta", name: "Beta", installed: true },
      ],
    };
  }
  check(agentId: string): { ok: true } | { ok: false; code: "bad_message"; message: string } {
    return agentId === "alpha" || agentId === "beta" ? { ok: true } : { ok: false, code: "bad_message", message: `unknown agent: ${agentId}` };
  }
  create(agentId: string, root?: string): AcpBridge {
    const bridge = new FakeBridge(`${agentId}@${path.basename(root ?? "?")}`);
    this.created.push({ agentId, root, bridge });
    return bridge;
  }
  bridge(agentId: string, root: string): FakeBridge {
    const found = this.created.filter((c) => c.agentId === agentId && c.root === root).at(-1);
    if (found === undefined) throw new Error(`no bridge for ${agentId} @ ${root}`);
    return found.bridge;
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
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
  types(): string[] {
    return this.sent.map((m) => m.type);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1);
  }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Project {
  root: string;
  runtime: () => ProjectRuntime;
  closes: () => number;
}

function project(name: string): Project {
  const root = tempDir(`ruah-${name}-`);
  writeFileSync(
    path.join(root, "architecture.json"),
    JSON.stringify({ version: 1, name, nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }),
  );
  let closes = 0;
  return {
    root,
    closes: () => closes,
    runtime: () => {
      const store: ArchitectureStore = createArchitectureStore(path.join(root, "architecture.json"), { watch: false });
      const close = store.close.bind(store);
      store.close = () => {
        closes += 1;
        close();
      };
      void store.load();
      const info: ProjectInfo = { id: projectIdFor(root), name, root, kind: "repo", lastOpenedAt: new Date().toISOString() };
      return { info, store };
    },
  };
}

function setup(opts: { warmTtlMs?: number } = {}) {
  const home = tempDir("ruah-home-");
  const chats = new ChatStore(home);
  const switcher = new FakeSwitcher();
  const hub = new SessionHub(null, null, {
    version: "0.0.0-test",
    links: false,
    debug: () => {},
    info: () => {},
    agentId: "alpha",
    agents: switcher,
    chats,
    warmTtlMs: opts.warmTtlMs ?? 60_000,
  });
  cleanups.push(() => hub.shutdown());
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  return { hub, chats, switcher, socket };
}

describe("launcher state", () => {
  it("hello sends project null, no architecture; prompts are refused; agent.set is remembered", async () => {
    const { hub, switcher, socket } = setup();
    expect(socket.types()).toEqual(["project", "agent.status"]);
    expect(socket.sent[0]).toEqual({ type: "project", project: null });
    expect(socket.last("agent.status")).toMatchObject({ state: "stopped", agents: { currentAgentId: "alpha" } });
    socket.receive({ type: "prompt", turnId: "t0", nodeId: "api", text: "hi" });
    expect(socket.last("error")).toMatchObject({ code: "bad_message", message: "no project open", turnId: "t0" });
    socket.receive({ type: "chat.new" });
    expect(socket.last("error")?.message).toBe("no project open");
    socket.receive({ type: "agent.set", agentId: "beta" });
    await until(() => hub.agentId() === "beta");
    expect(switcher.created).toHaveLength(0);
    const a = project("alpha-repo");
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    expect(switcher.created.map((c) => c.agentId)).toEqual(["beta"]);
    expect(switcher.created[0]?.root).toBe(a.root);
  });
});

describe("project switching", () => {
  it("swaps the store, stores the active turn as cancelled and broadcasts project, architecture, chats, status — fast", async () => {
    const { hub, chats, switcher, socket } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Explain the API" });
    expect(socket.last("turn.started")).toMatchObject({ turnId: "t1" });
    bridgeA.say("Looking");
    bridgeA.say(" at it");
    const chatId = hub.chatId();
    expect(chatId).not.toBeNull();

    socket.sent = [];
    const started = performance.now();
    hub.setProject(b.runtime());
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(300);

    expect(socket.types()).toEqual(["turn.finished", "chats", "project", "architecture", "chats", "agent.status"]);
    expect(socket.sent[0]).toEqual({ type: "turn.finished", turnId: "t1", stopReason: "cancelled" });
    expect(socket.last("project")?.project).toMatchObject({ name: "repo-b", root: b.root });
    expect(socket.last("architecture")).toMatchObject({ reason: "initial", root: b.root });
    expect(socket.last("chats")).toEqual({ type: "chats", projectId: projectIdFor(b.root), chats: [], activeChatId: null });
    expect(socket.last("agent.status")?.state).toBe("starting");
    expect(a.closes()).toBe(1);
    expect(hub.activeTurnId()).toBeUndefined();
    expect(bridgeA.calls).toContain("cancel:t1");
    expect(bridgeA.calls).not.toContain("stop"); // parked warm

    // The cancelled turn is in project A's chat with what streamed so far.
    const history = chats.history(projectIdFor(a.root), chatId ?? "");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ turnId: "t1", stopReason: "cancelled", events: [{ kind: "text", text: "Looking at it" }] });
    // Late events of the old project's turn reach nobody.
    socket.sent = [];
    bridgeA.say("late");
    bridgeA.finish("cancelled");
    expect(socket.sent.filter((m) => m.type === "stream" || m.type === "turn.finished")).toEqual([]);
    await until(() => hub.agentState() === "idle");
    expect(socket.last("agent.status")).toMatchObject({ state: "idle", agent: { name: `alpha@${path.basename(b.root)}` } });

    // Switching back restores A's chat and sends its history.
    socket.sent = [];
    hub.setProject(a.runtime());
    expect(socket.types()).toEqual(["project", "architecture", "chats", "chat.history", "agent.status"]);
    expect(socket.last("chats")?.activeChatId).toBe(chatId);
    expect(socket.last("chat.history")?.turns.map((t) => t.turnId)).toEqual(["t1"]);
    expect(socket.last("agent.status")?.state).toBe("idle"); // warm bridge, no startup
  });

  it("keeps the previous bridge warm, reuses it on switch back, caps live bridges at 2", async () => {
    const { hub, switcher } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    hub.setProject(b.runtime());
    await until(() => hub.agentState() === "idle");
    expect(hub.liveBridges()).toBe(2);
    hub.setProject(a.runtime());
    expect(hub.agentState()).toBe("idle");
    expect(switcher.created).toHaveLength(2);
    expect(hub.bridge).toBe(switcher.bridge("alpha", a.root));

    // A third bridge evicts the oldest warm one (alpha @ B).
    await hub.switchAgent("beta");
    expect(switcher.created).toHaveLength(3);
    await until(() => switcher.bridge("alpha", b.root).calls.includes("stop"));
    expect(hub.liveBridges()).toBe(2);
    expect(switcher.bridge("alpha", a.root).calls).not.toContain("stop");

    // Switching the agent back is instant: the warm bridge, already idle.
    const before = switcher.created.length;
    const switching = hub.switchAgent("alpha");
    expect(hub.agentState()).toBe("idle");
    await switching;
    expect(switcher.created.length).toBe(before);
    expect(hub.bridge).toBe(switcher.bridge("alpha", a.root));
  });

  it("stops a warm bridge when its TTL runs out", async () => {
    const { hub, switcher } = setup({ warmTtlMs: 30 });
    const a = project("repo-a");
    const b = project("repo-b");
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    hub.setProject(b.runtime());
    const warm = switcher.bridge("alpha", a.root);
    expect(warm.calls).not.toContain("stop");
    await until(() => warm.calls.includes("stop"));
    expect(hub.liveBridges()).toBe(1);
  });

  it("with no TTL (default) the released bridge is stopped at once", async () => {
    const home = tempDir("ruah-home-");
    const switcher = new FakeSwitcher();
    const hub = new SessionHub(null, null, { version: "0", links: false, debug: () => {}, info: () => {}, agentId: "alpha", agents: switcher, chats: new ChatStore(home) });
    cleanups.push(() => hub.shutdown());
    const a = project("repo-a");
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    hub.setProject(null);
    await until(() => switcher.bridge("alpha", a.root).calls.includes("stop"));
    expect(hub.liveBridges()).toBe(0);
    expect(hub.agentState()).toBe("stopped");
  });
});

describe("chats", () => {
  it("records turns into titled chats and resumes each chat's agent session", async () => {
    const { hub, chats, switcher, socket } = setup();
    const a = project("repo-a");
    const projectId = projectIdFor(a.root);
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    const bridge = switcher.bridge("alpha", a.root);

    // First prompt: a chat is created and titled after it.
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "  Why is the\ninvoice API slow?  " });
    const first = socket.last("chats");
    expect(first?.chats).toHaveLength(1);
    expect(first?.chats[0]).toMatchObject({ title: "Why is the invoice API slow?", agentId: "alpha", turnCount: 0 });
    const chat1 = first?.activeChatId ?? "";
    bridge.say("It is ");
    bridge.say("the N+1 query.");
    bridge.finish();
    expect(socket.last("turn.finished")).toEqual({ type: "turn.finished", turnId: "t1", stopReason: "end_turn" });
    expect(socket.last("chats")?.chats[0]).toMatchObject({ id: chat1, turnCount: 1, lastNodeId: "api" });
    expect(chats.get(projectId, chat1)?.sessions).toEqual({ alpha: "alpha@" + path.basename(a.root) + "-s1" });
    const stored = chats.history(projectId, chat1)[0];
    expect(stored).toMatchObject({ turnId: "t1", nodeId: "api", stopReason: "end_turn", events: [{ kind: "text", text: "It is the N+1 query." }] });
    expect(stored?.contextPack).toContain("[archmap context]");

    // chat.new: a fresh agent session (the old one belongs to chat 1).
    socket.receive({ type: "chat.new" });
    const chat2 = socket.last("chats")?.activeChatId ?? "";
    expect(chat2).not.toBe(chat1);
    expect(socket.last("chat.history")).toEqual({ type: "chat.history", chatId: chat2, turns: [] });
    await until(() => bridge.calls.includes("use:fresh"));
    // chat.new again while the new chat is empty reuses it.
    socket.receive({ type: "chat.new" });
    expect(socket.last("chats")?.chats).toHaveLength(2);
    socket.receive({ type: "prompt", turnId: "t2", nodeId: "api", text: "second chat" });
    bridge.finish();
    const session2 = chats.get(projectId, chat2)?.sessions?.alpha;
    expect(session2).toBe(bridge.sessionId);
    expect(session2).not.toBe(chats.get(projectId, chat1)?.sessions?.alpha);

    // chat.open: history comes back and the stored session is resumed.
    socket.receive({ type: "chat.open", chatId: chat1 });
    expect(socket.last("chat.history")?.turns.map((t) => t.turnId)).toEqual(["t1"]);
    expect(socket.last("chats")?.activeChatId).toBe(chat1);
    await until(() => bridge.calls.includes(`use:${chats.get(projectId, chat1)?.sessions?.alpha}`));
    expect(bridge.sessionId).toBe(chats.get(projectId, chat1)?.sessions?.alpha);

    // chat.open while a turn runs cancels it first (stored as cancelled in its chat).
    socket.receive({ type: "prompt", turnId: "t3", nodeId: "api", text: "third" });
    socket.receive({ type: "chat.open", chatId: chat2 });
    expect(socket.sent.some((m) => m.type === "turn.finished" && m.turnId === "t3" && m.stopReason === "cancelled")).toBe(true);
    expect(chats.history(projectId, chat1).map((t) => [t.turnId, t.stopReason])).toEqual([
      ["t1", "end_turn"],
      ["t3", "cancelled"],
    ]);

    // rename / delete / unknown ids.
    socket.receive({ type: "chat.rename", chatId: chat1, title: "Invoice perf" });
    expect(socket.last("chats")?.chats.find((c) => c.id === chat1)?.title).toBe("Invoice perf");
    socket.receive({ type: "chat.open", chatId: "does-not-exist" });
    expect(socket.last("error")).toMatchObject({ code: "bad_message", message: "unknown chat: does-not-exist" });
    socket.receive({ type: "chat.delete", chatId: chat2 });
    expect(socket.last("chats")).toMatchObject({ activeChatId: null });
    expect(socket.last("chats")?.chats.map((c) => c.id)).toEqual([chat1]);

    // A new socket gets project, architecture, status, chats (no history: no active chat).
    const late = new FakeSocket();
    attachSession(hub, late as unknown as WebSocket);
    late.receive({ type: "hello", protocol: 1, client: "test/1" });
    expect(late.types()).toEqual(["project", "architecture", "agent.status", "chats"]);
  });

  it("switching agents inside a chat keeps one session per agent", async () => {
    const { hub, chats, switcher, socket } = setup();
    const a = project("repo-a");
    const projectId = projectIdFor(a.root);
    hub.setProject(a.runtime());
    await until(() => hub.agentState() === "idle");
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "with alpha" });
    switcher.bridge("alpha", a.root).finish();
    const chatId = hub.chatId() ?? "";
    await hub.switchAgent("beta");
    const beta = switcher.bridge("beta", a.root);
    socket.receive({ type: "prompt", turnId: "t2", nodeId: "api", text: "with beta" });
    beta.finish();
    expect(chats.get(projectId, chatId)?.sessions).toEqual({
      alpha: `alpha@${path.basename(a.root)}-s1`,
      beta: `beta@${path.basename(a.root)}-s1`,
    });
    expect(chats.get(projectId, chatId)?.turnCount).toBe(2);
  });
});
