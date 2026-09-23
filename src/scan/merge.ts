// Hand-edit preservation for re-scans (PLAN.md risk table: "hand-editing is
// supported and preserved").
//
// Rule, applied when <repo>/architecture.json already exists and validates:
// 1. A node whose id is in both files keeps the existing file's `description`,
//    `notes`, `x` and `y` (hand edits win over heuristics); everything else
//    (type, name, tech, path, files, layer, parent) is refreshed by the scan.
// 2. An existing node the scan did not produce is kept when it has no `path`
//    (a hand-added concept: an external, a step, a datastore) or when its
//    `path` still exists under `root` (e.g. a level pinned from drill-in, or a
//    folder the user added by hand). Nodes whose path disappeared are dropped — except elements a
//    person or an agent drew (`origin` "user" / "agent", CONTRACTS §1.7): those may describe code
//    that does not exist yet and are always kept. A kept node's missing parent is
//    cleared; its layer is appended to `layers` if the scan lacks it. A scanned node keeps the
//    existing `origin` (an agent-made element the scan now finds stays marked until the user keeps it).
// 3. Existing edges the user owns — `source` "manual", "suggested" or "agent" — are kept
//    when both ends still exist, and replace a scanned edge between the same
//    two nodes (the user's label/kind wins). Existing edges touching a kept
//    hand-added node are kept too. Everything else comes from the scan; an
//    existing edge without `source` predates provenance and counts as scan
//    output (the scanner now writes source "scan" on every edge).
// 4. Existing workflows are kept when every step still exists.
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Architecture, ArchEdge, ArchNode } from "../contracts/architecture.js";

/** A repo-relative path that still exists inside `root` (never outside it). */
function pathStillExists(root: string, rel: string): boolean {
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return false;
  return existsSync(abs);
}

export function mergeWithExisting(scanned: Architecture, existing: Architecture, root?: string): Architecture {
  const old = new Map(existing.nodes.map((n) => [n.id, n]));
  const scannedIds = new Set(scanned.nodes.map((n) => n.id));

  const nodes: ArchNode[] = scanned.nodes.map((n) => {
    const prev = old.get(n.id);
    if (prev === undefined) return n;
    const merged: ArchNode = { ...n };
    if (prev.description !== undefined) merged.description = prev.description;
    if (prev.notes !== undefined) merged.notes = prev.notes;
    if (prev.x !== undefined && prev.y !== undefined) {
      merged.x = prev.x;
      merged.y = prev.y;
    }
    if (prev.origin !== undefined && prev.origin !== "scan") merged.origin = prev.origin;
    return merged;
  });

  const drawn = (n: ArchNode): boolean => n.origin === "agent" || n.origin === "user";
  const kept: ArchNode[] = existing.nodes.filter(
    (n) => !scannedIds.has(n.id) && (drawn(n) || n.path === undefined || (root !== undefined && pathStillExists(root, n.path))),
  );
  const allIds = new Set([...scannedIds, ...kept.map((n) => n.id)]);
  const layers = [...(scanned.layers ?? [])];
  for (const n of kept) {
    const copy: ArchNode = { ...n };
    if (copy.parent !== undefined && !allIds.has(copy.parent)) delete copy.parent;
    if (copy.layer !== undefined && !layers.includes(copy.layer)) layers.push(copy.layer);
    nodes.push(copy);
  }

  const keptIds = new Set(kept.map((n) => n.id));
  const edgeKey = (e: ArchEdge): string => `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
  const owned = (e: ArchEdge): boolean => e.source === "manual" || e.source === "suggested" || e.source === "agent";
  const userEdges = existing.edges.filter((e) => owned(e) && allIds.has(e.from) && allIds.has(e.to));
  const userPairs = new Set(userEdges.map((e) => `${e.from}\u0000${e.to}`));
  // A user edge between the same two nodes supersedes the scanned one.
  const edges = scanned.edges.filter((e) => !userPairs.has(`${e.from}\u0000${e.to}`));
  const seen = new Set(edges.map(edgeKey));
  for (const e of [...userEdges, ...existing.edges.filter((x) => !owned(x))]) {
    if (!owned(e) && !(keptIds.has(e.from) || keptIds.has(e.to))) continue;
    if (!allIds.has(e.from) || !allIds.has(e.to) || seen.has(edgeKey(e))) continue;
    seen.add(edgeKey(e));
    edges.push(e);
  }

  const workflows = existing.workflows.filter((w) => w.steps.every((s) => allIds.has(s)));
  const wfIds = new Set(workflows.map((w) => w.id));
  for (const w of scanned.workflows) if (!wfIds.has(w.id)) workflows.push(w);

  return {
    ...scanned,
    ...(layers.length > 0 ? { layers } : {}),
    nodes,
    edges,
    workflows,
  };
}
