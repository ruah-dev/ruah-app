// test/resume.test.ts — CONTRACTS §13.4 "where you left off" as a standalone
// library (no SessionHub, no daemon) on a temp git repo, plus the CLI
// commands `ruah app resume` / `ruah app activity` (offline, and with live
// counts from a stub daemon), git status parsing and duration parsing.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent } from "../src/contracts/ws.js";
import type { ResumeInfo } from "../src/contracts/resume.js";
import type { Runner } from "../src/integrations/exec.js";
import { ActivityLog, parseDuration, parseSince } from "../src/activity/log.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { ProjectsStore } from "../src/projects/projects-store.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import { computeResume, resolveProject } from "../src/resume/resume.js";
import { clearGitCache, gitState, parseStatusV2 } from "../src/resume/git.js";
import { runResume } from "../src/resume/run-resume.js";
import { runActivity } from "../src/activity/run-activity.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  clearGitCache();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

/** A repo on branch "feature" with one commit, two changed files and one untracked file. */
function gitRepo(): string {
  const root = tempDir("ruah-resume-repo-");
  git(root, "init", "-q", "-b", "feature");
  writeFileSync(path.join(root, "architecture.json"), JSON.stringify({ version: 1, name: "billing", nodes: [{ id: "api", name: "Billing API", type: "service" }], edges: [], workflows: [] }));
  writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial billing service");
  writeFileSync(path.join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");
  writeFileSync(path.join(root, "new file.ts"), "x\n");
  return root;
}

function event(fields: Partial<ActivityEvent> & Pick<ActivityEvent, "kind" | "projectId" | "at">): ActivityEvent {
  return { id: `${fields.kind}-${fields.at}`, projectName: "billing", chatId: null, summary: fields.kind, background: true, ...fields };
}

/** $RUAH_HOME with the repo in the recent list, a chat, state.json and a few logged events. */
function seedHome(root: string): { home: string; projectId: string; chatId: string } {
  const home = tempDir("ruah-resume-home-");
  const projectId = projectIdFor(root);
  new ProjectsStore(home).touch({ id: projectId, name: "billing", root, kind: "repo" });
  const chats = new ChatStore(home);
  const chat = chats.create(projectId, { agentId: "claude", title: "Fix invoice rounding" });
  chats.appendTurn(
    projectId,
    chat.id,
    {
      turnId: "t1",
      text: "Why are invoices off by a cent?",
      contextPack: "",
      events: [{ kind: "text", text: "Rounding happens before the tax is applied." }],
      stopReason: "end_turn",
      startedAt: "2026-09-24T09:00:00.000Z",
      finishedAt: "2026-09-24T09:01:00.000Z",
    },
    { agentId: "claude" },
  );
  chats.setActiveChat(projectId, chat.id);
  chats.state.setFocus(projectId, "api");
  chats.state.setLastViewed(projectId, "2026-09-24T10:00:00.000Z");
  chats.state.addUnread(projectId, chat.id);
  const log = new ActivityLog(home);
  log.append(event({ kind: "turn.finished", projectId, at: "2026-09-24T09:30:00.000Z", stopReason: "end_turn", files: ["old.ts"] })); // before the user left
  log.append(event({ kind: "turn.finished", projectId, at: "2026-09-24T11:00:00.000Z", stopReason: "end_turn", files: ["a.ts", "b.ts"], chatId: chat.id }));
  log.append(event({ kind: "turn.finished", projectId, at: "2026-09-24T11:10:00.000Z", stopReason: "error", files: ["a.ts"] }));
  log.append(event({ kind: "permission.requested", projectId, at: "2026-09-24T11:20:00.000Z", requestId: "r1" }));
  log.append(event({ kind: "map.changed", projectId, at: "2026-09-24T11:21:00.000Z", mapChanges: 2 }));
  log.append(event({ kind: "turn.finished", projectId: "000000000000", at: "2026-09-24T11:30:00.000Z", stopReason: "end_turn" })); // another project
  return { home, projectId, chatId: chat.id };
}

const fakeRuah: Runner = (_bin, args) => {
  if (args.join(" ") === "task list --json") {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        "api-fix": { name: "api-fix", status: "in-progress", executor: "claude-code", files: ["src/api/**"] },
        old: { name: "old", status: "merged" },
        next: { name: "next", status: "created" },
      }),
      stderr: "",
    });
  }
  return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected" });
};

function captureIo(home: string, extra: Record<string, unknown> = {}) {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        err += t;
      },
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      deps: { home, ruah: { runner: fakeRuah, bin: "/fake/ruah" }, ...extra },
    },
    out: () => out,
    err: () => err,
  };
}

describe("resume library (§13.4)", () => {
  it("computes last chat, focus, activity since the user left, git state and ruah tasks from disk", async () => {
    const root = gitRepo();
    mkdirSync(path.join(root, ".ruah"));
    const { home, projectId, chatId } = seedHome(root);
    const target = resolveProject(root, { home });
    expect(target).toMatchObject({ id: projectId, name: "billing", root });
    const info = await computeResume(target!, { home, ruah: { runner: fakeRuah, bin: "/fake/ruah" } });

    expect(info.project).toMatchObject({ id: projectId, name: "billing", root, kind: "repo" });
    expect(info.lastViewedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(info.lastChat).toMatchObject({
      id: chatId,
      title: "Fix invoice rounding",
      turnCount: 1,
      lastPrompt: "Why are invoices off by a cent?",
      lastReply: "Rounding happens before the tax is applied.",
    });
    expect(info.lastFocus).toMatchObject({ nodeId: "api", name: "Billing API" });
    expect(info.since).toMatchObject({
      from: "2026-09-24T10:00:00.000Z",
      turnsFinished: 1,
      turnsFailed: 1,
      permissionsRequested: 1,
      files: ["a.ts", "b.ts"],
      filesTotal: 2,
      mapChanges: 2,
    });
    expect(info.since.events).toHaveLength(4);
    expect(info.unread).toBe(1);
    expect(info.live).toBeUndefined();
    expect(info.git).toMatchObject({ available: true, branch: "feature", upstream: null, ahead: null, behind: null, dirty: 3 });
    if (info.git.available) {
      expect(info.git.dirtyPaths.sort()).toEqual(["a.ts", "b.ts", "new file.ts"]);
      expect(info.git.lastCommit).toMatchObject({ subject: "Initial billing service", author: "Ruah Test" });
    }
    expect(info.ruah).toEqual({
      initialized: true,
      tasks: [
        { name: "api-fix", status: "in-progress", executor: "claude-code", files: ["src/api/**"] },
        { name: "next", status: "created" },
      ],
    });
    // 10 × unread + 2 × (turns since) + 1 in-progress task + 1 dirty tree.
    expect(info.attention).toBe(10 + 4 + 1 + 1);
    expect(info.view).toBeNull();
  });

  it("a folder that is no git repo, never opened, without .ruah/", async () => {
    const root = tempDir("ruah-resume-plain-");
    const home = tempDir("ruah-resume-home-");
    const target = resolveProject(root, { home });
    expect(target).toMatchObject({ id: projectIdFor(root), root, kind: "repo" });
    const info = await computeResume(target!, { home });
    expect(info).toMatchObject({ lastViewedAt: null, lastChat: null, lastFocus: null, unread: 0, git: { available: false, reason: "not a git repository" }, ruah: { initialized: false } });
    expect(resolveProject(path.join(root, "missing"), { home })).toBeUndefined();
  });

  it("git state is cached briefly per root", async () => {
    const root = gitRepo();
    const first = await gitState(root);
    writeFileSync(path.join(root, "c.ts"), "c\n");
    expect(await gitState(root)).toEqual(first); // cached
    expect(await gitState(root, { cacheMs: 0 })).toMatchObject({ dirty: 4 });
  });

  it("parses porcelain v2 status (renames, conflicts, untracked, upstream)", () => {
    const out = [
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new name.ts",
      "src/old.ts",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc merge.ts",
      "? notes.md",
      "",
    ].join("\0");
    expect(parseStatusV2(out, 3)).toEqual({
      branch: "main",
      head: "1234567890ab",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      dirty: 4,
      dirtyPaths: ["src/app.ts", "src/new name.ts", "merge.ts"],
    });
    expect(parseStatusV2("# branch.oid (initial)\0# branch.head (detached)\0")).toMatchObject({ branch: null, head: null, dirty: 0 });
  });

  it("parses durations and since values", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("2")).toBe(7_200_000);
    expect(parseDuration("soon")).toBeUndefined();
    const now = new Date("2026-09-24T12:00:00.000Z");
    expect(parseSince("1h", now)?.toISOString()).toBe("2026-09-24T11:00:00.000Z");
    expect(parseSince("2026-09-20T00:00:00Z", now)?.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(parseSince("never", now)).toBeUndefined();
  });
});

describe("ruah app resume / activity (CLI, no daemon)", () => {
  it("resume <repo> --json prints the library's answer; the text form reads like a briefing", async () => {
    const root = gitRepo();
    const { home, projectId } = seedHome(root);
    const json = captureIo(home);
    expect(await runResume([root, "--json", "--offline"], json.io)).toBe(0);
    const info = JSON.parse(json.out()) as ResumeInfo;
    expect(info.project.id).toBe(projectId);
    expect(info.since.turnsFinished).toBe(1);

    const byId = captureIo(home);
    expect(await runResume([projectId, "--offline"], byId.io)).toBe(0);
    const text = byId.out();
    expect(text).toContain(`billing  (${root})  [1 unread]`);
    expect(text).toContain('chat        "Fix invoice rounding" · 1 turn');
    expect(text).toContain("focus       Billing API (api)");
    expect(text).toContain("since then  1 turn finished · 1 failed or stopped · 1 permission request · 2 files edited (a.ts, b.ts) · 2 map changes");
    expect(text).toMatch(/git {9}feature · 3 dirty: .* · last commit [0-9a-f]+ "Initial billing service"/);

    const missing = captureIo(home);
    expect(await runResume(["/definitely/not/here", "--offline"], missing.io)).toBe(1);
    expect(missing.err()).toContain("no such project or folder");
    const bad = captureIo(home);
    expect(await runResume(["--nope"], bad.io)).toBe(2);
  });

  it("resume without a project lists recent projects by attention", async () => {
    const root = gitRepo();
    const { home } = seedHome(root);
    const quiet = tempDir("ruah-resume-quiet-");
    new ProjectsStore(home).touch({ id: projectIdFor(quiet), name: "quiet", root: quiet, kind: "repo" });
    const cap = captureIo(home);
    expect(await runResume(["--json", "--offline"], cap.io)).toBe(0);
    const { projects, daemon } = JSON.parse(cap.out()) as { projects: ResumeInfo[]; daemon: boolean };
    expect(daemon).toBe(false);
    expect(projects.map((p) => p.project.name)).toEqual(["billing", "quiet"]);
    const text = captureIo(home);
    await runResume(["--offline"], text.io);
    expect(text.out()).toContain("billing");
    expect(text.out()).toContain("(no daemon running: live turn counts are not shown)");
  });

  it("activity --since reads the persisted feed and unread markers", async () => {
    const root = gitRepo();
    const { home, projectId } = seedHome(root);
    const cap = captureIo(home);
    expect(await runActivity(["--since", "1h", "--json", "--offline"], cap.io)).toBe(0);
    const report = JSON.parse(cap.out()) as { since: string; daemon: boolean; projects: { projectId: string; unread: number }[]; events: ActivityEvent[] };
    expect(report.since).toBe("2026-09-24T11:00:00.000Z");
    expect(report.daemon).toBe(false);
    expect(report.events.map((e) => e.at)).toEqual([
      "2026-09-24T11:00:00.000Z",
      "2026-09-24T11:10:00.000Z",
      "2026-09-24T11:20:00.000Z",
      "2026-09-24T11:21:00.000Z",
      "2026-09-24T11:30:00.000Z",
    ]);
    expect(report.projects.find((p) => p.projectId === projectId)).toMatchObject({ unread: 1 });

    const one = captureIo(home);
    await runActivity(["--since", "7d", "--project", root, "--offline"], one.io);
    expect(one.out()).toContain("Projects");
    expect(one.out()).toContain("billing");
    expect(one.out()).toContain("1 unread");
    expect(one.out()).not.toContain("000000000000");

    const bad = captureIo(home);
    expect(await runActivity(["--since", "whenever", "--offline"], bad.io)).toBe(2);
  });

  it("adds live counts when a daemon answers on --daemon", async () => {
    const root = gitRepo();
    const { home, projectId } = seedHome(root);
    const server = createServer((req, res) => {
      res.writeHead(req.url?.startsWith("/api/activity") === true ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ projects: [{ projectId, projectName: "billing", running: 1, waitingPermission: 1, unread: 1, chats: {} }], events: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const resume = captureIo(home);
    await runResume([root, "--json", "--daemon", url], resume.io);
    const info = JSON.parse(resume.out()) as ResumeInfo;
    expect(info.live).toEqual({ running: 1, waitingPermission: 1 });
    expect(info.attention).toBeGreaterThanOrEqual(100);

    const activity = captureIo(home);
    await runActivity(["--daemon", url, "--since", "1h"], activity.io);
    expect(activity.out()).toContain("1 waiting for permission · 1 running · 1 unread");
    expect(activity.out()).not.toContain("no daemon running");
  });
});
