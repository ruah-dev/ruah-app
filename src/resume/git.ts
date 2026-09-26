// src/resume/git.ts — the git part of "where you left off" (CONTRACTS §13.4):
// branch, ahead/behind upstream, dirty paths, last commit. Two read-only git
// calls (`status --porcelain=v2 --branch -z`, `log -1`), run in parallel with
// a timeout, never through a shell, cached per repo root for a few seconds so
// a launcher that asks for every recent project does not hammer git.
import { execFile } from "node:child_process";
import type { GitState } from "../contracts/resume.js";
import { searchPath } from "../integrations/exec.js";
import { withoutDaemonPlumbing } from "../desktop/child-env.js";

export const GIT_TIMEOUT_MS = 3000;
export const GIT_CACHE_MS = 5000;
export const DIRTY_PATHS_TOP = 5;

export interface GitOptions {
  timeoutMs?: number;
  cacheMs?: number;
  top?: number;
  /** git executable (default "git" on PATH + Homebrew dirs). */
  bin?: string;
  now?: () => number;
}

interface GitRun {
  code: number | null;
  stdout: string;
  error?: "missing" | "timeout" | "failed";
}

function runGit(bin: string, root: string, args: string[], timeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        // Never prompt, never page, no optional locks (a background status must not block the user's git).
        env: { ...withoutDaemonPlumbing(process.env), PATH: searchPath(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ code: 0, stdout });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (err.code === "ENOENT") resolve({ code: null, stdout: "", error: "missing" });
        else if (err.killed === true) resolve({ code: null, stdout: "", error: "timeout" });
        else resolve({ code: typeof err.code === "number" ? err.code : 1, stdout, error: "failed" });
      },
    );
  });
}

/** Parses `git status --porcelain=v2 --branch -z` output. */
export function parseStatusV2(output: string, top = DIRTY_PATHS_TOP): {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: number;
  dirtyPaths: string[];
} {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const paths: string[] = [];
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.length === 0) continue;
    if (token.startsWith("# ")) {
      const [, key, ...rest] = token.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") branch = value === "(detached)" ? null : value;
      else if (key === "branch.oid") head = value === "(initial)" ? null : value.slice(0, 12);
      else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m !== null) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }
    const fields = token.split(" ");
    const kind = fields[0];
    if (kind === "1") paths.push(fields.slice(8).join(" "));
    else if (kind === "2") {
      paths.push(fields.slice(9).join(" "));
      i += 1; // the original path follows as its own NUL-separated token
    } else if (kind === "u") paths.push(fields.slice(10).join(" "));
    else if (kind === "?") paths.push(token.slice(2));
  }
  return { branch, head, upstream, ahead, behind, dirty: paths.length, dirtyPaths: paths.slice(0, top) };
}

const cache = new Map<string, { at: number; value: Promise<GitState> }>();

/** Git state of `root` (cached for cacheMs; failures are a value, never a throw). */
export function gitState(root: string, options: GitOptions = {}): Promise<GitState> {
  const now = options.now?.() ?? Date.now();
  const cacheMs = options.cacheMs ?? GIT_CACHE_MS;
  const cached = cache.get(root);
  if (cached !== undefined && now - cached.at < cacheMs) return cached.value;
  const value = computeGitState(root, options);
  cache.set(root, { at: now, value });
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

/** Drops cached git states (tests; after a commit made by Ruah itself). */
export function clearGitCache(): void {
  cache.clear();
}

async function computeGitState(root: string, options: GitOptions): Promise<GitState> {
  const bin = options.bin ?? "git";
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const [status, log] = await Promise.all([
    runGit(bin, root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], timeoutMs),
    runGit(bin, root, ["log", "-1", "--format=%h%x00%s%x00%an%x00%cI"], timeoutMs),
  ]);
  if (status.error === "missing") return { available: false, reason: "git is not installed" };
  if (status.error === "timeout") return { available: false, reason: `git status timed out after ${timeoutMs} ms` };
  if (status.code !== 0) return { available: false, reason: "not a git repository" };
  const parsed = parseStatusV2(status.stdout, options.top ?? DIRTY_PATHS_TOP);
  let lastCommit: { hash: string; subject: string; author: string; at: string } | null = null;
  if (log.code === 0) {
    const [hash, subject, author, at] = log.stdout.replace(/\n$/, "").split("\0");
    if (hash !== undefined && hash.length > 0) lastCommit = { hash, subject: subject ?? "", author: author ?? "", at: at ?? "" };
  }
  return { available: true, ...parsed, lastCommit };
}
