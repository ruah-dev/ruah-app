// test/git-branches.test.ts — CONTRACTS §24: listing and switching the open
// project's branches on real temp git repos (two branches with different
// architecture.json, one without, dirty trees git carries or refuses, detached
// HEAD, invalid names, a clone with remote-only branches, a linked worktree),
// the pure architecture diff, and the HTTP endpoints' status codes.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import type { ProjectInfo, ServerMessage } from "../src/contracts/ws.js";
import { branchNameProblem, diffArchitectures, GitBranchError, listBranches, parseBranchStatus, parseTrack, switchBranch } from "../src/git/branches.js";
import { switchProjectBranch, SYSTEM_MESSAGE, type GitSwitchHost } from "../src/git/project-switch.js";
import { clearGitCache } from "../src/resume/git.js";
import { createArchitectureStore, type ArchitectureStore } from "../src/serve/architecture-store.js";
import { handleGitRequest } from "../src/serve/git-http.js";
import { createProductStore, type ProductStore } from "../src/serve/product-store.js";

// The daemon's own git calls inherit process.env: keep the user's global config (hooks,
// signing, default branch) out of them for the whole file.
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  clearGitCache();
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ruah Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Ruah Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Ruah Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function arch(name: string, nodes: Architecture["nodes"], edges: Architecture["edges"] = [], workflows: Architecture["workflows"] = []): Architecture {
  return { version: 1, name, nodes, edges, workflows };
}

const MAIN_ARCH = arch(
  "shop",
  [
    { id: "api", name: "API", type: "service", x: 10, y: 20 },
    { id: "db", name: "Database", type: "datastore" },
    { id: "legacy", name: "Legacy cron", type: "module" },
  ],
  [{ from: "api", to: "db", label: "reads" }],
);

const FEATURE_ARCH = arch(
  "shop",
  [
    { id: "api", name: "API", type: "service", x: 400, y: 900 }, // moved only: not a change
    { id: "db", name: "Database", type: "datastore", tech: ["postgres"] },
    { id: "queue", name: "Queue", type: "queue" },
    { id: "worker", name: "Worker", type: "service" },
  ],
  [
    { from: "api", to: "db", label: "reads" },
    { from: "api", to: "queue" },
  ],
  [{ id: "checkout", name: "Checkout", steps: ["api", "queue", "worker"] }],
);

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/**
 * main: architecture.json (MAIN_ARCH), shared.ts, conflict.ts = "main"
 * feature-x: FEATURE_ARCH, conflict.ts = "feature", product.json
 * bare: no architecture.json, a package.json and src/index.ts to scan
 */
function makeRepo(): string {
  const root = tempDir("ruah-git-branches-");
  git(root, "init", "-q", "-b", "main");
  write(root, "architecture.json", `${JSON.stringify(MAIN_ARCH, null, 2)}\n`);
  write(root, "shared.ts", "export const shared = 1;\n");
  write(root, "conflict.ts", "export const who = 'main';\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "main: shop");
  git(root, "switch", "-q", "-c", "feature-x");
  write(root, "architecture.json", `${JSON.stringify(FEATURE_ARCH, null, 2)}\n`);
  write(root, "conflict.ts", "export const who = 'feature';\n");
  write(root, "product.json", `${JSON.stringify({ version: 1, personas: [], screens: [], journeys: [] })}\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "feature: queue and worker");
  git(root, "switch", "-q", "main");
  git(root, "switch", "-q", "-c", "bare");
  git(root, "rm", "-q", "architecture.json");
  write(root, "package.json", JSON.stringify({ name: "bare-shop", version: "1.0.0" }));
  write(root, "src/index.ts", "export const main = () => 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "bare: no map");
  git(root, "switch", "-q", "main");
  return root;
}

interface FakeHost extends GitSwitchHost {
  messages: ServerMessage[];
  turn: { turnId: string; text: string } | undefined;
  info: ProjectInfo | null;
}

function hostFor(root: string, kind: ProjectInfo["kind"] = "repo"): FakeHost & { store: ArchitectureStore; product: ProductStore } {
  const store = createArchitectureStore(path.join(root, "architecture.json"), { watch: false });
  const product = createProductStore(path.join(root, "product.json"), { watch: false });
  cleanups.push(() => {
    store.close();
    product.close();
  });
  const host = {
    messages: [] as ServerMessage[],
    turn: undefined as { turnId: string; text: string } | undefined,
    info: { id: "p1", name: "shop", root, kind, lastOpenedAt: new Date(0).toISOString() } as ProjectInfo | null,
    store,
    product,
    project() {
      return host.info;
    },
    runningTurn() {
      return host.turn;
    },
    broadcast(message: ServerMessage) {
      host.messages.push(message);
    },
    version() {
      return "test";
    },
  };
  return host;
}

async function openHost(root: string) {
  const host = hostFor(root);
  await host.store.load();
  await host.product.load();
  return host;
}

async function refusal(p: Promise<unknown>): Promise<GitBranchError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GitBranchError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("listBranches", () => {
  it("lists local branches (current marked, last commit), counts changes and sees detached HEAD", async () => {
    const root = makeRepo();
    write(root, "shared.ts", "export const shared = 2;\n");
    write(root, "new.txt", "x\n");
    git(root, "add", "shared.ts");
    write(root, "conflict.ts", "export const who = 'edited';\n");
    const list = await listBranches(root);
    expect(list.current).toBe("main");
    expect(list.detached).toBe(false);
    expect(list.head).toMatch(/^[0-9a-f]{7}$/);
    expect(list.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 1 });
    expect(list.local.map((b) => b.name).sort()).toEqual(["bare", "feature-x", "main"]);
    const main = list.local.find((b) => b.name === "main");
    expect(main).toMatchObject({ current: true, lastCommit: { subject: "main: shop" } });
    expect(main?.lastCommit.date).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(list.local.find((b) => b.name === "feature-x")).toMatchObject({ current: false, lastCommit: { subject: "feature: queue and worker" } });
    expect(list.remote).toEqual([]);

    git(root, "reset", "-q", "--hard");
    git(root, "clean", "-q", "-f");
    git(root, "checkout", "-q", "--detach", "feature-x");
    const detached = await listBranches(root);
    expect(detached).toMatchObject({ current: null, detached: true });
    expect(detached.local.every((b) => !b.current)).toBe(true);
  });

  it("answers 400 outside a git repository", async () => {
    const dir = tempDir("ruah-not-git-");
    const err = await refusal(listBranches(dir));
    expect(err.status).toBe(400);
    expect(err.message).toBe("not a git repository");
  });

  it("parses status and tracking info", () => {
    const out = ["# branch.oid 0123456789abcdef", "# branch.head main", "1 M. N... 100644 100644 100644 a b x.ts", "1 .M N... 100644 100644 100644 a b y.ts", "2 R. N... 100644 100644 100644 a b R100 new.ts", "old.ts", "? u.txt", ""].join("\0");
    expect(parseBranchStatus(out)).toEqual({ current: "main", head: "0123456", dirty: { staged: 2, unstaged: 1, untracked: 1 } });
    expect(parseTrack("ahead 2, behind 1")).toEqual({ ahead: 2, behind: 1 });
    expect(parseTrack("gone")).toEqual({ gone: true });
    expect(parseTrack("")).toEqual({});
  });
});

describe("switchProjectBranch", () => {
  it("switches to a branch with its own map: the store reloads, the diff and git.changed come back", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    expect(host.product.current()).toBeNull();
    const result = await switchProjectBranch(host, "feature-x");
    expect(result).toMatchObject({ ok: true, branch: "feature-x", previous: "main", created: false, carried: 0, architecture: "tracked" });
    expect(result.diff.added.map((e) => e.id).sort()).toEqual(["queue", "worker"]);
    expect(result.diff.removed).toEqual([{ id: "legacy", name: "Legacy cron", type: "module" }]);
    expect(result.diff.changed).toEqual([{ id: "db", name: "Database", fields: ["tech"] }]);
    expect(result.diff.edges).toEqual({ added: [{ from: "api", to: "queue" }], removed: [] });
    expect(result.diff.workflows).toEqual({ added: [{ id: "checkout", name: "Checkout" }], removed: [] });
    expect(host.store.current()?.nodes.map((n) => n.id).sort()).toEqual(["api", "db", "queue", "worker"]);
    expect(host.product.current()).not.toBeNull();
    expect(host.messages).toContainEqual({ type: "git.changed", projectId: "p1", branch: "feature-x" });
    expect(git(root, "branch", "--show-current").trim()).toBe("feature-x");

    // Back to main: product.json is gone on main, so the product store goes back to null.
    const back = await switchProjectBranch(host, "main");
    expect(back.diff.removed.map((e) => e.id).sort()).toEqual(["queue", "worker"]);
    expect(host.product.current()).toBeNull();
  });

  it("scans a branch without architecture.json like a first open, and the generated map does not block the way back", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    const result = await switchProjectBranch(host, "bare");
    expect(result.architecture).toBe("generated");
    expect(fs.existsSync(path.join(root, "architecture.json"))).toBe(true);
    expect(host.store.current()?.name).toBeTruthy();
    expect(result.diff.removed.map((e) => e.id)).toEqual(expect.arrayContaining(["api", "db", "legacy"]));
    // The pristine generated file is untracked; main tracks one: it is removed before the switch.
    const back = await switchProjectBranch(host, "main");
    expect(back.architecture).toBe("tracked");
    expect(host.store.current()?.nodes.map((n) => n.id).sort()).toEqual(["api", "db", "legacy"]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("rescans an untracked map carried to a branch that has none", async () => {
    const root = makeRepo();
    git(root, "switch", "-q", "bare");
    write(root, "architecture.json", `${JSON.stringify(MAIN_ARCH, null, 2)}\n`); // hand-made, untracked
    git(root, "switch", "-q", "-c", "bare-2");
    git(root, "switch", "-q", "bare");
    const host = await openHost(root);
    const result = await switchProjectBranch(host, "bare-2");
    expect(result.architecture).toBe("rescanned");
    expect(host.store.current()).not.toBeNull();
  });

  it("carries uncommitted changes git can carry, and counts them", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    write(root, "shared.ts", "export const shared = 42;\n");
    const result = await switchProjectBranch(host, "feature-x");
    expect(result.carried).toBe(1);
    expect(fs.readFileSync(path.join(root, "shared.ts"), "utf8")).toContain("42");
  });

  it("refuses (409) when git would overwrite local changes, without stashing anything", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    write(root, "conflict.ts", "export const who = 'mine';\n");
    const err = await refusal(switchProjectBranch(host, "feature-x"));
    expect(err.status).toBe(409);
    expect(err.code).toBe("local-changes");
    expect(err.message).toMatch(/^Commit or stash your changes first: conflict\.ts/);
    expect(git(root, "branch", "--show-current").trim()).toBe("main");
    expect(fs.readFileSync(path.join(root, "conflict.ts"), "utf8")).toContain("mine");
    expect(git(root, "stash", "list")).toBe("");
    expect(host.messages.some((m) => m.type === "git.changed")).toBe(false);
  });

  it("refuses while an agent turn runs in the project, and during a merge", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    host.turn = { turnId: "t1", text: "refactor" };
    const turn = await refusal(switchProjectBranch(host, "feature-x"));
    expect(turn).toMatchObject({ status: 409, code: "turn-running" });
    host.turn = undefined;

    const gitDir = git(root, "rev-parse", "--git-dir").trim();
    fs.writeFileSync(path.resolve(root, gitDir, "MERGE_HEAD"), `${git(root, "rev-parse", "feature-x").trim()}\n`);
    const merge = await refusal(switchProjectBranch(host, "feature-x"));
    expect(merge).toMatchObject({ status: 409, code: "in-progress" });
    expect(merge.message).toMatch(/merge/);
  });

  it("switches out of a detached HEAD", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "--detach", "feature-x");
    const host = await openHost(root);
    const result = await switchProjectBranch(host, "main");
    expect(result).toMatchObject({ branch: "main", previous: null });
  });

  it("creates a branch from the current one or from another, and validates names", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    const made = await switchProjectBranch(host, "topic/new-idea", { create: true });
    expect(made).toMatchObject({ branch: "topic/new-idea", created: true, previous: "main", architecture: "tracked" });
    expect(made.diff).toMatchObject({ added: [], removed: [], changed: [] });
    const fromFeature = await switchProjectBranch(host, "from-feature", { create: true, from: "feature-x" });
    expect(fromFeature.diff.added.map((e) => e.id).sort()).toEqual(["queue", "worker"]);

    for (const bad of ["-rf", "a..b", "@{-1}", "has space", "ends.lock", "HEAD", "x/"]) {
      const err = await refusal(switchProjectBranch(host, bad, { create: true }));
      expect(err.status, bad).toBe(400);
    }
    expect(branchNameProblem("feature/ok-1")).toBeUndefined();
    expect((await refusal(switchProjectBranch(host, "main", { create: true }))).status).toBe(409);
    expect((await refusal(switchProjectBranch(host, "nope", { create: true, from: "no-such-ref" }))).status).toBe(404);
    expect((await refusal(switchProjectBranch(host, "no-such-branch"))).status).toBe(404);
    expect((await refusal(switchProjectBranch(host, "--force"))).status).toBe(400);
  });

  it("tracks a remote-only branch of a clone (by its name or origin/<name>)", async () => {
    const upstream = makeRepo();
    const parent = tempDir("ruah-git-clone-");
    git(parent, "clone", "-q", upstream, "clone");
    const root = path.join(parent, "clone");
    const list = await listBranches(root);
    expect(list.local.map((b) => b.name)).toEqual(["main"]);
    expect(list.local[0]).toMatchObject({ upstream: "origin/main" });
    const remote = list.remote.find((r) => r.name === "origin/feature-x");
    expect(remote).toMatchObject({ remote: "origin", branch: "feature-x", hasLocal: false, lastCommit: { subject: "feature: queue and worker" } });
    expect(list.remote.some((r) => r.name.endsWith("/HEAD"))).toBe(false);

    const host = await openHost(root);
    const result = await switchProjectBranch(host, "feature-x");
    expect(result).toMatchObject({ branch: "feature-x", created: true });
    expect(git(root, "rev-parse", "--abbrev-ref", "feature-x@{upstream}").trim()).toBe("origin/feature-x");
    const viaRemote = await switchProjectBranch(host, "origin/bare");
    expect(viaRemote).toMatchObject({ branch: "bare", created: true, architecture: "generated" });
  });

  it("works in a linked worktree and refuses a branch checked out elsewhere", async () => {
    const root = makeRepo();
    const parent = tempDir("ruah-git-wt-");
    const wt = path.join(parent, "wt");
    git(root, "worktree", "add", "-q", wt, "feature-x");
    const list = await listBranches(wt);
    expect(list.current).toBe("feature-x");
    expect(list.local.find((b) => b.name === "main")?.worktree).toBeTruthy();
    const err = await refusal(switchBranch(wt, "main"));
    expect(err).toMatchObject({ status: 409, code: "worktree" });
    const host = await openHost(wt);
    expect((await switchProjectBranch(host, "bare")).branch).toBe("bare");
  });

  it("answers 409 without a project and 400 for a system", async () => {
    const root = makeRepo();
    const host = hostFor(root, "system");
    expect(await refusal(switchProjectBranch(host, "feature-x"))).toMatchObject({ status: 400, message: SYSTEM_MESSAGE });
    host.info = null;
    expect((await refusal(switchProjectBranch(host, "feature-x"))).status).toBe(409);
  });
});

describe("diffArchitectures", () => {
  it("compares elements by id ignoring layout, edges by (from, to, label), workflows by id", () => {
    const diff = diffArchitectures(MAIN_ARCH, FEATURE_ARCH);
    expect(diff.changed).toEqual([{ id: "db", name: "Database", fields: ["tech"] }]);
    expect(diff.added.map((a) => a.id)).toEqual(["queue", "worker"]);
    expect(diff.removed.map((a) => a.id)).toEqual(["legacy"]);
    expect(diffArchitectures(MAIN_ARCH, MAIN_ARCH)).toEqual({ added: [], removed: [], changed: [], edges: { added: [], removed: [] }, workflows: { added: [], removed: [] } });
    const relabelled = arch("shop", MAIN_ARCH.nodes, [{ from: "api", to: "db", label: "writes" }]);
    expect(diffArchitectures(MAIN_ARCH, relabelled).edges).toEqual({ added: [{ from: "api", to: "db", label: "writes" }], removed: [{ from: "api", to: "db", label: "reads" }] });
    expect(diffArchitectures(null, MAIN_ARCH).added).toHaveLength(3);
    expect(diffArchitectures(FEATURE_ARCH, null).workflows.removed).toEqual([{ id: "checkout", name: "Checkout" }]);
    // Key order and absent-vs-undefined are not changes.
    const reordered = arch("shop", [{ type: "datastore", name: "Database", id: "db", description: undefined }], []);
    expect(diffArchitectures(arch("shop", [{ id: "db", name: "Database", type: "datastore" }]), reordered).changed).toEqual([]);
  });
});

describe("HTTP /api/git/*", () => {
  async function serve(host: GitSwitchHost) {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const originOk = (origin: string | undefined) => origin === undefined || origin.startsWith("http://localhost");
      if (!handleGitRequest(req, res, url, host, originOk)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  }

  it("answers the documented status codes", async () => {
    const root = makeRepo();
    const host = await openHost(root);
    const call = await serve(host);

    const list = await call("GET", "/api/git/branches");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ projectId: "p1", current: "main", detached: false });
    expect(await call("POST", "/api/git/branches")).toMatchObject({ status: 405 });
    expect(await call("GET", "/api/git/branches", undefined, { origin: "https://evil.example" })).toMatchObject({ status: 403 });
    expect(await call("GET", "/api/git/branches", undefined, { "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403 });
    expect(await call("POST", "/api/git/switch", { name: "feature-x" }, { origin: "https://evil.example" })).toMatchObject({ status: 403 });

    expect(await call("POST", "/api/git/switch", {})).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/git/switch", { name: "a..b", create: true })).toMatchObject({ status: 400, body: { code: "bad-name" } });
    expect(await call("POST", "/api/git/switch", { name: "missing" })).toMatchObject({ status: 404 });

    write(root, "conflict.ts", "export const who = 'mine';\n");
    const dirty = await call("POST", "/api/git/switch", { name: "feature-x" });
    expect(dirty).toMatchObject({ status: 409, body: { code: "local-changes" } });
    expect(String(dirty.body.error)).toMatch(/Commit or stash your changes first/);
    git(root, "checkout", "--", "conflict.ts");

    (host as FakeHost).turn = { turnId: "t", text: "x" };
    expect(await call("POST", "/api/git/switch", { name: "feature-x" })).toMatchObject({ status: 409, body: { code: "turn-running" } });
    (host as FakeHost).turn = undefined;

    const ok = await call("POST", "/api/git/switch", { name: "feature-x" }, { origin: "http://localhost:5173" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, branch: "feature-x", previous: "main", carried: 0 });

    (host as FakeHost).info = null;
    expect(await call("GET", "/api/git/branches")).toMatchObject({ status: 409 });
  });

  it("answers 400 for a folder that is not a git repository", async () => {
    const dir = tempDir("ruah-git-none-");
    fs.writeFileSync(path.join(dir, "architecture.json"), JSON.stringify(MAIN_ARCH));
    const host = await openHost(dir);
    const call = await serve(host);
    expect(await call("GET", "/api/git/branches")).toMatchObject({ status: 400, body: { error: "not a git repository" } });
    expect(await call("POST", "/api/git/switch", { name: "main" })).toMatchObject({ status: 400 });
  });
});
