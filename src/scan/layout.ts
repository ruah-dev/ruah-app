// Deterministic layered layout for scanned architectures (PLAN.md 2.3).
//
// Each drill-down level (nodes sharing a `parent`) is laid out on its own.
// Layers are horizontal bands in `layers` order (unlayered nodes last); inside
// a band nodes are ordered by type column (frontend/external → gateway →
// service/module → datastore/queue, the same rule as src/serve/layout.ts), then
// by id, on a 260 × 110 px grid wrapping after MAX_PER_ROW. Nodes that already
// have x and y keep them.
import type { Architecture, ArchNode } from "../contracts/architecture.js";
import { typeColumn } from "../serve/layout.js";

export const COL_W = 260;
export const ROW_H = 110;
export const BAND_GAP = 60;
export const MAX_PER_ROW = 6;

export function layoutArchitecture(arch: Architecture): Architecture {
  const layerIndex = new Map((arch.layers ?? []).map((l, i) => [l, i]));
  const byLevel = new Map<string, ArchNode[]>();
  for (const n of arch.nodes) {
    const key = n.parent ?? "";
    const list = byLevel.get(key) ?? [];
    list.push(n);
    byLevel.set(key, list);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const nodes of byLevel.values()) {
    const bands = new Map<number, ArchNode[]>();
    for (const n of nodes) {
      const b = n.layer !== undefined ? (layerIndex.get(n.layer) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const list = bands.get(b) ?? [];
      list.push(n);
      bands.set(b, list);
    }
    let y = 0;
    for (const b of [...bands.keys()].sort((a, c) => a - c)) {
      const band = (bands.get(b) ?? []).sort(
        (a, c) => typeColumn(a.type) - typeColumn(c.type) || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0),
      );
      band.forEach((n, i) => {
        pos.set(n.id, { x: (i % MAX_PER_ROW) * COL_W, y: y + Math.floor(i / MAX_PER_ROW) * ROW_H });
      });
      y += Math.ceil(band.length / MAX_PER_ROW) * ROW_H + BAND_GAP;
    }
  }
  return {
    ...arch,
    nodes: arch.nodes.map((n) => {
      if (n.x !== undefined && n.y !== undefined) return n;
      const p = pos.get(n.id) ?? { x: 0, y: 0 };
      return { ...n, x: p.x, y: p.y };
    }),
  };
}
