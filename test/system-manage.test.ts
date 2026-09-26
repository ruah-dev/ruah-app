// Multi-repo systems management (CONTRACTS §12): the standalone library
// (create / add / remove / rename / rebuild / rescan), git status on real
// `git init` repos, deterministic signals, suggestion review persistence, and
// the `ruah app system` CLI commands (no daemon; `gh` and the agent mocked).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import { validateArchitecture } from "../src/contracts/validate.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import type { Runner } from "../src/integrations/exec.js";
import { runSystem } from "../src/system/run-system.js";
import {
  acceptPending,
  addRepos,
  crossRepoSignalEdges,
  deriveRepoId,
  initSystem,
  livePending,
  loadSystem,
  parseGitStatus,
  readScanState,
  readSuggestionsFile,
  rebuildSystem,
  recordSuggestionRun,
  rejectPending,
  removeRepo,
  renameRepo,
  rescanRepo,
  runSuggestPass,
  suggestionId,
  SystemManageError,
  systemStatus,
  unreject,
} from "../src/system/index.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "system");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  vi.restoreAllMocks();
});

function tmp(prefix = "ruah-sysm-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** A copy of the fixture's repos (web, invoices-api, notify-worker, infra), each a real git repo with one commit. */
function fixtureRepos(): string {
  const dir = tmp();
  for (const repo of ["web", "invoices-api", "notify-worker", "infra"]) {
    cpSync(join(FIXTURE, repo), join(dir, repo), { recursive: true });
    git(join(dir, repo), "init", "-q", "-b", "main");
    git(join(dir, repo), "add", "-A");
    git(join(dir, repo), "commit", "-qm", "init");
  }
  return dir;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    e.mockRestore();
  }
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return { code: await fn(), out };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const REPLY = JSON.stringify({
  edges: [
    { from: "web", to: "notify-worker", label: "HTTP", kind: "sync", confidence: 0.7, evidence: ["web/src/api.js:4"], reason: "fetch to the worker" },
    { from: "invoices-api", to: "resend", confidence: 0.55, evidence: ["invoices-api/src/events.js:8"] },
    { from: "web", to: "nowhere", confidence: 0.9, evidence: ["web/src/api.js:1"] },
  ],
});

describe("library: create, add, remove", () => {
  test("initSystem writes relative paths, derives unique ids, refuses bad folders", () => {
    const dir = fixtureRepos();
    const r = initSystem(join(dir, "platform"), { repos: [{ path: join(dir, "web") }, { path: join(dir, "invoices-api"), id: "api" }] });
    expect(r.created).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "platform", "ruah.system.json"), "utf8"))).toEqual({
      version: 1,
      name: "platform",
      repos: [
        { id: "web", path: "../web" },
        { id: "api", path: "../invoices-api" },
      ],
    });
    // Exists: conflict, unless merging (then already-present repos are skipped).
    expect(() => initSystem(join(dir, "platform"))).toThrow(SystemManageError);
    const merged = initSystem(join(dir, "platform"), { merge: true, repos: [{ path: join(dir, "web") }, { path: join(dir, "notify-worker") }] });
    expect(merged.added.map((a) => a.id)).toEqual(["notify-worker"]);
    // A repo folder cannot hold its own system (its architecture.json is the repo's map).
    writeFileSync(join(dir, "web", "architecture.json"), JSON.stringify({ version: 1, name: "w", nodes: [], edges: [], workflows: [] }));
    expect(() => initSystem(join(dir, "web"), { repos: [{ path: join(dir, "infra") }] })).toThrow(/single-repo map/);
    expect(() => initSystem(join(dir, "other"), { repos: [{ path: join(dir, "other") }] })).toThrow(/system folder itself/);
    expect(() => initSystem(join(dir, "x"), { repos: [{ path: join(dir, "missing") }] })).toThrow(/folder not found/);
    expect(() => initSystem(join(dir, "y"), { repos: [{ path: join(dir, "web"), id: "Bad" }] })).toThrow(/invalid repo id/);
  });

  test("deriveRepoId slugs folder names and stays unique", () => {
    expect(deriveRepoId("Billing_Service", new Set())).toBe("billing-service");
    expect(deriveRepoId("web", new Set(["web", "web-2"]))).toBe("web-3");
    expect(deriveRepoId("___", new Set())).toBe("repo");
  });

  test("add + remove: ids, duplicates, files untouched, pending suggestions of the repo dropped", () => {
    const dir = fixtureRepos();
    initSystem(join(dir, "platform"), { repos: [{ path: join(dir, "web") }] });
    const added = addRepos(join(dir, "platform"), [{ path: join(dir, "invoices-api") }, { path: join(dir, "notify-worker") }]);
    expect(added.system.repos.map((r) => r.id)).toEqual(["web", "invoices-api", "notify-worker"]);
    expect(() => addRepos(join(dir, "platform"), [{ path: join(dir, "web") }])).toThrow(/already in the system/);
    expect(() => addRepos(join(dir, "platform"), [{ path: join(dir, "infra"), id: "web" }])).toThrow(/repo id already/);
    rebuildSystem(join(dir, "platform"), { version: "test" });
    recordSuggestionRun(join(dir, "platform"), [
      { from: "web", to: "notify-worker", confidence: 0.7, evidence: ["web/src/api.js:4"] },
      { from: "invoices-api", to: "resend", confidence: 0.5, evidence: ["invoices-api/src/events.js:8"] },
    ]);
    const r = removeRepo(join(dir, "platform"), "notify-worker");
    expect(r.removed).toEqual({ id: "notify-worker", path: "../notify-worker" });
    expect(r.system.repos.map((x) => x.id)).toEqual(["web", "invoices-api"]);
    expect(existsSync(join(dir, "notify-worker", "package.json"))).toBe(true);
    expect(readSuggestionsFile(join(dir, "platform")).pending.map((p) => p.to)).toEqual(["resend"]);
    expect(() => removeRepo(join(dir, "platform"), "notify-worker")).toThrow(/unknown repo/);
    const rebuilt = rebuildSystem(join(dir, "platform"), { version: "test" }).architecture;
    expect(rebuilt.nodes.some((n) => n.repo === "notify-worker")).toBe(false);
  });
});

describe("library: rebuild, rescan, status", () => {
  test("rebuild records scan facts; rescan refreshes a repo's own architecture.json", () => {
    const dir = fixtureRepos();
    initSystem(join(dir, "platform"), { repos: ["web", "invoices-api", "notify-worker"].map((r) => ({ path: join(dir, r) })) });
    const now = new Date("2026-09-24T10:00:00Z");
    rebuildSystem(join(dir, "platform"), { version: "test", now });
    const state = readScanState(join(dir, "platform"));
    expect(state?.builtAt).toBe("2026-09-24T10:00:00Z");
    expect(state?.repos["invoices-api"]).toMatchObject({ source: "scan", scannedAt: "2026-09-24T10:00:00Z", type: "service" });
    // CONTRACTS §20.3: writing into .ruah/ brings the .gitignore that keeps caches out of git.
    expect(readFileSync(join(dir, "platform", ".ruah", ".gitignore"), "utf8")).toContain(".cache/");
    // A repo with its own map: rescan rewrites it (hand edits merged) and the system reuses it.
    const own = join(dir, "web", "architecture.json");
    writeFileSync(
      own,
      JSON.stringify({ version: 1, name: "web", generatedAt: "2026-01-01T00:00:00Z", nodes: [{ id: "acme-web", type: "frontend", name: "Web", path: "src", description: "Hand-written." }], edges: [], workflows: [] }),
    );
    const r = rescanRepo(join(dir, "platform"), "web", { version: "test", now: new Date("2026-09-24T11:00:00Z") });
    expect(r.wroteRepoArchitecture).toBe(true);
    const refreshed = JSON.parse(readFileSync(own, "utf8")) as Architecture;
    expect(refreshed.generatedAt).toBe("2026-09-24T11:00:00Z");
    expect(readScanState(join(dir, "platform"))?.repos.web).toMatchObject({ source: "architecture.json", scannedAt: "2026-09-24T11:00:00Z" });
    expect(() => rescanRepo(join(dir, "platform"), "nope")).toThrow(/unknown repo/);
  });

  test("status: branch, ahead/behind against a real upstream, dirty count, nodes, missing folders", async () => {
    const dir = fixtureRepos();
    // invoices-api gets an upstream and one commit ahead of it.
    const bare = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", bare);
    const api = join(dir, "invoices-api");
    git(api, "remote", "add", "origin", bare);
    git(api, "push", "-q", "-u", "origin", "main");
    writeFileSync(join(api, "CHANGELOG.md"), "x\n");
    git(api, "add", "-A");
    git(api, "commit", "-qm", "two");
    // web: two dirty entries (a change and an untracked file), on a branch.
    git(join(dir, "web"), "checkout", "-q", "-b", "feature/x");
    writeFileSync(join(dir, "web", "index.html"), "<p>changed</p>\n");
    writeFileSync(join(dir, "web", "new.txt"), "new\n");
    // notify-worker is not a git repo.
    rmSync(join(dir, "notify-worker", ".git"), { recursive: true, force: true });
    initSystem(join(dir, "platform"), { repos: ["web", "invoices-api", "notify-worker", "infra"].map((r) => ({ path: join(dir, r) })) });
    rebuildSystem(join(dir, "platform"), { version: "test" });
    rmSync(join(dir, "infra"), { recursive: true, force: true });

    const s = await systemStatus(loadSystem(join(dir, "platform")));
    const by = new Map(s.repos.map((r) => [r.id, r]));
    expect(by.get("web")?.git).toMatchObject({ branch: "feature/x", upstream: null, dirty: 2 });
    expect(by.get("invoices-api")?.git).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1, behind: 0, dirty: 0 });
    expect(by.get("invoices-api")?.nodes).toBeGreaterThan(0);
    expect(by.get("invoices-api")?.lastScanAt).not.toBeNull();
    expect(by.get("notify-worker")?.git).toBeNull();
    expect(by.get("notify-worker")?.gitError).toBeUndefined();
    expect(by.get("infra")).toMatchObject({ exists: false, git: null });
  });

  test("parseGitStatus reads porcelain v2", () => {
    expect(
      parseGitStatus("# branch.oid 0123456789abcdef\n# branch.head (detached)\n1 .M N... 100644 100644 100644 a b c.txt\n? x\n"),
    ).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0, dirty: 2, head: "0123456789ab" });
  });
});

describe("library: signals, suggestions, rename", () => {
  test("deterministic signals are top-level scan edges with evidence (no agent)", () => {
    const dir = fixtureRepos();
    initSystem(join(dir, "platform"), { repos: ["web", "invoices-api", "notify-worker", "infra"].map((r) => ({ path: join(dir, r) })) });
    const edges = crossRepoSignalEdges(rebuildSystem(join(dir, "platform")).architecture);
    const lines = edges.map((e) => `${e.from} -> ${e.to} [${e.label ?? ""}]`);
    expect(lines).toContain("invoices-api -> notify-worker [invoice.created]");
    expect(lines).toContain("web -> invoices-api [HTTP]");
    for (const e of edges) {
      expect(e.source).toBe("scan");
      expect(e.evidence?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("suggestions: stored pending, accept → suggested edge, reject remembered across runs, unreject", async () => {
    const dir = fixtureRepos();
    initSystem(join(dir, "platform"), { repos: ["web", "invoices-api", "notify-worker"].map((r) => ({ path: join(dir, r) })) });
    const sys = loadSystem(join(dir, "platform"));
    let prompt = "";
    const first = await runSuggestPass(sys, async (p) => ((prompt = p), REPLY), { agentId: "mock" });
    expect(prompt).toContain("Known edges:");
    expect(first.added.map((s) => `${s.from}->${s.to}`)).toEqual(["web->notify-worker", "invoices-api->resend"]);
    expect(first.result.rejected.map((r) => r.reason)).toEqual(["unknown node: nowhere"]);
    const file = readSuggestionsFile(sys.dir);
    expect(file.lastRun).toMatchObject({ agentId: "mock", proposed: 2, dropped: 0 });
    expect(file.pending[0]?.id).toBe(suggestionId({ from: "web", to: "notify-worker", label: "HTTP" }));

    // Accept #1 → edge with source "suggested" and its evidence; it leaves pending.
    const arch = JSON.parse(readFileSync(join(sys.dir, "architecture.json"), "utf8")) as Architecture;
    const accepted = acceptPending(sys.dir, arch, "1");
    expect(accepted.edge).toMatchObject({ from: "web", to: "notify-worker", label: "HTTP", source: "suggested", evidence: ["web/src/api.js:4"] });
    expect(validateArchitecture(accepted.architecture, null).ok).toBe(true);
    writeFileSync(join(sys.dir, "architecture.json"), JSON.stringify(accepted.architecture));
    // Reject the other → remembered; a second run neither re-adds it nor the accepted one.
    rejectPending(sys.dir, readSuggestionsFile(sys.dir).pending[0]!.id);
    expect(readSuggestionsFile(sys.dir).pending).toEqual([]);
    const second = await runSuggestPass(sys, async (p) => ((prompt = p), REPLY), { agentId: "mock" });
    expect(prompt).toContain("Rejected by the user (never propose these again):\n- invoices-api -> resend");
    expect(second.added).toEqual([]);
    expect(second.droppedRejected).toBe(1);
    expect(second.result.rejected.map((r) => r.reason)).toContain("duplicate of existing edge web -> notify-worker [HTTP]");
    // The accepted edge survives a rebuild.
    const rebuilt = rebuildSystem(sys).architecture;
    expect(rebuilt.edges.find((e) => e.from === "web" && e.to === "notify-worker" && e.label === "HTTP")?.source).toBe("suggested");
    // Unreject: proposed again next time.
    const rejectedId = readSuggestionsFile(sys.dir).rejected[0]!.id;
    expect(unreject(sys.dir, rejectedId)).toBe(true);
    expect(unreject(sys.dir, rejectedId)).toBe(false);
    const third = await runSuggestPass(sys, async () => REPLY, { agentId: "mock" });
    expect(third.added.map((s) => s.to)).toEqual(["resend"]);
    // livePending hides a pending edge that someone drew meanwhile.
    const drawn = { ...rebuilt, edges: [...rebuilt.edges, { from: "invoices-api", to: "resend", source: "manual" }] };
    expect(livePending(readSuggestionsFile(sys.dir), drawn)).toEqual([]);
  });

  test("rename rewrites the file, the map, suggestions, links and chats consistently; unsafe ids refused", () => {
    const dir = fixtureRepos();
    const home = tmp("ruah-home-");
    initSystem(join(dir, "platform"), { repos: ["web", "invoices-api", "notify-worker"].map((r) => ({ path: join(dir, r) })) });
    const platform = join(dir, "platform");
    const arch = rebuildSystem(platform).architecture;
    // A manual edge, a pending + a rejected suggestion, a work-item link and a chat that name "web".
    arch.edges.push({ from: "web:acme-web", to: "invoices-api", label: "REST", source: "manual" });
    writeFileSync(join(platform, "architecture.json"), JSON.stringify(arch));
    recordSuggestionRun(platform, [
      { from: "web", to: "notify-worker", label: "HTTP", confidence: 0.7, evidence: ["web/src/api.js:4"] },
      { from: "web", to: "resend", confidence: 0.3, evidence: ["web/src/api.js:1"] },
    ]);
    rejectPending(platform, suggestionId({ from: "web", to: "resend" }));
    mkdirSync(join(platform, ".ruah"), { recursive: true });
    writeFileSync(join(platform, ".ruah", "links.json"), JSON.stringify({ version: 1, links: [{ nodeId: "web:acme-web", provider: "github", itemId: "o/r#1" }] }));
    const chats = new ChatStore(home);
    const projectId = projectIdFor(platform);
    const chat = chats.create(projectId, { agentId: "claude" });
    chats.appendTurn(projectId, chat.id, { turnId: "t1", nodeId: "web:acme-web", text: "hi", contextPack: "", events: [], startedAt: "2026-09-24T00:00:00Z" }, { agentId: "claude" });

    expect(() => renameRepo(platform, "web", "postgres")).toThrow(/already an element/);
    expect(() => renameRepo(platform, "web", "invoices-api")).toThrow(/already in the system/);
    expect(() => renameRepo(platform, "web", "Web")).toThrow(/invalid repo id/);
    expect(() => renameRepo(platform, "nope", "x")).toThrow(/unknown repo/);

    const report = renameRepo(platform, "web", "frontend", { home });
    expect(report).toMatchObject({ architecture: true, suggestions: true, links: 1, chats: 1 });
    expect(loadSystem(platform).repos.map((r) => `${r.id}=${r.path}`)).toContain("frontend=../web");
    const renamed = JSON.parse(readFileSync(join(platform, "architecture.json"), "utf8")) as Architecture;
    expect(validateArchitecture(renamed, null).ok).toBe(true);
    expect(renamed.nodes.some((n) => n.id === "web" || n.id.startsWith("web:"))).toBe(false);
    expect(renamed.nodes.find((n) => n.id === "frontend:acme-web")).toMatchObject({ parent: "frontend", repo: "frontend", path: "frontend/src" });
    expect(renamed.edges.find((e) => e.label === "REST")).toMatchObject({ from: "frontend:acme-web", source: "manual" });
    expect(renamed.edges.every((e) => (e.evidence ?? []).every((ev) => !ev.startsWith("web/")))).toBe(true);
    const sugg = readSuggestionsFile(platform);
    expect(sugg.pending.map((p) => `${p.id}:${p.from}:${p.evidence.join()}`)).toEqual([
      `${suggestionId({ from: "frontend", to: "notify-worker", label: "HTTP" })}:frontend:frontend/src/api.js:4`,
    ]);
    expect(sugg.rejected.map((r) => r.id)).toEqual([suggestionId({ from: "frontend", to: "resend" })]);
    expect(JSON.parse(readFileSync(join(platform, ".ruah", "links.json"), "utf8")).links[0].nodeId).toBe("frontend:acme-web");
    const fresh = new ChatStore(home);
    expect(fresh.history(projectId, chat.id)[0]?.nodeId).toBe("frontend:acme-web");
    expect(fresh.get(projectId, chat.id)?.lastNodeId).toBe("frontend:acme-web");
    // A rebuild keeps the hand edge and the paths resolve through the new id.
    const rebuilt = rebuildSystem(platform).architecture;
    expect(rebuilt.edges.find((e) => e.label === "REST")?.from).toBe("frontend:acme-web");
  });
});

describe("ruah app system CLI (no daemon)", () => {
  test("init with plain paths, add gh:owner/name (mock gh), remove, rename, status --json, signals --json", async () => {
    const dir = fixtureRepos();
    const cwd = process.cwd();
    process.chdir(dir);
    const ghCalls: string[][] = [];
    const ghRunner: Runner = async (_file, args) => {
      ghCalls.push([...args]);
      const target = args[3] ?? "";
      mkdirSync(target, { recursive: true });
      cpSync(join(FIXTURE, "notify-worker"), target, { recursive: true });
      git(target, "init", "-q", "-b", "main");
      return { code: 0, stdout: "", stderr: "" };
    };
    try {
      expect(await quiet(() => runSystem(["init", "platform", "--repo", "web", "--repo", "api=invoices-api", "--name", "acme"], "test"))).toBe(0);
      expect(loadSystem("platform").repos.map((r) => `${r.id}=${r.path}`)).toEqual(["web=../web", "api=../invoices-api"]);
      // add without a <system> positional: --system (or the cwd).
      expect(await quiet(() => runSystem(["add", "gh:acme/notify", "--system", "platform"], "test", { ghRunner }))).toBe(0);
      expect(ghCalls).toEqual([["repo", "clone", "acme/notify", join(dir, "notify")]]);
      expect(loadSystem("platform").repos.map((r) => r.id)).toEqual(["web", "api", "notify"]);
      expect(await quiet(() => runSystem(["add", "gh:-bad/x", "--system", "platform"], "test", { ghRunner }))).toBe(2);
      expect(await quiet(() => runSystem(["add", "platform", "infra", "--id", "ops"], "test"))).toBe(0);
      expect(await quiet(() => runSystem(["remove", "ops", "--system", "platform"], "test"))).toBe(0);
      expect(existsSync(join(dir, "infra", "docker-compose.yml"))).toBe(true);
      expect(await quiet(() => runSystem(["remove", "ops", "--system", "platform"], "test"))).toBe(2);
      expect(await quiet(() => runSystem(["scan", "platform"], "test"))).toBe(0);
      expect(await quiet(() => runSystem(["rename", "api", "invoices", "--system", "platform"], "test"))).toBe(0);
      expect(loadSystem("platform").repos.map((r) => r.id)).toEqual(["web", "invoices", "notify"]);

      process.chdir(join(dir, "platform"));
      const status = await captureStdout(() => runSystem(["status", "--json"], "test"));
      expect(status.code).toBe(0);
      const parsed = JSON.parse(status.out) as { name: string; repos: { id: string; git: { branch: string } | null; nodes: number }[] };
      expect(parsed.name).toBe("acme");
      expect(parsed.repos.map((r) => [r.id, r.git?.branch])).toEqual([["web", "main"], ["invoices", "main"], ["notify", "main"]]);
      const table = await captureStdout(() => runSystem(["status"], "test"));
      expect(table.out).toMatch(/ID\s+BRANCH\s+AHEAD\/BEHIND\s+DIRTY\s+NODES\s+LAST SCAN\s+PATH/);

      const signals = await captureStdout(() => runSystem(["signals", "--json"], "test"));
      const edges = (JSON.parse(signals.out) as { edges: { from: string; to: string; label?: string; evidence?: string[] }[] }).edges;
      expect(edges.map((e) => `${e.from} -> ${e.to} [${e.label ?? ""}]`)).toContain("web -> invoices [HTTP]");
      expect(edges.every((e) => (e.evidence?.length ?? 0) > 0)).toBe(true);
      expect(await quiet(() => runSystem(["status", join(dir, "nowhere")], "test"))).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });

  test("suggest: pluggable agent (hook / reply file / prompt), list, accept, reject by position and id", async () => {
    const dir = fixtureRepos();
    await quiet(() => runSystem(["init", join(dir, "platform"), "--repo", join(dir, "web"), "--repo", join(dir, "invoices-api"), "--repo", join(dir, "notify-worker")], "t"));
    const platform = join(dir, "platform");
    // --print-prompt: run any agent yourself, then feed its answer back with --reply-file.
    const printed = await captureStdout(() => runSystem(["suggest", platform, "--print-prompt"], "t"));
    expect(printed.out).toContain('multi-repo system "platform"');
    // Agent hook (as `--agent claude` is wired to the Claude Agent SDK).
    let seen = "";
    const agent = () => async (prompt: string) => ((seen = prompt), REPLY);
    const run = await captureStdout(() => runSystem(["suggest", platform], "t", { agent }));
    expect(run.code).toBe(0);
    expect(seen).toBe(printed.out);
    expect(run.out).toMatch(/^1\. s-[0-9a-f]{10} {2}web -> notify-worker \[HTTP\] \(sync\) {2}confidence 0\.70/m);
    expect(run.out).toContain("evidence: web/src/api.js:4");
    const list = await captureStdout(() => runSystem(["suggest", platform, "--list", "--json"], "t"));
    const pending = (JSON.parse(list.out) as { pending: { id: string; to: string }[] }).pending;
    expect(pending.map((p) => p.to)).toEqual(["notify-worker", "resend"]);
    // Accept #1 and reject by id in one call; positions refer to the list shown before.
    expect(await quiet(() => runSystem(["suggest", platform, "--accept", "1", "--reject", pending[1]!.id], "t"))).toBe(0);
    const arch = JSON.parse(readFileSync(join(platform, "architecture.json"), "utf8")) as Architecture;
    expect(arch.edges.find((e) => e.from === "web" && e.to === "notify-worker")).toMatchObject({ source: "suggested", evidence: ["web/src/api.js:4"] });
    expect(readSuggestionsFile(platform)).toMatchObject({ pending: [], rejected: [{ from: "invoices-api", to: "resend" }] });
    // Reply file: the rejected edge is not proposed again, the accepted one is a known edge.
    const replyFile = join(dir, "reply.json");
    writeFileSync(replyFile, REPLY);
    const again = await captureStdout(() => runSystem(["suggest", platform, "--reply-file", replyFile], "t"));
    expect(again.out).toContain("no pending suggestions");
    expect(await quiet(() => runSystem(["suggest", platform, "--accept", "9"], "t"))).toBe(2);
    expect(await quiet(() => runSystem(["suggest", platform, "--agent", "gpt"], "t"))).toBe(2);
    expect(await quiet(() => runSystem(["suggest", platform, "--min-confidence", "3"], "t"))).toBe(2);
  });
});
