// "Pin to map" (CONTRACTS.md §1.6): copy an expanded folder level into architecture.json as
// ordinary stored nodes (valid ids, children of the expanded element) with `source: "scan"`
// import edges. Saved through the normal architecture.save path. Pure.
import type { Architecture, ArchEdge, ArchNode } from "./contracts";
import type { ExpandedNode, Expansion } from "./expand";

const ID_RE = /^([a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,63}$/;

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return out === "" ? "node" : out;
}

export function pinExpansion(
  arch: Architecture,
  expansion: Expansion,
  positions: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): { arch: Architecture } | { error: string } {
  const parent = arch.nodes.find((n) => n.id === expansion.nodeId);
  if (!parent) return { error: "Pin the level above first: only levels directly below a stored element can be pinned." };
  if (expansion.level !== "folder") return { error: "Symbols stay live from the source; only folder levels can be pinned." };
  if (arch.nodes.some((n) => n.parent === parent.id)) return { error: "This element already has stored children." };

  // Keep a system namespace ("repo:") and derive the rest from the parent id and the entry name.
  const colon = parent.id.indexOf(":");
  const ns = colon === -1 ? "" : parent.id.slice(0, colon + 1);
  const base = colon === -1 ? parent.id : parent.id.slice(colon + 1);
  const used = new Set(arch.nodes.map((n) => n.id));
  const ids = new Map<string, string>();
  for (const n of expansion.architecture.nodes) {
    const stem = slug(`${base}.${n.name.replace(/\//g, ".")}`).slice(0, 60);
    let id = `${ns}${stem}`;
    for (let i = 2; used.has(id) || !ID_RE.test(id); i++) id = `${ns}${stem.slice(0, 58)}-${i}`;
    used.add(id);
    ids.set(n.id, id);
  }
  const layers = [...(arch.layers ?? [])];
  const nodes: ArchNode[] = expansion.architecture.nodes.map((n: ExpandedNode) => {
    const pos = positions.get(n.id);
    if (n.layer && !layers.includes(n.layer)) layers.push(n.layer);
    return {
      id: ids.get(n.id)!,
      type: n.type,
      name: n.name,
      parent: parent.id,
      ...(n.path !== undefined ? { path: n.path } : {}),
      ...(n.files?.length ? { files: n.files.slice(0, 20) } : {}),
      ...(n.description !== undefined ? { description: n.description } : {}),
      ...(n.layer !== undefined ? { layer: n.layer } : {}),
      ...(parent.repo !== undefined ? { repo: parent.repo } : {}),
      x: pos?.x ?? n.x ?? 0,
      y: pos?.y ?? n.y ?? 0,
    };
  });
  const seen = new Set<string>();
  const edges: ArchEdge[] = [];
  for (const e of expansion.architecture.edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}\u0000${e.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, ...(e.label ? { label: e.label } : {}), ...(e.kind ? { kind: e.kind } : {}), source: "scan" });
  }
  return { arch: { ...arch, ...(layers.length ? { layers } : {}), nodes: [...arch.nodes, ...nodes], edges: [...arch.edges, ...edges] } };
}
