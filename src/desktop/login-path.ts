// src/desktop/login-path.ts — the login shell's PATH for GUI launches.
//
// An app started from Finder, the Dock or `open` gets launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so claude, cursor-agent, gh, kubectl & co.
// installed by Homebrew, npm, bun or their own installers are "not found".
// The fix every terminal-aware Mac app uses: ask the user's login shell once
// (`$SHELL -ilc`), merge its PATH in front of ours, and cache it so the next
// launch does not wait. Rc files may print banners, so the value travels
// between markers. Never throws: a broken shell leaves PATH as it was.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { ruahHome } from "../usage/log.js";

export const LOGIN_PATH_MARKER = "__RUAH_LOGIN_PATH__";
/** launchd's default PATH for GUI apps; a PATH made only of these needs the login shell. */
const LAUNCHD_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 256 * 1024;
/** Daemon plumbing that must not reach the user's rc files. */
const PLUMBING = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "RUAH_PARENT_PID", "RUAH_MCP_TOKEN", "RUAH_LOGIN_PATH"];

export interface ShellInvocation {
  file: string;
  args: string[];
}

export type LoginPathResult =
  | { ok: true; shell: string; path: string; ms: number }
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

/** How to make `shell` print its PATH between markers, reading the same files a terminal would. */
export function loginShellInvocation(shell: string): ShellInvocation {
  const name = path.basename(shell);
  const m = LOGIN_PATH_MARKER;
  if (name === "fish") return { file: shell, args: ["-l", "-i", "-c", `printf '%s%s%s' '${m}' (string join : $PATH) '${m}'`] };
  // csh/tcsh accept -l only as the sole flag: a plain -c still reads .cshrc / .tcshrc.
  if (name === "csh" || name === "tcsh") return { file: shell, args: ["-c", `printf '%s%s%s' '${m}' "$PATH" '${m}'`] };
  return { file: shell, args: ["-i", "-l", "-c", `printf '%s%s%s' '${m}' "$PATH" '${m}'`] };
}

/** The PATH between the markers, or undefined when the output has none (or it looks wrong). */
export function parseLoginPath(output: string): string | undefined {
  const start = output.indexOf(LOGIN_PATH_MARKER);
  if (start === -1) return undefined;
  const end = output.indexOf(LOGIN_PATH_MARKER, start + LOGIN_PATH_MARKER.length);
  if (end === -1) return undefined;
  const value = output.slice(start + LOGIN_PATH_MARKER.length, end).trim();
  if (value.length === 0 || value.includes("\n")) return undefined;
  const dirs = value.split(path.delimiter).filter((d) => path.isAbsolute(d));
  return dirs.length === 0 ? undefined : dirs.join(path.delimiter);
}

/** `primary` first, then what only `secondary` has; relative and empty entries and duplicates dropped. */
export function mergePaths(primary: string, secondary: string | undefined): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...primary.split(path.delimiter), ...(secondary ?? "").split(path.delimiter)]) {
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

function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of PLUMBING) delete out[key];
  // oh-my-zsh: never prompt for an update in a shell nobody sees.
  out.DISABLE_AUTO_UPDATE = "true";
  return out;
}

export interface ReadLoginPathOptions {
  shell?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Runs the login shell once. Resolves (never rejects) within `timeoutMs` plus a moment to reap it. */
export function readLoginPath(options: ReadLoginPathOptions = {}): Promise<LoginPathResult> {
  const env = options.env ?? process.env;
  const shell = options.shell ?? loginShell(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { file, args } = loginShellInvocation(shell);
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: LoginPathResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy(); // a background job the rc files started may hold the pipe open
      resolve(result);
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
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
      const found = parseLoginPath(output);
      if (found !== undefined) {
        // Done as soon as the value is complete; background jobs the rc files left behind are not our business.
        finish({ ok: true, shell, path: found, ms: Date.now() - started });
      }
    });
    child.on("error", (err) => finish({ ok: false, shell, error: err.message, ms: Date.now() - started }));
    child.on("close", (code) => {
      const found = parseLoginPath(output);
      finish(
        found !== undefined
          ? { ok: true, shell, path: found, ms: Date.now() - started }
          : { ok: false, shell, error: `${path.basename(shell)} exited ${code ?? "by signal"} without printing PATH`, ms: Date.now() - started },
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
    const clean = parseLoginPath(`${LOGIN_PATH_MARKER}${record.path}${LOGIN_PATH_MARKER}`);
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
    // a read-only home only costs the next launch the shell round trip
  }
}

export interface ApplyLoginPathOptions extends ReadLoginPathOptions {
  /** The environment to update in place (default process.env). */
  target?: NodeJS.ProcessEnv;
  cacheFile?: string;
  log?: (line: string) => void;
}

export interface ApplyLoginPathResult {
  /** Where the PATH in effect when this resolved came from. */
  source: "cache" | "shell" | "unchanged";
  path: string;
  /** Settles when the background refresh (cache hit, or a PATH that was already rich) is done. */
  refreshed: Promise<void>;
}

/**
 * Puts the login shell's PATH in front of `target.PATH`.
 * - cached value for this shell: applied at once, refreshed in the background;
 * - no cache and a bare launchd PATH (Finder/Dock launch): waits for the shell (bounded by the timeout);
 * - no cache and a PATH that already looks like a terminal's: refreshed in the background.
 */
export async function applyLoginPath(options: ApplyLoginPathOptions = {}): Promise<ApplyLoginPathResult> {
  const target = options.target ?? process.env;
  const env = options.env ?? target;
  const shell = options.shell ?? loginShell(env);
  const cacheFile = options.cacheFile ?? loginPathCacheFile(env);
  const log = options.log ?? (() => {});
  const readOptions: ReadLoginPathOptions = { shell, env, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) };
  const original = target.PATH;

  const resolveAndApply = async (): Promise<boolean> => {
    const result = await readLoginPath(readOptions);
    if (!result.ok) {
      log(`login shell PATH unavailable: ${result.error}`);
      return false;
    }
    target.PATH = mergePaths(result.path, original);
    writeLoginPathCache(cacheFile, shell, result.path);
    log(`PATH from ${path.basename(shell)} login shell (${result.ms} ms)`);
    return true;
  };

  const cached = readLoginPathCache(cacheFile, shell);
  if (cached !== undefined) {
    target.PATH = mergePaths(cached.path, original);
    const refreshed = resolveAndApply().then(() => undefined);
    return { source: "cache", path: target.PATH, refreshed };
  }
  if (isMinimalPath(original)) {
    const ok = await resolveAndApply();
    return { source: ok ? "shell" : "unchanged", path: target.PATH ?? "", refreshed: Promise.resolve() };
  }
  const refreshed = resolveAndApply().then(() => undefined);
  return { source: "unchanged", path: original ?? "", refreshed };
}
