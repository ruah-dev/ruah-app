// test/projects.test.ts — CONTRACTS §5 storage and HTTP: the recent-projects
// store (order, pin/forget, atomic writes, corrupt file), the chat store
// (header, turns, titles, sessions, event coalescing), ProjectService
// open/create (scan on first open, system hook, validation) in temp dirs with
// RUAH_HOME-style temp homes, and the HTTP layer (Origin 403 on every POST,
// 409 in the launcher state, create → open → recent chats).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsStore } from "../src/projects/projects-store.js";
import { ChatStore, appendStreamEvent, chatTitleFrom } from "../src/projects/chat-store.js";
import { ProjectError, ProjectService, validateProjectName, type ProjectHost } from "../src/projects/service.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import type { ProjectInfo, StreamEvent, TurnRecord } from "../src/contracts/ws.js";
import { ProjectInfoSchema, ProjectsListSchema, RecentChatsSchema } from "../src/contracts/projects.js";
import type { ProjectRuntime } from "../src/serve/session.js";
import { SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { MockBridge } from "../src/acp/mock-bridge.js";
import type { AcpBridge } from "../src/acp/bridge.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeArch(dir: string, name = "fixture"): void {
  writeFileSync(
    path.join(dir, "architecture.json"),
    JSON.stringify({ version: 1, name, nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }),
  );
}

let clock = Date.parse("2026-09-23T10:00:00Z");
const tick = (): Date => new Date((clock += 1000));

describe("ProjectsStore", () => {
  it("keeps most recent first with pinned on top; pin/forget; atomic rewrite", () => {
    const home = tempDir("ruah-home-");
    const store = new ProjectsStore(home, { now: tick });
    const a = store.touch({ id: "aaaaaaaaaaaa", name: "a", root: "/a", kind: "repo" });
    store.touch({ id: "bbbbbbbbbbbb", name: "b", root: "/b", kind: "repo" });
    store.touch({ id: "cccccccccccc", name: "c", root: "/c", kind: "system" });
    expect(store.list().map((p) => p.name)).toEqual(["c", "b", "a"]);
    expect(ProjectInfoSchema.parse(a)).toEqual(a);

    expect(store.pin("aaaaaaaaaaaa", true)).toBe(true);
    expect(store.list().map((p) => p.name)).toEqual(["a", "c", "b"]);
    expect(store.list()[0]?.pinned).toBe(true);
    // Re-opening keeps the pin and refreshes lastOpenedAt.
    const again = store.touch({ id: "aaaaaaaaaaaa", name: "a2", root: "/a", kind: "repo" });
    expect(again).toMatchObject({ name: "a2", pinned: true });
    expect(store.pin("aaaaaaaaaaaa", false)).toBe(true);
    expect(store.list().map((p) => p.name)).toEqual(["a2", "c", "b"]);
    expect(store.list()[0]?.pinned).toBeUndefined();

    expect(store.forget("bbbbbbbbbbbb")).toBe(true);
    expect(store.forget("bbbbbbbbbbbb")).toBe(false);
    expect(store.pin("nope", true)).toBe(false);
    expect(store.list().map((p) => p.name)).toEqual(["a2", "c"]);
    // Forgotten projects are still known to chat listings via project.json.
    expect(store.lookup("bbbbbbbbbbbb")).toMatchObject({ name: "b", root: "/b" });

    // Atomic writes leave no temp files; the file is valid JSON with version 1.
    expect(readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);
    const file = JSON.parse(readFileSync(path.join(home, "projects.json"), "utf8")) as { version: number; projects: unknown[] };
    expect(file.version).toBe(1);
    expect(file.projects).toHaveLength(2);
  });

  it("treats a corrupt file as empty and replaces it on the next change", () => {
    const home = tempDir("ruah-home-");
    writeFileSync(path.join(home, "projects.json"), "{ not json");
    const errors: string[] = [];
    const store = new ProjectsStore(home, { now: tick, onError: (line) => errors.push(line) });
    expect(store.list()).toEqual([]);
    expect(errors[0]).toContain("not valid JSON");
    store.touch({ id: "dddddddddddd", name: "d", root: "/d", kind: "repo" });
    expect(new ProjectsStore(home).list().map((p) => p.id)).toEqual(["dddddddddddd"]);
  });
});

const turn = (turnId: string, text: string, events: StreamEvent[] = []): TurnRecord => ({
  turnId,
  nodeId: "api",
  text,
  contextPack: `[archmap context]\n${text}`,
  events,
  stopReason: "end_turn",
  startedAt: "2026-09-23T10:00:00.000Z",
  finishedAt: "2026-09-23T10:00:01.000Z",
});

describe("ChatStore", () => {
  it("creates, records turns (title, sessions, turnCount), renames, lists and deletes", () => {
    const home = tempDir("ruah-home-");
    const chats = new ChatStore(home, { now: tick });
    const chat = chats.create("p1", { agentId: "claude", model: "opus" });
    expect(chat).toMatchObject({ projectId: "p1", title: "New chat", agentId: "claude", model: "opus", turnCount: 0, autoTitle: true });
    const long = `  Why   does\nthe invoice ${"x".repeat(120)}`;
    const after = chats.appendTurn("p1", chat.id, turn("t1", long), { agentId: "claude", sessionId: "s-claude", model: "sonnet" });
    expect(after?.title).toBe(chatTitleFrom(long));
    expect(after?.title.length).toBe(80);
    expect(after?.title.startsWith("Why does the invoice")).toBe(true);
    expect(after).toMatchObject({ turnCount: 1, lastNodeId: "api", model: "sonnet", sessions: { claude: "s-claude" } });
    expect(after?.autoTitle).toBeUndefined();
    // A second turn does not retitle; a second agent's session is kept alongside.
    chats.appendTurn("p1", chat.id, turn("t2", "second"), { agentId: "cursor", sessionId: "s-cursor" });
    const header = chats.get("p1", chat.id);
    expect(header).toMatchObject({ title: chatTitleFrom(long), turnCount: 2, sessions: { claude: "s-claude", cursor: "s-cursor" } });

    // A fresh store (new daemon) reads header + turns back from disk.
    const reread = new ChatStore(home);
    expect(reread.history("p1", chat.id).map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(reread.list("p1")[0]).not.toHaveProperty("sessions");
    const lines = readFileSync(reread.chatFile("p1", chat.id), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ id: chat.id, sessions: { claude: "s-claude" } });

    expect(chats.rename("p1", chat.id, "  Invoice bug ")?.title).toBe("Invoice bug");
    const second = chats.create("p1", { agentId: "claude", title: "explicit title" });
    expect(second.autoTitle).toBeUndefined();
    expect(chats.list("p1").map((c) => c.id)).toEqual([second.id, chat.id]);
    expect(chats.recent(10).map((c) => c.id)).toEqual([second.id, chat.id]);

    expect(chats.delete("p1", chat.id)).toBe(true);
    expect(chats.delete("p1", chat.id)).toBe(false);
    expect(chats.list("p1").map((c) => c.id)).toEqual([second.id]);
    // Ids are validated before touching the file system.
    expect(chats.get("p1", "../../etc/passwd")).toBeUndefined();
    expect(() => chats.chatFile("p1", "../x")).toThrow();
  });

  it("skips unparseable turn lines", () => {
    const home = tempDir("ruah-home-");
    const chats = new ChatStore(home, { now: tick });
    const chat = chats.create("p1", { agentId: "mock" });
    chats.appendTurn("p1", chat.id, turn("t1", "one"), { agentId: "mock" });
    writeFileSync(chats.chatFile("p1", chat.id), `${readFileSync(chats.chatFile("p1", chat.id), "utf8")}{"partial":`);
    expect(new ChatStore(home).history("p1", chat.id).map((t) => t.turnId)).toEqual(["t1"]);
  });

  it("coalesces text chunks and upserts tool calls in place", () => {
    const events: StreamEvent[] = [];
    const tool = (status: "pending" | "completed") => ({ toolCallId: "tc1", title: "Read", kind: "read", status, locations: [] });
    appendStreamEvent(events, { kind: "text", text: "Hel" });
    appendStreamEvent(events, { kind: "text", text: "lo" });
    appendStreamEvent(events, { kind: "tool_call", toolCall: tool("pending") });
    appendStreamEvent(events, { kind: "text", text: "after" });
    appendStreamEvent(events, { kind: "tool_result", toolCall: tool("completed") });
    appendStreamEvent(events, { kind: "plan", entries: [] });
    appendStreamEvent(events, { kind: "plan", entries: [{ content: "x", priority: "low", status: "pending" }] });
    expect(events).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "tool_result", toolCall: tool("completed") },
      { kind: "text", text: "after" },
      { kind: "plan", entries: [{ content: "x", priority: "low", status: "pending" }] },
    ]);
  });
});

class FakeHost implements ProjectHost {
  current: ProjectRuntime | null = null;
  readonly opened: ProjectRuntime[] = [];
  setProject(runtime: ProjectRuntime | null): void {
    this.current?.store.close();
    this.current = runtime;
    if (runtime !== null) this.opened.push(runtime);
  }
  project(): ProjectInfo | null {
    return this.current?.info ?? null;
  }
}

function service(home: string, extra: Partial<ConstructorParameters<typeof ProjectService>[0]> = {}) {
  const host = new FakeHost();
  cleanups.push(() => host.setProject(null));
  const svc = new ProjectService({
    projects: new ProjectsStore(home, { now: tick }),
    chats: new ChatStore(home),
    host,
    version: "0.0.0-test",
    watch: false,
    ...extra,
  });
  return { svc, host };
}

describe("ProjectService", () => {
  it("opens a repo by realpath, scanning first when there is no architecture.json", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const repo = path.join(work, "shop");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "shop", version: "1.0.0" }));
    writeFileSync(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    const { svc, host } = service(home);
    const result = await svc.open(`${repo}/./src/..`);
    expect(result.scanned).toBe(true);
    expect(existsSync(path.join(repo, "architecture.json"))).toBe(true);
    const real = realpath(repo);
    expect(result.project).toMatchObject({ id: projectIdFor(real), root: real, kind: "repo" });
    expect(host.current?.store.current()?.version).toBe(1);
    expect(svc.list().current?.id).toBe(result.project.id);
    expect(ProjectsListSchema.parse(svc.list()).recent).toHaveLength(1);

    // Re-opening the open project does not swap stores.
    const again = await svc.open(repo);
    expect(again.scanned).toBe(false);
    expect(host.opened).toHaveLength(1);
  });

  it("rejects missing paths and files, and systems until src/system is wired", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const { svc } = service(home);
    await expect(svc.open(path.join(work, "nope"))).rejects.toMatchObject({ status: 404 });
    writeFileSync(path.join(work, "file.txt"), "x");
    await expect(svc.open(path.join(work, "file.txt"))).rejects.toMatchObject({ status: 400 });
    const system = path.join(work, "platform");
    mkdirSync(system);
    writeFileSync(path.join(system, "ruah.system.json"), JSON.stringify({ version: 1, name: "platform", repos: [] }));
    await expect(svc.open(system)).rejects.toThrow(/multi-repo systems are not wired yet/);
  });

  it("opens systems through the injected hook as kind system", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const system = path.join(work, "platform");
    mkdirSync(system);
    writeFileSync(path.join(system, "ruah.system.json"), "{}");
    writeArch(system, "platform-map");
    const { createArchitectureStore } = await import("../src/serve/architecture-store.js");
    const calls: string[] = [];
    const { svc, host } = service(home, {
      openSystemProject: async (root) => {
        calls.push(root);
        const store = createArchitectureStore(path.join(root, "architecture.json"), { watch: false });
        await store.load();
        return { store, name: "Platform" };
      },
    });
    const result = await svc.open(system);
    expect(calls).toEqual([realpath(system)]);
    expect(result.project).toMatchObject({ kind: "system", name: "Platform" });
    expect(host.current?.info.kind).toBe("system");
  });

  it("creates a project: validates the name, parent and target, optional git init, empty architecture", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const gitCalls: string[] = [];
    const { svc, host } = service(home, {
      gitInit: async (dir) => {
        gitCalls.push(dir);
      },
    });
    expect(() => validateProjectName("a/b")).toThrow(ProjectError);
    expect(() => validateProjectName("..")).toThrow(/cannot be/);
    await expect(svc.create({ parentDir: work, name: "bad\\name" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create({ parentDir: path.join(work, "missing"), name: "x" })).rejects.toMatchObject({ status: 404 });
    mkdirSync(path.join(work, "taken"));
    await expect(svc.create({ parentDir: work, name: "taken" })).rejects.toMatchObject({ status: 409 });

    const result = await svc.create({ parentDir: work, name: "new-app", git: true });
    const target = path.join(realpath(work), "new-app");
    expect(gitCalls).toEqual([target]);
    expect(result.project).toMatchObject({ name: "new-app", root: target, kind: "repo" });
    expect(JSON.parse(readFileSync(path.join(target, "architecture.json"), "utf8"))).toEqual({
      version: 1,
      name: "new-app",
      layers: [],
      nodes: [],
      edges: [],
      workflows: [],
    });
    expect(host.current?.store.current()?.nodes).toEqual([]);
  });

  it("really runs git init without a shell", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const { svc } = service(home);
    const result = await svc.create({ parentDir: work, name: "with git", git: true });
    expect(existsSync(path.join(result.project.root, ".git"))).toBe(true);
  });
});

function realpath(p: string): string {
  return realpathSync(p);
}

// ---------- HTTP ----------

async function serveLauncher() {
  const home = tempDir("ruah-home-");
  const chats = new ChatStore(home);
  const agents = {
    choices: (currentAgentId: string) => ({ currentAgentId, available: [{ id: "mock", name: "Mock", installed: true }] }),
    check: () => ({ ok: true as const }),
    create: (_agentId: string, root?: string): AcpBridge => new MockBridge({ root: root ?? "/", preset: { command: "none", args: [] }, clientVersion: "0", chunkDelayMs: 1 }),
  };
  const hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", agents, chats });
  const projects = new ProjectService({ projects: new ProjectsStore(home), chats, host: hub, version: "0.0.0-test", watch: false });
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, projects });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  return { url: server.url, hub, home };
}

const post = (url: string, body: unknown, origin?: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) },
    body: JSON.stringify(body),
  });

describe("projects HTTP", () => {
  it("launcher state: health and projects work, architecture endpoints answer 409", async () => {
    const { url } = await serveLauncher();
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ ok: true, agent: "stopped", project: null });
    expect(ProjectsListSchema.parse(await (await fetch(`${url}/api/projects`)).json())).toEqual({ current: null, recent: [] });
    for (const p of ["/api/architecture", "/api/context/api", "/api/file?path=a.ts"]) {
      const res = await fetch(`${url}${p}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "no project open" });
    }
    expect((await post(`${url}/api/rescan`, {})).status).toBe(409);
    expect(RecentChatsSchema.parse(await (await fetch(`${url}/api/chats/recent`)).json())).toEqual({ chats: [] });
  });

  it("every POST checks the Origin (403) before doing anything", async () => {
    const { url } = await serveLauncher();
    const work = tempDir("ruah-work-");
    const evil = "https://evil.example";
    for (const [p, body] of [
      ["/api/projects/open", { path: work }],
      ["/api/projects/create", { parentDir: work, name: "x" }],
      ["/api/projects/pin", { id: "x" }],
      ["/api/projects/forget", { id: "x" }],
      ["/api/rescan", {}],
    ] as const) {
      const res = await post(`${url}${p}`, body, evil);
      expect(res.status, p).toBe(403);
    }
    expect(existsSync(path.join(work, "x"))).toBe(false);
    // Loopback origins pass.
    expect((await post(`${url}/api/projects/forget`, { id: "x" }, "http://localhost:5173")).status).toBe(404);
  });

  it("create → open over HTTP, bad bodies, pin/forget", async () => {
    const { url, hub } = await serveLauncher();
    const work = tempDir("ruah-work-");
    expect((await post(`${url}/api/projects/open`, {})).status).toBe(400);
    const bad = await fetch(`${url}/api/projects/open`, { method: "POST", body: "{nope" });
    expect(bad.status).toBe(400);
    const created = await post(`${url}/api/projects/create`, { parentDir: work, name: "demo" });
    expect(created.status).toBe(200);
    const project = ProjectInfoSchema.parse(await created.json());
    expect(hub.project()?.id).toBe(project.id);
    expect((await fetch(`${url}/api/architecture`)).status).toBe(200);

    const other = path.join(work, "other");
    mkdirSync(other);
    writeArch(other, "other-map");
    const opened = await post(`${url}/api/projects/open`, { path: other });
    expect(opened.status).toBe(200);
    expect(ProjectInfoSchema.parse(await opened.json()).name).toBe("other-map");
    const list = ProjectsListSchema.parse(await (await fetch(`${url}/api/projects`)).json());
    expect(list.current?.name).toBe("other-map");
    expect(list.recent.map((p) => p.name)).toEqual(["other-map", "demo"]);
    expect((await post(`${url}/api/projects/pin`, { id: project.id })).status).toBe(200);
    expect(ProjectsListSchema.parse(await (await fetch(`${url}/api/projects`)).json()).recent[0]?.name).toBe("demo");
    expect(await (await post(`${url}/api/projects/forget`, { id: project.id })).json()).toEqual({ ok: true });
    expect(ProjectsListSchema.parse(await (await fetch(`${url}/api/projects`)).json()).recent.map((p) => p.name)).toEqual(["other-map"]);
  });
});
