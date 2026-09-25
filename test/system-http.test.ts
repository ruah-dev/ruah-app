// CONTRACTS §12 over HTTP: create a system from the app (it opens as the
// current project), status, add / remove / rename / rescan through the live
// store (broadcast, project stays open), POST /api/rescan on a system, Origin
// 403 and 409 without a system, "Suggest connections" as a normal turn of the
// current agent (recorded in the chat, pending → accept / reject), GitHub
// helpers with a mocked `gh`; plus namespaced ids through context, expand and
// the draw.io export.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { Architecture } from "../src/contracts/architecture.js";
import type { AgentChoiceState, AgentState, StopReason } from "../src/contracts/ws.js";
import type { Runner } from "../src/integrations/exec.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { ProjectsStore } from "../src/projects/projects-store.js";
import { ProjectService } from "../src/projects/service.js";
import { startServer } from "../src/serve/server.js";
import { SessionHub, type AgentSwitcher } from "../src/serve/session.js";
import { SystemService } from "../src/serve/system-http.js";
import { makeOpenSystemProject } from "../src/system/open.js";
import { buildContextPack } from "../src/context/pack.js";
import { resolveNodeScope } from "../src/expand/context.js";
import { expanderFor } from "../src/expand/index.js";
import { toDrawio } from "../src/export/drawio.js";

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
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });

function repos(): string {
  const dir = tmp("ruah-sysh-");
  for (const r of ["web", "invoices-api", "notify-worker", "infra"]) {
    cpSync(path.join(FIXTURE, r), path.join(dir, r), { recursive: true });
    git(path.join(dir, r), "init", "-q", "-b", "main");
    git(path.join(dir, r), "add", "-A");
    git(path.join(dir, r), "commit", "-qm", "init");
  }
  return dir;
}

const REPLY = JSON.stringify({
  edges: [
    { from: "web", to: "notify-worker", label: "HTTP", kind: "sync", confidence: 0.7, evidence: ["web/src/api.js:4"], reason: "fetch" },
    { from: "invoices-api", to: "resend", confidence: 0.55, evidence: ["invoices-api/src/events.js:8"] },
  ],
});

/** An agent that answers every prompt with REPLY (streamed in two chunks). */
class ReplyBridge implements AcpBridge {
  state: AgentState = "stopped";
  prompts: string[] = [];
  private readonly listeners = new Set<(e: BridgeEvent) => void>();
  async start(): Promise<void> {
    this.state = "idle";
    this.emit({ type: "status", state: "idle", sessionId: "s1" });
  }
  status(): AgentState {
    return this.state;
  }
  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle {
    this.prompts.push(blocks.map((b) => (b.type === "text" ? b.text : "")).join(""));
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      setTimeout(() => {
        this.emit({ type: "stream", turnId, event: { kind: "text", text: REPLY.slice(0, 20) } });
        this.emit({ type: "stream", turnId, event: { kind: "text", text: REPLY.slice(20) } });
        this.state = "idle";
        this.emit({ type: "turn_finished", turnId, stopReason: "end_turn" });
        this.emit({ type: "status", state: "idle", sessionId: "s1" });
        resolve({ stopReason: "end_turn" });
      }, 20);
    });
    return { turnId, done };
  }
  async cancel(): Promise<void> {}
  answerPermission(): boolean {
    return false;
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
  readonly bridges: ReplyBridge[] = [];
  choices(currentAgentId: string): AgentChoiceState {
    return { currentAgentId, available: [{ id: "alpha", name: "Alpha", installed: true }] };
  }
  check(): { ok: true } {
    return { ok: true };
  }
  create(): AcpBridge {
    const b = new ReplyBridge();
    this.bridges.push(b);
    return b;
  }
}

async function daemon(ghRunner?: Runner) {
  const home = tmp("ruah-home-");
  const chats = new ChatStore(home);
  const switcher = new Switcher();
  const hub = new SessionHub(null, null, { version: "t", links: false, debug: () => {}, info: () => {}, agentId: "alpha", agents: switcher, chats, autoPrewarmDelayMs: -1 });
  const projects = new ProjectService({ projects: new ProjectsStore(home), chats, host: hub, version: "t", openSystemProject: makeOpenSystemProject("t", { watch: false }) });
  const system = new SystemService({ host: hub, projects, version: "t", home, chats, ...(ghRunner !== undefined ? { ghRunner } : {}) });
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, projects, system });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  return { url: server.url, hub, home, chats, switcher, system };
}

const post = (url: string, body: unknown, origin?: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) }, body: JSON.stringify(body) });

async function json<T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<{ status: number; body: T }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as T };
}

describe("/api/system (CONTRACTS §12)", () => {
  it("creates a system from repos, manages it live, suggests via the current agent", async () => {
    const dir = repos();
    const d = await daemon();
    // Without a system: 409; a foreign Origin: 403.
    expect((await json(fetch(`${d.url}/api/system`))).status).toBe(409);
    expect((await post(`${d.url}/api/system/create`, { dir: path.join(dir, "platform"), repos: [] }, "https://evil.example")).status).toBe(403);

    // "New system…": create + open.
    const created = await json<{ project: { kind: string; root: string }; created: boolean; added: string[] }>(
      post(`${d.url}/api/system/create`, {
        dir: path.join(dir, "platform"),
        name: "acme",
        repos: [{ path: path.join(dir, "web") }, { path: path.join(dir, "invoices-api") }],
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ created: true, added: ["web", "invoices-api"], project: { kind: "system", root: path.join(dir, "platform") } });
    expect(d.hub.project()?.kind).toBe("system");

    const status = await json<{ name: string; repos: { id: string; git: { branch: string; dirty: number } | null; nodes: number; lastScanAt: string | null }[] }>(fetch(`${d.url}/api/system`));
    expect(status.body.name).toBe("acme");
    expect(status.body.repos.map((r) => [r.id, r.git?.branch, r.git?.dirty])).toEqual([["web", "main", 0], ["invoices-api", "main", 0]]);
    expect(status.body.repos.every((r) => r.nodes > 0 && r.lastScanAt !== null)).toBe(true);

    // Add a repo: the open store gets it (no project switch), its paths resolve.
    const revision = d.hub.store?.revision ?? 0;
    const added = await json<{ repos: { id: string }[] }>(post(`${d.url}/api/system/repos/add`, { path: path.join(dir, "notify-worker") }));
    expect(added.body.repos.map((r) => r.id)).toEqual(["web", "invoices-api", "notify-worker"]);
    expect(d.hub.store?.revision).toBeGreaterThan(revision);
    expect(d.hub.store?.current()?.nodes.some((n) => n.id === "notify-worker")).toBe(true);
    expect(d.hub.store?.resolvePath?.("notify-worker/src/index.js")?.abs).toBe(path.join(dir, "notify-worker", "src", "index.js"));
    expect((await post(`${d.url}/api/system/repos/add`, { path: path.join(dir, "web") })).status).toBe(409);
    expect((await post(`${d.url}/api/system/repos/add`, { path: path.join(dir, "missing") })).status).toBe(404);
    expect((await post(`${d.url}/api/system/repos/add`, {})).status).toBe(400);

    // Signals: deterministic cross-repo edges, zero tokens.
    const signals = await json<{ edges: { from: string; to: string; label?: string; evidence?: string[] }[] }>(fetch(`${d.url}/api/system/signals`));
    expect(signals.body.edges.map((e) => `${e.from} -> ${e.to} [${e.label ?? ""}]`)).toContain("invoices-api -> notify-worker [invoice.created]");

    // Suggest connections: a normal turn of the current agent.
    const started = await json<{ running: { agentId: string } | null }>(post(`${d.url}/api/system/suggestions/run`, {}));
    expect(started.status).toBe(202);
    expect(started.body.running?.agentId).toBe("alpha");
    expect((await post(`${d.url}/api/system/suggestions/run`, {})).status).toBe(409);
    await d.system.settle();
    const bridge = d.switcher.bridges.at(-1)!;
    expect(bridge.prompts[0]).toContain('multi-repo system "acme"');
    const projectId = d.hub.project()!.id;
    const chat = d.chats.list(projectId)[0];
    expect(chat?.turnCount).toBe(1);
    expect(d.chats.history(projectId, chat!.id)[0]).toMatchObject({ text: "Suggest connections between the 3 repos of acme" });
    const sugg = await json<{ pending: { id: string; from: string; to: string; confidence: number; evidence: string[] }[]; lastRun: { agentId: string } }>(
      fetch(`${d.url}/api/system/suggestions`),
    );
    expect(sugg.body.pending.map((p) => `${p.from}->${p.to}`)).toEqual(["web->notify-worker", "invoices-api->resend"]);
    expect(sugg.body.lastRun.agentId).toBe("alpha");

    // Accept → edge saved through the store; reject → remembered.
    const accepted = await json<{ edge: { source: string } }>(post(`${d.url}/api/system/suggestions/accept`, { id: sugg.body.pending[0]!.id }));
    expect(accepted.body.edge.source).toBe("suggested");
    expect(d.hub.store?.current()?.edges.find((e) => e.from === "web" && e.to === "notify-worker")?.evidence).toEqual(["web/src/api.js:4"]);
    const rejected = await json<{ pending: unknown[]; rejected: { id: string }[] }>(post(`${d.url}/api/system/suggestions/reject`, { id: sugg.body.pending[1]!.id }));
    expect(rejected.body).toMatchObject({ pending: [], rejected: [{ id: sugg.body.pending[1]!.id }] });
    expect((await post(`${d.url}/api/system/suggestions/accept`, { id: "s-nope" })).status).toBe(404);
    // A second run proposes nothing new (accepted = known edge, rejected = remembered).
    await post(`${d.url}/api/system/suggestions/run`, {});
    await d.system.settle();
    expect((await json<{ pending: unknown[] }>(fetch(`${d.url}/api/system/suggestions`))).body.pending).toEqual([]);

    // Rename: ids, the accepted edge and chats follow; the project stays open.
    const renamed = await json<{ repos: { id: string }[] }>(post(`${d.url}/api/system/repos/rename`, { id: "web", newId: "frontend" }));
    expect(renamed.body.repos.map((r) => r.id)).toEqual(["frontend", "invoices-api", "notify-worker"]);
    const arch = d.hub.store!.current()!;
    expect(arch.nodes.some((n) => n.id === "web")).toBe(false);
    expect(arch.edges.find((e) => e.from === "frontend" && e.to === "notify-worker")?.source).toBe("suggested");
    expect((await post(`${d.url}/api/system/repos/rename`, { id: "frontend", newId: "postgres" })).status).toBe(409);

    // Rescan: one repo, the whole system, and POST /api/rescan (never scans the system folder as a repo).
    expect((await json(post(`${d.url}/api/system/repos/rescan`, { id: "invoices-api" }))).status).toBe(200);
    const rescan = await json<{ ok: boolean; nodes: number }>(post(`${d.url}/api/rescan`, {}));
    expect(rescan.body.ok).toBe(true);
    expect(d.hub.store?.current()?.nodes.filter((n) => n.parent === undefined).map((n) => n.id)).toEqual(
      expect.arrayContaining(["frontend", "invoices-api", "notify-worker"]),
    );

    // Remove: out of the system, files untouched.
    const removed = await json<{ repos: { id: string }[] }>(post(`${d.url}/api/system/repos/remove`, { id: "notify-worker" }));
    expect(removed.body.repos.map((r) => r.id)).toEqual(["frontend", "invoices-api"]);
    expect(existsSync(path.join(dir, "notify-worker", "src", "index.js"))).toBe(true);
    expect(d.hub.store?.current()?.nodes.some((n) => n.repo === "notify-worker")).toBe(false);

    // "Add another repo…" into the existing system from elsewhere: merges, keeps it open.
    const merged = await json<{ created: boolean; added: string[] }>(
      post(`${d.url}/api/system/create`, { dir: path.join(dir, "platform"), repos: [{ path: path.join(dir, "invoices-api") }, { path: path.join(dir, "infra") }] }),
    );
    expect(merged.body).toMatchObject({ created: false, added: ["infra"] });
    // Regression: the open system reloads even when the dialog names it through a symlink
    // (tmpdir() is /var/folders → /private/var/folders on macOS; opened roots are real paths).
    const viaLink = realpathSync(dir) !== dir ? dir : undefined;
    const afterMerge = await json<{ repos: { id: string }[] }>(fetch(`${d.url}/api/system`));
    expect(afterMerge.body.repos.map((r) => r.id)).toContain("infra");
    if (viaLink === undefined) {
      // Not a symlinked tmpdir: go through an explicit symlink to the system folder.
      const link = path.join(realpathSync(tmpdir()), `ruah-link-${Date.now()}`);
      symlinkSync(path.join(dir, "platform"), link);
      await post(`${d.url}/api/system/create`, { dir: link, repos: [{ path: path.join(dir, "notify-worker") }] });
      const again = await json<{ repos: { id: string }[] }>(fetch(`${d.url}/api/system`));
      expect(again.body.repos.map((r) => r.id)).toContain("notify-worker");
    }
  });

  it("turns an open repo into a system; a single repo project has no system endpoints", async () => {
    const dir = repos();
    const d = await daemon();
    await post(`${d.url}/api/projects/open`, { path: path.join(dir, "web") });
    expect(d.hub.project()?.kind).toBe("repo");
    expect((await json(fetch(`${d.url}/api/system`))).status).toBe(409);
    expect((await post(`${d.url}/api/system/suggestions/run`, {})).status).toBe(409);
    // The repo keeps its own map; the system lives in the picked folder.
    const repoMap = readFileSync(path.join(dir, "web", "architecture.json"), "utf8");
    expect((await post(`${d.url}/api/system/create`, { dir: path.join(dir, "web"), repos: [{ path: path.join(dir, "web") }] })).status).toBe(409);
    const r = await json<{ project: { kind: string } }>(
      post(`${d.url}/api/system/create`, { dir: path.join(dir, "sys"), repos: [{ path: path.join(dir, "web") }, { path: path.join(dir, "invoices-api") }] }),
    );
    expect(r.body.project.kind).toBe("system");
    expect(readFileSync(path.join(dir, "web", "architecture.json"), "utf8")).toBe(repoMap);
  });

  it("GitHub: lists with gh repo list --json, clones only on an explicit call, validates names", async () => {
    const dir = repos();
    const calls: string[][] = [];
    const gh: Runner = async (_file, args) => {
      calls.push([...args]);
      if (args[1] === "list") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            { name: "billing", nameWithOwner: "acme/billing", description: "Billing", url: "https://github.com/acme/billing", isPrivate: true, isArchived: false, updatedAt: "2026-09-01T00:00:00Z", defaultBranchRef: { name: "main" } },
            { name: "bad", nameWithOwner: "acme/../x", url: "" },
          ]),
        };
      }
      mkdirSync(args[3] ?? "", { recursive: true });
      writeFileSync(path.join(args[3] ?? "", "package.json"), JSON.stringify({ name: "billing" }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const d = await daemon(gh);
    const list = await json<{ repos: { nameWithOwner: string; isPrivate: boolean; defaultBranch: string }[] }>(fetch(`${d.url}/api/system/github/repos?owner=acme`));
    expect(list.body.repos).toEqual([expect.objectContaining({ nameWithOwner: "acme/billing", isPrivate: true, defaultBranch: "main" })]);
    expect(calls[0]).toEqual(["repo", "list", "acme", "--json", expect.any(String), "--limit", "100"]);
    expect((await json(fetch(`${d.url}/api/system/github/repos?owner=-rf`))).status).toBe(400);
    expect(calls).toHaveLength(1);
    const cloned = await json<{ path: string }>(post(`${d.url}/api/system/github/clone`, { repo: "acme/billing", parentDir: dir }));
    expect(cloned.body.path).toBe(path.join(dir, "billing"));
    expect(calls[1]).toEqual(["repo", "clone", "acme/billing", path.join(dir, "billing")]);
    expect((await post(`${d.url}/api/system/github/clone`, { repo: "acme/billing", parentDir: dir })).status).toBe(409);
    expect((await post(`${d.url}/api/system/github/clone`, { repo: "acme/billing; rm -rf /", parentDir: dir })).status).toBe(400);
    // Add from GitHub into an open system: clone into the system folder's parent, then add.
    await post(`${d.url}/api/system/create`, { dir: path.join(dir, "platform"), repos: [{ path: path.join(dir, "web") }] });
    const added = await json<{ repos: { id: string; path: string }[] }>(post(`${d.url}/api/system/repos/add`, { github: { repo: "acme/payments" } }));
    expect(added.body.repos.at(-1)).toMatchObject({ id: "payments", path: "../payments" });
  });
});

describe("namespaced ids (repoId:nodeId) through context, expand, export", () => {
  it("context pack names the repo root; expand and context work below a namespaced node; draw.io pages per repo", async () => {
    const dir = tmp("ruah-sysns-");
    cpSync(FIXTURE, dir, { recursive: true });
    const { store } = await makeOpenSystemProject("t", { watch: false })(dir);
    cleanups.push(() => store.close());
    const arch = store.current() as Architecture;

    const scope = resolveNodeScope(store, arch, "invoices-api:acme-invoices-api");
    expect(scope).not.toBeNull();
    const pack = buildContextPack(scope!.index, "invoices-api:acme-invoices-api", store.root, "what does it do?");
    expect(pack).toContain("id=invoices-api:acme-invoices-api");
    expect(pack).toContain("path: invoices-api/src");
    expect(pack).toContain(`repo: invoices-api at ${path.join(dir, "invoices-api")}`);

    const level = expanderFor(store).expand(arch, "invoices-api:acme-invoices-api");
    const server = level.architecture.nodes.find((n) => n.name === "server.js");
    expect(server?.id).toBe("invoices-api:acme-invoices-api/server.js");
    expect(server?.path).toBe("invoices-api/src/server.js");
    const deep = resolveNodeScope(store, arch, server!.id);
    expect(deep?.node.path).toBe("invoices-api/src/server.js");
    expect(buildContextPack(deep!.index, server!.id, store.root)).toContain(`repo: invoices-api at ${path.join(dir, "invoices-api")}`);

    const xml = toDrawio(arch);
    expect(xml).toContain('ruahId="invoices-api:acme-invoices-api"');
    // One drill page per repo node with children, linked from the overview.
    for (const repo of ["web", "invoices-api", "notify-worker", "infra"]) expect(xml).toContain(`id="level-${repo}"`);
    expect(xml).toContain("data:page/id,level-invoices-api");
  });

  it("the HTTP context / expand endpoints take URL-encoded namespaced ids", async () => {
    const dir = tmp("ruah-sysns-");
    cpSync(FIXTURE, dir, { recursive: true });
    const d = await daemon();
    await post(`${d.url}/api/projects/open`, { path: dir });
    const ctx = await fetch(`${d.url}/api/context/${encodeURIComponent("notify-worker:acme-notify-worker")}`);
    expect(ctx.status).toBe(200);
    expect(await ctx.text()).toContain(`repo: notify-worker at ${path.join(dir, "notify-worker")}`);
    const exp = await json<{ architecture: { nodes: { id: string; path?: string }[] } }>(fetch(`${d.url}/api/expand/${encodeURIComponent("notify-worker:acme-notify-worker")}`));
    expect(exp.status).toBe(200);
    expect(exp.body.architecture.nodes.map((n) => n.path)).toContain("notify-worker/src/index.js");
    const file = await json<{ content: string }>(fetch(`${d.url}/api/file?path=${encodeURIComponent("notify-worker/src/index.js")}`));
    expect(file.status).toBe(200);
    const drawio = await fetch(`${d.url}/api/export/drawio`);
    expect(drawio.status).toBe(200);
    expect(await drawio.text()).toContain("notify-worker:acme-notify-worker");
  });
});
