// src/engines/verify.ts — sync acceptance criteria into .ruah/verify.json and
// run ruah-verify after agent turns. Verdict mapping: unverifiable is never pass.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchNode, Architecture } from "../contracts/architecture.js";
import { globsForNode } from "../integrations/ruah.js";
import { runEngineJson, type EngineCliDeps } from "./cli.js";

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

  const outDir = path.join(options.root, ".ruah");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "verify.json");
  fs.writeFileSync(outPath, `${JSON.stringify({ schemaVersion: "1", criteria }, null, 2)}\n`, "utf8");
  return { path: outPath, criteriaCount: criteria.length };
}

export function filterCriteriaForNode(criteriaPath: string, nodeId: string): string | null {
  if (!fs.existsSync(criteriaPath)) return null;
  const raw = JSON.parse(fs.readFileSync(criteriaPath, "utf8")) as { criteria?: Array<{ id?: string }> };
  const all = raw.criteria ?? [];
  const prefix = `node/${nodeId}/`;
  const filtered = all.filter((c) => typeof c.id === "string" && c.id.startsWith(prefix));
  if (filtered.length === 0) return null;
  const cacheDir = path.join(path.dirname(criteriaPath), ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `verify-${nodeId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.json`);
  fs.writeFileSync(out, `${JSON.stringify({ schemaVersion: "1", criteria: filtered }, null, 2)}\n`, "utf8");
  return out;
}

export async function runVerifyForNode(options: {
  root: string;
  nodeId: string;
  deps?: EngineCliDeps;
  stateDir?: string;
}): Promise<NodeVerifyState> {
  const criteriaRoot = path.join(options.root, ".ruah", "verify.json");
  let criteriaFile = filterCriteriaForNode(criteriaRoot, options.nodeId);
  if (!criteriaFile) {
    if (!fs.existsSync(criteriaRoot)) {
      const emptyArch: Architecture = {
        version: 1,
        name: "tmp",
        nodes: [],
        edges: [],
        workflows: [],
      };
      syncVerifyJson({ root: options.root, architecture: emptyArch });
    }
    criteriaFile = criteriaRoot;
  }

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

function persistNodeState(root: string, nodeId: string, state: NodeVerifyState, stateDir?: string): void {
  const dir = stateDir ?? path.join(root, ".ruah", ".cache");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "verify-nodes.json");
  let map: Record<string, NodeVerifyState> = {};
  if (fs.existsSync(file)) {
    try {
      map = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, NodeVerifyState>;
    } catch {
      map = {};
    }
  }
  map[nodeId] = state;
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

export function loadVerifyState(root: string): Record<string, NodeVerifyState> {
  const file = path.join(root, ".ruah", ".cache", "verify-nodes.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, NodeVerifyState>;
  } catch {
    return {};
  }
}
