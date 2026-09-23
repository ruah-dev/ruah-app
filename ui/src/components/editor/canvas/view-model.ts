// What the canvas actually draws for a diagram: kind / layer filters, "only neighbours of the
// selection", collapsed layer groups (members fold into one card, their edges are merged), and
// search matching. Pure.
import type { DiagramEdge, DiagramGroup, DiagramNode } from "@/data/graphs";
import { NODE_H, NODE_W } from "@/components/explorer/kinds";
import { neighbourhood } from "./geometry";

export type CanvasFilters = {
  hiddenKinds: ReadonlySet<string>;
  hiddenLayers: ReadonlySet<string>;
  collapsedLayers: ReadonlySet<string>;
  /** 0 = off; 1 or 2 = show only elements within that many links of the selection. */
  hops: 0 | 1 | 2;
};

export const NO_FILTERS: CanvasFilters = {
  hiddenKinds: new Set(),
  hiddenLayers: new Set(),
  collapsedLayers: new Set(),
  hops: 0,
};

export const GROUP_NODE_PREFIX = "group:";
export const groupNodeId = (layer: string) => `${GROUP_NODE_PREFIX}${layer}`;
export const isGroupNodeId = (id: string) => id.startsWith(GROUP_NODE_PREFIX);

/** The filter key of a node: its symbol kind on file levels, else its kind. */
export const filterKindOf = (n: DiagramNode) => (n.symbol ? `symbol:${n.symbol.kind}` : n.kind);

export type ViewModel = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  /** Members hidden by filters or hops (for the "n hidden" hint). */
  hidden: number;
};

export function buildViewModel(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  groups: readonly DiagramGroup[],
  f: CanvasFilters,
  selectedId: string | null,
): ViewModel {
  const noFilters =
    f.hiddenKinds.size === 0 && f.hiddenLayers.size === 0 && f.collapsedLayers.size === 0 && f.hops === 0;
  if (noFilters) return { nodes: nodes as DiagramNode[], edges: edges as DiagramEdge[], groups: groups as DiagramGroup[], hidden: 0 };

  let keep = nodes.filter(
    (n) => !f.hiddenKinds.has(filterKindOf(n)) && !(n.layer && f.hiddenLayers.has(n.layer)),
  );
  if (f.hops > 0 && selectedId && keep.some((n) => n.id === selectedId)) {
    const near = neighbourhood(edges, selectedId, f.hops);
    keep = keep.filter((n) => near.has(n.id));
  }
  const hidden = nodes.length - keep.length;
  const kept = new Set(keep.map((n) => n.id));
  let outEdges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));

  // Collapsed layers: one card per layer at the group's corner, edges re-pointed and merged.
  const alias = new Map<string, string>();
  const folded: DiagramNode[] = [];
  const counts = new Map<string, number>();
  for (const n of keep) if (n.layer && f.collapsedLayers.has(n.layer)) counts.set(n.layer, (counts.get(n.layer) ?? 0) + 1);
  for (const [layer, count] of counts) {
    const members = keep.filter((n) => n.layer === layer);
    const minX = Math.min(...members.map((n) => n.x));
    const minY = Math.min(...members.map((n) => n.y));
    const id = groupNodeId(layer);
    for (const m of members) alias.set(m.id, id);
    folded.push({
      id,
      label: layer,
      subtitle: `${count} element${count === 1 ? "" : "s"} · collapsed`,
      kind: "cluster",
      x: minX,
      y: minY,
      w: NODE_W,
      h: NODE_H,
      layer,
      childCount: count,
    });
  }
  if (alias.size > 0) {
    keep = [...keep.filter((n) => !alias.has(n.id)), ...folded];
    const merged = new Map<string, DiagramEdge & { n: number }>();
    for (const e of outEdges) {
      const from = alias.get(e.from) ?? e.from;
      const to = alias.get(e.to) ?? e.to;
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      const cur = merged.get(key);
      if (cur) {
        cur.n += e.weight ?? 1;
        cur.label = `${cur.n} links`;
      } else merged.set(key, { ...e, from, to, n: e.weight ?? 1 });
    }
    outEdges = [...merged.values()].map(({ n, ...e }) => ({ ...e, weight: n }));
  }
  const groupsOut = groups.filter((g) => {
    const layer = g.id.replace(/^layer:/, "");
    return !f.collapsedLayers.has(layer) && !f.hiddenLayers.has(layer) && keep.some((n) => n.layer === layer);
  });
  // Group frames follow the remaining members.
  const fitted = groupsOut.map((g) => {
    const layer = g.id.replace(/^layer:/, "");
    const members = keep.filter((n) => n.layer === layer);
    if (members.length === 0) return g;
    const minX = Math.min(...members.map((n) => n.x));
    const minY = Math.min(...members.map((n) => n.y));
    const maxX = Math.max(...members.map((n) => n.x + (n.w ?? NODE_W)));
    const maxY = Math.max(...members.map((n) => n.y + (n.h ?? NODE_H)));
    return { ...g, x: minX - 24, y: minY - 24, w: maxX - minX + 48, h: maxY - minY + 48 };
  });
  return { nodes: keep, edges: outEdges, groups: fitted, hidden };
}

/** Case-insensitive match on name, path and subtitle; best matches first. */
export function searchNodes(nodes: readonly DiagramNode[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { id: string; s: number }[] = [];
  for (const n of nodes) {
    const label = n.label.toLowerCase();
    let s = -1;
    if (label === q) s = 0;
    else if (label.startsWith(q)) s = 1;
    else if (label.includes(q)) s = 2;
    else if ((n.path ?? "").toLowerCase().includes(q)) s = 3;
    else if ((n.subtitle ?? "").toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) s = 4;
    if (s >= 0) scored.push({ id: n.id, s });
  }
  scored.sort((a, b) => a.s - b.s);
  return scored.map((x) => x.id);
}
