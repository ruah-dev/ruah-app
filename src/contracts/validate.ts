import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture, ArchNode } from "./architecture.js";
import { ArchitectureSchema } from "./architecture.js";

export type ValidationResult =
  | { ok: true; value: Architecture; warnings: string[] }
  | { ok: false; errors: string[] };

// Plain ids, or `<repoId>:<nodeId>` in system (multi-repo) architectures.
export const ID_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,63}$/;

function normalizeRel(p: string): string {
  return path.posix.normalize(p.replaceAll("\\", "/"));
}

function relInsideRoot(p: string): boolean {
  const n = normalizeRel(p);
  return n !== ".." && !n.startsWith("../") && !path.posix.isAbsolute(n) && n !== "." && n.length > 0;
}

// Validates an unknown input as an `Architecture` per CONTRACTS.md §1.2
// (rules 1–7 as errors) and §1.2 warnings (description/files/path).
// `root` enables the on-disk path warning; pass null to skip it.
export function validateArchitecture(
  input: unknown,
  root: string | null = null,
): ValidationResult {
  const parsed = ArchitectureSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const arch = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Rule 2: unique ids; edge/parent/step references exist.
  const ids = new Set<string>();
  for (const node of arch.nodes) {
    if (!ID_PATTERN.test(node.id)) {
      errors.push(`node ${node.id}: id must match ^(<repoId>:)?[a-z0-9][a-z0-9._-]{0,63}$`);
    }
    if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of arch.edges) {
    for (const [field, id] of [["from", edge.from], ["to", edge.to]] as const) {
      if (!ids.has(id)) errors.push(`edge ${field} references unknown node: ${id}`);
    }
  }
  for (const node of arch.nodes) {
    if (node.parent !== undefined && !ids.has(node.parent)) {
      errors.push(`node ${node.id}: parent references unknown node: ${node.parent}`);
    }
  }
  for (const wf of arch.workflows) {
    for (const step of wf.steps) {
      if (!ids.has(step)) errors.push(`workflow ${wf.id}: step references unknown node: ${step}`);
    }
  }

  // Rule 3: parent chains acyclic.
  const parentOf = new Map(arch.nodes.map((n) => [n.id, n.parent]));
  for (const node of arch.nodes) {
    const seen = new Set<string>([node.id]);
    let cur = node.parent;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        errors.push(`node ${node.id}: parent cycle via ${cur}`);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }

  // Rule 4: node.layer appears in layers.
  if (arch.layers !== undefined) {
    const layerSet = new Set(arch.layers);
    for (const node of arch.nodes) {
      if (node.layer !== undefined && !layerSet.has(node.layer)) {
        errors.push(`node ${node.id}: layer "${node.layer}" not in layers`);
      }
    }
  }

  // Rule 5: path/files repo-relative, stay inside repo.
  for (const node of arch.nodes) {
    if (node.path !== undefined && !relOk(node.path)) {
      errors.push(`node ${node.id}: path escapes repo: ${node.path}`);
    }
    for (const f of node.files ?? []) {
      if (!relOk(f)) errors.push(`node ${node.id}: file escapes repo: ${f}`);
    }
  }

  // Rule 6: self-edges and duplicate (from,to,label) triples.
  const seen = new Set<string>();
  for (const edge of arch.edges) {
    if (edge.from === edge.to) errors.push(`self-edge: ${edge.from}`);
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;
    if (seen.has(key)) errors.push(`duplicate edge: ${edge.from} -> ${edge.to} [${edge.label ?? ""}]`);
    seen.add(key);
  }

  // Rule 7: workflow steps >= 2.
  for (const wf of arch.workflows) {
    if (wf.steps.length < 2) errors.push(`workflow ${wf.id}: needs >= 2 steps`);
  }

  // Warnings.
  for (const node of arch.nodes) {
    if (node.description !== undefined && node.description.length > 400) {
      warnings.push(`node ${node.id}: description over 400 chars`);
    }
    if ((node.files?.length ?? 0) > 20) warnings.push(`node ${node.id}: files over 20`);
    if (node.path !== undefined && root !== null) {
      const abs = path.join(root, normalizeRel(node.path));
      if (!fs.existsSync(abs)) warnings.push(`node ${node.id}: path does not exist on disk: ${node.path}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: arch, warnings };
}

function relOk(p: string): boolean {
  const n = normalizeRel(p);
  return n.length > 0 && !path.posix.isAbsolute(n) && n !== ".." && !n.startsWith("../") && n !== ".";
}
