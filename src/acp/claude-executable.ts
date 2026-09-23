// Adapted from t3code apps/server/src/provider/Drivers/ClaudeExecutable.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/claude-executable.ts — resolves CLAUDE_CODE_EXECUTABLE into a path
// the Claude Agent SDK can spawn via `pathToClaudeCodeExecutable`. Effect-TS
// services (HostProcessPlatform, SpawnExecutableResolution, the injectable
// file check) became plain parameters.
import { statSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Windows launcher-script extensions that Node cannot spawn without a shell
 * (`spawn EINVAL` since Node 20.12) and that the Claude Agent SDK therefore
 * cannot use as `pathToClaudeCodeExecutable`.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Entry points of the npm `@anthropic-ai/claude-code` package relative to the
 * global `node_modules` directory that sits next to the npm launcher shim.
 * Newer package versions ship a native `bin/claude.exe`; older versions only
 * ship `cli.js`, which the SDK runs with a JavaScript runtime.
 */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** PATH/PATHEXT lookup for a bare command name on Windows (t3code's SpawnExecutableResolution, reduced). */
function resolveOnWindowsPath(command: string, env: NodeJS.ProcessEnv, isFile: ExecutableFileCheck): string | undefined {
  if (command.includes("\\") || command.includes("/") || win32.isAbsolute(command)) {
    return isFile(command) ? command : undefined;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = win32.extname(command).length > 0
    ? [""]
    : ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)];
  for (const dir of pathValue.split(";")) {
    if (dir.length === 0) continue;
    for (const ext of extensions) {
      const candidate = win32.join(dir, command + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves the configured Claude binary path into a value the Claude Agent
 * SDK can spawn directly via `pathToClaudeCodeExecutable`.
 *
 * The SDK spawns the given path without a shell and without Windows PATH /
 * PATHEXT resolution, so a bare command name like `claude` fails with
 * "native binary not found" and an npm `claude.cmd` shim fails with
 * `spawn EINVAL`. On Windows this resolves the command against PATH/PATHEXT
 * and, when the result is an npm launcher shim, follows it to the real
 * package entry (`bin/claude.exe`, or `cli.js` for older package versions).
 * On other platforms the configured value is returned unchanged.
 */
export function resolveClaudeSdkExecutablePath(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isFile: ExecutableFileCheck = isExistingFile,
): string {
  if (platform !== "win32") return binaryPath;

  const resolved = resolveOnWindowsPath(binaryPath, env, isFile) ?? binaryPath;
  const extension = win32.extname(resolved).toLowerCase();
  if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) return resolved;

  const shimDirectory = win32.dirname(resolved);
  for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = win32.join(shimDirectory, ...entrySegments);
    if (isFile(candidate)) return candidate;
  }
  // No known package entry next to the shim; the SDK will fail to spawn it and
  // report the error through the bridge.
  return binaryPath;
}
