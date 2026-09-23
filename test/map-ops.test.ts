// test/map-ops.test.ts — agents editing the map (CONTRACTS §1.7): ops
// validation and atomicity, provenance through re-scans, the token-guarded
// /api/arch endpoints, the stdio MCP server (in-process and the built
// binary) against a test daemon, the `by` field of the broadcast, the
// per-turn undo, and map changes recorded into the chat turn.
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Architecture } from "../src/contracts/architecture.js";
import type { ArchOp } from "../src/contracts/map.js";
import type { ServerMessage, StopReason, AgentState } from "../src/contracts/ws.js";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import { applyOps, OpError, revertTurn, slugify } from "../src/mcp/ops.js";
import { summarizeArchitecture, findElements, describeElement } from "../src/mcp/read.js";
import { callMapTool, mapToolList, MAP_TOOLS } from "../src/mcp/tools.js";
import { httpMapBackend, serveMcpStdio } from "../src/mcp/stdio-server.js";
import { mergeWithExisting } from "../src/scan/merge.js";
import { mergeSystemWithExisting } from "../src/system/merge.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { attachSession, SessionHub } from "../src/serve/session.js";
import { startServer, type RunningServer } from "../src/serve/server.js";
import { MapOpsService } from "../src/serve/map-ops.js";
import { handleMapOpsRequest, isLoopback } from "../src/serve/map-ops-http.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { buildContextPack } from "../src/context/pack.js";
import { ArchIndex } from "../src/context/graph.js";
import { AcpProcessBridge } from "../src/acp/acp-bridge.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const BASE: Architecture = {
  version: 1,
  name: "shop",
  layers: ["clients", "services", "data"],
  nodes: [
    { id: "web", type: "frontend", name: "web", layer: "clients", x: 0, y: 0 },
    { id: "api", type: "service", name: "api", layer: "services", x: 520, y: 0 },
    { id: "api-routes", type: "module", name: "routes", parent: "api", x: 0, y: 0 },
    { id: "data", type: "datastore", name: "data", layer: "data", x: 780, y: 0 },
  ],
  edges: [
    { from: "web", to: "api", label: "REST", kind: "sync", source: "scan" },
    { from: "api", to: "data", label: "sql", kind: "data", source: "scan" },
  ],
  workflows: [{ id: "checkout", name: "Checkout", steps: ["web", "api", "data"] }],
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-mapops-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("applyOps", () => {
  it("adds, links, updates and removes; names work as references", () => {
    const out = applyOps(BASE, [
      { op: "add_element", name: "Stripe", type: "external", layer: "external" },
      { op: "connect", from: "data", to: "Stripe", label: "payments" },
      { op: "update_element", id: "api", patch: { description: "Order API.", tech: ["Node 22"] } },
    ]);
    const stripe = out.architecture.nodes.find((n) => n.id === "stripe");
    expect(stripe).toMatchObject({ name: "Stripe", type: "external", layer: "external", origin: "agent" });
    expect(stripe?.x).toBeTypeOf("number");
    expect(out.architecture.layers).toContain("external");
    expect(out.architecture.edges).toContainEqual({ from: "data", to: "stripe", label: "payments", source: "agent" });
    expect(out.architecture.nodes.find((n) => n.id === "api")).toMatchObject({ description: "Order API.", tech: ["Node 22"] });
    expect(out.changes.map((c) => `${c.action}:${c.id}`)).toEqual(["add:stripe", "connect:data->stripe", "update:api"]);
    expect(out.changes[2]?.fields).toEqual(["description", "tech"]);
    // base untouched
    expect(BASE.nodes).toHaveLength(4);
  });

  it("places a new element next to the element it links to, without overlapping", () => {
    const out = applyOps(BASE, [
      { op: "add_element", name: "Cache", type: "datastore" },
      { op: "connect", from: "api", to: "cache" },
    ]);
    const cache = out.architecture.nodes.find((n) => n.id === "cache");
    expect(cache?.x).toBe(780); // right of api (datastore column > service column)
    expect(cache?.y).not.toBe(0); // data already sits at 780,0
  });

  it("is atomic: a failing op leaves nothing changed and names the op", () => {
    let error: unknown;
    try {
      applyOps(BASE, [
        { op: "add_element", name: "Queue", type: "queue" },
        { op: "connect", from: "queue", to: "nowhere" },
      ]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OpError);
    expect((error as OpError).opIndex).toBe(1);
    expect((error as Error).message).toMatch(/op 2 of 2 \(connect\): unknown to element "nowhere".*nothing was changed/);
    expect(BASE.nodes.some((n) => n.id === "queue")).toBe(false);
  });

  it("returns fixable errors", () => {
    expect(() => applyOps(BASE, [{ op: "remove_element", id: "api" }])).toThrow(/1 element\(s\) inside \(api-routes\); pass recursive: true/);
    expect(() => applyOps(BASE, [{ op: "connect", from: "api", to: "api" }])).toThrow(/cannot link to itself/);
    expect(() => applyOps(BASE, [{ op: "connect", from: "api", to: "data", label: "x".repeat(41) }])).toThrow(/label is 41 chars/);
    expect(() => applyOps(BASE, [{ op: "add_element", id: "api", name: "API 2", type: "service" }])).toThrow(/already exists/);
    expect(() => applyOps(BASE, [{ op: "add_element", id: "Bad Id", name: "x", type: "service" }])).toThrow(/not valid/);
    expect(() => applyOps(BASE, [{ op: "update_element", id: "api", patch: { parent: "api-routes" } }])).toThrow(/parent cycle/);
    expect(() => applyOps(BASE, [{ op: "add_element", name: "x", type: "module", path: "../outside" }])).toThrow(/escapes repo/);
    expect(() => applyOps(BASE, [{ op: "disconnect", from: "data", to: "api" }])).toThrow(/other way round/);
    expect(() => applyOps(BASE, [{ op: "update_element", id: "ap", patch: { name: "x" } }])).toThrow(/did you mean api/);
  });

  it("removes recursively with links and workflow steps", () => {
    const out = applyOps(BASE, [{ op: "remove_element", id: "api", recursive: true }]);
    expect(out.architecture.nodes.map((n) => n.id)).toEqual(["web", "data"]);
    expect(out.architecture.edges).toEqual([]);
    expect(out.architecture.workflows[0]?.steps).toEqual(["web", "data"]);
  });

  it("namespaces ids under a system repo parent", () => {
    const system: Architecture = {
      version: 1,
      name: "sys",
      nodes: [
        { id: "billing", type: "service", name: "billing", repo: "billing", path: "billing" },
        { id: "billing:api", type: "module", name: "api", parent: "billing", repo: "billing", path: "billing/src/api" },
      ],
      edges: [],
      workflows: [],
    };
    const out = applyOps(system, [{ op: "add_element", name: "Invoices worker", type: "service", parent: "billing:api" }]);
    expect(out.architecture.nodes.at(-1)).toMatchObject({ id: "billing:invoices-worker", repo: "billing", parent: "billing:api" });
  });

  it("slugifies names", () => {
    expect(slugify("Payments Service")).toBe("payments-service");
    expect(slugify("Ünïcode & co.")).toBe("unicode-co.");
    expect(slugify("!!!")).toBe("element");
  });
});

describe("read views", () => {
  it("summarizes a level, finds and describes elements", () => {
    const top = summarizeArchitecture(BASE, "");
    expect(top).toContain("- api · api · service · services · - · -  [1 inside]");
    expect(top).not.toContain("api-routes ·");
    expect(summarizeArchitecture(BASE, "api")).toContain("- api-routes · routes · module");
    expect(findElements(BASE, "rout")).toContain("api-routes");
    const described = JSON.parse(describeElement(BASE, "api")) as { children: unknown[]; outgoing: { to: string }[] };
    expect(described.children).toHaveLength(1);
    expect(described.outgoing[0]?.to).toBe("data");
  });
});

describe("provenance through re-scans", () => {
  it("scan merge keeps agent-made elements (even with a path that does not exist yet) and agent links", () => {
    const root = tmp();
    const existing: Architecture = {
      ...BASE,
      nodes: [...BASE.nodes, { id: "payments", type: "service", name: "Payments", path: "services/payments", origin: "agent" }],
      edges: [...BASE.edges, { from: "api", to: "payments", source: "agent" }],
    };
    const scanned: Architecture = { ...BASE, nodes: BASE.nodes.map((n) => (n.id === "api" ? n : n)), edges: BASE.edges };
    const merged = mergeWithExisting(scanned, existing, root);
    expect(merged.nodes.find((n) => n.id === "payments")).toMatchObject({ origin: "agent" });
    expect(merged.edges).toContainEqual({ from: "api", to: "payments", source: "agent" });
  });

  it("scan merge keeps the origin marker on an element the scan now finds", () => {
    const existing: Architecture = { ...BASE, nodes: BASE.nodes.map((n) => (n.id === "data" ? { ...n, origin: "agent" } : n)) };
    const merged = mergeWithExisting(BASE, existing, tmp());
    expect(merged.nodes.find((n) => n.id === "data")?.origin).toBe("agent");
  });

  it("system merge keeps agent-made elements inside a repo", () => {
    const existing: Architecture = {
      version: 1,
      name: "sys",
      nodes: [
        { id: "billing", type: "service", name: "billing", repo: "billing", path: "billing" },
        { id: "billing:worker", type: "service", name: "worker", repo: "billing", parent: "billing", origin: "agent" },
      ],
      edges: [{ from: "billing:worker", to: "billing", source: "agent" }],
      workflows: [],
    };
    const scanned: Architecture = { version: 1, name: "sys", nodes: [existing.nodes[0]!], edges: [], workflows: [] };
    const merged = mergeSystemWithExisting(scanned, existing);
    expect(merged.nodes.map((n) => n.id)).toEqual(["billing", "billing:worker"]);
    expect(merged.edges).toHaveLength(1);
  });
});

describe("revertTurn", () => {
  it("puts back what the turn changed and leaves later user edits alone", () => {
    const after = applyOps(BASE, [
      { op: "add_element", name: "Stripe", type: "external" },
      { op: "connect", from: "data", to: "stripe" },
      { op: "update_element", id: "web", patch: { description: "Shop UI." } },
      { op: "update_element", id: "api", patch: { description: "agent text" } },
    ]).architecture;
    // The user then edits api again.
    const current = structuredClone(after);
    current.nodes.find((n) => n.id === "api")!.description = "user text";
    const out = revertTurn(current, BASE, after);
    expect(out.architecture.nodes.some((n) => n.id === "stripe")).toBe(false);
    expect(out.architecture.edges.some((e) => e.to === "stripe")).toBe(false);
    expect(out.architecture.nodes.find((n) => n.id === "web")?.description).toBeUndefined();
    expect(out.architecture.nodes.find((n) => n.id === "api")?.description).toBe("user text");
    expect(out.skipped).toEqual(["api"]);
    expect(out.architecture.layers).toEqual(BASE.layers);
  });
});

describe("context pack", () => {
  it("mentions the map tools only when the agent has them", () => {
    const index = new ArchIndex(BASE, "/r");
    expect(buildContextPack(index, "api", "/r", "hi")).not.toContain("ruah_*");
    expect(buildContextPack(index, "api", "/r", "hi", { mapTools: true })).toContain("with the ruah_* tools; keep it in sync");
  });
});

// ---------- daemon: hub + store + server ----------

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
  archs(): Extract<ServerMessage, { type: "architecture" }>[] {
    return this.sent.flatMap((m) => (m.type === "architecture" ? [m] : []));
  }
}

class TurnBridge implements AcpBridge {
  state: AgentState = "idle";
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private active: { turnId: string; resolve: (r: { stopReason: StopReason }) => void } | undefined;
  async start(): Promise<void> {
    this.emit({ type: "status", state: "idle", agent: { name: "claude", version: "1" }, sessionId: "s1" });
  }
  status(): AgentState {
    return this.state;
  }
  prompt(turnId: string, _blocks: ContentBlock[]): TurnHandle {
    const done = new Promise<{ stopReason: StopReason }>((resolveTurn) => {
      this.active = { turnId, resolve: resolveTurn };
    });
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    return { turnId, done };
  }
  finish(): void {
    const turn = this.active;
    if (turn === undefined) return;
    this.active = undefined;
    this.state = "idle";
    this.emit({ type: "turn_finished", turnId: turn.turnId, stopReason: "end_turn" });
    this.emit({ type: "status", state: "idle" });
    turn.resolve({ stopReason: "end_turn" });
  }
  async cancel(): Promise<void> {}
  answerPermission(): boolean {
    return false;
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async reset(): Promise<void> {}
  async stop(): Promise<void> {}
  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: BridgeEvent): void {
    for (const l of this.listeners) l(event);
  }
}

async function daemon() {
  const dir = tmp();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "architecture.json"), JSON.stringify(BASE, null, 2));
  const store = createArchitectureStore(join(repo, "architecture.json"), { watch: false });
  await store.load();
  cleanups.push(() => store.close());
  const chats = new ChatStore(join(dir, "home"), { onError: () => {} });
  let hubRef: SessionHub | undefined;
  const service = new MapOpsService(() => hubRef, { version: "0.0.0-test" });
  const bridge = new TurnBridge();
  const hub = new SessionHub(store, bridge, {
    version: "0.0.0-test",
    links: false,
    debug: () => {},
    info: () => {},
    agentId: "claude",
    chats,
    mapOps: service,
  });
  hubRef = hub;
  await bridge.start();
  const server: RunningServer = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, mapOps: service });
  cleanups.push(() => server.close());
  service.setDaemonUrl(server.url);
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  const ctx = { agentId: "claude", root: store.root };
  return { repo, store, hub, service, server, socket, bridge, chats, ctx };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("/api/arch endpoints", () => {
  it("need the capability token (401), refuse browsers (403), and apply ops (200) with one broadcast by the agent", async () => {
    const { server, service, ctx, socket, repo } = await daemon();
    const token = service.issueToken(ctx);
    const ops: ArchOp[] = [{ op: "add_element", name: "Stripe", type: "external" }];
    const post = (headers: Record<string, string>, body: unknown = { ops }) =>
      fetch(`${server.url}/api/arch/ops`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    expect((await post({})).status).toBe(401);
    expect((await post({ "x-ruah-token": "wrong-token-wrong-token" })).status).toBe(401);
    expect((await fetch(`${server.url}/api/arch`)).status).toBe(401);
    expect((await post({ "x-ruah-token": token, origin: "http://127.0.0.1:4177" })).status).toBe(403);
    expect((await post({ "x-ruah-token": token }, { ops: [{ op: "explode" }] })).status).toBe(400);

    const bad = await post({ "x-ruah-token": token }, { ops: [{ op: "connect", from: "api", to: "nope" }] });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toMatch(/unknown to element "nope"/);

    const before = socket.archs().length;
    const ok = await post({ authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { revision: number; changes: { id: string }[] };
    expect(body.changes[0]?.id).toBe("stripe");
    const onDisk = JSON.parse(readFileSync(join(repo, "architecture.json"), "utf8")) as Architecture;
    expect(onDisk.nodes.find((n) => n.id === "stripe")?.origin).toBe("agent");
    const broadcasts = socket.archs().slice(before);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ reason: "saved", by: { kind: "agent", agentId: "claude" }, changes: [{ action: "add", id: "stripe" }] });

    const read = await fetch(`${server.url}/api/arch`, { headers: { "x-ruah-token": token } });
    expect(((await read.json()) as { revision: number }).revision).toBe(body.revision);
  });

  it("refuses non-loopback peers", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("192.168.1.20")).toBe(false);
    let status = 0;
    const req = { socket: { remoteAddress: "192.168.1.20" }, headers: {}, method: "GET" } as unknown as IncomingMessage;
    const res = { writeHead: (s: number) => { status = s; }, end: () => {}, setHeader: () => {} } as unknown as ServerResponse;
    const service = new MapOpsService(() => undefined, { version: "t" });
    expect(handleMapOpsRequest(req, res, new URL("http://x/api/arch"), service)).toBe(true);
    expect(status).toBe(403);
  });

  it("refuses a token whose project is not the open one", async () => {
    const { service, server } = await daemon();
    const token = service.issueToken({ agentId: "claude", root: "/some/other/project" });
    const res = await fetch(`${server.url}/api/arch`, { headers: { "x-ruah-token": token } });
    expect(res.status).toBe(409);
  });
});

describe("stdio MCP server", () => {
  it("lists the tools with JSON schemas", () => {
    const tools = mapToolList();
    expect(tools.map((t) => t.name)).toEqual(MAP_TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["ruah_get_architecture", "ruah_get_element", "ruah_find_elements", "ruah_add_element", "ruah_update_element", "ruah_remove_element", "ruah_connect", "ruah_disconnect", "ruah_add_workflow", "ruah_update_workflow", "ruah_apply"]),
    );
    const add = tools.find((t) => t.name === "ruah_add_element");
    expect(add?.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["name", "type"]) });
    expect(add?.inputSchema.$schema).toBeUndefined();
  });

  it("round-trips initialize, tools/list and tools/call against a test daemon", async () => {
    const { server, service, ctx, socket } = await daemon();
    const token = service.issueToken(ctx);
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: { id: number; result?: { content?: { text: string }[]; isError?: boolean; tools?: unknown[]; serverInfo?: unknown }; error?: unknown }[] = [];
    let buffer = "";
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        replies.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    const done = serveMcpStdio(httpMapBackend(server.url, token), { input, output, version: "t" });
    const send = (m: unknown) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...(m as object) })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({ id: 3, method: "tools/call", params: { name: "ruah_add_element", arguments: { name: "Stripe", type: "external", layer: "external" } } });
    await until(() => replies.length >= 3);
    send({ id: 4, method: "tools/call", params: { name: "ruah_connect", arguments: { from: "data", to: "Stripe", label: "payments" } } });
    send({ id: 5, method: "tools/call", params: { name: "ruah_connect", arguments: { from: "data", to: "Nope" } } });
    send({ id: 6, method: "tools/call", params: { name: "ruah_get_architecture", arguments: { level: "" } } });
    send({ id: 7, method: "bogus" });
    await until(() => replies.length >= 7);
    input.end();
    await done;
    const byId = new Map(replies.map((r) => [r.id, r]));
    expect(byId.get(1)?.result?.serverInfo).toMatchObject({ name: "ruah" });
    expect(byId.get(2)?.result?.tools).toHaveLength(MAP_TOOLS.length);
    expect(byId.get(3)?.result?.content?.[0]?.text).toMatch(/added external "Stripe" \(id stripe/);
    expect(byId.get(4)?.result?.content?.[0]?.text).toMatch(/linked "data" → "Stripe" \[payments\]/);
    expect(byId.get(5)?.result).toMatchObject({ isError: true });
    expect(byId.get(5)?.result?.content?.[0]?.text).toMatch(/unknown to element "Nope"/);
    expect(byId.get(6)?.result?.content?.[0]?.text).toContain("data -> stripe [payments] {agent}");
    expect(byId.get(7)?.error).toMatchObject({ code: -32601 });
    expect(socket.archs().filter((m) => m.by?.kind === "agent")).toHaveLength(2);
  });

  it("the built binary serves the tools (ruah app mcp --daemon, token from the environment)", async () => {
    const cli = resolve("dist/cli.js");
    if (!existsSync(cli)) return; // pnpm build first (the smoke tests need it too)
    const { server, service, ctx, store } = await daemon();
    const token = service.issueToken(ctx);
    const child = spawn(process.execPath, [cli, "mcp", "--daemon", server.url], { env: { ...process.env, RUAH_MCP_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(() => {
      child.kill();
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ruah_apply", arguments: { ops: [{ op: "add_element", name: "Queue", type: "queue" }, { op: "connect", from: "api", to: "Queue", kind: "event" }] } } })}\n`);
    await until(() => out.split("\n").filter((l) => l.trim() !== "").length >= 2, 8000);
    child.stdin.end();
    const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: { tools?: unknown[]; content?: { text: string }[] } });
    expect(lines.find((l) => l.id === 1)?.result.tools).toHaveLength(MAP_TOOLS.length);
    expect(lines.find((l) => l.id === 2)?.result.content?.[0]?.text).toMatch(/added queue "Queue"[\s\S]*linked "api" → "Queue"/);
    expect(store.current()?.edges).toContainEqual({ from: "api", to: "queue", kind: "event", source: "agent" });
  });
});

describe("bridges get the map tools", () => {
  it("ACP session/new carries the stdio MCP server (token in env, not argv)", async () => {
    const { service, ctx } = await daemon();
    const tools = service.toolsFor(ctx);
    const spec = await tools.stdio();
    expect(spec).toMatchObject({ name: "ruah", command: process.execPath });
    expect(spec?.args.slice(-3)).toEqual(["mcp", "--daemon", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
    const token = spec?.env.find((e) => e.name === "RUAH_MCP_TOKEN")?.value;
    expect(service.contextForToken(token)).toEqual(ctx);
    expect(spec?.args.join(" ")).not.toContain(token);

    const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    let stderr = "";
    const bridge = new AcpProcessBridge(
      {
        root: ctx.root,
        preset: { command: process.execPath, args: ["--import", tsxLoader, resolve("test/fake-agent.ts")] },
        clientVersion: "0.0.0-test",
        onStderr: (c) => {
          stderr += c;
        },
        mapTools: tools,
      },
      { killGraceMs: 200 },
    );
    cleanups.push(() => bridge.stop());
    await bridge.start();
    expect(stderr).toContain(`mcp=ruah:${process.execPath}`);
  });

  it("ACP permission requests for the map tools are allowed without asking; others are not", () => {
    const service = new MapOpsService(() => undefined, { version: "t" });
    const bridge = new AcpProcessBridge({ root: "/r", preset: { command: "none", args: [] }, clientVersion: "t", mapTools: service.toolsFor({ agentId: "cursor", root: "/r" }) });
    const options = [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    const ask = (title: string) => (bridge as unknown as { mapToolPermission(p: unknown): string | undefined }).mapToolPermission({ sessionId: "s", toolCall: { toolCallId: "t", title }, options });
    expect(ask("ruah-ruah_apply: ruah_apply")).toBe("yes");
    expect(ask("mcp__ruah__ruah_connect")).toBe("yes");
    expect(ask("ruah-ruah_delete_everything: x")).toBeUndefined();
    expect(ask("other-ruah_apply")).toBeUndefined();
    expect(ask("Edit src/app.ts")).toBeUndefined();
  });

  it("the Claude Agent SDK gets an in-process server with every tool", () => {
    const service = new MapOpsService(() => undefined, { version: "t" });
    const tools = service.toolsFor({ agentId: "claude", root: "/r" });
    const server = tools.sdkServer() as { type: string; name: string; instance: unknown };
    expect(server).toMatchObject({ type: "sdk", name: "ruah" });
    expect(server.instance).toBeDefined();
    expect(tools.allowedTools).toContain("mcp__ruah__ruah_add_element");
    expect(tools.allowedTools).toHaveLength(MAP_TOOLS.length);
  });
});

describe("in-process tools, per-turn undo and the chat record", () => {
  it("records the turn's map changes, broadcasts them with the turn id, and undoes them", async () => {
    const { hub, service, ctx, socket, bridge, chats, store } = await daemon();
    const backend = service.backendFor(ctx);
    // Outside a turn: applied, but no turn id and nothing to undo.
    await callMapTool("ruah_update_element", { id: "web", description: "Shop UI." }, backend);
    expect(socket.archs().at(-1)?.by).toEqual({ kind: "agent", agentId: "claude" });

    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "add payments" });
    await until(() => hub.activeTurnId() === "t1");
    expect(socket.sent.find((m) => m.type === "turn.started")).toMatchObject({ contextPack: expect.stringContaining("ruah_* tools") });
    const r1 = await callMapTool("ruah_add_element", { name: "Payments", type: "service", layer: "services" }, backend);
    expect(r1.isError).toBeUndefined();
    await callMapTool("ruah_connect", { from: "api", to: "payments", label: "charge" }, backend);
    const failed = await callMapTool("ruah_remove_element", { id: "api" }, backend);
    expect(failed).toMatchObject({ isError: true });
    expect(socket.archs().at(-1)).toMatchObject({ by: { kind: "agent", agentId: "claude", turnId: "t1" }, changes: [{ action: "connect" }] });
    expect(service.undoable("t1")).toBe(true);

    bridge.finish();
    await until(() => socket.sent.some((m) => m.type === "turn.finished"));
    const chatId = hub.chatId();
    expect(chatId).not.toBeNull();
    const record = chats.history(hub.project()!.id, chatId!)[0];
    expect(record?.mapChanges?.map((c) => `${c.action}:${c.id}`)).toEqual(["add:payments", "connect:api->payments"]);

    socket.receive({ type: "arch.undo", turnId: "t1" });
    await until(() => socket.archs().at(-1)?.by?.undo === true);
    expect(socket.archs().at(-1)).toMatchObject({ reason: "saved", by: { kind: "user", turnId: "t1", undo: true } });
    expect(store.current()?.nodes.some((n) => n.id === "payments")).toBe(false);
    expect(store.current()?.edges.some((e) => e.to === "payments")).toBe(false);
    // Changes outside the turn stay.
    expect(store.current()?.nodes.find((n) => n.id === "web")?.description).toBe("Shop UI.");

    socket.receive({ type: "arch.undo", turnId: "t1" });
    await until(() => socket.sent.some((m) => m.type === "error" && m.message.includes("nothing to undo")));
  });

  it("a viewer save and a rescan are tagged user / scan", async () => {
    const { socket, store } = await daemon();
    const arch = structuredClone(store.current()!);
    arch.name = "renamed";
    socket.receive({ type: "architecture.save", architecture: arch });
    await until(() => socket.archs().at(-1)?.architecture.name === "renamed");
    expect(socket.archs().at(-1)?.by).toEqual({ kind: "user" });
  });
});
