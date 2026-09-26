// src/engines/verify.ts — sync acceptance criteria into .ruah/verify.json and
// run ruah-verify after agent turns. Verdict mapping: unverifiable is never pass.
//
// What lands in the repo (CONTRACTS §21.3): only `.ruah/verify.json`, and
// only when the user syncs criteria (an explicit action). A run never
// creates it; node badges and the per-node criteria slices are caches in
// $RUAH_HOME/projects/<id>/cache. Older versions kept them (and eval runs)
// in the repo's `.ruah/`: moved out once per project, on the first read.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchNode, Architecture } from "../contracts/architecture.js";
import { globsForNode } from "../integrations/ruah.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { ensureRuahGitignore } from "../projects/repo-files.js";
import { runEngineJson, type EngineCliDeps } from "./cli.js";

export const VERIFY_FILE = path.join(".ruah", "verify.json");
const STATE_FILE = "verify-nodes.json";
/** The placeholder older versions wrote on their own when a repo had no criteria. */
const PLACEHOLDER_ID = "workspace/human-review";
const PLACEHOLDER_DOC = {
  schemaVersion: "1",
  criteria: [
    {
      id: PLACEHOLDER_ID,
      description: "No acceptance criteria linked to map nodes yet",
      check: { type: "unverifiable", reason: "Run ruah verify init or add acceptance on orch workflow tasks" },
    },
  ],
};
/** In the project's cache folder: the one-time move of the old repo caches happened (§21.3). */
const MIGRATION_FILE = "repo-migration.json";

export type VerifyBadge = "pass" | "fail" | "unverifiable" | "error" | "idle";

export interface NodeVerifyState {
  nodeId: string;
  badge: VerifyBadge;
  verdict?: string;
  detail?: string;
  verifiedAt?: string;
  reportPath?: string;
}

export interface VerifyReportLike {
  verdict?: string;
  summary?: {
    pass?: boolean;
    failed?: number;
    unverifiable?: number;
    total?: number;
  };
  tool?: string;
  error?: string;
}

/** Map a verify report to a UI badge. Never treat unverifiable as pass. */
export function badgeFromReport(report: VerifyReportLike | null | undefined, cliError?: string): VerifyBadge {
  if (cliError) return cliError.includes("not installed") ? "unverifiable" : "error";
  if (!report) return "idle";
  const failed = report.summary?.failed ?? 0;
  const unverifiable = report.summary?.unverifiable ?? 0;
  if (failed > 0 || report.verdict === "fail") return "fail";
  if (unverifiable > 0 || report.verdict === "pass-with-unverifiable") return "unverifiable";
  if (report.verdict === "pass" || (report.summary?.pass === true && unverifiable === 0 && failed === 0)) {
    return "pass";
  }
  return "unverifiable";
}

function globMatches(file: string, glob: string): boolean {
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -2);
    return file === prefix.slice(0, -1) || file.startsWith(prefix);
  }
  if (glob.includes("*")) {
    const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
    return re.test(file);
  }
  return file === glob;
}

function taskTouchesNode(taskFiles: string[], nodeGlobs: string[]): boolean {
  if (taskFiles.length === 0 || nodeGlobs.length === 0) return false;
  for (const f of taskFiles) {
    for (const g of nodeGlobs) {
      if (globMatches(f, g) || globMatches(g.replace(/\/\*\*$/, ""), f) || f.startsWith(g.replace(/\/\*\*$/, ""))) {
        return true;
      }
    }
  }
  return false;
}

interface OrchTaskLike {
  name?: string;
  files?: string[];
  acceptanceCriteria?: string[];
}

interface OrchWorkflowLike {
  name?: string;
  path?: string;
  tasks?: OrchTaskLike[];
}

/**
 * Build criteria from architecture nodes + optional orch workflow list JSON
 * (from `ruah workflow list --json` / task metadata). Writes `.ruah/verify.json`
 * when there is at least one criterion; with none it writes nothing
 * (`written: false`): a run without criteria already answers "unverifiable",
 * so a placeholder file would only add noise to the repo.
 */
export function syncVerifyJson(options: {
  root: string;
  architecture: Architecture;
  workflows?: OrchWorkflowLike[];
}): { path: string; criteriaCount: number; written: boolean } {
  const criteria: Array<Record<string, unknown>> = [];
  const nodes = options.architecture.nodes ?? [];

  for (const node of nodes) {
    const nodeGlobs = globsForNode(node as ArchNode, options.root);
    for (const wf of options.workflows ?? []) {
      for (const task of wf.tasks ?? []) {
        const files = task.files ?? [];
        if (!taskTouchesNode(files, nodeGlobs)) continue;
        const acceptance = task.acceptanceCriteria ?? [];
        if (acceptance.length === 0) {
          criteria.push({
            id: `node/${node.id}/${task.name ?? "task"}/human`,
            description: `Human review for ${task.name ?? "task"} on ${node.id}`,
            check: { type: "unverifiable", reason: "No machine-checkable acceptance criteria on this task" },
          });
          continue;
        }
        for (let i = 0; i < acceptance.length; i++) {
          const line = acceptance[i] ?? "";
          const cmd = line.match(/`([^`]+)`/)?.[1];
          if (cmd && !cmd.includes("/") && !cmd.startsWith(".")) {
            criteria.push({
              id: `node/${node.id}/${task.name ?? "task"}/${i}`,
              description: line,
              check: { type: "command", cmd },
            });
          } else if (cmd && (cmd.includes("/") || cmd.startsWith("."))) {
            criteria.push({
              id: `node/${node.id}/${task.name ?? "task"}/${i}`,
              description: line,
              check: { type: "file_exists", path: cmd },
            });
          } else if (/tests?\s+pass/i.test(line)) {
            criteria.push({
              id: `node/${node.id}/${task.name ?? "task"}/${i}`,
              description: line,
              check: { type: "tests_pass" },
            });
          } else if (/build\s+pass/i.test(line)) {
            criteria.push({
              id: `node/${node.id}/${task.name ?? "task"}/${i}`,
              description: line,
              check: { type: "build_passes" },
            });
          } else {
            criteria.push({
              id: `node/${node.id}/${task.name ?? "task"}/${i}`,
              description: line,
              check: { type: "unverifiable", reason: line || "Not machine-checkable" },
            });
          }
        }
      }
    }
  }

  const outPath = path.join(options.root, VERIFY_FILE);
  if (criteria.length === 0) return { path: outPath, criteriaCount: 0, written: false };
  // An explicit action (Sync criteria): the committable file, plus the .gitignore for caches.
  atomicWriteFileSync(outPath, `${JSON.stringify({ schemaVersion: "1", criteria }, null, 2)}\n`);
  ensureRuahGitignore(options.root);
  return { path: outPath, criteriaCount: criteria.length, written: true };
}

/**
 * Whether `.ruah/verify.json` is exactly the placeholder older versions wrote
 * on their own (no criteria at all). Reads only.
 */
export function isPlaceholderVerifyJson(root: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, VERIFY_FILE), "utf8")) as unknown;
    return JSON.stringify(parsed) === JSON.stringify(PLACEHOLDER_DOC);
  } catch {
    return false;
  }
}

/**
 * Deletes `.ruah/verify.json` when it is exactly that placeholder (an explicit
 * user action: "Remove it"), and `.ruah/` too when that leaves it empty.
 * Returns whether the file was removed; anything else is left alone.
 */
export function removePlaceholderVerifyJson(root: string): boolean {
  if (!isPlaceholderVerifyJson(root)) return false;
  fs.rmSync(path.join(root, VERIFY_FILE), { force: true });
  removeIfEmpty(path.join(root, ".ruah"));
  return true;
}

function readCriteria(criteriaPath: string): Array<{ id?: string }> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(criteriaPath, "utf8")) as { criteria?: unknown };
    return Array.isArray(raw.criteria) ? (raw.criteria as Array<{ id?: string }>) : [];
  } catch {
    return undefined;
  }
}

/**
 * Whether the repo has criteria worth running after a turn: `.ruah/verify.json`
 * exists and is not just the placeholder older versions wrote on their own.
 */
export function hasVerifyCriteria(root: string): boolean {
  const criteria = readCriteria(path.join(root, VERIFY_FILE));
  return criteria !== undefined && criteria.some((c) => c.id !== PLACEHOLDER_ID);
}

/** The node's criteria as their own file in `cacheDir` (never in the repo); null when it has none. */
export function filterCriteriaForNode(criteriaPath: string, nodeId: string, cacheDir: string): string | null {
  const all = readCriteria(criteriaPath);
  if (all === undefined) return null;
  const prefix = `node/${nodeId}/`;
  const filtered = all.filter((c) => typeof c.id === "string" && c.id.startsWith(prefix));
  if (filtered.length === 0) return null;
  const out = path.join(cacheDir, `verify-${nodeId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.json`);
  atomicWriteFileSync(out, `${JSON.stringify({ schemaVersion: "1", criteria: filtered }, null, 2)}\n`);
  return out;
}

export async function runVerifyForNode(options: {
  root: string;
  nodeId: string;
  deps?: EngineCliDeps;
  /** Where badges and criteria slices are cached: $RUAH_HOME/projects/<id>/cache. */
  stateDir: string;
}): Promise<NodeVerifyState> {
  const criteriaRoot = path.join(options.root, VERIFY_FILE);
  if (!fs.existsSync(criteriaRoot)) {
    // Nothing is written into the repo on a run: criteria come from Sync criteria (or by hand).
    const state: NodeVerifyState = {
      nodeId: options.nodeId,
      badge: "unverifiable",
      detail: "No acceptance criteria yet: Sync criteria writes .ruah/verify.json (commit it to share them).",
      verifiedAt: new Date().toISOString(),
    };
    persistNodeState(options.root, options.nodeId, state, options.stateDir);
    return state;
  }
  const criteriaFile = filterCriteriaForNode(criteriaRoot, options.nodeId, options.stateDir) ?? criteriaRoot;

  const result = await runEngineJson<VerifyReportLike>("verify", ["run", "--criteria", criteriaFile], {
    cwd: options.root,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });

  if (!result.ok) {
    const state: NodeVerifyState = {
      nodeId: options.nodeId,
      badge: badgeFromReport(null, result.error),
      detail: result.error,
      verifiedAt: new Date().toISOString(),
    };
    persistNodeState(options.root, options.nodeId, state, options.stateDir);
    return state;
  }

  const state: NodeVerifyState = {
    nodeId: options.nodeId,
    badge: badgeFromReport(result.data),
    verifiedAt: new Date().toISOString(),
    ...(result.data.verdict !== undefined ? { verdict: result.data.verdict } : {}),
    ...(result.data.summary !== undefined
      ? { detail: `${result.data.summary.failed ?? 0} failed, ${result.data.summary.unverifiable ?? 0} unverifiable` }
      : {}),
  };
  persistNodeState(options.root, options.nodeId, state, options.stateDir);
  return state;
}

function readStateFile(file: string): Record<string, NodeVerifyState> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, NodeVerifyState>) : {};
  } catch {
    return {};
  }
}

function persistNodeState(root: string, nodeId: string, state: NodeVerifyState, stateDir: string): void {
  migrateLegacyRepoCache(root, stateDir);
  const file = path.join(stateDir, STATE_FILE);
  const map = readStateFile(file);
  map[nodeId] = state;
  atomicWriteFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

/** Node badges of the repo at `root`, from the cache in Ruah's home (the old repo cache is moved there once). */
export function loadVerifyState(root: string, stateDir: string): Record<string, NodeVerifyState> {
  migrateLegacyRepoCache(root, stateDir);
  return readStateFile(path.join(stateDir, STATE_FILE));
}

/** What an older Ruah left in the repo that the user may want to act on (§21.3); undefined when nothing. */
export interface LegacyRepoFiles {
  /** `.ruah/verify.json` is only the placeholder older versions wrote on their own: offer to remove it. */
  placeholderCriteria?: string;
  /** Ruah's own old cache files still in the repo, repo-relative: committed ones (left for the user) or ones it could not delete. */
  leftover?: string[];
}

/** Reads only: the placeholder check each time, the leftovers as the one-time move recorded them. */
export function legacyRepoFiles(root: string, stateDir: string): LegacyRepoFiles | undefined {
  const out: LegacyRepoFiles = {};
  if (isPlaceholderVerifyJson(root)) out.placeholderCriteria = VERIFY_FILE;
  const leftover = readMigration(stateDir)?.leftover?.filter((rel) => fs.existsSync(path.join(root, rel))) ?? [];
  if (leftover.length > 0) out.leftover = leftover;
  return out.placeholderCriteria !== undefined || out.leftover !== undefined ? out : undefined;
}

/** A criteria slice older versions wrote to `.ruah/.cache/verify-<node>.json`. */
function isRuahCriteriaSlice(file: string): boolean {
  const criteria = readCriteria(file);
  return criteria !== undefined && criteria.length > 0 && criteria.every((c) => typeof c.id === "string" && c.id.startsWith("node/"));
}

/** An eval spec older versions wrote to `.ruah/evals/node-<id>.json`. */
function isRuahEvalSpec(file: string): boolean {
  try {
    const spec = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; task?: unknown; executors?: unknown };
    return typeof spec.name === "string" && spec.name.startsWith("node-") && Array.isArray(spec.executors) && spec.task !== undefined;
  } catch {
    return false;
  }
}

interface MigrationRecord {
  version: 1;
  migratedAt: string;
  /** Repo-relative files moved or deleted. */
  moved: string[];
  /** Repo-relative Ruah files left in the repo (committed, or not removable). */
  leftover?: string[];
}

function readMigration(stateDir: string): MigrationRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, MIGRATION_FILE), "utf8")) as MigrationRecord;
    return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.moved) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // gone already, or not ours to remove
  }
}

/**
 * Once per project (recorded in `stateDir`), moves what older versions left in
 * the repo out of it: the badges in `.ruah/.cache/verify-nodes.json` into
 * `stateDir` (entries already there win), the `verify-<node>.json` criteria
 * slices deleted, eval specs and results in `.ruah/evals/` moved to
 * `stateDir/evals`, and each of those folders (and `.ruah/`) removed when that
 * leaves it empty. Only Ruah's own, uncommitted files are touched (a committed
 * one is copied but kept, and reported as a leftover); nothing is created in
 * the repo (no `.gitignore`), and later reads do not write anything at all.
 * Returns whether the move ran now. Never throws.
 */
export function migrateLegacyRepoCache(root: string, stateDir: string, options: { tracked?: (root: string) => Set<string> } = {}): boolean {
  if (fs.existsSync(path.join(stateDir, MIGRATION_FILE))) return false;
  const ruahDir = path.join(root, ".ruah");
  const cacheDir = path.join(ruahDir, ".cache");
  const evalsDir = path.join(ruahDir, "evals");
  const moved: string[] = [];
  const leftover: string[] = [];
  const rel = (file: string): string => path.relative(root, file).split(path.sep).join("/");
  // A committed file is left where it is (deleting it would be a change in the user's git
  // status): reported as a leftover for the user to remove. Asked only when there is anything
  // to move.
  const tracked = fs.existsSync(cacheDir) || fs.existsSync(evalsDir) ? (options.tracked ?? gitTrackedUnder)(root) : new Set<string>();
  const remove = (file: string): void => {
    if (tracked.has(rel(file))) {
      leftover.push(rel(file));
      return;
    }
    try {
      fs.rmSync(file);
      moved.push(rel(file));
    } catch {
      leftover.push(rel(file));
    }
  };

  const legacyState = path.join(cacheDir, STATE_FILE);
  if (fs.existsSync(legacyState)) {
    const badges = readStateFile(legacyState);
    try {
      if (Object.keys(badges).length > 0) {
        const target = path.join(stateDir, STATE_FILE);
        atomicWriteFileSync(target, `${JSON.stringify({ ...badges, ...readStateFile(target) }, null, 2)}\n`);
      }
      remove(legacyState);
    } catch {
      return false; // home not writable: try again on the next read
    }
  }
  for (const name of safeList(cacheDir)) {
    if (name === STATE_FILE || !/^verify-.+\.json$/.test(name)) continue;
    const file = path.join(cacheDir, name);
    if (isRuahCriteriaSlice(file)) remove(file);
  }

  for (const name of safeList(evalsDir)) {
    const file = path.join(evalsDir, name);
    const spec = /^node-.+\.json$/.test(name) && isRuahEvalSpec(file);
    if (!spec && !/^results-.+-\d{10,}\.json$/.test(name)) continue;
    const target = path.join(stateDir, "evals", name);
    try {
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
      }
    } catch {
      continue; // keep it in the repo rather than lose a result
    }
    remove(file);
  }

  if (moved.length > 0) {
    // Only folders this move emptied: an empty folder that was there before is left as it was.
    removeIfEmpty(cacheDir);
    removeIfEmpty(evalsDir);
    removeIfEmpty(ruahDir);
  }
  try {
    const record: MigrationRecord = { version: 1, migratedAt: new Date().toISOString(), moved, ...(leftover.length > 0 ? { leftover } : {}) };
    atomicWriteFileSync(path.join(stateDir, MIGRATION_FILE), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // home not writable: the move is tried again next time (it only touches what is still there)
  }
  return true;
}

/** Repo-relative paths git tracks under `.ruah/` (empty when git or the repo is not there). */
function gitTrackedUnder(root: string): Set<string> {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--", ".ruah"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.split("\0").filter((line) => line.length > 0));
  } catch {
    return new Set();
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
