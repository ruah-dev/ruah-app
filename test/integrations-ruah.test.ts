import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Architecture } from "../src/contracts/architecture.js";
import type { RunResult, Runner } from "../src/integrations/exec.js";
import { IntegrationRegistry, IntegrationsService } from "../src/integrations/index.js";
import { MemorySecretStore } from "../src/integrations/keychain.js";
import { gitRootOf, globsForNode, ruahFailureMessage, RuahIntegration, validateGlobs, type Launcher } from "../src/integrations/ruah.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-orch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repo(initialized: boolean, options: { git?: boolean } = {}): string {
  const root = tempDir();
  mkdirSync(join(root, "services", "invoices-api", "src"), { recursive: true });
  // A git work tree (ruah needs one); only its .git marker matters here.
  if (options.git !== false) mkdirSync(join(root, ".git"));
  if (initialized) {
    mkdirSync(join(root, ".ruah", "workflows"), { recursive: true });
    writeFileSync(join(root, ".ruah", "state.json"), "{}");
  }
  return root;
}

const arch: Architecture = {
  version: 1,
  name: "acme",
  nodes: [
    { id: "api", type: "service", name: "invoices-api", path: "services/invoices-api", files: ["services/invoices-api/src/app.ts", "package.json"] },
    { id: "ext", type: "external", name: "Stripe" },
  ],
  edges: [],
  workflows: [],
};

function ruahRunner(root: string): Runner & { calls: { args: string[]; cwd: string | undefined; timeoutMs: number | undefined }[] } {
  const calls: { args: string[]; cwd: string | undefined; timeoutMs: number | undefined }[] = [];
  const ok = (v: unknown): RunResult => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
  const runner = ((_file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
    calls.push({ args: [...args], cwd: options?.cwd, timeoutMs: options?.timeoutMs });
    const key = args.slice(0, 2).join(" ");
    if (key === "--version") return Promise.resolve(ok("ruah v1.1.3\n"));
    if (key === "status --json") return Promise.resolve(ok({ baseBranch: "main", taskCounts: { total: 0 }, tasks: {} }));
    if (key === "workflow list") return Promise.resolve(ok([{ name: "example-feature", path: join(root, ".ruah/workflows/example-feature.md") }]));
    if (key === "task list") return Promise.resolve(ok({ "api-fix": { name: "api-fix", status: "created", files: ["services/invoices-api/**"] } }));
    if (key === "task create") return Promise.resolve(ok("\u001b[32m✓\u001b[0m Task api-fix created\n"));
    if (key === "task done" || key === "task cancel") return Promise.resolve(ok("done\n"));
    if (key === "task merge") return Promise.resolve({ code: 1, stdout: "", stderr: "✗ governance gate failed: tests" });
    return Promise.resolve({ code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` });
  }) as Runner & { calls: { args: string[]; cwd: string | undefined; timeoutMs: number | undefined }[] };
  runner.calls = calls;
  return runner;
}

function fakeLauncher(): Launcher & { launched: { args: string[]; cwd: string; log: string }[] } {
  const launched: { args: string[]; cwd: string; log: string }[] = [];
  const launch = ((_bin: string, args: readonly string[], cwd: string, logFile: string) => {
    launched.push({ args: [...args], cwd, log: logFile });
    return { pid: 4242 };
  }) as Launcher & { launched: { args: string[]; cwd: string; log: string }[] };
  launch.launched = launched;
  return launch;
}

describe("globs", () => {
  test("from an element: directory path → dir/**, files not under it kept", () => {
    const root = repo(false);
    expect(globsForNode(arch.nodes[0]!, root)).toEqual(["services/invoices-api/**", "package.json"]);
    expect(globsForNode({ id: "f", type: "file", name: "f", path: "src/main.ts" }, root)).toEqual(["src/main.ts"]);
  });

  test("validation rejects escapes, absolute paths, commas and flag-shaped globs", () => {
    expect(validateGlobs(["./src/**", "src/**", "a.ts"])).toEqual(["src/**", "a.ts"]);
    for (const bad of ["../x", "a/../../b", "/etc/passwd", "a,b", "--all", "a\nb"]) expect(() => validateGlobs([bad])).toThrow(/invalid file glob/);
  });
});

describe("ruah integration", () => {
  test("status passthrough when initialized; {initialized:false, hint} otherwise", async () => {
    const root = repo(true);
    const r = new RuahIntegration({ runner: ruahRunner(root), home: tempDir(), bin: () => "/fake/ruah" });
    expect(await r.status({ root })).toEqual({ initialized: true, baseBranch: "main", taskCounts: { total: 0 }, tasks: {} });
    const bare = repo(false);
    expect(await r.status({ root: bare })).toEqual({ initialized: false, reason: "not_initialized", hint: "ruah init" });
    expect(await r.status(null)).toMatchObject({ initialized: false });
    const missing = new RuahIntegration({ runner: ruahRunner(root), home: tempDir(), bin: () => undefined });
    expect(await missing.status({ root })).toEqual({ initialized: false, reason: "cli_missing", hint: "npm i -g @ruah-dev/cli" });
    expect(await missing.info({ root })).toMatchObject({ status: "cli_missing" });
    expect(await r.info({ root: bare })).toMatchObject({ status: "not_connected", setupHint: "ruah init", detail: "ruah v1.1.3 · this repo is not initialized for ruah" });
    expect(await r.info({ root })).toMatchObject({ status: "connected", detail: "ruah v1.1.3 · initialized" });
  });

  // Regression: a folder that is not a git repository (with or without .ruah/) showed the CLI's
  // raw error / stack trace on the Tasks page.
  test("a folder that is not a git repository: a reason, no CLI run, no raw output", async () => {
    const root = repo(true, { git: false });
    const runner = ruahRunner(root);
    const r = new RuahIntegration({ runner, home: tempDir(), bin: () => "/fake/ruah" });
    expect(await r.status({ root })).toEqual({ initialized: false, reason: "not_git", hint: expect.stringContaining("git init") });
    expect(await r.workflows({ root })).toEqual({ workflows: [] });
    expect(await r.info({ root })).toMatchObject({ status: "not_connected", setupHint: "git init", detail: expect.stringContaining("not a git repository") });
    await expect(r.createTask({ name: "x", prompt: "p", files: ["a"] }, undefined, { root })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("git init") });
    expect(runner.calls.filter((c) => c.args[0] !== "--version")).toEqual([]);
    // A nested folder of a work tree is fine.
    const nested = join(repo(true), "services");
    expect(gitRootOf(nested)).toBe(join(nested, ".."));
  });

  test("CLI failures are one readable line: no colours, no stack, no source excerpt", () => {
    const stack = [
      "/opt/homebrew/lib/node_modules/@ruah-dev/orch-core/dist/cli.js:412",
      "    throw new Error(`git rev-parse failed: ${e.message}`);",
      "    ^",
      "",
      "Error: git rev-parse failed: fatal: not a git repository (or any of the parent directories): .git",
      "    at gitRoot (file:///opt/homebrew/lib/node_modules/@ruah-dev/orch-core/dist/git.js:10:11)",
      "    at node:internal/main/run_main_module:36:49",
      "",
      "Node.js v22.20.0",
    ].join("\n");
    expect(ruahFailureMessage(stack)).toBe("this folder is not a git repository (ruah needs one: `git init`)");
    expect(ruahFailureMessage("\u001b[31m✗\u001b[0m task \"x\" already exists")).toBe('task "x" already exists');
    expect(ruahFailureMessage("TypeError: Cannot read properties of undefined (reading 'files')\n    at run (file:///x.js:1:1)")).toBe(
      "Cannot read properties of undefined (reading 'files')",
    );
  });

  test("never runs `ruah init` (connect is status-only)", async () => {
    const root = repo(false);
    const runner = ruahRunner(root);
    const r = new RuahIntegration({ runner, home: tempDir(), bin: () => "/fake/ruah" });
    await r.connect({}, { root });
    expect(runner.calls.some((c) => c.args[0] === "init")).toBe(false);
    await expect(r.createTask({ name: "x", prompt: "p", files: ["a"] }, undefined, { root })).rejects.toMatchObject({ status: 409 });
  });

  test("workflows list with repo-relative paths; run only a listed workflow, detached", async () => {
    const root = repo(true);
    const home = tempDir();
    const launch = fakeLauncher();
    const r = new RuahIntegration({ runner: ruahRunner(root), home, bin: () => "/fake/ruah", launch });
    expect(await r.workflows({ root })).toEqual({ workflows: [{ name: "example-feature", path: ".ruah/workflows/example-feature.md" }] });
    const run = await r.runWorkflow("example-feature", { root });
    expect(run).toMatchObject({ name: "example-feature", started: true, pid: 4242 });
    expect(launch.launched[0]).toMatchObject({ args: ["workflow", "run", ".ruah/workflows/example-feature.md"], cwd: root });
    expect(launch.launched[0]?.log.startsWith(join(home, "projects"))).toBe(true);
    await expect(r.runWorkflow("nope", { root })).rejects.toMatchObject({ status: 404 });
    await expect(r.runWorkflow("../../etc/x", { root })).rejects.toMatchObject({ status: 400 });
  });

  test("task actions: start detached; done/cancel awaited in the repo; merge failure surfaces as 422", async () => {
    const root = repo(true);
    const runner = ruahRunner(root);
    const launch = fakeLauncher();
    const r = new RuahIntegration({ runner, home: tempDir(), bin: () => "/fake/ruah", launch });
    expect(await r.taskAction("api-fix", "start", { root })).toMatchObject({ name: "api-fix", action: "start", started: true });
    expect(launch.launched[0]?.args).toEqual(["task", "start", "api-fix"]);
    expect(await r.taskAction("api-fix", "done", { root })).toMatchObject({ ok: true, output: "done", task: { status: "created" } });
    const done = runner.calls.find((c) => c.args[1] === "done");
    expect(done).toMatchObject({ args: ["task", "done", "api-fix"], cwd: root, timeoutMs: 120_000 });
    await expect(r.taskAction("api-fix", "merge", { root })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/governance gate failed/) });
    expect(runner.calls.some((c) => c.args.includes("--skip-gates"))).toBe(false);
    await expect(r.taskAction("Bad Name", "done", { root })).rejects.toMatchObject({ status: 400 });
  });
});

describe("IntegrationsService ruah endpoints", () => {
  test("create task from an element: globs from the node, executor default, optional detached start", async () => {
    const root = repo(true);
    const runner = ruahRunner(root);
    const launch = fakeLauncher();
    const ruah = new RuahIntegration({ runner, home: tempDir(), bin: () => "/fake/ruah", launch });
    const svc = new IntegrationsService({
      home: tempDir(), project: () => ({ root, architecture: arch }), runner, secrets: new MemorySecretStore(),
      registry: new IntegrationRegistry(), ruah,
    });
    const result = await svc.ruahTask({ name: "api-fix", prompt: "Fix the currency enum", nodeId: "api", start: true });
    expect(runner.calls.find((c) => c.args[1] === "create")?.args).toEqual([
      "task", "create", "api-fix", "--files", "services/invoices-api/**,package.json", "--executor", "claude-code", "--prompt", "Fix the currency enum",
    ]);
    expect(result).toMatchObject({ name: "api-fix", executor: "claude-code", started: true, output: "✓ Task api-fix created", task: { status: "created" } });
    expect(launch.launched.map((l) => l.args)).toEqual([["task", "start", "api-fix"]]);

    await expect(svc.ruahTask({ name: "x", prompt: "p", nodeId: "ghost" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.ruahTask({ name: "x", prompt: "p", nodeId: "ext" })).rejects.toThrow(/no files to lock/);
    await svc.ruahTask({ name: "y", prompt: "p", files: ["docs/**"], executor: "codex" });
    expect(runner.calls.filter((c) => c.args[1] === "create").at(-1)?.args).toContain("codex");
    expect(launch.launched).toHaveLength(1);
  });
});
