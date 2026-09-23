// Context-pack scope for any element id (CONTRACTS.md §3 + §1.6): stored
// nodes as before; expanded folders, files and symbols are resolved through
// the expander and spliced into a copy of the architecture (with the levels
// above them), so buildContextPack sees parent, siblings and edges as usual.
import type { Architecture, ArchNode } from "../contracts/architecture.js";
import { ArchIndex } from "../context/graph.js";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import { expanderFor, isExpandedId } from "./index.js";

export interface NodeScope {
  index: ArchIndex;
  node: ArchNode;
}

export function resolveNodeScope(store: ArchitectureStore, arch: Architecture, nodeId: string): NodeScope | null {
  const index = new ArchIndex(arch, store.root);
  const stored = index.byId(nodeId);
  if (stored !== undefined) return { index, node: stored };
  if (!isExpandedId(nodeId)) return null;
  let located;
  try {
    located = expanderFor(store).locate(arch, nodeId);
  } catch {
    return null;
  }
  if (located === null) return null;
  const nodes = [...arch.nodes];
  const edges = [...arch.edges];
  const seen = new Set(nodes.map((n) => n.id));
  for (const level of located.chain) {
    for (const n of level.architecture.nodes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      // Children point at the element they were expanded from; plain ArchNode fields only.
      const { expandable: _e, childCount: _c, symbol: _s, test: _t, ...plain } = n;
      nodes.push({ ...plain, parent: level.nodeId });
    }
    for (const e of level.architecture.edges) {
      const { weight: _w, ...plain } = e;
      edges.push(plain);
    }
  }
  const scoped = new ArchIndex({ ...arch, nodes, edges }, store.root);
  const node = scoped.byId(nodeId);
  return node === undefined ? null : { index: scoped, node };
}
