// Hand-edit preservation for system re-scans (docs/MULTI-REPO.md decision 2:
// "Hand-drawn edges survive re-scans"). Same spirit as src/scan/merge.ts, plus
// edge provenance:
//
// 1. A node in both files keeps the existing `description`, `notes`, `x`, `y`.
// 2. An existing node the scan did not produce is kept only when it is a
//    hand-added concept: no `repo`, no `path`, no `files` (every generated
//    node has one of them) — or an element a person or an agent drew
//    (`origin` "user" / "agent", CONTRACTS §1.7), even inside a repo. Its
//    dangling `parent` is cleared; its layer is appended to `layers` when
//    missing. A scanned node keeps the existing non-scan `origin`.
// 3. Edges: the scan's edges (all `source: "scan"`) replace the old scan
//    edges. Every other existing edge — `manual`, `suggested`, or without a
//    `source` (hand-written JSON, older viewers; normalised to `manual`) — is
//    kept when both ends still exist. When a kept edge has the same
//    (from, to, label) as a scan edge, the kept edge wins (the user decided).
// 4. Existing workflows are kept when every step still exists, except scanned
//    ones (`source: "scan"`, the IaC "how it ships" workflows of §11), which
//    the new scan replaces (as in src/scan/merge.ts); new scanned workflows
//    are added.
import type { ArchEdge, ArchNode, Architecture } from "../contracts/architecture.js";

const edgeKey = (e: ArchEdge): string => `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;

export function isHandAddedNode(n: ArchNode): boolean {
  return n.repo === undefined && n.path === undefined && (n.files === undefined || n.files.length === 0);
}

export function mergeSystemWithExisting(scanned: Architecture, existing: Architecture): Architecture {
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
  const kept = existing.nodes.filter((n) => !scannedIds.has(n.id) && (isHandAddedNode(n) || drawn(n)));
  const allIds = new Set([...scannedIds, ...kept.map((n) => n.id)]);
  const layers = [...(scanned.layers ?? [])];
  for (const n of kept) {
    const copy: ArchNode = { ...n };
    if (copy.parent !== undefined && !allIds.has(copy.parent)) delete copy.parent;
    if (copy.layer !== undefined && !layers.includes(copy.layer)) layers.push(copy.layer);
    nodes.push(copy);
  }

  const userEdges: ArchEdge[] = [];
  const userKeys = new Set<string>();
  for (const e of existing.edges) {
    if (e.source === "scan") continue;
    if (!allIds.has(e.from) || !allIds.has(e.to) || userKeys.has(edgeKey(e))) continue;
    userKeys.add(edgeKey(e));
    userEdges.push(e.source === undefined ? { ...e, source: "manual" } : e);
  }
  const edges = [...scanned.edges.filter((e) => !userKeys.has(edgeKey(e))), ...userEdges];

  const workflows = existing.workflows.filter((w) => w.source !== "scan" && w.steps.every((s) => allIds.has(s)));
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
