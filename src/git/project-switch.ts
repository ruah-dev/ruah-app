// src/git/project-switch.ts — CONTRACTS §24: switching the OPEN project's
// branch and bringing its map along. The stores watch their files, so a branch
// with its own architecture.json / product.json reloads by itself; this module
// makes the reload immediate, and gives a branch that does not track
// architecture.json a map of its own (a fresh scan when the file is gone, a
// rescan that keeps hand edits when an untracked one was carried over). The
// answer carries a summary diff of the map (before → after).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import type { ProjectInfo, ServerMessage } from "../contracts/ws.js";
import { validateArchitecture } from "../contracts/validate.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { clearGitCache } from "../resume/git.js";
import { scanRepo } from "../scan/index.js";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import type { ProductStore } from "../serve/product-store.js";
import {
  diffArchitectures,
  GitBranchError,
  isTracked,
  listBranches,
  operationInProgress,
  planSwitch,
  revisionHasFile,
  runSwitch,
  type ArchitectureDiff,
  type BranchList,
  type GitRunOptions,
  type SwitchOptions,
} from "./branches.js";

/** The slice of SessionHub this needs (SessionHub satisfies it). */
export interface GitSwitchHost {
  project(): ProjectInfo | null;
  readonly store: ArchitectureStore | null;
  readonly product: ProductStore | null;
  runningTurn(projectId: string): { turnId: string; text: string } | undefined;
  broadcast(message: ServerMessage): void;
  version(): string;
}

export interface GitSwitchDeps {
  /** Per-project scan option (§11): IaC on unless the project turned it off. Default true. */
  scanInfra?: (projectId: string) => boolean;
  git?: GitRunOptions;
}

/** How the map of the new branch came to be. */
export type ArchitectureSource =
  /** the branch tracks architecture.json (the store reloaded it) */
  | "tracked"
  /** the branch has none and there was no file: scanned like a first open */
  | "generated"
  /** the branch has none, an untracked one was carried over: rescanned, hand edits kept */
  | "rescanned";

export interface ProjectSwitchResult {
  ok: true;
  branch: string;
  previous: string | null;
  created: boolean;
  carried: number;
  architecture: ArchitectureSource;
  /** The branch's architecture.json did not load (invalid): the map shows the last good one. */
  architectureError?: string;
  diff: ArchitectureDiff;
}

export const SYSTEM_MESSAGE = "switch branches per repo from the system view";
export const TURN_RUNNING_MESSAGE = "An agent is working in this project — wait for it to finish (or stop it) before switching branches";

/** Hashes of architecture files this module wrote (a pristine generated file may be removed before a switch). */
const generated = new Map<string, string>();
/** One switch per repository at a time. */
const switching = new Set<string>();

function hashFile(file: string): string | undefined {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

function openRepo(host: GitSwitchHost): { info: ProjectInfo; store: ArchitectureStore } {
  const info = host.project();
  const store = host.store;
  if (info === null || store === null) throw new GitBranchError(409, "no project open", "no-project");
  if (info.kind === "system") throw new GitBranchError(400, SYSTEM_MESSAGE, "system");
  return { info, store };
}

/** GET /api/git/branches for the open project. */
export async function projectBranches(host: GitSwitchHost, deps: GitSwitchDeps = {}): Promise<BranchList & { projectId: string }> {
  const { info } = openRepo(host);
  const list = await listBranches(info.root, deps.git);
  return { projectId: info.id, ...list };
}

/**
 * POST /api/git/switch: refuses while a turn runs in the project (409), then
 * switches (see switchBranch for git's own refusals), reloads the stores,
 * scans when the branch has no map, broadcasts `git.changed` and answers the
 * diff. Throws GitBranchError.
 */
export async function switchProjectBranch(
  host: GitSwitchHost,
  name: string,
  opts: SwitchOptions = {},
  deps: GitSwitchDeps = {},
): Promise<ProjectSwitchResult> {
  const { info, store } = openRepo(host);
  if (host.runningTurn(info.id) !== undefined) throw new GitBranchError(409, TURN_RUNNING_MESSAGE, "turn-running");
  const root = info.root;
  if (switching.has(root)) throw new GitBranchError(409, "a branch switch is already running in this project", "busy");
  switching.add(root);
  try {
    const busy = await operationInProgress(root, deps.git);
    if (busy !== undefined) throw new GitBranchError(409, `Finish or abort ${busy} first (git is in the middle of it)`, "in-progress");
    const plan = await planSwitch(root, name, opts, deps.git);

    const archPath = store.path;
    const rel = path.relative(root, archPath);
    const insideRepo = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
    // A map Ruah generated for a branch without one blocks the way back to a branch that
    // tracks it ("untracked file would be overwritten"): remove it while it is pristine.
    // (Put back when git refuses the switch after all.)
    let setAside: Buffer | undefined;
    if (insideRepo && fs.existsSync(archPath) && generated.get(archPath) === hashFile(archPath)) {
      const tracked = await isTracked(root, rel, deps.git);
      if (!tracked && (await revisionHasFile(root, plan.target, rel, deps.git))) {
        setAside = fs.readFileSync(archPath);
        fs.rmSync(archPath, { force: true });
      }
    }

    const before = store.current();
    let outcome;
    try {
      outcome = await runSwitch(root, plan, deps.git);
    } catch (err) {
      if (setAside !== undefined && !fs.existsSync(archPath)) atomicWriteFileSync(archPath, setAside);
      throw err;
    } finally {
      clearGitCache();
    }

    let source: ArchitectureSource = "tracked";
    if (insideRepo && !(await revisionHasFile(root, "HEAD", rel, deps.git))) {
      const exists = fs.existsSync(archPath);
      source = exists ? "rescanned" : "generated";
      try {
        writeScan(root, archPath, {
          version: host.version(),
          infra: deps.scanInfra?.(info.id) ?? true,
          previous: exists ? before : null,
        });
      } catch (err) {
        // The switch happened: report it, with the map left as it was.
        host.broadcast({ type: "git.changed", projectId: info.id, branch: outcome.branch });
        throw new GitBranchError(500, `switched to ${outcome.branch}, but the scan failed: ${(err as Error).message}`, "scan-failed");
      }
    } else {
      generated.delete(archPath);
    }

    let architectureError: string | undefined;
    const off = store.onError((e) => {
      architectureError = e.message;
    });
    try {
      await store.load();
    } finally {
      off();
    }
    await host.product?.load();
    const after = store.current();

    host.broadcast({ type: "git.changed", projectId: info.id, branch: outcome.branch });
    return {
      ok: true,
      branch: outcome.branch,
      previous: outcome.previous,
      created: outcome.created,
      carried: outcome.carried,
      architecture: source,
      ...(architectureError !== undefined ? { architectureError } : {}),
      diff: diffArchitectures(before, after),
    };
  } finally {
    switching.delete(root);
  }
}

/** Scan + validate + atomic write (ProjectService.scanInto, plus hand edits from `previous`). */
function writeScan(root: string, archPath: string, opts: { version: string; infra: boolean; previous: Architecture | null }): void {
  const arch = scanRepo(root, { version: opts.version, now: new Date(), infra: opts.infra, previous: opts.previous });
  const result = validateArchitecture(arch, root);
  if (!result.ok) throw new Error(`scan result failed validation: ${result.errors[0] ?? "unknown"}`);
  atomicWriteFileSync(archPath, `${JSON.stringify(arch, null, 2)}\n`);
  const hash = hashFile(archPath);
  if (hash !== undefined) generated.set(archPath, hash);
}
