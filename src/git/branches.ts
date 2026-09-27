// src/git/branches.ts — CONTRACTS §24: the open project's git branches and
// switching between them. Read-only listing (`for-each-ref`, `status
// --porcelain=v2`) and `git switch` (never --force, never --discard-changes, no
// auto-stash). Every git call goes through execFile — no shell — with a
// timeout, no terminal prompts and C locale (git's messages are matched here).
// Branch names are validated before they reach git (`check-ref-format
// --branch`, and never anything that starts with "-", so a name cannot become
// an option). The architecture diff shown after a switch is the pure
// `diffArchitectures` at the end.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import { searchPath } from "../integrations/exec.js";
import { withoutDaemonPlumbing } from "../desktop/child-env.js";

export const GIT_READ_TIMEOUT_MS = 5000;
/** A checkout of a large tree (and its post-checkout hooks) takes longer than a status. */
export const GIT_SWITCH_TIMEOUT_MS = 60_000;
export const BRANCH_LIST_CAP = 200;

// ---------- types ----------

export interface BranchCommit {
  sha: string;
  subject: string;
  /** ISO 8601 committer date. */
  date: string;
}

export interface LocalBranch {
  name: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** The upstream branch was deleted on the remote. */
  upstreamGone?: boolean;
  lastCommit: BranchCommit;
  current: boolean;
  /** Checked out in another worktree (git refuses to switch to it here). */
  worktree?: string;
}

export interface RemoteBranch {
  /** e.g. "origin/feature-x" */
  name: string;
  remote: string;
  /** The branch name without the remote ("feature-x"). */
  branch: string;
  /** A local branch of the same name exists (switching to it switches to the local one). */
  hasLocal: boolean;
  lastCommit: BranchCommit;
}

export interface DirtyCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface BranchList {
  /** null = detached HEAD */
  current: string | null;
  /** short sha of HEAD ("" in an empty repository) */
  head: string;
  detached: boolean;
  dirty: DirtyCounts;
  local: LocalBranch[];
  remote: RemoteBranch[];
  /** More than BRANCH_LIST_CAP refs of a kind exist: the list holds the most recent ones. */
  truncated: boolean;
}

export interface SwitchOptions {
  /** Create `name` (git switch -c), from `from` (default: HEAD). */
  create?: boolean;
  from?: string;
}

export interface SwitchOutcome {
  /** The branch now checked out. */
  branch: string;
  /** The branch before (null = was detached). */
  previous: string | null;
  /** A new local branch was made (-c, or --track of a remote-only branch). */
  created: boolean;
  /** Tracked files with uncommitted changes that git carried over to the branch. */
  carried: number;
}

/** A refusal with the HTTP status the endpoint answers (400 / 404 / 409 / 500 / 503). */
export class GitBranchError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "git",
  ) {
    super(message);
    this.name = "GitBranchError";
  }
}

// ---------- running git ----------

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: "missing" | "timeout" | "failed";
}

export interface GitRunOptions {
  /** git executable (default "git" on PATH + Homebrew dirs). */
  bin?: string;
  timeoutMs?: number;
}

function runGit(root: string, args: string[], options: GitRunOptions = {}): Promise<GitRun> {
  const timeoutMs = options.timeoutMs ?? GIT_READ_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile(
      options.bin ?? "git",
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        // Never prompt (credentials, editors), never page; C locale so the messages matched below are English.
        env: {
          ...withoutDaemonPlumbing(process.env),
          PATH: searchPath(),
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_EDITOR: "true",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (err.code === "ENOENT") resolve({ code: null, stdout: "", stderr: "", error: "missing" });
        else if (err.killed === true) resolve({ code: null, stdout, stderr, error: "timeout" });
        else resolve({ code: typeof err.code === "number" ? err.code : 1, stdout, stderr, error: "failed" });
      },
    );
  });
}

function gitFailure(run: GitRun, what: string, timeoutMs: number): GitBranchError {
  if (run.error === "missing") return new GitBranchError(503, "git is not installed", "git-missing");
  if (run.error === "timeout") return new GitBranchError(500, `git ${what} timed out after ${Math.round(timeoutMs / 1000)} s`, "git-timeout");
  return new GitBranchError(500, `git ${what} failed: ${firstLines(run.stderr) || `exit code ${run.code ?? "?"}`}`);
}

/** git's message without "error: " / "fatal: " / "hint: " noise, at most a few lines. */
function firstLines(text: string, max = 6): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^(error|fatal): /, "").trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith("hint:"))
    .slice(0, max)
    .join("\n");
}

/** The repository's git dir (absolute; `.git/worktrees/<name>` in a linked worktree), or throws 400. */
export async function gitDir(root: string, options: GitRunOptions = {}): Promise<string> {
  const run = await runGit(root, ["rev-parse", "--git-dir"], options);
  if (run.error === "missing") throw new GitBranchError(503, "git is not installed", "git-missing");
  if (run.code !== 0) throw new GitBranchError(400, "not a git repository", "not-git");
  return path.resolve(root, run.stdout.trim());
}

// ---------- names ----------

/**
 * A branch name git accepts for a new branch (`git check-ref-format --branch`),
 * refused before git sees it when it could be read as an option or a
 * `@{-N}` shorthand. Throws 400.
 */
export async function validateBranchName(root: string, name: string, options: GitRunOptions = {}): Promise<void> {
  const reason = branchNameProblem(name);
  if (reason !== undefined) throw new GitBranchError(400, `invalid branch name "${name}": ${reason}`, "bad-name");
  const run = await runGit(root, ["check-ref-format", "--branch", name], options);
  if (run.error === "missing") throw new GitBranchError(503, "git is not installed", "git-missing");
  if (run.code !== 0) throw new GitBranchError(400, `invalid branch name "${name}"`, "bad-name");
}

/** Quick checks (the viewer's validation feedback mirrors them); undefined = looks fine, git decides. */
export function branchNameProblem(name: string): string | undefined {
  if (name.trim().length === 0) return "empty";
  if (name.length > 250) return "longer than 250 characters";
  if (name.startsWith("-")) return "cannot start with -";
  if (name.includes("@{")) return "cannot contain @{";
  if (name === "@" || name === "HEAD") return `"${name}" is reserved`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return "cannot contain spaces or any of ~ ^ : ? * [ \\";
  if (name.includes("..")) return "cannot contain ..";
  if (name.includes("//") || name.startsWith("/") || name.endsWith("/")) return "slashes must separate non-empty parts";
  if (name.endsWith(".") || name.endsWith(".lock")) return "cannot end with . or .lock";
  if (name.split("/").some((part) => part.startsWith("."))) return "a part cannot start with .";
  return undefined;
}

// ---------- listing ----------

const REF_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(upstream:short)",
  "%(upstream:track,nobracket)",
  "%(objectname:short)",
  "%(committerdate:iso-strict)",
  "%(HEAD)",
  "%(worktreepath)",
  "%(subject)",
].join("%00");

interface RefRow {
  refname: string;
  short: string;
  upstream: string;
  track: string;
  sha: string;
  date: string;
  head: boolean;
  worktree: string;
  subject: string;
}

/** Parses `for-each-ref --format=REF_FORMAT` output (one ref per line, fields NUL-separated). */
export function parseRefs(output: string): RefRow[] {
  const rows: RefRow[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const [refname = "", short = "", upstream = "", track = "", sha = "", date = "", head = "", worktree = "", ...subject] = line.split("\0");
    rows.push({ refname, short, upstream, track, sha, date, head: head === "*", worktree, subject: subject.join(" ") });
  }
  return rows;
}

/** "ahead 2, behind 1" / "gone" / "" → counts. */
export function parseTrack(track: string): { ahead?: number; behind?: number; gone?: boolean } {
  if (track.trim() === "gone") return { gone: true };
  const out: { ahead?: number; behind?: number } = {};
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (ahead !== null) out.ahead = Number(ahead[1]);
  if (behind !== null) out.behind = Number(behind[1]);
  return out;
}

/** Branch, HEAD and change counts from `git status --porcelain=v2 --branch -z`. */
export function parseBranchStatus(output: string): { current: string | null; head: string; dirty: DirtyCounts } {
  let current: string | null = null;
  let head = "";
  const dirty: DirtyCounts = { staged: 0, unstaged: 0, untracked: 0 };
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.length === 0) continue;
    if (token.startsWith("# ")) {
      const [, key, ...rest] = token.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") current = value === "(detached)" ? null : value;
      else if (key === "branch.oid") head = value === "(initial)" ? "" : value.slice(0, 7);
      continue;
    }
    const kind = token[0];
    if (kind === "?") {
      dirty.untracked += 1;
      continue;
    }
    if (kind === "1" || kind === "2" || kind === "u") {
      const xy = token.slice(2, 4);
      if (kind === "u") dirty.unstaged += 1;
      else {
        if (xy[0] !== ".") dirty.staged += 1;
        if (xy[1] !== ".") dirty.unstaged += 1;
      }
      if (kind === "2") i += 1; // the original path follows as its own token
    }
  }
  return { current, head, dirty };
}

async function status(root: string, options: GitRunOptions): Promise<{ current: string | null; head: string; dirty: DirtyCounts; changedTracked: number }> {
  const run = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], options);
  if (run.error === "missing") throw new GitBranchError(503, "git is not installed", "git-missing");
  if (run.error === "timeout") throw gitFailure(run, "status", options.timeoutMs ?? GIT_READ_TIMEOUT_MS);
  if (run.code !== 0) throw new GitBranchError(400, "not a git repository", "not-git");
  const parsed = parseBranchStatus(run.stdout);
  // Tracked paths with any change (a path both staged and modified counts once).
  let changedTracked = 0;
  const tokens = run.stdout.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? "";
    if (t.startsWith("1 ") || t.startsWith("u ")) changedTracked += 1;
    else if (t.startsWith("2 ")) {
      changedTracked += 1;
      i += 1;
    }
  }
  return { ...parsed, changedTracked };
}

async function refs(root: string, pattern: string, options: GitRunOptions): Promise<RefRow[]> {
  const run = await runGit(
    root,
    ["for-each-ref", "--sort=-committerdate", `--count=${BRANCH_LIST_CAP + 1}`, `--format=${REF_FORMAT}`, pattern],
    options,
  );
  if (run.code !== 0) throw gitFailure(run, "for-each-ref", options.timeoutMs ?? GIT_READ_TIMEOUT_MS);
  return parseRefs(run.stdout);
}

/** The repository's branches: local ones (most recent commit first) and remote-tracking ones. Throws GitBranchError. */
export async function listBranches(root: string, options: GitRunOptions = {}): Promise<BranchList> {
  const st = await status(root, options);
  const [heads, remotes] = await Promise.all([refs(root, "refs/heads", options), refs(root, "refs/remotes", options)]);
  const truncated = heads.length > BRANCH_LIST_CAP || remotes.length > BRANCH_LIST_CAP;
  const ownDir = path.resolve(root);
  const local: LocalBranch[] = heads.slice(0, BRANCH_LIST_CAP).map((r) => {
    const track = parseTrack(r.track);
    const current = st.current !== null && r.short === st.current;
    const elsewhere = r.worktree.length > 0 && !current && !samePath(r.worktree, ownDir);
    return {
      name: r.short,
      ...(r.upstream.length > 0 ? { upstream: r.upstream } : {}),
      ...(track.ahead !== undefined ? { ahead: track.ahead } : {}),
      ...(track.behind !== undefined ? { behind: track.behind } : {}),
      ...(track.gone === true ? { upstreamGone: true } : {}),
      lastCommit: { sha: r.sha, subject: r.subject, date: r.date },
      current,
      ...(elsewhere ? { worktree: r.worktree } : {}),
    };
  });
  const localNames = new Set(heads.map((r) => r.short));
  const remote: RemoteBranch[] = remotes
    .filter((r) => !r.refname.endsWith("/HEAD"))
    .slice(0, BRANCH_LIST_CAP)
    .map((r) => {
      const rest = r.refname.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      const remoteName = slash > 0 ? rest.slice(0, slash) : rest;
      const branch = slash > 0 ? rest.slice(slash + 1) : rest;
      return { name: rest, remote: remoteName, branch, hasLocal: localNames.has(branch), lastCommit: { sha: r.sha, subject: r.subject, date: r.date } };
    });
  return { current: st.current, head: st.head, detached: st.current === null, dirty: st.dirty, local, remote, truncated };
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// ---------- switching ----------

/** A merge, rebase, cherry-pick or revert in progress (the name), else undefined. */
export async function operationInProgress(root: string, options: GitRunOptions = {}): Promise<string | undefined> {
  const dir = await gitDir(root, options);
  const markers: [string, string][] = [
    ["MERGE_HEAD", "a merge"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
  ];
  for (const [file, what] of markers) if (fs.existsSync(path.join(dir, file))) return what;
  return undefined;
}

async function refExists(root: string, ref: string, options: GitRunOptions): Promise<boolean> {
  const run = await runGit(root, ["show-ref", "--verify", "--quiet", ref], options);
  if (run.error === "missing") throw new GitBranchError(503, "git is not installed", "git-missing");
  return run.code === 0;
}

/** Whether `rev` names a commit (`from` of a new branch). */
async function commitExists(root: string, rev: string, options: GitRunOptions): Promise<boolean> {
  if (rev.startsWith("-") || rev.length > 250) return false;
  const run = await runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], options);
  return run.code === 0;
}

/** Remotes that have `branch` (refs/remotes/<remote>/<branch>). */
async function remotesWith(root: string, branch: string, options: GitRunOptions): Promise<string[]> {
  const run = await runGit(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"], options);
  if (run.code !== 0) return [];
  const out: string[] = [];
  for (const ref of run.stdout.split("\n")) {
    const rest = ref.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    if (slash > 0 && rest.slice(slash + 1) === branch) out.push(rest.slice(0, slash));
  }
  return out;
}

/** What the switch will run, decided before anything changes (404 / 409 / 400 here). */
export interface SwitchPlan {
  args: string[];
  /** The branch checked out afterwards. */
  branch: string;
  created: boolean;
  /** The commit-ish the working tree will show (for "does it track architecture.json?"). */
  target: string;
}

/** Resolves a switch request to git switch arguments. Throws GitBranchError. */
export async function planSwitch(root: string, name: string, opts: SwitchOptions = {}, options: GitRunOptions = {}): Promise<SwitchPlan> {
  if (opts.create === true) {
    await validateBranchName(root, name, options);
    if (await refExists(root, `refs/heads/${name}`, options)) throw new GitBranchError(409, `a branch named "${name}" already exists`, "exists");
    const from = opts.from?.trim();
    if (from !== undefined && from.length > 0) {
      if (!(await commitExists(root, from, options))) throw new GitBranchError(404, `no such branch or commit: ${from}`, "not-found");
      return { args: ["switch", "--no-guess", "-c", name, from], branch: name, created: true, target: from };
    }
    return { args: ["switch", "--no-guess", "-c", name], branch: name, created: true, target: "HEAD" };
  }
  const reason = branchNameProblem(name);
  if (reason !== undefined) throw new GitBranchError(400, `invalid branch name "${name}": ${reason}`, "bad-name");
  if (await refExists(root, `refs/heads/${name}`, options)) {
    return { args: ["switch", "--no-guess", name], branch: name, created: false, target: `refs/heads/${name}` };
  }
  // "origin/feature-x": the remote-tracking branch itself.
  if (await refExists(root, `refs/remotes/${name}`, options)) {
    const slash = name.indexOf("/");
    const local = slash > 0 ? name.slice(slash + 1) : name;
    if (local.length === 0 || local === "HEAD") throw new GitBranchError(400, `cannot switch to ${name}`, "bad-name");
    if (await refExists(root, `refs/heads/${local}`, options)) {
      return { args: ["switch", "--no-guess", local], branch: local, created: false, target: `refs/heads/${local}` };
    }
    return { args: ["switch", "--track", `${name}`], branch: local, created: true, target: `refs/remotes/${name}` };
  }
  // "feature-x" that only a remote has.
  const remotes = await remotesWith(root, name, options);
  if (remotes.length === 1) {
    const ref = `${remotes[0]}/${name}`;
    return { args: ["switch", "--track", ref], branch: name, created: true, target: `refs/remotes/${ref}` };
  }
  if (remotes.length > 1) {
    throw new GitBranchError(409, `"${name}" exists on several remotes (${remotes.join(", ")}): pick one, e.g. ${remotes[0]}/${name}`, "ambiguous");
  }
  throw new GitBranchError(404, `no such branch: ${name}`, "not-found");
}

/** git's refusal → a clear message and status (409 for local changes / worktrees, 500 otherwise). */
export function switchRefusal(stderr: string): GitBranchError {
  const detail = firstLines(stderr, 12);
  const files = stderr
    .split("\n")
    .filter((l) => /^\t/.test(l))
    .map((l) => l.trim())
    .slice(0, 8);
  const list = files.length > 0 ? files.join(", ") : "";
  if (/untracked working tree files would be (overwritten|removed)/.test(stderr)) {
    return new GitBranchError(
      409,
      `Move, remove or commit these untracked files first — the branch has its own copy${list ? `: ${list}` : ""}`,
      "untracked-overwritten",
    );
  }
  if (/would be overwritten by checkout|Your local changes to the following files would be overwritten/.test(stderr)) {
    return new GitBranchError(409, `Commit or stash your changes first${list ? `: ${list}` : ""}`, "local-changes");
  }
  if (/is already (checked out|used by worktree) at/.test(stderr)) {
    return new GitBranchError(409, detail, "worktree");
  }
  if (/you need to resolve your current index first|needs merge|unmerged/i.test(stderr)) {
    return new GitBranchError(409, `Resolve the conflicts first: ${detail}`, "unmerged");
  }
  return new GitBranchError(500, `git switch failed: ${detail || "unknown error"}`);
}

/**
 * Switches the repository at `root` to `name` (see planSwitch). Refuses (409)
 * while a merge / rebase / cherry-pick / revert is in progress and when git
 * would overwrite local changes; uncommitted changes git can carry over are
 * carried (and counted). Does not touch stores or caches: see project-switch.ts.
 */
export async function switchBranch(root: string, name: string, opts: SwitchOptions = {}, options: GitRunOptions = {}): Promise<SwitchOutcome> {
  const busy = await operationInProgress(root, options);
  if (busy !== undefined) throw new GitBranchError(409, `Finish or abort ${busy} first (git is in the middle of it)`, "in-progress");
  const plan = await planSwitch(root, name, opts, options);
  return runSwitch(root, plan, options);
}

/** Runs a plan made by planSwitch (the caller checked operationInProgress). */
export async function runSwitch(root: string, plan: SwitchPlan, options: GitRunOptions = {}): Promise<SwitchOutcome> {
  const before = await status(root, options);
  const timeoutMs = options.timeoutMs ?? GIT_SWITCH_TIMEOUT_MS;
  const run = await runGit(root, plan.args, { ...options, timeoutMs });
  if (run.error === "missing") throw new GitBranchError(503, "git is not installed", "git-missing");
  if (run.error === "timeout") throw gitFailure(run, "switch", timeoutMs);
  if (run.code !== 0) throw switchRefusal(run.stderr);
  return { branch: plan.branch, previous: before.current, created: plan.created, carried: before.changedTracked };
}

/** Whether `rev` has `file` (a path relative to `root`) in its tree. */
export async function revisionHasFile(root: string, rev: string, file: string, options: GitRunOptions = {}): Promise<boolean> {
  const rel = file.split(path.sep).join("/");
  const run = await runGit(root, ["cat-file", "-e", `${rev}:./${rel}`], options);
  return run.code === 0;
}

/** Whether `file` (relative to `root`) is tracked in the working tree's index. */
export async function isTracked(root: string, file: string, options: GitRunOptions = {}): Promise<boolean> {
  const run = await runGit(root, ["ls-files", "--error-unmatch", "--", file], options);
  return run.code === 0;
}

// ---------- the architecture diff ----------

export interface ElementRef {
  id: string;
  name: string;
  type: string;
}

export interface EdgeRef {
  from: string;
  to: string;
  label?: string;
}

export interface ArchitectureDiff {
  added: ElementRef[];
  removed: ElementRef[];
  changed: { id: string; name: string; fields: string[] }[];
  edges: { added: EdgeRef[]; removed: EdgeRef[] };
  workflows: { added: { id: string; name: string }[]; removed: { id: string; name: string }[] };
}

/** Layout is not a change: positions differ between any two scans. */
const IGNORED_FIELDS = new Set(["x", "y"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function edgeKey(e: { from: string; to: string; label?: string | undefined }): string {
  return `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
}

/**
 * What changed between two architectures: elements by id (x/y ignored),
 * edges by (from, to, label), workflows by id. null = no architecture.
 */
export function diffArchitectures(before: Architecture | null, after: Architecture | null): ArchitectureDiff {
  const beforeNodes = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const afterNodes = new Map((after?.nodes ?? []).map((n) => [n.id, n]));
  const added: ElementRef[] = [];
  const removed: ElementRef[] = [];
  const changed: ArchitectureDiff["changed"] = [];
  for (const [id, n] of afterNodes) {
    const old = beforeNodes.get(id);
    if (old === undefined) {
      added.push({ id, name: n.name, type: n.type });
      continue;
    }
    const keys = new Set([...Object.keys(old), ...Object.keys(n)]);
    const fields: string[] = [];
    for (const key of keys) {
      if (IGNORED_FIELDS.has(key)) continue;
      const a = (old as Record<string, unknown>)[key];
      const b = (n as Record<string, unknown>)[key];
      if (canonical(a) !== canonical(b)) fields.push(key);
    }
    if (fields.length > 0) changed.push({ id, name: n.name, fields: fields.sort() });
  }
  for (const [id, n] of beforeNodes) if (!afterNodes.has(id)) removed.push({ id, name: n.name, type: n.type });

  const beforeEdges = new Map((before?.edges ?? []).map((e) => [edgeKey(e), e]));
  const afterEdges = new Map((after?.edges ?? []).map((e) => [edgeKey(e), e]));
  const edgeRef = (e: { from: string; to: string; label?: string | undefined }): EdgeRef => ({
    from: e.from,
    to: e.to,
    ...(e.label !== undefined ? { label: e.label } : {}),
  });
  const edgesAdded = [...afterEdges].filter(([k]) => !beforeEdges.has(k)).map(([, e]) => edgeRef(e));
  const edgesRemoved = [...beforeEdges].filter(([k]) => !afterEdges.has(k)).map(([, e]) => edgeRef(e));

  const beforeFlows = new Map((before?.workflows ?? []).map((w) => [w.id, w]));
  const afterFlows = new Map((after?.workflows ?? []).map((w) => [w.id, w]));
  const flowsAdded = [...afterFlows.values()].filter((w) => !beforeFlows.has(w.id)).map((w) => ({ id: w.id, name: w.name }));
  const flowsRemoved = [...beforeFlows.values()].filter((w) => !afterFlows.has(w.id)).map((w) => ({ id: w.id, name: w.name }));

  return {
    added,
    removed,
    changed,
    edges: { added: edgesAdded, removed: edgesRemoved },
    workflows: { added: flowsAdded, removed: flowsRemoved },
  };
}
