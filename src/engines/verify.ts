// src/engines/verify.ts — sync acceptance criteria into .ruah/verify.json and
// run ruah-verify after agent turns. Verdict mapping: unverifiable is never pass.
//
// What lands in the repo (CONTRACTS §20.3): only `.ruah/verify.json`, and
// only when the user syncs criteria (an explicit action). A run never
// creates it; node badges and the per-node criteria slices are caches in
// $RUAH_HOME/projects/<id>/cache (older versions kept them in the repo's
// `.ruah/.cache/`: moved out on first read).
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
 * (from `ruah workflow list --json` / task metadata). Writes `.ruah/verify.json`.
 * When no machine-checkable criteria exist, writes an unverifiable placeholder
 * so a later run cannot silently pass.
 */
export function syncVerifyJson(options: {
  root: string;
  architecture: Architecture;
  workflows?: OrchWorkflowLike[];
}): { path: string; criteriaCount: number } {
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

  if (criteria.length === 0) {
    criteria.push({
      id: "workspace/human-review",
      description: "No acceptance criteria linked to map nodes yet",
      check: { type: "unverifiable", reason: "Run ruah verify init or add acceptance on orch workflow tasks" },
    });
  }

  // An explicit action (Sync criteria): the committable file, plus the .gitignore for caches.
  const outPath = path.join(options.root, VERIFY_FILE);
  atomicWriteFileSync(outPath, `${JSON.stringify({ schemaVersion: "1", criteria }, null, 2)}\n`);
  ensureRuahGitignore(options.root);
  return { path: outPath, criteriaCount: criteria.length };
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
  const file = path.join(stateDir, STATE_FILE);
  const map = { ...migrateLegacyVerifyCache(root, stateDir), ...readStateFile(file) };
  map[nodeId] = state;
  atomicWriteFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

/** Node badges of the repo at `root`, from the cache in Ruah's home (the legacy repo cache is moved there first). */
export function loadVerifyState(root: string, stateDir: string): Record<string, NodeVerifyState> {
  const legacy = migrateLegacyVerifyCache(root, stateDir);
  return { ...legacy, ...readStateFile(path.join(stateDir, STATE_FILE)) };
}

/** A criteria slice older versions wrote to `.ruah/.cache/verify-<node>.json`. */
function isRuahCriteriaSlice(file: string): boolean {
  const criteria = readCriteria(file);
  return criteria !== undefined && criteria.length > 0 && criteria.every((c) => typeof c.id === "string" && c.id.startsWith("node/"));
}

/**
 * Moves what older versions cached in the repo (`.ruah/.cache/verify-nodes.json`
 * and the `verify-<node>.json` criteria slices) out of it: the badges into
 * `stateDir` (entries already there win), the Ruah-written files deleted,
 * `.ruah/.cache` removed when that leaves it empty, and `.ruah/.gitignore`
 * made to ignore caches. Anything else in `.ruah/.cache` is left alone.
 * Returns the badges it moved ({} when there was nothing). Never throws.
 */
export function migrateLegacyVerifyCache(root: string, stateDir: string): Record<string, NodeVerifyState> {
  const legacyDir = path.join(root, ".ruah", ".cache");
  const legacyState = path.join(legacyDir, STATE_FILE);
  let names: string[];
  try {
    names = fs.readdirSync(legacyDir);
  } catch {
    return {};
  }
  const moved = fs.existsSync(legacyState) ? readStateFile(legacyState) : {};
  try {
    if (Object.keys(moved).length > 0) {
      const target = path.join(stateDir, STATE_FILE);
      atomicWriteFileSync(target, `${JSON.stringify({ ...moved, ...readStateFile(target) }, null, 2)}\n`);
    }
    if (fs.existsSync(legacyState)) fs.rmSync(legacyState, { force: true });
    for (const name of names) {
      if (name === STATE_FILE || !/^verify-.+\.json$/.test(name)) continue;
      const file = path.join(legacyDir, name);
      if (isRuahCriteriaSlice(file)) fs.rmSync(file, { force: true });
    }
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    ensureRuahGitignore(root);
  } catch {
    // a read-only repo: keep reading the old cache as it is
  }
  return moved;
}
