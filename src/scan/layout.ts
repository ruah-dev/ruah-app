// Deterministic layered layout for scanned architectures (PLAN.md 2.3).
//
// Each drill-down level (nodes sharing a `parent`) is laid out on its own.
// Layers are horizontal bands in `layers` order (unlayered nodes last); inside
// a band nodes are ordered by type column (frontend/external → gateway →
// service/module → datastore/queue, the same rule as src/serve/layout.ts), then
// by id, on a 260 × 110 px grid wrapping after MAX_PER_ROW. Nodes that already
// have x and y keep them.
//
// Re-scans (hand-kept positions): new nodes must not land on the kept ones. A
// new node whose band already has kept members extends that band to the right
// (first free slot on the band's first row); a band with no kept member (e.g.
// the IaC "infra" band appearing on a map made before §11) is stacked below
// everything the level already has. Without this, the fresh band layout put a
// new band at the y of an existing one and the two lanes overlapped.
import type { Architecture, ArchNode } from "../contracts/architecture.js";
import { typeColumn } from "../serve/layout.js";

export const COL_W = 260;
export const ROW_H = 110;
export const BAND_GAP = 60;
export const MAX_PER_ROW = 6;

type Point = { x: number; y: number };

const positioned = (n: ArchNode): n is ArchNode & { x: number; y: number } => n.x !== undefined && n.y !== undefined;

export function layoutArchitecture(arch: Architecture): Architecture {
  const layerIndex = new Map((arch.layers ?? []).map((l, i) => [l, i]));
  const bandOf = (n: ArchNode): number =>
    n.layer !== undefined ? (layerIndex.get(n.layer) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  const byLevel = new Map<string, ArchNode[]>();
  for (const n of arch.nodes) {
    const key = n.parent ?? "";
    const list = byLevel.get(key) ?? [];
    list.push(n);
    byLevel.set(key, list);
  }
  const pos = new Map<string, Point>();
  for (const nodes of byLevel.values()) {
    const kept = nodes.filter(positioned);
    const bands = new Map<number, ArchNode[]>();
    for (const n of nodes) {
      if (kept.length > 0 && positioned(n)) continue;
      const b = bandOf(n);
      const list = bands.get(b) ?? [];
      list.push(n);
      bands.set(b, list);
    }
    const order = [...bands.keys()].sort((a, c) => a - c);
    const sortBand = (band: ArchNode[]): ArchNode[] =>
      band.sort((a, c) => typeColumn(a.type) - typeColumn(c.type) || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    if (kept.length === 0) {
      let y = 0;
      for (const b of order) {
        const band = sortBand(bands.get(b) ?? []);
        band.forEach((n, i) => {
          pos.set(n.id, { x: (i % MAX_PER_ROW) * COL_W, y: y + Math.floor(i / MAX_PER_ROW) * ROW_H });
        });
        y += Math.ceil(band.length / MAX_PER_ROW) * ROW_H + BAND_GAP;
      }
      continue;
    }
    const taken: Point[] = kept.map((n) => ({ x: n.x, y: n.y }));
    const free = (p: Point): boolean => taken.every((t) => Math.abs(t.x - p.x) >= COL_W || Math.abs(t.y - p.y) >= ROW_H);
    let bottom = Math.max(...kept.map((n) => n.y)) + ROW_H;
    for (const b of order) {
      const band = sortBand(bands.get(b) ?? []);
      const lane = kept.filter((n) => bandOf(n) === b);
      if (lane.length > 0) {
        // Extend the existing lane to the right, on its first row.
        const y = Math.min(...lane.map((n) => n.y));
        let x = Math.max(...lane.filter((n) => Math.abs(n.y - y) < ROW_H).map((n) => n.x)) + COL_W;
        for (const n of band) {
          while (!free({ x, y })) x += COL_W;
          const p = { x, y };
          pos.set(n.id, p);
          taken.push(p);
          x += COL_W;
        }
        continue;
      }
      // A new lane: below everything this level already has.
      const y0 = bottom + BAND_GAP;
      band.forEach((n, i) => {
        const p = { x: (i % MAX_PER_ROW) * COL_W, y: y0 + Math.floor(i / MAX_PER_ROW) * ROW_H };
        pos.set(n.id, p);
        taken.push(p);
      });
      bottom = y0 + Math.ceil(band.length / MAX_PER_ROW) * ROW_H;
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
