// src/desktop/login-env.ts — the login shell's environment for GUI launches.
//
// An app started from Finder, the Dock or `open` gets launchd's environment:
// a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so claude, cursor-agent, gh,
// kubectl & co. installed by Homebrew, npm, bun or their own installers are
// "not found", and none of what the user's profile exports (ANTHROPIC_API_KEY,
// CLAUDE_CODE_USE_BEDROCK, AWS_PROFILE, KUBECONFIG, proxies, LANG, …). The fix
// every terminal-aware Mac app uses (VS Code's resolveShellEnv): ask the
// user's login shell once (`$SHELL -ilc`) for its whole environment and take
// what this process lacks. Rc files may print banners, so the answer travels
// between markers, NUL-separated (`env -0`: values may hold newlines). Only
// the PATH is cached (the rest may hold secrets, which never land in
// ~/.ruah). Never throws: a broken shell leaves the environment as it was.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { ruahHome } from "../usage/log.js";
import { DAEMON_PLUMBING } from "./child-env.js";

export const LOGIN_ENV_MARKER = "__RUAH_LOGIN_ENV__";
/** launchd's default PATH for GUI apps; a PATH made only of these needs the login shell. */
const LAUNCHD_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 1024 * 1024;
/** Daemon plumbing that must not reach the user's rc files. */
const PLUMBING = [...DAEMON_PLUMBING, "RUAH_MCP_TOKEN"];
/**
 * Never taken from the login shell: its per-shell state, the daemon's plumbing and
 * the settings that fixed this instance's identity before the shell answered.
 */
const NOT_IMPORTED = new Set([
  "PATH", // merged, not replaced (mergePaths)
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM",
  "DISABLE_AUTO_UPDATE",
  ...PLUMBING,
  "RUAH_HOME",
  "RUAH_USER_DATA",
  "RUAH_PORT",
  "RUAH_DAEMON_URL",
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ShellInvocation {
  file: string;
  args: string[];
}

export type LoginEnvResult =
  | { ok: true; shell: string; path: string; env: Record<string, string>; ms: number }
  | { ok: false; shell: string; error: string; ms: number };

export interface LoginPathCache {
  version: 1;
  shell: string;
  path: string;
  resolvedAt: string;
}

/** $SHELL when it is an absolute path to an executable, else /bin/zsh (the macOS default). */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const shell = env.SHELL?.trim();
  if (shell !== undefined && path.isAbsolute(shell)) {
    try {
      fs.accessSync(shell, fs.constants.X_OK);
      return shell;
    } catch {
      // fall through
    }
  }
  return "/bin/zsh";
}

/** How to make `shell` print its environment between markers, reading the same files a terminal would. */
export function loginShellInvocation(shell: string): ShellInvocation {
  const name = path.basename(shell);
  const m = LOGIN_ENV_MARKER;
  // The same line in sh, bash, zsh, fish and csh; env -0 ends every entry with NUL (an env
  // without -0 prints lines instead: parseLoginEnv reads both).
  const command = `printf '%s' '${m}'; /usr/bin/env -0 || /usr/bin/env; printf '%s' '${m}'`;
  if (name === "fish") return { file: shell, args: ["-l", "-i", "-c", command] };
  // csh/tcsh accept -l only as the sole flag: a plain -c still reads .cshrc / .tcshrc.
  if (name === "csh" || name === "tcsh") return { file: shell, args: ["-c", command] };
  return { file: shell, args: ["-i", "-l", "-c", command] };
}

/** A PATH value with only absolute entries, or undefined when none is left. */
export function cleanPath(value: string | undefined): string | undefined {
  if (value === undefined || value.includes("\n")) return undefined;
  const dirs = value
    .trim()
    .split(path.delimiter)
    .filter((d) => path.isAbsolute(d));
  return dirs.length === 0 ? undefined : dirs.join(path.delimiter);
}

/** `env` without -0: one entry per line; a line that does not start with `NAME=` continues the previous value. */
function lineEntries(body: string): string[] {
  const entries: string[] = [];
  for (const line of body.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && NAME.test(line.slice(0, eq))) entries.push(line);
    else if (entries.length > 0 && line.length > 0) entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

/** The environment between the markers (`NAME=value` entries, NUL-separated), or undefined when there is none. */
export function parseLoginEnv(output: string): Record<string, string> | undefined {
  const start = output.indexOf(LOGIN_ENV_MARKER);
  if (start === -1) return undefined;
  const end = output.indexOf(LOGIN_ENV_MARKER, start + LOGIN_ENV_MARKER.length);
  if (end === -1) return undefined;
  const body = output.slice(start + LOGIN_ENV_MARKER.length, end);
  const env: Record<string, string> = {};
  for (const entry of body.includes("\0") ? body.split("\0") : lineEntries(body)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (NAME.test(name)) env[name] = entry.slice(eq + 1);
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/** `primary` first, then what only `secondary` has; relative and empty entries and duplicates dropped. */
export function mergePaths(primary: string | undefined, secondary: string | undefined): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...(primary ?? "").split(path.delimiter), ...(secondary ?? "").split(path.delimiter)]) {
    const trimmed = dir.trim();
    const clean = trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
    if (clean.length === 0 || !path.isAbsolute(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.join(path.delimiter);
}

/** True when PATH is launchd's bare default (a GUI launch): the daemon then waits for the login shell. */
export function isMinimalPath(value: string | undefined): boolean {
  const dirs = (value ?? "").split(path.delimiter).filter((d) => d.length > 0);
  return dirs.every((d) => LAUNCHD_DIRS.has(d.replace(/\/+$/, "")));
}

/**
 * The PATH in effect after the login shell answered: a GUI launch (launchd's bare PATH)
 * takes the login shell's first; a PATH that already looks like a terminal's keeps its
 * order (an active venv, `nvm use`, a project bin stay first) and only gains what it lacks.
 */
export function effectivePath(original: string | undefined, login: string): string {
  return isMinimalPath(original) ? mergePaths(login, original) : mergePaths(original, login);
}

/** The login-shell variables `target` lacks (never PATH, per-shell state or the daemon's plumbing), by name. */
export function missingLoginVars(target: NodeJS.ProcessEnv, login: Record<string, string>): string[] {
  return Object.keys(login)
    .filter((name) => !NOT_IMPORTED.has(name) && target[name] === undefined)
    .sort();
}

function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of PLUMBING) delete out[key];
  // oh-my-zsh: never prompt for an update in a shell nobody sees.
  out.DISABLE_AUTO_UPDATE = "true";
  return out;
}

export interface ReadLoginEnvOptions {
  shell?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Runs the login shell once. Resolves (never rejects) within `timeoutMs` plus a moment to reap it. */
export function readLoginEnv(options: ReadLoginEnvOptions = {}): Promise<LoginEnvResult> {
  const env = options.env ?? process.env;
  const shell = options.shell ?? loginShell(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { file, args } = loginShellInvocation(shell);
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: LoginEnvResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy(); // a background job the rc files started may hold the pipe open
      resolve(result);
    };
    /** The answer, once both markers are in (decoded as a whole: a chunk may split a UTF-8 character). */
    const answer = (): LoginEnvResult | undefined => {
      const found = parseLoginEnv(Buffer.concat(chunks).toString("utf8"));
      if (found === undefined) return undefined;
      const loginPath = cleanPath(found.PATH);
      const ms = Date.now() - started;
      return loginPath === undefined
        ? { ok: false, shell, error: `${path.basename(shell)} printed no usable PATH`, ms }
        : { ok: true, shell, path: loginPath, env: found, ms };
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Own process group (detached) so a timeout also kills what the rc files started.
      child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], env: shellEnv(env), detached: true });
    } catch (err) {
      resolve({ ok: false, shell, error: err instanceof Error ? err.message : String(err), ms: 0 });
      return;
    }
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, shell, error: `${path.basename(shell)} did not answer within ${timeoutMs} ms`, ms: Date.now() - started });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (size >= MAX_OUTPUT) return;
      chunks.push(chunk);
      size += chunk.length;
      // Done as soon as the value is complete; background jobs the rc files left behind are not our business.
      const result = answer();
      if (result !== undefined) finish(result);
    });
    child.on("error", (err) => finish({ ok: false, shell, error: err.message, ms: Date.now() - started }));
    child.on("close", (code) => {
      finish(
        answer() ?? { ok: false, shell, error: `${path.basename(shell)} exited ${code ?? "by signal"} without printing its environment`, ms: Date.now() - started },
      );
    });
    child.unref();
  });
}

export function loginPathCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ruahHome(env), "cache", "login-path.json");
}

export function readLoginPathCache(file: string, shell: string): LoginPathCache | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || record.shell !== shell || typeof record.path !== "string" || typeof record.resolvedAt !== "string") return undefined;
    const clean = cleanPath(record.path);
    return clean === undefined ? undefined : { version: 1, shell, path: clean, resolvedAt: record.resolvedAt };
  } catch {
    return undefined;
  }
}

export function writeLoginPathCache(file: string, shell: string, value: string, now: Date = new Date()): void {
  try {
    const cache: LoginPathCache = { version: 1, shell, path: value, resolvedAt: now.toISOString() };
    atomicWriteFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // a read-only home only costs a failing shell its fallback
  }
}

export interface ApplyLoginEnvOptions extends ReadLoginEnvOptions {
  /** The environment to update in place (default process.env). */
  target?: NodeJS.ProcessEnv;
  cacheFile?: string;
  log?: (line: string) => void;
}

export interface ApplyLoginEnvResult {
  /** Where the environment in effect when this resolved came from. */
  source: "shell" | "cache" | "unchanged";
  path: string;
  /** Variables taken from the login shell, by name (sorted). */
  added: string[];
  /** Settles when the background pass (a launch from a terminal) is done. */
  refreshed: Promise<void>;
}

/**
 * Brings the login shell's environment into `target`:
 * - PATH: effectivePath (login first for launchd's bare PATH, else the process's order kept);
 * - every other variable the process lacks (never PATH, per-shell state or daemon plumbing);
 *   what the process already has is never overwritten.
 * A GUI launch (launchd's bare PATH) waits for the shell (bounded by the timeout) — agents
 * read their environment when they start, so it must be complete before anything runs; if
 * the shell fails, the cached PATH of its last answer applies. A launch from a terminal
 * already has the user's environment: the shell only fills gaps, in the background.
 */
export async function applyLoginEnv(options: ApplyLoginEnvOptions = {}): Promise<ApplyLoginEnvResult> {
  const target = options.target ?? process.env;
  const env = options.env ?? target;
  const shell = options.shell ?? loginShell(env);
  const cacheFile = options.cacheFile ?? loginPathCacheFile(env);
  const log = options.log ?? (() => {});
  const readOptions: ReadLoginEnvOptions = { shell, env: { ...env }, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) };
  const original = target.PATH;

  const resolveAndApply = async (): Promise<string[] | undefined> => {
    const result = await readLoginEnv(readOptions);
    if (!result.ok) {
      log(`login shell environment unavailable: ${result.error}`);
      return undefined;
    }
    target.PATH = effectivePath(original, result.path);
    const added = missingLoginVars(target, result.env);
    for (const name of added) target[name] = result.env[name];
    writeLoginPathCache(cacheFile, shell, result.path);
    log(`environment from the ${path.basename(shell)} login shell (${result.ms} ms): PATH${added.length > 0 ? ` + ${added.length} variable${added.length === 1 ? "" : "s"}` : ""}`);
    return added;
  };

  if (!isMinimalPath(original)) {
    const refreshed = resolveAndApply().then(() => undefined);
    return { source: "unchanged", path: original ?? "", added: [], refreshed };
  }
  const added = await resolveAndApply();
  if (added !== undefined) return { source: "shell", path: target.PATH ?? "", added, refreshed: Promise.resolve() };
  const cached = readLoginPathCache(cacheFile, shell);
  if (cached !== undefined) {
    target.PATH = effectivePath(original, cached.path);
    log(`using the login PATH cached ${cached.resolvedAt}`);
    return { source: "cache", path: target.PATH, added: [], refreshed: Promise.resolve() };
  }
  return { source: "unchanged", path: original ?? "", added: [], refreshed: Promise.resolve() };
}
