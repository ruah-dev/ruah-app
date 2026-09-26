// The environment a dev server gets: the user's login + interactive shell
// environment (PATH from ~/.zshrc: nvm, pyenv, asdf, Homebrew …), resolved once
// like VS Code does — `$SHELL -i -l -c env` without a TTY and with a timeout —
// because Ruah started from the Dock has only the system PATH. The daemon's own
// plumbing is dropped (terminalEnv's rules), and browsers are never opened by
// the dev server (BROWSER=none): the preview shows the page.
import { spawn } from "node:child_process";
import { resolveShell, terminalEnv } from "../terminal/env.js";

const START = "__RUAH_ENV_START__";
const END = "__RUAH_ENV_END__";

export interface ShellEnvOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Parses `env -0` output between the markers; undefined when the markers are missing. */
export function parseEnvBlock(output: string): Record<string, string> | undefined {
  const start = output.indexOf(START);
  const end = output.indexOf(END, start + START.length);
  if (start === -1 || end === -1) return undefined;
  const block = output.slice(start + START.length, end);
  const env: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq).replace(/^\n+/, "")] = entry.slice(eq + 1);
  }
  return env;
}

/** Runs the user's shell once to read its environment; falls back to `env` on any failure. */
export function readShellEnv(options: ShellEnvOptions = {}): Promise<Record<string, string>> {
  const base = options.env ?? process.env;
  const fallback = (): Record<string, string> => Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || base.RUAH_PREVIEW_SHELL_ENV === "0") return Promise.resolve(fallback());
  const { shell } = resolveShell(base, platform);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: Record<string, string>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-i", "-l", "-c", `printf '%s' '${START}'; /usr/bin/env -0; printf '%s' '${END}'`], {
        env: { ...base, RUAH_RESOLVING_SHELL_ENV: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      resolve(fallback());
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      finish(fallback());
    }, options.timeoutMs ?? 8000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > 4 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024);
    });
    child.on("error", () => finish(fallback()));
    child.on("close", () => {
      const parsed = parseEnvBlock(out);
      if (parsed === undefined || parsed.PATH === undefined) {
        finish(fallback());
        return;
      }
      delete parsed.RUAH_RESOLVING_SHELL_ENV;
      delete parsed.SHLVL;
      delete parsed._;
      delete parsed.OLDPWD;
      finish(parsed);
    });
  });
}

let cached: Promise<Record<string, string>> | undefined;

/** The dev server environment (cached per process): shell env minus daemon plumbing, plus BROWSER=none. */
export function previewEnv(options: ShellEnvOptions & { projectRoot: string; version: string }): Promise<Record<string, string>> {
  cached ??= readShellEnv(options);
  return cached.then((shellEnv) => {
    const env = terminalEnv(shellEnv, { projectRoot: options.projectRoot, version: options.version });
    // A PTY is a terminal: colours stay on. Frameworks must not open a browser tab.
    env.BROWSER = "none";
    delete env.PWD;
    return env;
  });
}

/** Tests: forget the cached shell environment. */
export function resetShellEnvCache(): void {
  cached = undefined;
}
