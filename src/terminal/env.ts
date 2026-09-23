// Adapted from t3code apps/server/src/terminal/Manager.ts (createTerminalSpawnEnv,
// shell candidates) (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// The user's login shell and environment for a terminal. The daemon's own
// plumbing (Electron-as-Node, the desktop parent pid, agent tokens, package
// manager script variables) must not leak into the user's shell.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ShellCommand {
  shell: string;
  args: string[];
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `$SHELL -l` (a login shell, so PATH and the user's profile are set up even when the app was started from the Dock); fallback /bin/zsh, then /bin/bash, /bin/sh. */
export function resolveShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellCommand {
  if (platform === "win32") return { shell: env.COMSPEC ?? "powershell.exe", args: [] };
  const requested = env.RUAH_TERMINAL_SHELL ?? env.SHELL;
  const candidates = [requested, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0 && path.isAbsolute(c.trim()),
  );
  const shell = candidates.find((c) => isExecutable(c.trim()))?.trim() ?? "/bin/sh";
  return { shell, args: ["-l"] };
}

const BLOCKED_KEYS = new Set([
  "ELECTRON_RUN_AS_NODE", // would turn every `electron` / Electron-based CLI in the shell into plain Node
  "ELECTRON_NO_ATTACH_CONSOLE",
  "RUAH_PARENT_PID",
  "RUAH_MCP_TOKEN",
  "RUAH_DAEMON_URL",
  "RUAH_TERMINAL_SHELL",
  "INIT_CWD",
  "PORT",
]);

function blocked(key: string): boolean {
  // Lower-case npm_* are the package manager's script variables (`pnpm desktop`); NPM_TOKEN & co. are the user's.
  return BLOCKED_KEYS.has(key.toUpperCase()) || key.startsWith("npm_") || key === "PNPM_SCRIPT_SRC_DIR";
}

export interface TerminalEnvOptions {
  projectRoot: string;
  version: string;
}

/** The user's environment minus daemon plumbing, plus the terminal's identity. */
export function terminalEnv(base: NodeJS.ProcessEnv, options: TerminalEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || blocked(key)) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Ruah";
  env.TERM_PROGRAM_VERSION = options.version;
  env.RUAH_PROJECT_ROOT = options.projectRoot;
  // Apps started from the Dock get no locale: zsh would then garble UTF-8 input.
  if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) env.LANG = "en_US.UTF-8";
  return env;
}
