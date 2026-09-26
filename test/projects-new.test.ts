// test/projects-new.test.ts — CONTRACTS §20: stable pinned order (+ migration of
// registries written before it), tags, the template library, creating a project
// (files, scan, real git init + commit with an isolated git config, never
// overwriting, rollback, `gh repo create` only when asked), the wizard's checks,
// the HTTP endpoints (Origin checks included), the batched overview and the
// `ruah app new` CLI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsStore, normalizeTags } from "../src/projects/projects-store.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { ProjectService } from "../src/projects/service.js";
import { checkNewProject, commandLine, createProjectFolder, githubCreateArgs, githubRepoName, suggestParentDir } from "../src/projects/create.js";
import { TEMPLATES, findTemplate, renderTemplate, templateInfos, slugify } from "../src/projects/templates/index.js";
import { ProjectOverviewService } from "../src/projects/overview.js";
import { formatReport, runNew, shellPath } from "../src/projects/run-new.js";
import { validateArchitecture } from "../src/contracts/validate.js";
import { CreateResultSchema, NewProjectCheckSchema, NewProjectDefaultsSchema, ProjectsListSchema } from "../src/contracts/projects.js";
import { ProjectsOverviewSchema } from "../src/contracts/overview.js";
import type { ActivityEvent, ProjectInfo } from "../src/contracts/ws.js";
import type { Runner } from "../src/integrations/exec.js";
import { SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { MockBridge } from "../src/acp/mock-bridge.js";
import type { AcpBridge } from "../src/acp/bridge.js";
import { projectIdFor } from "../src/projects/fs-util.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let clock = Date.parse("2026-09-26T10:00:00Z");
const tick = (): Date => new Date((clock += 1000));

/** A git config of its own: an identity, no signing, no system config (the user's never applies). */
function gitEnv(dir: string): Record<string, string> {
  const file = path.join(dir, "gitconfig");
  writeFileSync(file, "[user]\n\tname = Ruah Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1" };
}

const git = (cwd: string, args: string[], env: Record<string, string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

// ---------------------------------------------------------------- pinned order + tags

describe("ProjectsStore §20: stable pinned order and tags", () => {
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
  const touchAll = (store: ProjectsStore) => ids.forEach((id, i) => store.touch({ id, name: `p${i}`, root: `/p${i}`, kind: "repo" }));

  it("keeps the pin order when pinned projects are opened; a new pin goes last; unpin drops the order", () => {
    const store = new ProjectsStore(tempDir("ruah-home-"), { now: tick });
    touchAll(store);
    store.pin(ids[0]!, true);
    store.pin(ids[2]!, true);
    store.pin(ids[1]!, true);
    const pinnedNames = () => store.list().filter((p) => p.pinned).map((p) => p.name);
    expect(pinnedNames()).toEqual(["p0", "p2", "p1"]);
    // Opening ⌘3 (p1) and then ⌘1 (p0) keeps every number.
    store.touch({ id: ids[1]!, name: "p1", root: "/p1", kind: "repo" });
    store.touch({ id: ids[0]!, name: "p0", root: "/p0", kind: "repo" });
    expect(pinnedNames()).toEqual(["p0", "p2", "p1"]);
    expect(store.list().filter((p) => p.pinned).map((p) => p.pinOrder)).toEqual([0, 1, 2]);
    expect(store.get(ids[2]!)?.pinnedAt).toMatch(/^2026-/);
    // Pinning a pinned project again changes nothing.
    store.pin(ids[0]!, true);
    expect(pinnedNames()).toEqual(["p0", "p2", "p1"]);
    // Unpin the middle one: the rest close ranks, the unpinned entry has no order fields.
    store.pin(ids[2]!, false);
    expect(pinnedNames()).toEqual(["p0", "p1"]);
    expect(store.get(ids[2]!)).not.toHaveProperty("pinOrder");
    expect(store.get(ids[2]!)).not.toHaveProperty("pinnedAt");
    store.pin(ids[3]!, true);
    expect(pinnedNames()).toEqual(["p0", "p1", "p3"]);
  });

  it("reorders pins (unknown / unpinned ids ignored, the rest keep their order)", () => {
    const store = new ProjectsStore(tempDir("ruah-home-"), { now: tick });
    touchAll(store);
    for (const id of ids.slice(0, 3)) store.pin(id, true);
    const sorted = store.reorder([ids[2]!, "nope", ids[3]!, ids[0]!]);
    expect(sorted.filter((p) => p.pinned).map((p) => p.name)).toEqual(["p2", "p0", "p1"]);
    expect(new ProjectsStore(store.home).list().filter((p) => p.pinned).map((p) => p.name)).toEqual(["p2", "p0", "p1"]);
    expect(store.get(ids[3]!)?.pinned).toBeUndefined();
  });

  it("migrates a registry written before §20: pins get the order they were listed in, saved on the next change", () => {
    const home = tempDir("ruah-home-");
    const old = (id: string, name: string, at: string, pinned?: boolean) => ({ id, name, root: `/${name}`, kind: "repo", lastOpenedAt: at, ...(pinned ? { pinned } : {}) });
    writeFileSync(
      path.join(home, "projects.json"),
      JSON.stringify({
        version: 1,
        projects: [
          old(ids[0]!, "x", "2026-09-20T10:00:00.000Z", true),
          old(ids[1]!, "y", "2026-09-25T10:00:00.000Z", true),
          old(ids[2]!, "z", "2026-09-26T09:00:00.000Z"),
        ],
      }),
    );
    const store = new ProjectsStore(home, { now: tick });
    // Most recently opened pin first, as the old daemon listed them.
    expect(store.list().map((p) => [p.name, p.pinOrder])).toEqual([["y", 0], ["x", 1], ["z", undefined]]);
    // Opening x (older pin) keeps it second: the order was fixed by the migration.
    store.touch({ id: ids[0]!, name: "x", root: "/x", kind: "repo" });
    const file = JSON.parse(readFileSync(path.join(home, "projects.json"), "utf8")) as { version: number; projects: ProjectInfo[] };
    expect(file.version).toBe(1);
    expect(file.projects.map((p) => [p.name, p.pinOrder])).toEqual([["y", 0], ["x", 1], ["z", undefined]]);
  });

  it("normalizes tags and lists them by use; touch keeps them", () => {
    expect(normalizeTags(["  Job ", "job", "Acme\u0007  Studio", "", "x".repeat(60), "a", "b", "c", "d"])).toEqual(["Job", "Acme Studio", "x".repeat(40), "a", "b", "c"]);
    const store = new ProjectsStore(tempDir("ruah-home-"), { now: tick });
    touchAll(store);
    expect(store.setTags(ids[0]!, ["Freelance", "Acme Studio"])?.tags).toEqual(["Freelance", "Acme Studio"]);
    store.setTags(ids[1]!, ["freelance"]);
    store.setTags(ids[3]!, ["Freelance"]);
    store.setTags(ids[2]!, ["Job"]);
    expect(store.tags()).toEqual(["Freelance", "Acme Studio", "Job"]);
    store.touch({ id: ids[0]!, name: "p0", root: "/p0", kind: "repo" });
    expect(store.get(ids[0]!)?.tags).toEqual(["Freelance", "Acme Studio"]);
    expect(store.setTags(ids[0]!, [])).not.toHaveProperty("tags");
    expect(store.setTags("nope", ["x"])).toBeUndefined();
    // A tie between spellings: the capitalized one names the group ("Job", not "job").
    store.setTags(ids[1]!, ["job"]);
    expect(store.tags()).toEqual(["Job", "Freelance"]);
  });
});

// ---------------------------------------------------------------- templates

describe("templates §20.2", () => {
  it("has the curated set, each renders plain relative files and scans into a valid map", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["empty", "web-vite-react", "node-api-ts", "static-site", "pnpm-monorepo", "infra-terraform"]);
    for (const info of templateInfos()) {
      expect(info.files.length, info.id).toBeGreaterThan(0);
      expect(info.setupPrompt.length).toBeGreaterThan(20);
    }
    for (const t of TEMPLATES) {
      for (const [rel, content] of renderTemplate(t, "My <App>")) {
        expect(rel, t.id).not.toMatch(/^\/|\.\.|\\/);
        expect(content.endsWith("\n"), `${t.id}/${rel}`).toBe(true);
        if (rel.endsWith(".json")) expect(() => JSON.parse(content), `${t.id}/${rel}`).not.toThrow();
        // The name is escaped in HTML and quoted in code: no raw "<App>" in markup or scripts.
        if (/\.(html|tsx?|js)$/.test(rel)) expect(content, `${t.id}/${rel}`).not.toContain("My <App>");
      }
    }
    expect(slugify("Payments API")).toBe("payments-api");
    expect(slugify("  ..Ünïcode//name  ")).toBe("unicode-name");
    expect(slugify("!!!")).toBe("app");
    expect(findTemplate("web-vite-react")?.run).toBe("pnpm install && pnpm dev");
  });
});

// ---------------------------------------------------------------- create

describe("createProjectFolder §20.1", () => {
  it("creates every template with a scanned map, git init and an initial commit", async () => {
    const work = tempDir("ruah-new-");
    const env = gitEnv(work);
    for (const t of TEMPLATES) {
      const name = `proj-${t.id}`;
      const report = await createProjectFolder({ parentDir: work, name, template: t.id, git: true }, { version: "0.0.0-test", env });
      const root = path.join(work, name);
      expect(report.path).toBe(root);
      expect(report.template).toBe(t.id);
      expect(report.warnings, t.id).toEqual([]);
      for (const [rel] of renderTemplate(t, name)) expect(existsSync(path.join(root, rel)), `${t.id}/${rel}`).toBe(true);
      const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8")) as unknown;
      const valid = validateArchitecture(arch, root);
      expect(valid.ok, t.id).toBe(true);
      if (t.scan) expect(report.scanned?.nodes, t.id).toBeGreaterThan(0);
      else expect(report.scanned).toBeNull();
      expect(report.git).toMatchObject({ init: true, branch: "main" });
      expect(report.git?.commit).toMatch(/^[0-9a-f]{7,}$/);
      // Everything, the map included, is in the first commit; the tree is clean.
      expect(git(root, ["log", "--oneline"], env)).toContain("Initial commit (Ruah:");
      expect(git(root, ["status", "--porcelain"], env)).toBe("");
      expect(git(root, ["ls-files"], env).split("\n")).toContain("architecture.json");
    }
    const infra = JSON.parse(readFileSync(path.join(work, "proj-infra-terraform", "architecture.json"), "utf8")) as { nodes: { type: string }[] };
    expect(infra.nodes.length).toBeGreaterThan(1);
  });

  it("never overwrites: an existing folder (even empty) is refused and left untouched", async () => {
    const work = tempDir("ruah-new-");
    mkdirSync(path.join(work, "taken"));
    writeFileSync(path.join(work, "taken", "keep.txt"), "mine");
    mkdirSync(path.join(work, "empty"));
    await expect(createProjectFolder({ parentDir: work, name: "taken", template: "static-site" }, { version: "t" })).rejects.toMatchObject({ status: 409 });
    await expect(createProjectFolder({ parentDir: work, name: "empty" }, { version: "t" })).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(path.join(work, "taken"))).toEqual(["keep.txt"]);
    expect(readdirSync(path.join(work, "empty"))).toEqual([]);
  });

  it("validates before touching the disk, rolls back when git init fails, creates the parent only on request", async () => {
    const work = tempDir("ruah-new-");
    await expect(createProjectFolder({ parentDir: work, name: ".hidden" }, { version: "t" })).rejects.toMatchObject({ status: 400 });
    await expect(createProjectFolder({ parentDir: work, name: "a:b" }, { version: "t" })).rejects.toMatchObject({ status: 400 });
    await expect(createProjectFolder({ parentDir: work, name: "x", template: "nope" }, { version: "t" })).rejects.toThrow(/unknown template/);
    await expect(createProjectFolder({ parentDir: work, name: "x", git: true }, { version: "t", resolveBin: () => undefined })).rejects.toThrow(/git is not installed/);
    await expect(createProjectFolder({ parentDir: work, name: "x", github: { visibility: "private" } }, { version: "t" })).rejects.toThrow(/needs git/);
    await expect(createProjectFolder({ parentDir: path.join(work, "a", "b"), name: "x" }, { version: "t" })).rejects.toMatchObject({ status: 404 });
    expect(readdirSync(work)).toEqual([]);

    const failing: Runner = async (_f, args) => ({ code: args[0] === "init" ? 128 : 1, stdout: "", stderr: "fatal: nope" });
    await expect(
      createProjectFolder({ parentDir: path.join(work, "new", "parent"), name: "x", git: true, createParent: true }, { version: "t", runner: failing, resolveBin: (n) => `/bin/${n}` }),
    ).rejects.toThrow(/git init failed: fatal: nope — nothing was created/);
    expect(readdirSync(work)).toEqual([]);

    const ok = await createProjectFolder({ parentDir: path.join(work, "new", "parent"), name: "x", createParent: true }, { version: "t" });
    expect(ok.path).toBe(path.join(work, "new", "parent", "x"));
    expect(ok.git).toBeNull();
  });

  it("a rollback removes only the parents it made that are still empty (never a neighbour's new project)", async () => {
    const work = tempDir("ruah-new-");
    const shared = path.join(work, "clients", "acme");
    // While this create runs, `ruah app new` makes "other" in the same new parent; then git init fails.
    const racing: Runner = async (_f, args) => {
      if (args[0] === "init") {
        mkdirSync(path.join(shared, "other"));
        writeFileSync(path.join(shared, "other", "README.md"), "theirs");
        return { code: 128, stdout: "", stderr: "fatal: nope" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    await expect(
      createProjectFolder({ parentDir: shared, name: "mine", git: true, createParent: true }, { version: "t", runner: racing, resolveBin: (n) => `/bin/${n}` }),
    ).rejects.toThrow(/nothing was created/);
    expect(readdirSync(shared)).toEqual(["other"]);
    expect(readFileSync(path.join(shared, "other", "README.md"), "utf8")).toBe("theirs");
  });

  it("takes a relative location from `cwd` (the daemon passes home), not from where the process started", async () => {
    const work = tempDir("ruah-new-");
    mkdirSync(path.join(work, "Projects"));
    const report = await createProjectFolder({ parentDir: "Projects", name: "rel" }, { version: "t", home: work, cwd: work });
    expect(report.path).toBe(path.join(work, "Projects", "rel"));
    expect(existsSync(path.join(process.cwd(), "Projects", "rel"))).toBe(false);
  });

  it("runs `gh repo create` only when asked, with the exact arguments; failures only warn", async () => {
    const work = tempDir("ruah-new-");
    const calls: { file: string; args: readonly string[]; cwd?: string }[] = [];
    const runner: Runner = async (file, args, options) => {
      calls.push({ file, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
      if (file.endsWith("/gh")) return { code: 0, stdout: "https://github.com/me/my-api\n", stderr: "" };
      return { code: 0, stdout: args[0] === "rev-parse" ? "1234567\n" : args[0] === "symbolic-ref" ? "main\n" : "", stderr: "" };
    };
    const deps = { version: "t", runner, resolveBin: (n: string) => `/usr/bin/${n}` };
    const plain = await createProjectFolder({ parentDir: work, name: "No GH", git: true }, deps);
    expect(plain.github).toBeNull();
    expect(calls.some((c) => c.file.endsWith("/gh"))).toBe(false);

    const withGh = await createProjectFolder({ parentDir: work, name: "My API", template: "node-api-ts", git: true, github: { visibility: "private" } }, deps);
    const gh = calls.filter((c) => c.file.endsWith("/gh"));
    expect(gh).toHaveLength(1);
    expect(gh[0]?.args).toEqual(["repo", "create", "my-api", "--private", "--source", ".", "--remote", "origin", "--push"]);
    expect(gh[0]?.cwd).toBe(path.join(work, "My API"));
    expect(withGh.github).toEqual({ command: ["gh", ...gh[0]!.args], ran: true, url: "https://github.com/me/my-api" });

    const refused: Runner = async (file, args) =>
      file.endsWith("/gh") ? { code: 1, stdout: "", stderr: "GraphQL: Name already exists on this account" } : { code: 0, stdout: args[0] === "rev-parse" ? "1234567\n" : "", stderr: "" };
    const warned = await createProjectFolder({ parentDir: work, name: "dup", git: true, github: { visibility: "public", name: "dup-repo" } }, { ...deps, runner: refused });
    expect(warned.github?.error).toMatch(/already exists/);
    expect(warned.github?.command).toContain("--public");
    expect(warned.warnings[0]).toMatch(/^GitHub repo not created/);
    expect(existsSync(path.join(work, "dup", "README.md"))).toBe(true);

    expect(githubCreateArgs("x", "private", false)).not.toContain("--push");
    expect(githubRepoName("Payments API")).toBe("payments-api");
    expect(() => githubRepoName("x", "bad name")).toThrow(/invalid GitHub repo name/);
    // A name gh would read as a flag is refused before anything runs.
    for (const flag of ["--public", "-h", "-", "--push"]) expect(() => githubRepoName("x", flag), flag).toThrow(/invalid GitHub repo name/);
    expect(githubRepoName("x", ".github")).toBe(".github");
    expect(githubRepoName("--Payments--")).toBe("payments");
    const before = calls.length;
    await expect(createProjectFolder({ parentDir: work, name: "inj", git: true, github: { visibility: "private", name: "--public" } }, deps)).rejects.toMatchObject({ status: 400 });
    expect(calls.length).toBe(before);
    expect(existsSync(path.join(work, "inj"))).toBe(false);

    // gh exits 0 but names no repository: never reported as created.
    const silent: Runner = async (file, args) => (file.endsWith("/gh") ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: args[0] === "rev-parse" ? "1234567\n" : "", stderr: "" });
    const unconfirmed = await createProjectFolder({ parentDir: work, name: "quiet", git: true, github: { visibility: "private" } }, { ...deps, runner: silent });
    expect(unconfirmed.github).toMatchObject({ ran: true });
    expect(unconfirmed.github?.url).toBeUndefined();
    expect(unconfirmed.warnings).toContainEqual(expect.stringMatching(/^GitHub repo not confirmed/));
    const lines = formatReport(unconfirmed, "quiet").join("\n");
    expect(lines).toMatch(/GitHub: not confirmed/);
    expect(lines).not.toMatch(/GitHub: created/);
    expect(commandLine("gh", ["repo", "create", "my app"])).toBe("gh repo create 'my app'");
  });

  it("adds the new repo to a system and warns (keeping the project) when the commit cannot be made", async () => {
    const work = tempDir("ruah-new-");
    const system = path.join(work, "platform");
    mkdirSync(system);
    writeFileSync(path.join(system, "ruah.system.json"), JSON.stringify({ version: 1, name: "platform", repos: [] }));
    const noIdentity: Runner = async (_f, args) =>
      args[0] === "commit" ? { code: 128, stdout: "", stderr: "Author identity unknown\n*** Please tell me who you are." } : { code: args[0] === "config" ? 1 : 0, stdout: "", stderr: "" };
    const report = await createProjectFolder({ parentDir: work, name: "billing", git: true, system }, { version: "t", runner: noIdentity, resolveBin: (n) => `/usr/bin/${n}` });
    expect(report.system).toEqual({ root: system, repoId: "billing" });
    expect(JSON.parse(readFileSync(path.join(system, "ruah.system.json"), "utf8")).repos).toEqual([{ id: "billing", path: "../billing" }]);
    expect(report.git?.commit).toBeNull();
    expect(report.git?.warning).toMatch(/user\.name \/ user\.email/);
    await expect(createProjectFolder({ parentDir: work, name: "y", system: work }, { version: "t" })).rejects.toThrow(/not a system folder/);
  });
});

describe("checkNewProject + suggestParentDir", () => {
  it("reports name, parent and target problems without side effects", () => {
    const work = tempDir("ruah-new-");
    const home = work;
    mkdirSync(path.join(work, "Projects"));
    mkdirSync(path.join(work, "Projects", "exists"));
    writeFileSync(path.join(work, "file"), "x");
    const ok = NewProjectCheckSchema.parse(checkNewProject({ parentDir: "~/Projects", name: "fresh" }, { home }));
    expect(ok).toMatchObject({ ok: true, path: path.join(work, "Projects", "fresh"), parent: { exists: true, isDir: true, writable: true }, target: { exists: false } });
    const exists = checkNewProject({ parentDir: "~/Projects", name: "exists" }, { home });
    expect(exists).toMatchObject({ ok: false, target: { exists: true, empty: true } });
    expect(exists.problems[0]).toMatch(/already exists \(an empty folder\)/);
    expect(checkNewProject({ parentDir: "~/nope", name: "x" }, { home })).toMatchObject({ ok: false, parent: { exists: false, writable: true } });
    expect(checkNewProject({ parentDir: "~/file", name: "x" }, { home }).problems[0]).toMatch(/is a file/);
    expect(checkNewProject({ parentDir: "~/Projects", name: "a/b" }, { home }).name).toEqual({ ok: false, error: "name must not contain path separators" });
    expect(checkNewProject({ parentDir: "", name: "" }, { home }).problems).toEqual(["Name: enter a name", "Choose a location"]);
    // A relative location: from `cwd` (the daemon passes home), and the resolved parent is reported.
    const rel = checkNewProject({ parentDir: "Projects", name: "fresh" }, { home, cwd: home });
    expect(rel).toMatchObject({ ok: true, path: path.join(work, "Projects", "fresh"), parent: { path: path.join(work, "Projects") } });
    expect(checkNewProject({ parentDir: "Projects", name: "fresh" }, { home }).path).toBe(path.join(process.cwd(), "Projects", "fresh"));
    expect(readdirSync(path.join(work, "Projects"))).toEqual(["exists"]);

    expect(suggestParentDir({ remembered: path.join(work, "gone"), home })).toEqual({ dir: path.join(work, "Projects"), source: "projects" });
    expect(suggestParentDir({ remembered: path.join(work, "Projects", "exists"), home })).toEqual({ dir: path.join(work, "Projects", "exists"), source: "remembered" });
    rmSync(path.join(work, "Projects"), { recursive: true });
    expect(suggestParentDir({ recentRoots: [path.join(work, "Projects", "x")], home })).toEqual({ dir: work, source: "home" });
    mkdirSync(path.join(work, "clients"));
    expect(suggestParentDir({ recentRoots: [path.join(work, "clients", "acme")], home })).toEqual({ dir: path.join(work, "clients"), source: "recent" });
  });
});

// ---------------------------------------------------------------- HTTP

async function serveDaemon(extra: Partial<ConstructorParameters<typeof ProjectService>[0]> = {}) {
  const home = tempDir("ruah-home-");
  const chats = new ChatStore(home);
  const agents = {
    choices: (currentAgentId: string) => ({ currentAgentId, available: [{ id: "mock", name: "Mock", installed: true }] }),
    check: () => ({ ok: true as const }),
    create: (_agentId: string, root?: string): AcpBridge => new MockBridge({ root: root ?? "/", preset: { command: "none", args: [] }, clientVersion: "0", chunkDelayMs: 1 }),
  };
  const hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", agents, chats });
  const store = new ProjectsStore(home);
  const changes: ProjectInfo[][] = [];
  let remembered: string | undefined;
  const overview = new ProjectOverviewService({ home, projects: store, chats, log: { read: () => [] }, current: () => hub.project(), git: false, cloud: false });
  const projects = new ProjectService({
    projects: store,
    chats,
    host: hub,
    version: "0.0.0-test",
    watch: false,
    newProjectParent: { get: () => remembered, set: (dir) => (remembered = dir) },
    onListChanged: (recent) => changes.push(recent),
    overview,
    create: { home },
    ...extra,
  });
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, projects });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  return { url: server.url, hub, home, changes, remembered: () => remembered };
}

/** A GET with headers fetch() may not send (Sec-Fetch-*): node:http as a browser would. */
const getStatus = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

const post = (url: string, body: unknown, origin?: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) }, body: JSON.stringify(body) });

describe("§20 HTTP", () => {
  it("wizard endpoints, create with a template, reorder + tags broadcast, overview; cross-site requests refused", async () => {
    const { url, changes, remembered, home } = await serveDaemon();
    const evil = "https://evil.example";
    for (const p of ["/api/projects/new", "/api/projects/new/github", "/api/projects/overview"]) {
      expect((await fetch(`${url}${p}`, { headers: { origin: evil } })).status, p).toBe(403);
    }
    for (const [p, body] of [["/api/projects/new/check", { parentDir: home, name: "x" }], ["/api/projects/reorder", { ids: [] }], ["/api/projects/tags", { id: "x", tags: [] }]] as const) {
      expect((await post(`${url}${p}`, body, evil)).status, p).toBe(403);
    }

    // A no-cors GET from another site (an <img src>) has no Origin, but says cross-site.
    for (const p of ["/api/projects/new", "/api/projects/new/github", "/api/projects/overview"]) {
      expect(await getStatus(`${url}${p}`, { "sec-fetch-site": "cross-site" }), p).toBe(403);
      expect(await getStatus(`${url}${p}`, { "sec-fetch-site": "same-site" }), p).toBe(403);
    }
    expect(await getStatus(`${url}/api/projects/new`, { "sec-fetch-site": "same-origin" })).toBe(200);

    const defaults = NewProjectDefaultsSchema.parse(await (await fetch(`${url}/api/projects/new`)).json());
    expect(defaults.home).toBe(home);
    expect(defaults.parentDir).toBe(home);
    expect(defaults.parentSource).toBe("home");
    expect(defaults.templates.map((t) => t.id)).toContain("infra-terraform");
    const work = path.join(home, "Projects");
    mkdirSync(work);
    const check = NewProjectCheckSchema.parse(await (await post(`${url}/api/projects/new/check`, { parentDir: "~/Projects", name: "site" })).json());
    expect(check).toMatchObject({ ok: true, path: path.join(work, "site") });
    // "Projects" (no ~/) means the one in home — never a folder under the daemon's cwd.
    const relative = NewProjectCheckSchema.parse(await (await post(`${url}/api/projects/new/check`, { parentDir: "Projects", name: "site" })).json());
    expect(relative).toMatchObject({ ok: true, path: path.join(work, "site"), parent: { path: work, exists: true } });

    const res = await post(`${url}/api/projects/create`, { parentDir: "~/Projects", name: "site", template: "static-site" });
    expect(res.status).toBe(200);
    const created = CreateResultSchema.parse(await res.json());
    expect(created).toMatchObject({ name: "site", root: path.join(work, "site"), created: { template: "static-site", git: null, github: null } });
    expect(created.created?.scanned?.nodes).toBeGreaterThan(0);
    expect(remembered()).toBe(work);
    expect(NewProjectDefaultsSchema.parse(await (await fetch(`${url}/api/projects/new`)).json())).toMatchObject({ parentDir: work, parentSource: "remembered" });
    const relCreate = CreateResultSchema.parse(await (await post(`${url}/api/projects/create`, { parentDir: "Projects", name: "rel" })).json());
    expect(relCreate.root).toBe(path.join(work, "rel"));
    expect((await post(`${url}/api/projects/create`, { parentDir: "~/Projects", name: "site" })).status).toBe(409);

    // A second and third project, pinned, reordered, tagged: every change is broadcast.
    const b = CreateResultSchema.parse(await (await post(`${url}/api/projects/create`, { parentDir: work, name: "b" })).json());
    const c = CreateResultSchema.parse(await (await post(`${url}/api/projects/create`, { parentDir: work, name: "c" })).json());
    for (const p of [created, b, c]) expect((await post(`${url}/api/projects/pin`, { id: p.id })).status).toBe(200);
    const reordered = ProjectsListSchema.parse(await (await post(`${url}/api/projects/reorder`, { ids: [c.id, created.id] })).json());
    expect(reordered.recent.map((p) => p.name)).toEqual(["c", "site", "b", "rel"]);
    const tagged = await post(`${url}/api/projects/tags`, { id: b.id, tags: ["Job", " job "] });
    expect(await tagged.json()).toMatchObject({ id: b.id, tags: ["Job"] });
    expect((await post(`${url}/api/projects/tags`, { id: "unknown", tags: [] })).status).toBe(404);
    expect(changes.length).toBeGreaterThanOrEqual(5);
    expect(changes.at(-1)?.find((p) => p.id === b.id)?.tags).toEqual(["Job"]);

    const overview = ProjectsOverviewSchema.parse(await (await fetch(`${url}/api/projects/overview`)).json());
    expect(overview.projects.map((p) => p.project.name).slice(0, 3)).toEqual(["c", "site", "b"]);
    expect(overview.projects.find((p) => p.project.name === "c")?.current).toBe(true);
    expect(overview.projects[2]?.project.tags).toEqual(["Job"]);
  });
});

// ---------------------------------------------------------------- overview

describe("ProjectOverviewService §20.5", () => {
  it("batches chats, activity since the last visit, live counts, permissions, preview and cloud health", async () => {
    const home = tempDir("ruah-home-");
    const work = tempDir("ruah-work-");
    const store = new ProjectsStore(home, { now: tick });
    const chats = new ChatStore(home, { now: tick });
    const roots = ["alpha", "beta"].map((n) => {
      const root = path.join(work, n);
      mkdirSync(root);
      return root;
    });
    const [a, b] = roots.map((root) => store.touch({ id: projectIdFor(root), name: path.basename(root), root, kind: "repo" }));
    // A missing folder is left out, as in GET /api/projects.
    store.touch({ id: "eeeeeeeeeeee", name: "gone", root: path.join(work, "gone"), kind: "repo" });
    const chat = chats.create(a!.id, { agentId: "mock", title: "Add tests" });
    chats.appendTurn(a!.id, chat.id, {
      turnId: "t1", text: "Add tests  for\nthe api", contextPack: "", startedAt: "2026-09-26T10:00:00.000Z", finishedAt: "2026-09-26T10:01:00.000Z", stopReason: "end_turn",
      events: [{ kind: "text", text: "Added 3 tests." }],
    }, { agentId: "mock" });
    chats.state.setLastViewed(a!.id, "2026-09-26T09:00:00.000Z");
    const event = (over: Partial<ActivityEvent>): ActivityEvent => ({
      id: `e${Math.random()}`, kind: "turn.finished", projectId: a!.id, projectName: "alpha", chatId: chat.id, summary: "Finished", at: "2026-09-26T10:01:00.000Z", background: true, ...over,
    });
    const events = [
      event({ at: "2026-09-26T08:00:00.000Z", stopReason: "end_turn" }), // before the last visit
      event({ stopReason: "error", summary: "Failed: boom" }),
      event({ kind: "permission.requested", summary: "Run pnpm migrate", at: "2026-09-26T10:02:00.000Z" }),
    ];
    let reads = 0;
    const overview = new ProjectOverviewService({
      home, projects: store, chats,
      log: { read: () => (reads++, events), recent: () => events.slice(-1) },
      current: () => b!,
      live: () => new Map([[a!.id, { running: 1, waitingPermission: 1 }]]),
      permissions: () => [{ projectId: a!.id, chatId: chat.id, turnId: "t2", requestId: "r1", title: "Run pnpm migrate", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] }],
      preview: (id) => (id === b!.id ? { state: "crashed", url: null, exitCode: 1 } : null),
      cloud: (root) => (root === a!.root ? { inScope: 3, healthy: 2, degraded: 0, down: 1, deploying: 0, unhealthy: ["worker"], syncedAt: null } : null),
      git: false,
    });
    const res = ProjectsOverviewSchema.parse(await overview.overview());
    expect(res.projects.map((p) => p.project.name)).toEqual(["beta", "alpha"]);
    const alpha = res.projects[1]!;
    expect(alpha).toMatchObject({
      current: false,
      lastChat: { title: "Add tests", lastPrompt: "Add tests for the api", lastReply: "Added 3 tests." },
      since: { turnsFinished: 0, turnsFailed: 1, permissionsRequested: 1 },
      lastEvent: { kind: "permission.requested" },
      live: { running: 1, waitingPermission: 1 },
      permissions: [{ requestId: "r1", title: "Run pnpm migrate" }],
      cloud: { down: 1, unhealthy: ["worker"] },
      preview: null,
    });
    expect(res.projects[0]).toMatchObject({ current: true, preview: { state: "crashed" }, lastChat: null, cloud: null });
    // Cached: a second call reads the log again only after something happened.
    await overview.overview();
    expect(reads).toBe(1);
    events.push(event({ id: "new", at: "2026-09-26T10:05:00.000Z" }));
    await overview.overview();
    expect(reads).toBe(2);
  });
});

// ---------------------------------------------------------------- CLI

describe("ruah app new", () => {
  const capture = async (fn: () => Promise<number>) => {
    const out: string[] = [];
    const err: string[] = [];
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const code = await fn();
      return { code, out: out.join(""), err: err.join("") };
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
  };

  it("lists templates, rejects bad arguments, creates a project (JSON and text), never runs gh without --gh", async () => {
    const work = tempDir("ruah-cli-new-");
    const env = gitEnv(work);
    expect((await capture(() => runNew(["--templates"], "t"))).out).toContain("web-vite-react");
    expect((await capture(() => runNew([], "t"))).code).toBe(2);
    expect((await capture(() => runNew(["x", "--gh", "internal"], "t"))).code).toBe(2);
    expect((await capture(() => runNew(["x", "--template", "nope"], "t"))).code).toBe(2);
    expect((await capture(() => runNew(["x", "--bogus"], "t"))).code).toBe(2);

    const seen: string[] = [];
    const spy: Runner = async (file, args, options) => {
      seen.push(path.basename(file));
      const { defaultRunner } = await import("../src/integrations/exec.js");
      return defaultRunner(file, args, options);
    };
    const json = await capture(() => runNew(["api", "--in", work, "--template", "node-api-ts", "--json"], "t", { env, runner: spy }));
    expect(json.code).toBe(0);
    const report = JSON.parse(json.out) as { path: string; git: { commit: string } };
    expect(report.path).toBe(path.join(work, "api"));
    expect(report.git.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(seen).not.toContain("gh");

    const text = await capture(() => runNew(["site", "--in", work, "-t", "static-site", "--no-git"], "t", { env }));
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/Created .*site from "Static site"/);
    expect(existsSync(path.join(work, "site", ".git"))).toBe(false);

    // Suggested commands stay copy-pasteable when the path has a space.
    const spaced = await capture(() => runNew(["My Site", "--in", work, "-t", "static-site", "--no-git"], "t", { env }));
    expect(spaced.out).toContain(`Next: cd '${path.join(work, "My Site")}'`);
    expect(shellPath("~/Projects/Payments API")).toBe("~/'Projects/Payments API'");
    expect(shellPath("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(shellPath("/tmp/plain-dir")).toBe("/tmp/plain-dir");

    const again = await capture(() => runNew(["site", "--in", work], "t", { env }));
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
  });
});
