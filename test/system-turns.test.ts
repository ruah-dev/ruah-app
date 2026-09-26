// CONTRACTS §12.4 / §20.2: a system repo rename waits for running agent turns
// (a turn stores its element ids when it finishes, so renaming under it wrote
// the old ids back into the chat), and "Suggest connections" has a timeout, a
// cancel, and shows the permission its agent waits on.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { AgentChoiceState, AgentState, StopReason } from "../src/contracts/ws.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { ProjectsStore } from "../src/projects/projects-store.js";
import { ProjectService } from "../src/projects/service.js";
import { startServer } from "../src/serve/server.js";
import { SessionHub, type AgentSwitcher } from "../src/serve/session.js";
import { SystemService } from "../src/serve/system-http.js";
import { makeOpenSystemProject } from "../src/system/open.js";
import { runSystem } from "../src/system/run-system.js";
import { loadSystem } from "../src/system/config.js";
import { createServer } from "node:http";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "system");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x", GIT_CONFIG_GLOBAL: "/dev/null" };

function repos(): string {
  const dir = tmp("ruah-systurn-");
  for (const r of ["web", "invoices-api"]) {
    cpSync(path.join(FIXTURE, r), path.join(dir, r), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path.join(dir, r), env: GIT_ENV, stdio: "ignore" });
  }
  return dir;
}

/** An agent whose turns wait until the test finishes them, optionally asking a permission first. */
class HeldBridge implements AcpBridge {
  state: AgentState = "stopped";
  askPermission = false;
  readonly cancelled: string[] = [];
  private readonly open = new Map<string, (stop: StopReason) => void>();
  private readonly listeners = new Set<(e: BridgeEvent) => void>();
  async start(): Promise<void> {
    this.state = "idle";
    this.emit({ type: "status", state: "idle", sessionId: "s1" });
  }
  status(): AgentState {
    return this.state;
  }
  prompt(turnId: string, _blocks: ContentBlock[]): TurnHandle {
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    // Like a real agent: the permission request arrives after the prompt call returned.
    if (this.askPermission) setTimeout(() => this.emit({
        type: "permission",
        turnId,
        requestId: "perm-1",
        toolCall: { toolCallId: "tc1", title: "Run `ls ../`", kind: "execute", status: "pending", locations: [] },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }), 5);
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      this.open.set(turnId, (stopReason) => {
        this.open.delete(turnId);
        this.emit({ type: "stream", turnId, event: { kind: "text", text: JSON.stringify({ edges: [] }) } });
        this.state = "idle";
        this.emit({ type: "turn_finished", turnId, stopReason });
        this.emit({ type: "status", state: "idle", sessionId: "s1" });
        resolve({ stopReason });
      });
    });
    return { turnId, done };
  }
  finish(stopReason: StopReason = "end_turn"): void {
    for (const f of [...this.open.values()]) f(stopReason);
  }
  async cancel(turnId: string): Promise<void> {
    this.cancelled.push(turnId);
    this.open.get(turnId)?.("cancelled");
  }
  answerPermission(): boolean {
    return true;
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async reset(): Promise<void> {}
  async stop(): Promise<void> {
    this.state = "stopped";
  }
  on(l: (e: BridgeEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(e: BridgeEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

class Switcher implements AgentSwitcher {
  readonly bridges: HeldBridge[] = [];
  askPermission = false;
  choices(currentAgentId: string): AgentChoiceState {
    return { currentAgentId, available: [{ id: "alpha", name: "Alpha", installed: true }] };
  }
  check(): { ok: true } {
    return { ok: true };
  }
  create(): AcpBridge {
    const b = new HeldBridge();
    b.askPermission = this.askPermission;
    this.bridges.push(b);
    return b;
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function daemon(options: { suggestTimeoutMs?: number; askPermission?: boolean } = {}) {
  const home = tmp("ruah-systurn-home-");
  const chats = new ChatStore(home);
  const switcher = new Switcher();
  switcher.askPermission = options.askPermission === true;
  const hub = new SessionHub(null, null, { version: "t", links: false, debug: () => {}, info: () => {}, agentId: "alpha", agents: switcher, chats, autoPrewarmDelayMs: -1 });
  const projects = new ProjectService({ projects: new ProjectsStore(home), chats, host: hub, version: "t", openSystemProject: makeOpenSystemProject("t", { watch: false }) });
  const system = new SystemService({ host: hub, projects, version: "t", home, chats, ...(options.suggestTimeoutMs !== undefined ? { suggestTimeoutMs: options.suggestTimeoutMs } : {}) });
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, projects, system });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  const dir = repos();
  const created = await post(`${server.url}/api/system/create`, {
    dir: path.join(dir, "platform"),
    name: "acme",
    repos: [{ path: path.join(dir, "web") }, { path: path.join(dir, "invoices-api") }],
  });
  expect(created.status).toBe(200);
  await until(() => hub.agentState() === "idle");
  return { url: server.url, hub, home, chats, switcher, system };
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function viewer(url: string): Promise<WebSocket> {
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", protocol: 1, client: "test" }));
  cleanups.push(() => ws.close());
  return ws;
}

describe("system repo rename while an agent turn runs (§12.4)", () => {
  it("is refused with 409 and a reason until the turn has finished; the chat keeps consistent ids", async () => {
    const d = await daemon();
    const ws = await viewer(d.url);
    const nodeId = d.hub.store?.current()?.nodes.find((n) => n.id.startsWith("web:"))?.id;
    expect(nodeId).toBeDefined();
    ws.send(JSON.stringify({ type: "prompt", turnId: "t-run", nodeId, text: "what does this do?" }));
    const projectId = d.hub.project()!.id;
    await until(() => d.hub.runningTurn(projectId) !== undefined);

    const refused = await post(`${d.url}/api/system/repos/rename`, { id: "web", newId: "storefront" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/agent turn is running.*old ids/);
    // Nothing was renamed.
    expect(d.hub.store?.current()?.nodes.some((n) => n.id === "web")).toBe(true);

    d.switcher.bridges.at(-1)!.finish();
    await until(() => d.hub.runningTurn(projectId) === undefined);
    const ok = await post(`${d.url}/api/system/repos/rename`, { id: "web", newId: "storefront" });
    expect(ok.status).toBe(200);
    // The finished turn was stored first, then rewritten: its element is the new id.
    const chat = d.chats.list(projectId)[0]!;
    expect(d.chats.history(projectId, chat.id)[0]?.nodeId).toBe(nodeId!.replace(/^web:/, "storefront:"));
  });
});

describe("Suggest connections: timeout, cancel, waiting permission (§20.2)", () => {
  it("shows the permission the agent waits on, and cancel stops the run and its turn", async () => {
    const d = await daemon({ askPermission: true });
    const started = await post(`${d.url}/api/system/suggestions/run`, {});
    expect(started.status).toBe(202);
    await until(() => d.hub.pendingPermissions(d.hub.activeTurnId() ?? "").length > 0);
    const view = (await (await fetch(`${d.url}/api/system/suggestions`)).json()) as {
      running: { turnId: string; deadline: string; waitingPermission?: { requestId: string; toolCall: { title: string }; options: { optionId: string }[] } } | null;
    };
    expect(view.running?.turnId).toMatch(/^task-/);
    expect(Date.parse(view.running!.deadline)).toBeGreaterThan(Date.now());
    expect(view.running?.waitingPermission).toMatchObject({ requestId: "perm-1", toolCall: { title: "Run `ls ../`" }, options: [{ optionId: "allow" }, { optionId: "deny" }] });

    const cancelled = await post(`${d.url}/api/system/suggestions/cancel`, {});
    expect(cancelled.status).toBe(200);
    const after = (await cancelled.json()) as { running: unknown; lastRun: { error?: string } | null };
    expect(after.running).toBeNull();
    expect(after.lastRun?.error).toBe("cancelled");
    expect(d.switcher.bridges.at(-1)!.cancelled).toEqual([view.running!.turnId]);
    expect((await post(`${d.url}/api/system/suggestions/cancel`, {})).status).toBe(409);
    // The agent is free again: a new run starts.
    await until(() => d.hub.agentState() === "idle");
    expect((await post(`${d.url}/api/system/suggestions/run`, {})).status).toBe(202);
  });

  it("times out instead of waiting forever on a permission prompt", async () => {
    const d = await daemon({ askPermission: true, suggestTimeoutMs: 150 });
    expect((await post(`${d.url}/api/system/suggestions/run`, {})).status).toBe(202);
    await d.system.settle();
    const view = (await (await fetch(`${d.url}/api/system/suggestions`)).json()) as { running: unknown; lastRun: { error?: string } | null };
    expect(view.running).toBeNull();
    expect(view.lastRun?.error).toMatch(/^timed out after 150 ms waiting for your permission \(Run `ls \.\.\/`\)$/);
    expect(d.switcher.bridges.at(-1)!.cancelled).toHaveLength(1);
  });
});

describe("ruah app system rename asks a running daemon first (§12.4)", () => {
  it("refuses (exit 2) while the daemon reports a running turn in the system; --offline skips the check", async () => {
    const dir = repos();
    const platform = path.join(dir, "platform");
    const quietErr = process.stderr.write.bind(process.stderr);
    const errors: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await runSystem(["init", platform, "--repo", path.join(dir, "web"), "--repo", path.join(dir, "invoices-api")], "t")).toBe(0);
      const projectId = (await import("../src/projects/fs-util.js")).projectIdFor(realpathSync(platform));
      let running = 1;
      const fake = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ projects: req.url?.startsWith("/api/activity") ? [{ projectId, running, waitingPermission: 0, unread: 0, chats: {} }] : [] }));
      });
      await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>((resolve) => fake.close(() => resolve())));
      const daemonUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
      expect(await runSystem(["rename", "web", "shop", "--system", platform, "--daemon", daemonUrl], "t")).toBe(2);
      expect(errors.join("")).toContain("an agent turn is running in this system");
      expect(loadSystem(platform).repos.map((r) => r.id)).toEqual(["web", "invoices-api"]);
      running = 0;
      expect(await runSystem(["rename", "web", "shop", "--system", platform, "--daemon", daemonUrl], "t")).toBe(0);
      expect(await runSystem(["rename", "shop", "store", "--system", platform, "--offline"], "t")).toBe(0);
      expect(loadSystem(platform).repos.map((r) => r.id)).toEqual(["store", "invoices-api"]);
    } finally {
      process.stderr.write = quietErr;
    }
  });
});
