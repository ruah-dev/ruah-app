// src/extensions/git.ts — fetches a git source into $RUAH_HOME/extensions/src.
// Fetching is not running: `git clone --depth 1` with no hooks (core.hooksPath
// → /dev/null), no submodules, no credential prompts, args array (no shell),
// the URL after `--`. The clone lands in a temp folder and is renamed into
// place, so a failed clone leaves nothing behind.
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultRunner, CliError, type Runner } from "../integrations/exec.js";
import { ExtensionError, validateGitUrl } from "./model.js";

const CLONE_TIMEOUT_MS = 120_000;

export interface CloneOptions {
  runner?: Runner;
  /** Tests clone file:// fixtures; the app never does. */
  allowFile?: boolean;
}

function baseArgs(allowFile: boolean): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", `protocol.file.allow=${allowFile ? "always" : "never"}`, "-c", "protocol.ext.allow=never"];
}

/** Clones `url` (at `ref`) into `dest` unless it is already there. Returns `dest`. */
export async function cloneSource(url: string, ref: string | undefined, dest: string, options: CloneOptions = {}): Promise<string> {
  const safeUrl = validateGitUrl(url, options.allowFile === true ? { allowFile: true } : {});
  if (ref !== undefined && (ref.startsWith("-") || !/^[A-Za-z0-9._/-]{1,200}$/.test(ref))) throw new ExtensionError(400, "invalid git ref");
  if (fs.existsSync(path.join(dest, ".git"))) return dest;
  const run = options.runner ?? defaultRunner;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const args = [
    ...baseArgs(options.allowFile === true),
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-recurse-submodules",
    ...(ref !== undefined ? ["--branch", ref] : []),
    "--",
    safeUrl,
    tmp,
  ];
  try {
    const result = await run("git", args, { timeoutMs: CLONE_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" } });
    if (result.code !== 0) {
      const reason = result.stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("Cloning into")).slice(-2).join(" ");
      throw new ExtensionError(502, `git clone failed${reason.length > 0 ? `: ${reason.slice(0, 300)}` : ` (exit ${result.code})`}`);
    }
    fs.renameSync(tmp, dest);
    return dest;
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (err instanceof ExtensionError) throw err;
    if (err instanceof CliError) throw new ExtensionError(err.kind === "missing" ? 424 : 502, err.kind === "missing" ? "git is not installed" : err.message);
    throw err;
  }
}
