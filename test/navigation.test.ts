// test/navigation.test.ts — fast project/chat switching (CONTRACTS §5.3, §5.5):
// the active chat persisted per project in $RUAH_HOME/projects/<id>/state.json
// (survives a daemon restart), open-at-chat in one step, recent chats filtered
// by project, the project preview and chat history used for hover prefetch.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ServerMessage, TurnRecord } from "../src/contracts/ws.js";
import { RecentChatsSchema } from "../src/contracts/projects.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { ProjectsStore } from "../src/projects/projects-store.js";
import { ProjectService } from "../src/projects/service.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import { attachSession, SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repo(work: string, name: string): string {
  const dir = path.join(work, name);
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, "architecture.json"),
    JSON.stringify({ version: 1, name, nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }),
  );
  return realpathSync(dir);
}

function turn(turnId: string, text: string): TurnRecord {
  return { turnId, nodeId: "api", text, contextPack: "", events: [{ kind: "text", text: `re: ${text}` }], stopReason: "end_turn", startedAt: new Date().toISOString() };
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
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1);
  }
}

let clock = Date.parse("2026-09-23T10:00:00Z");
const tick = (): Date => new Date((clock += 1000));

/** A daemon without agents (chats and switching only), as run-serve wires it. */
function daemon(home: string) {
  const chats = new ChatStore(home, { now: tick });
  const hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", chats });
  const projects = new ProjectService({ projects: new ProjectsStore(home), chats, host: hub, version: "0.0.0-test", watch: false });
  cleanups.push(() => hub.shutdown());
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  return { chats, hub, projects, socket };
}

describe("persisted active chat (state.json)", () => {
  it("ChatStore remembers the active chat per project across instances; a deleted chat is forgotten", () => {
    const home = tempDir("ruah-home-");
    const store = new ChatStore(home);
    const a = store.create("p1", { agentId: "mock", title: "first" });
    const b = store.create("p1", { agentId: "mock", title: "second" });
    expect(store.activeChat("p1")).toBeUndefined();
    store.setActiveChat("p1", a.id);
    store.setActiveChat("p2", null);
    const file = JSON.parse(readFileSync(path.join(home, "projects", "p1", "state.json"), "utf8")) as unknown;
    expect(file).toEqual({ version: 1, activeChatId: a.id });

    const reread = new ChatStore(home);
    expect(reread.activeChat("p1")).toBe(a.id);
    expect(reread.activeChat("p2")).toBeNull();
    expect(reread.delete("p1", a.id)).toBe(true);
    expect(reread.activeChat("p1")).toBeUndefined();
    reread.setActiveChat("p1", b.id);
    expect(new ChatStore(home).activeChat("p1")).toBe(b.id);
    // Path-like project ids never reach the file system.
    reread.setActiveChat("../evil", b.id);
    expect(reread.activeChat("../evil")).toBeUndefined();
  });

  it("the daemon reopens a project on the chat last active in it, after a switch and after a restart", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const rootA = repo(work, "alpha");
    const rootB = repo(work, "beta");
    const idA = projectIdFor(rootA);

    const first = daemon(home);
    await first.projects.open(rootA);
    const older = first.chats.create(idA, { agentId: "mock", title: "older chat" });
    first.chats.appendTurn(idA, older.id, turn("t1", "older chat"), { agentId: "mock" });
    const newer = first.chats.create(idA, { agentId: "mock", title: "newer chat" });
    first.chats.appendTurn(idA, newer.id, turn("t2", "newer chat"), { agentId: "mock" });
    // Picks the older chat (not the most recently updated one).
    first.socket.receive({ type: "chat.open", chatId: older.id });
    expect(first.socket.last("chats")?.activeChatId).toBe(older.id);

    await first.projects.open(rootB);
    await first.projects.open(rootA);
    expect(first.socket.last("chats")).toMatchObject({ projectId: idA, activeChatId: older.id });
    expect(first.socket.last("chat.history")?.chatId).toBe(older.id);
    await first.hub.shutdown();

    // A fresh daemon on the same RUAH_HOME: same chat.
    const second = daemon(home);
    await second.projects.open(rootA);
    expect(second.socket.last("chats")).toMatchObject({ projectId: idA, activeChatId: older.id });
    expect(second.socket.last("chat.history")?.turns.map((t) => t.turnId)).toEqual(["t1"]);

    // Deleting the active chat is remembered as "no chat".
    second.socket.receive({ type: "chat.delete", chatId: older.id });
    expect(second.socket.last("chats")?.activeChatId).toBeNull();
    const third = daemon(home);
    await third.projects.open(rootA);
    expect(third.socket.last("chats")?.activeChatId).toBeNull();
  });
});

describe("switching helpers", () => {
  it("opens another project directly on a chat (one chats frame, that chat's history)", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const rootA = repo(work, "alpha");
    const rootB = repo(work, "beta");
    const idB = projectIdFor(rootB);
    const { chats, projects, socket } = daemon(home);
    const target = chats.create(idB, { agentId: "mock", title: "target" });
    chats.appendTurn(idB, target.id, turn("tb", "target"), { agentId: "mock" });
    const newest = chats.create(idB, { agentId: "mock", title: "newest" });
    chats.appendTurn(idB, newest.id, turn("tn", "newest"), { agentId: "mock" });

    await projects.open(rootA);
    socket.sent = [];
    await projects.open(rootB, { chatId: target.id });
    const chatFrames = socket.sent.filter((m) => m.type === "chats");
    expect(chatFrames).toHaveLength(1);
    expect(chatFrames[0]).toMatchObject({ projectId: idB, activeChatId: target.id });
    expect(socket.last("chat.history")).toMatchObject({ chatId: target.id, turns: [{ turnId: "tb" }] });

    // Already open: the chat opens without a project swap; unknown ids are ignored.
    socket.sent = [];
    await projects.open(rootB, { chatId: newest.id });
    expect(socket.sent.some((m) => m.type === "project")).toBe(false);
    expect(socket.last("chats")?.activeChatId).toBe(newest.id);
    socket.sent = [];
    await projects.open(rootB, { chatId: "nope" });
    expect(socket.sent).toEqual([]);
  });

  it("recent chats filtered by project, previews and chat history; path-like ids are refused", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const rootA = repo(work, "alpha");
    const rootB = repo(work, "beta");
    const idA = projectIdFor(rootA);
    const idB = projectIdFor(rootB);
    const { chats, projects } = daemon(home);
    await projects.open(rootB);
    await projects.open(rootA);
    for (let i = 0; i < 7; i++) {
      const c = chats.create(idA, { agentId: "mock", title: `a${i}` });
      chats.appendTurn(idA, c.id, turn(`ta${i}`, `a${i}`), { agentId: "mock" });
    }
    const b = chats.create(idB, { agentId: "mock", title: "b0" });
    chats.appendTurn(idB, b.id, turn("tb0", "b0"), { agentId: "mock" });

    const inA = projects.recentChats(5, idA);
    expect(inA.map((c) => c.title)).toEqual(["a6", "a5", "a4", "a3", "a2"]);
    expect(inA.every((c) => c.projectId === idA && c.projectName === "alpha")).toBe(true);
    expect(projects.recentChats(50, idB).map((c) => c.title)).toEqual(["b0"]);
    expect(projects.recentChats(50).map((c) => c.title)[0]).toBe("b0");
    expect(projects.recentChats(50, "../../etc")).toEqual([]);

    const preview = projects.preview(idB);
    expect(preview?.project).toMatchObject({ id: idB, name: "beta", root: rootB });
    expect(preview?.architecture?.name).toBe("beta");
    expect(preview?.chats.map((c) => c.id)).toEqual([b.id]);
    expect(preview?.activeChatId).toBe(b.id);
    expect(preview?.activeTurns.map((t) => t.turnId)).toEqual(["tb0"]);
    // The open project previews from its live store.
    expect(projects.preview(idA)?.architecture?.name).toBe("alpha");
    expect(projects.preview("nope")).toBeUndefined();
    expect(projects.preview("../x")).toBeUndefined();

    expect(projects.chatHistory(idB, b.id)?.map((t) => t.turnId)).toEqual(["tb0"]);
    expect(projects.chatHistory(idB, "missing")).toBeUndefined();
    expect(projects.chatHistory("../x", b.id)).toBeUndefined();
  });

  it("HTTP: /api/chats/recent?projectId=, /api/projects/preview, /api/chats/history, open with chatId", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const rootA = repo(work, "alpha");
    const rootB = repo(work, "beta");
    const idA = projectIdFor(rootA);
    const idB = projectIdFor(rootB);
    const { chats, hub, projects } = daemon(home);
    const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, projects });
    cleanups.push(() => server.close());
    await projects.open(rootA);
    await projects.open(rootB);
    const b1 = chats.create(idB, { agentId: "mock", title: "b1" });
    chats.appendTurn(idB, b1.id, turn("tb1", "b1"), { agentId: "mock" });
    const a1 = chats.create(idA, { agentId: "mock", title: "a1" });
    chats.appendTurn(idA, a1.id, turn("ta1", "a1"), { agentId: "mock" });

    const url = server.url;
    const recentA = RecentChatsSchema.parse(await (await fetch(`${url}/api/chats/recent?projectId=${idA}&limit=5`)).json());
    expect(recentA.chats.map((c) => c.id)).toEqual([a1.id]);
    const preview = (await (await fetch(`${url}/api/projects/preview?id=${idA}`)).json()) as { architecture: { name: string }; activeChatId: string };
    expect(preview).toMatchObject({ architecture: { name: "alpha" }, activeChatId: a1.id });
    expect((await fetch(`${url}/api/projects/preview?id=zzz`)).status).toBe(404);
    const history = (await (await fetch(`${url}/api/chats/history?projectId=${idA}&chatId=${a1.id}`)).json()) as { turns: TurnRecord[] };
    expect(history.turns.map((t) => t.turnId)).toEqual(["ta1"]);
    expect((await fetch(`${url}/api/chats/history?projectId=${idA}&chatId=nope`)).status).toBe(404);

    const opened = await fetch(`${url}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: rootA, chatId: a1.id }),
    });
    expect(opened.status).toBe(200);
    expect(hub.project()?.id).toBe(idA);
    expect(hub.chatId()).toBe(a1.id);
  });
});
