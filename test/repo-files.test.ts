// CONTRACTS §20.3: Ruah writes into a user's repo only committable files, only
// on an explicit action, and keeps a .ruah/.gitignore for caches. Regression:
// .ruah/verify.json and .ruah/.cache/ appeared in a client repo after an agent
// turn (verify ran on its own and wrote both). Also §20.4: verify badges never
// carry over from the previous project.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import type { Runner } from "../src/integrations/exec.js";
import { EnginesService } from "../src/engines/index.js";
import { resetEngineProbe } from "../src/engines/cli.js";
import { migrateLegacyVerifyCache } from "../src/engines/verify.js";
import { ensureRuahGitignore, projectCacheDir } from "../src/projects/repo-files.js";
import { writePreviewChoice } from "../src/preview/config.js";
import { updateScopeFile } from "../src/integrations/scope/file.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  resetEngineProbe();
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const arch: Architecture = {
  version: 1,
  name: "client",
  nodes: [{ id: "api", type: "service", name: "api", path: "api" }],
  edges: [],
  workflows: [],
};

/** A fake `ruah verify` on PATH via a workspace build, answering with a passing report. */
function verifyWorkspace(): { workspaceRoot: string; runner: Runner; calls: string[][] } {
  const workspaceRoot = tmp("ruah-ws-");
  mkdirSync(path.join(workspaceRoot, "ruah-verify", "dist"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "ruah-verify", "dist", "cli.js"), "");
  const calls: string[][] = [];
  const runner: Runner = async (_file, args) => {
    calls.push([...args]);
    return { code: 0, stdout: JSON.stringify({ verdict: "pass", summary: { pass: true, failed: 0, unverifiable: 0 } }), stderr: "" };
  };
  return { workspaceRoot, runner, calls };
}

function engines(options: { root: () => string | null; home: string; runner?: Runner; workspaceRoot?: string }): EnginesService {
  return new EnginesService({
    root: options.root,
    architecture: () => arch,
    home: () => options.home,
    cli: {
      env: { PATH: "/nonexistent" },
      ...(options.runner !== undefined ? { runner: options.runner } : {}),
      ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    },
  });
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

describe("nothing lands in a repo that never opted in (§20.3)", () => {
  it("an agent turn on an element writes nothing into the repo, installed engine or not", async () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    const ws = verifyWorkspace();
    const withEngine = engines({ root: () => repo, home, runner: ws.runner, workspaceRoot: ws.workspaceRoot });
    withEngine.afterTurn("api");
    const without = engines({ root: () => repo, home });
    without.afterTurn("api");
    await settle();
    expect(existsSync(path.join(repo, ".ruah"))).toBe(false);
    expect(ws.calls).toEqual([]);
  });

  it("an explicit Verify without criteria answers 'unverifiable' and still writes nothing into the repo", async () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    const service = engines({ root: () => repo, home });
    const state = await service.runVerify("api");
    expect(state).toMatchObject({ badge: "unverifiable", detail: expect.stringContaining("Sync criteria") });
    expect(existsSync(path.join(repo, ".ruah"))).toBe(false);
    // The badge is cached in Ruah's home.
    expect(JSON.parse(readFileSync(path.join(projectCacheDir(home, repo), "verify-nodes.json"), "utf8"))).toMatchObject({ api: { badge: "unverifiable" } });
    expect(service.verifyStateOf()).toMatchObject({ root: repo, nodes: { api: { badge: "unverifiable" } } });
  });

  it("Sync criteria writes the committable .ruah/verify.json and a .gitignore for caches; runs keep caches in home", async () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    const ws = verifyWorkspace();
    const service = engines({ root: () => repo, home, runner: ws.runner, workspaceRoot: ws.workspaceRoot });
    const synced = service.syncVerify([{ name: "wf", tasks: [{ name: "fix", files: ["api/**"], acceptanceCriteria: ["`pnpm test` passes"] }] }]);
    expect(synced.path).toBe(path.join(repo, ".ruah", "verify.json"));
    expect(readFileSync(path.join(repo, ".ruah", ".gitignore"), "utf8")).toMatch(/^\.cache\/$/m);
    service.afterTurn("api");
    await settle();
    expect(ws.calls).toHaveLength(1);
    expect(ws.calls[0]?.join(" ")).toContain(projectCacheDir(home, repo));
    expect(readdirSync(path.join(repo, ".ruah")).sort()).toEqual([".gitignore", "verify.json"]);
    expect(service.verifyState()).toMatchObject({ api: { badge: "pass" } });
  });

  it("the placeholder older versions wrote on their own does not trigger runs after turns", async () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    mkdirSync(path.join(repo, ".ruah"));
    writeFileSync(
      path.join(repo, ".ruah", "verify.json"),
      JSON.stringify({ schemaVersion: "1", criteria: [{ id: "workspace/human-review", description: "No acceptance criteria linked to map nodes yet", check: { type: "unverifiable" } }] }),
    );
    const ws = verifyWorkspace();
    engines({ root: () => repo, home, runner: ws.runner, workspaceRoot: ws.workspaceRoot }).afterTurn("api");
    await settle();
    expect(ws.calls).toEqual([]);
  });

  it("eval runs keep their spec and results in home, and a missing engine writes nothing", async () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    const result = await engines({ root: () => repo, home }).runEval("api", "hello");
    expect(result).toMatchObject({ ok: false });
    expect(existsSync(path.join(repo, ".ruah"))).toBe(false);
    expect(existsSync(path.join(projectCacheDir(home, repo), "evals"))).toBe(false);
  });
});

describe("migrating the old repo cache (§20.3)", () => {
  it("moves Ruah's badges to home, deletes only its own files, and ignores caches from then on", () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    const cache = path.join(repo, ".ruah", ".cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, "verify-nodes.json"), JSON.stringify({ api: { nodeId: "api", badge: "fail" }, web: { nodeId: "web", badge: "pass" } }));
    writeFileSync(path.join(cache, "verify-api.json"), JSON.stringify({ schemaVersion: "1", criteria: [{ id: "node/api/fix/0" }] }));
    writeFileSync(path.join(cache, "verify-report.json"), JSON.stringify({ verdict: "pass" })); // not Ruah's: kept
    const stateDir = projectCacheDir(home, repo);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "verify-nodes.json"), JSON.stringify({ web: { nodeId: "web", badge: "unverifiable" } }));

    const moved = migrateLegacyVerifyCache(repo, stateDir);
    expect(Object.keys(moved).sort()).toEqual(["api", "web"]);
    // Home already knew "web": its newer entry wins.
    expect(JSON.parse(readFileSync(path.join(stateDir, "verify-nodes.json"), "utf8"))).toMatchObject({ api: { badge: "fail" }, web: { badge: "unverifiable" } });
    expect(readdirSync(cache)).toEqual(["verify-report.json"]);
    expect(readFileSync(path.join(repo, ".ruah", ".gitignore"), "utf8")).toContain(".cache/");

    // Only Ruah's files left: the folder goes too.
    rmSync(path.join(cache, "verify-report.json"));
    writeFileSync(path.join(cache, "verify-nodes.json"), "{}");
    migrateLegacyVerifyCache(repo, stateDir);
    expect(existsSync(cache)).toBe(false);
    // Idempotent and quiet without an old cache.
    expect(migrateLegacyVerifyCache(repo, stateDir)).toEqual({});
  });

  it("the daemon's first read migrates, and badges show from home afterwards", () => {
    const repo = tmp("ruah-client-repo-");
    const home = tmp("ruah-home-");
    mkdirSync(path.join(repo, ".ruah", ".cache"), { recursive: true });
    writeFileSync(path.join(repo, ".ruah", ".cache", "verify-nodes.json"), JSON.stringify({ api: { nodeId: "api", badge: "pass" } }));
    const service = engines({ root: () => repo, home });
    expect(service.verifyState()).toMatchObject({ api: { badge: "pass" } });
    expect(existsSync(path.join(repo, ".ruah", ".cache"))).toBe(false);
    expect(service.verifyState()).toMatchObject({ api: { badge: "pass" } });
  });
});

describe(".ruah/.gitignore (§20.3)", () => {
  it("is created, or completed with one line, and never duplicated", () => {
    const repo = tmp("ruah-client-repo-");
    expect(ensureRuahGitignore(repo)).toBe(false); // no .ruah/: nothing to do
    mkdirSync(path.join(repo, ".ruah"));
    expect(ensureRuahGitignore(repo)).toBe(true);
    expect(ensureRuahGitignore(repo)).toBe(false);
    writeFileSync(path.join(repo, ".ruah", ".gitignore"), "state.json");
    expect(ensureRuahGitignore(repo)).toBe(true);
    expect(readFileSync(path.join(repo, ".ruah", ".gitignore"), "utf8")).toBe("state.json\n.cache/\n");
    writeFileSync(path.join(repo, ".ruah", ".gitignore"), "/.cache/**\n");
    expect(ensureRuahGitignore(repo)).toBe(false);
  });

  it("comes with every committable file Ruah writes on request (preview, cloud scope)", () => {
    const a = tmp("ruah-client-repo-");
    writePreviewChoice(a, { command: "pnpm dev" });
    expect(readFileSync(path.join(a, ".ruah", ".gitignore"), "utf8")).toContain(".cache/");
    const b = tmp("ruah-client-repo-");
    updateScopeFile(b, (c) => ({ ...c, name: "prod" }));
    expect(readFileSync(path.join(b, ".ruah", ".gitignore"), "utf8")).toContain(".cache/");
  });
});

describe("verify badges follow the open project (§20.4)", () => {
  it("a badge from the previous project is never reported for the new one", async () => {
    const a = tmp("ruah-project-a-");
    const b = tmp("ruah-project-b-");
    const home = tmp("ruah-home-");
    let open: string = a;
    const service = engines({ root: () => open, home });
    await service.runVerify("api");
    expect(service.verifyStateOf()).toMatchObject({ root: a, nodes: { api: { badge: "unverifiable" } } });
    open = b;
    expect(service.verifyStateOf()).toEqual({ root: b, nodes: {} });
    open = a;
    expect(service.verifyState()).toMatchObject({ api: { badge: "unverifiable" } });
  });
});
