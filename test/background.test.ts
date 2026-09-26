// test/background.test.ts — CONTRACTS §13: background agents (a turn keeps
// running across a project switch, re-attach with history + pending
// permission, pool pinning, the background limit, the settings flag), the
// activity feed (events, snapshot on hello, unread markers that survive a
// restart), view state (WS + HTTP, 16 KB limit) and the HTTP endpoints.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { AgentChoiceState, AgentState, ProjectInfo, ServerMessage, StopReason } from "../src/contracts/ws.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { attachSession, SessionHub, type AgentSwitcher, type ProjectRuntime } from "../src/serve/session.js";
import { BridgePool } from "../src/serve/bridge-pool.js";
import { ActivityService, editedFiles } from "../src/serve/activity.js";
import { ActivityLog } from "../src/activity/log.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { SettingsStore } from "../src/projects/settings-store.js";
import { MAX_VIEW_BYTES } from "../src/projects/project-state.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import { startServer } from "../src/serve/server.js";
import { computeResume } from "../src/resume/resume.js";

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
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private turn: { turnId: string; resolve: (r: { stopReason: StopReason }) => void } | undefined;
  private readonly asks = new Map<string, string>();
  /** Delay start() until release() (a queued prompt waits for it). */
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  constructor(readonly name: string) {
    this.sessionId = `${name}-s1`;
  }

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
  }

  async start(): Promise<void> {
    this.calls.push("start");
    this.state = "starting";
    this.emit({ type: "status", state: "starting" });
    if (this.gate !== undefined) await this.gate;
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

  say(text: string): void {
    if (this.turn !== undefined) this.emit({ type: "stream", turnId: this.turn.turnId, event: { kind: "text", text } });
  }

  edit(file: string): void {
    if (this.turn === undefined) return;
    this.emit({
      type: "stream",
      turnId: this.turn.turnId,
      event: { kind: "tool_call", toolCall: { toolCallId: `e-${file}`, title: `Edit ${file}`, kind: "edit", status: "completed", locations: [{ path: file }] } },
    });
  }

  ask(requestId: string, title = "Run npm test"): void {
    if (this.turn === undefined) return;
    this.asks.set(requestId, this.turn.turnId);
    this.emit({
      type: "permission",
      turnId: this.turn.turnId,
      requestId,
      toolCall: { toolCallId: `tc-${requestId}`, title, kind: "execute", status: "pending", locations: [] },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
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

  answerPermission(requestId: string, answer: { optionId: string } | { cancelled: true }): boolean {
    const turnId = this.asks.get(requestId);
    if (turnId === undefined) return false;
    this.asks.delete(requestId);
    this.calls.push(`answer:${requestId}:${"optionId" in answer ? answer.optionId : "cancelled"}`);
    this.emit({ type: "permission_resolved", turnId, requestId, ...("optionId" in answer ? { optionId: answer.optionId } : { cancelled: true as const }) });
    return true;
  }

  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async reset(): Promise<void> {}

  async useSession(sessionId: string | undefined): Promise<void> {
    this.calls.push(`use:${sessionId ?? "fresh"}`);
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
  onCreate: ((bridge: FakeBridge) => void) | undefined;
  choices(currentAgentId: string): AgentChoiceState {
    return { currentAgentId, available: [{ id: "alpha", name: "Alpha", installed: true }, { id: "beta", name: "Beta", installed: true }] };
  }
  check(agentId: string): { ok: true } | { ok: false; code: "bad_message"; message: string } {
    return agentId === "alpha" || agentId === "beta" ? { ok: true } : { ok: false, code: "bad_message", message: `unknown agent: ${agentId}` };
  }
  create(agentId: string, root?: string): AcpBridge {
    const bridge = new FakeBridge(`${agentId}@${path.basename(root ?? "?")}`);
    this.onCreate?.(bridge);
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
  all<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.all(type).at(-1);
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
  id: string;
  runtime: () => ProjectRuntime;
}

function project(name: string): Project {
  const root = tempDir(`ruah-bg-${name}-`);
  writeFileSync(
    path.join(root, "architecture.json"),
    JSON.stringify({ version: 1, name, nodes: [{ id: "api", name: "Invoice API", type: "service" }], edges: [], workflows: [] }),
  );
  return {
    root,
    id: projectIdFor(root),
    runtime: () => {
      const store = createArchitectureStore(path.join(root, "architecture.json"), { watch: false });
      void store.load();
      const info: ProjectInfo = { id: projectIdFor(root), name, root, kind: "repo", lastOpenedAt: new Date().toISOString() };
      return { info, store };
    },
  };
}

function setup(opts: { home?: string; maxLiveBridges?: number; warmTtlMs?: number; maxBackgroundTurns?: number; backgroundAgents?: boolean } = {}) {
  const home = opts.home ?? tempDir("ruah-bg-home-");
  const chats = new ChatStore(home);
  const settings = new SettingsStore(home, { env: {} });
  if (opts.backgroundAgents !== undefined) settings.updateFeatures({ backgroundAgents: opts.backgroundAgents });
  const log = new ActivityLog(home);
  const names = new Map<string, { name: string; root: string }>();
  const activity = new ActivityService({
    log,
    state: chats.state,
    lookup: (id) => names.get(id),
    projectIds: () => [...names.keys()],
    features: () => settings.features(),
    ...(opts.maxBackgroundTurns !== undefined ? { maxBackgroundTurns: opts.maxBackgroundTurns } : {}),
  });
  const switcher = new FakeSwitcher();
  const hub = new SessionHub(null, null, {
    version: "0.0.0-test",
    links: false,
    debug: () => {},
    info: () => {},
    agentId: "alpha",
    agents: switcher,
    chats,
    settings,
    activity,
    warmTtlMs: opts.warmTtlMs ?? 60_000,
    maxLiveBridges: opts.maxLiveBridges ?? 4,
    autoPrewarmDelayMs: -1,
  });
  cleanups.push(() => hub.shutdown());
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  const open = (p: Project): void => {
    names.set(p.id, { name: path.basename(p.root), root: p.root });
    hub.setProject(p.runtime());
  };
  return { home, hub, chats, settings, log, activity, switcher, socket, open };
}

describe("background agents (§13.1)", () => {
  it("a turn keeps running across a project switch and re-attaches with its history", async () => {
    const { hub, chats, switcher, socket, open } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    await until(() => hub.agentState() === "idle");
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Refactor the invoice API" });
    bridgeA.say("Working");
    const chatId = hub.chatId() ?? "";

    socket.sent = [];
    open(b);
    // No cancel, no turn.finished: the turn runs on in the background.
    expect(socket.types()).not.toContain("turn.finished");
    expect(bridgeA.calls).not.toContain("cancel:t1");
    expect(hub.backgroundTurns().map((r) => r.record.turnId)).toEqual(["t1"]);
    await until(() => hub.agentState() === "idle");

    // Its events are recorded but not streamed to the viewer of project B.
    socket.sent = [];
    bridgeA.say(" on it");
    bridgeA.edit("src/invoices.ts");
    expect(socket.all("stream")).toEqual([]);

    // Back to A: the same agent is current, the turn's chat active, history carries the running turn.
    socket.sent = [];
    open(a);
    expect(hub.bridge).toBe(bridgeA);
    expect(hub.agentState()).toBe("busy");
    expect(hub.activeTurnId()).toBe("t1");
    expect(socket.last("chats")?.activeChatId).toBe(chatId);
    const history = socket.last("chat.history");
    expect(history?.chatId).toBe(chatId);
    expect(history?.turns.at(-1)).toMatchObject({ turnId: "t1", running: true, events: [{ kind: "text", text: "Working on it" }, { kind: "tool_call" }] });
    expect(history?.turns.at(-1)?.stopReason).toBeUndefined();

    // Streaming resumes to the viewer; the finish is stored in A's chat.
    bridgeA.say(" — done");
    expect(socket.last("stream")).toMatchObject({ turnId: "t1", event: { kind: "text", text: " — done" } });
    bridgeA.finish();
    expect(socket.last("turn.finished")).toMatchObject({ turnId: "t1", stopReason: "end_turn" });
    const stored = chats.history(a.id, chatId);
    expect(stored.map((t) => [t.turnId, t.stopReason])).toEqual([["t1", "end_turn"]]);
    expect(stored[0]?.running).toBeUndefined();
    expect(editedFiles(stored[0]!)).toEqual(["src/invoices.ts"]);
  });

  it("a turn that finishes in the background is stored, reported and marked unread", async () => {
    const { hub, chats, switcher, socket, open, activity } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    await until(() => hub.agentState() === "idle");
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Add tests" });
    const chatId = hub.chatId() ?? "";
    open(b);
    await until(() => hub.agentState() === "idle");
    socket.sent = [];
    bridgeA.edit("test/a.test.ts");
    bridgeA.finish();
    // No turn.finished for another project's turn; an activity event for everyone.
    expect(socket.all("turn.finished")).toEqual([]);
    const finished = socket.all("activity").find((m) => m.event.kind === "turn.finished");
    expect(finished?.event).toMatchObject({
      projectId: a.id,
      chatId,
      turnId: "t1",
      background: true,
      stopReason: "end_turn",
      files: ["test/a.test.ts"],
    });
    expect(finished?.event.summary).toContain('Finished "Add tests"');
    expect(finished?.project).toMatchObject({ projectId: a.id, running: 0, unread: 1, chats: { [chatId]: 1 } });
    expect(chats.history(a.id, chatId).map((t) => t.stopReason)).toEqual(["end_turn"]);
    expect(activity.projectActivity(a.id).unread).toBe(1);

    // Viewing the chat clears the marker (and tells every viewer).
    socket.sent = [];
    open(a);
    expect(socket.last("activity.project")?.project).toMatchObject({ projectId: a.id, unread: 0 });
    expect(chats.state.unread(a.id)).toEqual({});
  });

  it("a permission request made in the background is answered after switching back", async () => {
    const { hub, switcher, socket, open } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    await until(() => hub.agentState() === "idle");
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Run the tests" });
    open(b);
    await until(() => hub.agentState() === "idle");
    socket.sent = [];
    bridgeA.ask("r1", "Run npm test");
    expect(socket.all("permission.request")).toEqual([]);
    const asked = socket.all("activity").find((m) => m.event.kind === "permission.requested");
    expect(asked?.event).toMatchObject({ projectId: a.id, requestId: "r1", background: true, summary: "Needs permission: Run npm test" });
    expect(asked?.project).toMatchObject({ waitingPermission: 1, running: 1 });

    // A viewer that connects now (reload) is told in the snapshot.
    const late = new FakeSocket();
    attachSession(hub, late as unknown as WebSocket);
    late.receive({ type: "hello", protocol: 1, client: "test/1" });
    expect(late.last("activity.snapshot")?.projects.find((p) => p.projectId === a.id)).toMatchObject({ waitingPermission: 1, running: 1 });

    socket.sent = [];
    open(a);
    const again = socket.last("permission.request");
    expect(again).toMatchObject({ turnId: "t1", requestId: "r1", toolCall: { title: "Run npm test" } });
    expect(socket.types().indexOf("permission.request")).toBeGreaterThan(socket.types().indexOf("chat.history"));

    socket.receive({ type: "permission.response", requestId: "r1", optionId: "allow" });
    expect(bridgeA.calls).toContain("answer:r1:allow");
    expect(socket.last("permission.resolved")).toMatchObject({ requestId: "r1", optionId: "allow" });
    const answered = socket.all("activity").find((m) => m.event.kind === "permission.answered");
    expect(answered?.event.summary).toBe('Permission "Allow": Run npm test');
    expect(answered?.project.waitingPermission).toBe(0);
    bridgeA.finish();
    expect(hub.agentState()).toBe("idle");
  });

  it("a permission of a background turn can be answered from another project too", async () => {
    const { hub, switcher, socket, open } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    await until(() => hub.agentState() === "idle");
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Deploy" });
    open(b);
    bridgeA.ask("r9");
    socket.receive({ type: "permission.response", requestId: "r9", optionId: "deny" });
    expect(bridgeA.calls).toContain("answer:r9:deny");
    expect(socket.last("error")).toBeUndefined();
  });

  it("the pool never evicts a bridge while its turn runs (cap and TTL), then applies the policy", async () => {
    const { hub, switcher, socket, open } = setup({ maxLiveBridges: 2, warmTtlMs: 40 });
    const a = project("repo-a");
    const b = project("repo-b");
    const c = project("repo-c");
    open(a);
    await until(() => hub.agentState() === "idle");
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Long job" });
    open(b);
    await until(() => hub.agentState() === "idle");
    open(c); // needs room: alpha@B (warm) goes, alpha@A (busy) stays
    await until(() => hub.agentState() === "idle");
    await until(() => switcher.bridge("alpha", b.root).calls.includes("stop"));
    await new Promise((resolve) => setTimeout(resolve, 120)); // several TTLs
    expect(bridgeA.calls).not.toContain("stop");
    expect(hub.backgroundTurns()).toHaveLength(1);
    // Done: the TTL applies again.
    bridgeA.finish();
    await until(() => bridgeA.calls.includes("stop"));
  });

  it("BridgePool: release keeps a busy bridge even without a TTL; turnEnded stops it", async () => {
    const stopped: string[] = [];
    const pool = new BridgePool({
      create: (agentId) => {
        const bridge = new FakeBridge(agentId);
        const stop = bridge.stop.bind(bridge);
        bridge.stop = async () => {
          stopped.push(agentId);
          await stop();
        };
        return bridge;
      },
      onEvent: () => {},
      ttlMs: 0,
      maxLive: 1,
    });
    const { entry } = pool.acquire("/r", "alpha");
    entry.turnId = "t1";
    await pool.release(entry);
    expect(pool.size).toBe(1);
    expect(pool.busy()).toEqual([entry]);
    // Cap 1, busy one kept: a new bridge goes over the cap rather than killing the turn.
    const other = pool.acquire("/r", "beta").entry;
    expect(pool.size).toBe(2);
    expect(stopped).toEqual([]);
    await pool.turnEnded(entry);
    expect(stopped).toEqual(["alpha"]);
    expect(pool.list()).toEqual([other]);
  });

  it("beyond the background limit the switch cancels the turn as before", async () => {
    const { hub, switcher, socket, open, chats } = setup({ maxBackgroundTurns: 1 });
    const a = project("repo-a");
    const b = project("repo-b");
    const c = project("repo-c");
    open(a);
    await until(() => hub.agentState() === "idle");
    socket.receive({ type: "prompt", turnId: "ta", nodeId: "api", text: "one" });
    open(b);
    await until(() => hub.agentState() === "idle");
    socket.receive({ type: "prompt", turnId: "tb", nodeId: "api", text: "two" });
    const chatB = hub.chatId() ?? "";
    socket.sent = [];
    open(c);
    expect(socket.last("turn.finished")).toMatchObject({ turnId: "tb", stopReason: "cancelled" });
    expect(socket.last("turn.finished")?.error).toContain("background limit");
    expect(switcher.bridge("alpha", b.root).calls).toContain("cancel:tb");
    expect(hub.backgroundTurns().map((r) => r.record.turnId)).toEqual(["ta"]);
    expect(chats.history(b.id, chatB).map((t) => t.stopReason)).toEqual(["cancelled"]);
    expect(socket.last("activity.snapshot")).toBeUndefined();
    expect(hub.maxBackgroundTurns()).toBe(1);
  });

  it("settings.json backgroundAgents:false (and settings.set) turn background turns off", async () => {
    const { hub, socket, open, settings } = setup();
    const offByDefault = { readAppLogins: false, source: "default" };
    expect(settings.features()).toEqual({ backgroundAgents: true, notifications: "background", usage: offByDefault });
    socket.sent = [];
    socket.receive({ type: "settings.set", backgroundAgents: false, notifications: "off" });
    expect(settings.features()).toEqual({ backgroundAgents: false, notifications: "off", usage: offByDefault });
    expect(socket.last("activity.snapshot")?.settings).toEqual({ backgroundAgents: false, notifications: "off", usage: offByDefault });
    // §20.1: reading an agent app's saved login is switched over the same message.
    socket.receive({ type: "settings.set", usage: { readAppLogins: true } });
    expect(socket.last("activity.snapshot")?.settings.usage).toEqual({ readAppLogins: true, source: "settings" });
    socket.receive({ type: "settings.set", usage: { readAppLogins: false } });
    expect(hub.maxBackgroundTurns()).toBe(0);
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    await until(() => hub.agentState() === "idle");
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "x" });
    socket.sent = [];
    open(b);
    expect(socket.sent[0]).toMatchObject({ type: "turn.finished", turnId: "t1", stopReason: "cancelled" });
    expect(hub.backgroundTurns()).toEqual([]);
    // Persisted: a new store reads the same flags.
    expect(new SettingsStore(path.dirname(settings.file), { env: {} }).features()).toEqual({
      backgroundAgents: false,
      notifications: "off",
      usage: { readAppLogins: false, source: "settings" },
    });
  });

  it("a queued prompt (agent still starting) survives the switch and is sent once the agent is up", async () => {
    const { hub, switcher, socket, open } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    switcher.onCreate = (bridge) => bridge.hold();
    open(a);
    const bridgeA = switcher.bridge("alpha", a.root);
    socket.receive({ type: "prompt", turnId: "tq", nodeId: "api", text: "queued" });
    expect(socket.last("turn.started")).toMatchObject({ turnId: "tq", queued: true });
    switcher.onCreate = undefined;
    open(b);
    await until(() => hub.agentState() === "idle");
    socket.sent = [];
    bridgeA.release();
    await until(() => bridgeA.calls.includes("prompt:tq"));
    expect(socket.all("turn.started")).toEqual([]); // the viewer is on project B
    bridgeA.finish();
    expect(socket.all("activity").some((m) => m.event.kind === "turn.finished" && m.event.turnId === "tq")).toBe(true);
  });

  it("the last viewer leaving cancels background turns too (§2.2 rule 6)", async () => {
    const { hub, switcher, socket, open } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    await until(() => hub.agentState() === "idle");
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "x" });
    open(b);
    socket.close();
    await until(() => switcher.bridge("alpha", a.root).calls.includes("cancel:t1"), 3000);
  });
});

describe("activity feed (§13.2)", () => {
  it("hello carries a snapshot; unread markers survive a daemon restart", async () => {
    const first = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    first.open(a);
    await until(() => first.hub.agentState() === "idle");
    first.socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "Ship it" });
    expect(first.socket.last("activity")?.event).toMatchObject({ kind: "turn.started", projectId: a.id, turnId: "t1", background: false });
    const chatId = first.hub.chatId() ?? "";
    first.open(b);
    first.switcher.bridge("alpha", a.root).finish();
    await first.hub.shutdown();

    // "Restart": a new hub on the same $RUAH_HOME.
    const second = setup({ home: first.home });
    const snapshot = second.socket.last("activity.snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot?.settings).toEqual({ backgroundAgents: true, notifications: "background", usage: { readAppLogins: false, source: "default" } });
    expect(snapshot?.maxBackgroundTurns).toBe(3);
    expect(snapshot?.recent.map((e) => e.kind)).toEqual(["turn.started", "turn.finished"]);
    expect(second.activity.projectActivity(a.id)).toMatchObject({ unread: 1, chats: { [chatId]: 1 }, running: 0 });

    // activity.read clears it.
    second.socket.receive({ type: "activity.read", projectId: a.id });
    expect(second.socket.last("activity.project")?.project).toMatchObject({ projectId: a.id, unread: 0 });
    expect(new ChatStore(first.home).state.unread(a.id)).toEqual({});
    // The log on disk has both events, oldest first.
    expect(new ActivityLog(first.home).read({ projectId: a.id }).map((e) => e.kind)).toEqual(["turn.started", "turn.finished"]);
  });

  it("focus.set is remembered for resume; the last-viewed time is set when leaving", async () => {
    const { hub, chats, open, socket } = setup();
    const a = project("repo-a");
    const b = project("repo-b");
    open(a);
    socket.receive({ type: "focus.set", nodeId: "api" });
    expect(chats.state.read(a.id).lastFocus?.nodeId).toBe("api");
    expect(chats.state.read(a.id).lastViewedAt).toBeUndefined();
    open(b);
    expect(chats.state.read(a.id).lastViewedAt).toBeDefined();
    const info = await computeResume({ id: a.id, name: "repo-a", root: a.root, kind: "repo" }, { home: chats.home, chats, git: false, ruah: false });
    expect(info.lastFocus).toMatchObject({ nodeId: "api", name: "Invoice API" });
    void hub;
  });
});

describe("view state (§13.5)", () => {
  it("view.save stores an object ≤ 16 KB; larger or non-object views are refused", () => {
    const { chats, socket } = setup();
    const a = project("repo-a");
    socket.receive({ type: "view.save", projectId: a.id, view: { page: "map", drill: ["api"], zoom: 1.5 } });
    expect(chats.state.view(a.id).view).toEqual({ page: "map", drill: ["api"], zoom: 1.5 });
    socket.receive({ type: "view.save", projectId: a.id, view: { blob: "x".repeat(MAX_VIEW_BYTES) } });
    expect(socket.last("error")?.message).toMatch(/view\.save: view is \d+ bytes \(max 16384\)/);
    socket.receive({ type: "view.save", projectId: a.id, view: [1, 2] });
    expect(socket.last("error")?.message).toBe("view.save: view must be a JSON object");
    expect(chats.state.view(a.id).view).toEqual({ page: "map", drill: ["api"], zoom: 1.5 });
  });

  it("HTTP: GET/POST /api/projects/:id/view (413 over 16 KB, 403 bad origin), /api/activity, /api/projects/:id/resume", async () => {
    const { hub, chats, activity, open, home, log } = setup();
    const a = project("repo-a");
    open(a);
    const server = await startServer(null, hub, {
      host: "127.0.0.1",
      port: 0,
      allowOrigins: [],
      logger: () => {},
      activity: {
        activity,
        state: chats.state,
        markRead: (projectId, chatId) => hub.markRead(projectId, chatId),
        resume: (id) => computeResume({ id, name: "repo-a", root: a.root, kind: "repo" }, { home, chats, log, git: false, ruah: false }, activity.liveCounts().get(id)),
      },
    });
    cleanups.push(() => server.close());
    const base = server.url;
    const post = (p: string, body: unknown, origin?: string): Promise<Response> =>
      fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) }, body: JSON.stringify(body) });

    expect(await (await fetch(`${base}/api/projects/${a.id}/view`)).json()).toEqual({ view: null, updatedAt: null });
    const ok = await post(`/api/projects/${a.id}/view`, { view: { page: "chats" } }, "http://localhost:5173");
    expect(ok.status).toBe(200);
    expect(((await (await fetch(`${base}/api/projects/${a.id}/view`)).json()) as { view: unknown }).view).toEqual({ page: "chats" });
    expect((await post(`/api/projects/${a.id}/view`, { view: { blob: "y".repeat(MAX_VIEW_BYTES + 10) } })).status).toBe(413);
    expect((await post(`/api/projects/${a.id}/view`, { view: "nope" })).status).toBe(400);
    expect((await post(`/api/projects/${a.id}/view`, { view: {} }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/activity/read", { projectId: a.id }, "https://evil.example")).status).toBe(403);
    expect((await fetch(`${base}/api/projects/not%20an%20id/view`)).status).toBe(400);

    const feed = (await (await fetch(`${base}/api/activity?since=1h`)).json()) as { projects: unknown[]; events: unknown[]; settings: unknown };
    expect(feed).toMatchObject({ projects: [], events: [], settings: { backgroundAgents: true } });
    expect((await fetch(`${base}/api/activity?since=yesterday-ish`)).status).toBe(400);

    const resume = (await (await fetch(`${base}/api/projects/${a.id}/resume`)).json()) as { project: { id: string }; view: unknown; live: unknown };
    expect(resume.project.id).toBe(a.id);
    expect(resume.view).toEqual({ page: "chats" });
  });
});
