// Hand-edit preservation for re-scans (PLAN.md risk table: "hand-editing is
// supported and preserved").
//
// Rule, applied when <repo>/architecture.json already exists and validates:
// 1. A node whose id is in both files keeps the existing file's `description`,
//    `notes`, `x` and `y` (hand edits win over heuristics); everything else
//    (type, name, tech, path, files, layer, parent) is refreshed by the scan.
// 2. An existing node the scan did not produce is kept only when it has no
//    `path` (a hand-added concept: an external, a step, a datastore). Scanned
//    nodes whose path disappeared are dropped. A kept node's missing parent is
//    cleared; its layer is appended to `layers` if the scan lacks it.
// 3. Existing edges touching a kept hand-added node are kept when both ends
//    still exist. All other edges come from the scan.
// 4. Existing workflows are kept when every step still exists.
import type { Architecture, ArchEdge, ArchNode } from "../contracts/architecture.js";

export function mergeWithExisting(scanned: Architecture, existing: Architecture): Architecture {
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
    return merged;
  });

  const kept: ArchNode[] = existing.nodes.filter((n) => !scannedIds.has(n.id) && n.path === undefined);
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
  const edges = [...scanned.edges];
  const seen = new Set(edges.map(edgeKey));
  for (const e of existing.edges) {
    if (!(keptIds.has(e.from) || keptIds.has(e.to))) continue;
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
