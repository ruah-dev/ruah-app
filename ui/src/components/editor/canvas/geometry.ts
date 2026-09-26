// Pure geometry for the map canvas: boxes, fitting, viewport culling, spatial keyboard
// navigation and n-hop neighbourhoods. No React.
import type { DiagramEdge, DiagramNode } from "@/data/graphs";
import { NODE_H, NODE_W } from "@/components/explorer/kinds";

export type Box = { x: number; y: number; w: number; h: number };
/**
 * Pan (x, y) and zoom (k). `framed`: the canvas framed the level itself ("Fit to view", a level
 * opened fresh, a filter applied) — such a camera is fitted again when the canvas changes size or
 * the view is restored at another window size. Any pan or zoom by the user drops it (panBy,
 * zoomAround), so a map the user moved is left exactly where they put it.
 */
export type Camera = { x: number; y: number; k: number; framed?: true };

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2.2;

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function nodeBox(n: DiagramNode): Box {
  return { x: n.x, y: n.y, w: n.w ?? NODE_W, h: n.h ?? NODE_H };
}

export function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Camera that shows `b` centred in a `vw`×`vh` viewport with `pad` px margins. */
export function fitCamera(b: Box, vw: number, vh: number, opts: { pad?: number; maxK?: number; minK?: number } = {}): Camera {
  const pad = opts.pad ?? 48;
  const k = Math.min(
    opts.maxK ?? 1,
    Math.max(opts.minK ?? MIN_ZOOM, Math.min((vw - pad * 2) / Math.max(1, b.w), (vh - pad * 2) / Math.max(1, b.h))),
  );
  return { k, x: vw / 2 - (b.x + b.w / 2) * k, y: vh / 2 - (b.y + b.h / 2) * k };
}

/** The fit options the canvas frames a level with ("Fit to view", a level opened fresh). */
export const FIT_ALL = { pad: 56, maxK: 1 } as const;

/** `c` marked as framed by the canvas (see Camera). */
export function asFramed(c: Camera): Camera {
  return { x: c.x, y: c.y, k: c.k, framed: true };
}

/** The camera moved by (dx, dy) screen pixels — the user's own position, never framed. */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { k: c.k, x: c.x + dx, y: c.y + dy };
}

/** The camera zoomed by `factor` around the screen point (sx, sy) — never framed. */
export function zoomAround(c: Camera, sx: number, sy: number, factor: number): Camera {
  const k = clampZoom(c.k * factor);
  const wx = (sx - c.x) / c.k;
  const wy = (sy - c.y) / c.k;
  return { k, x: sx - wx * k, y: sy - wy * k };
}

/**
 * The camera a level opens with: its saved camera as the user left it, or "fit" — nothing saved,
 * the level was drilled into (it opens framed), or the saved camera was a frame taken at another
 * canvas size (it is framed again for the size the canvas has now).
 */
export function restoredCamera(saved: Camera | null | undefined, drilledIn: boolean): Camera | "fit" {
  if (!saved || drilledIn || saved.framed) return "fit";
  return saved;
}

/** The world rectangle visible through the camera. */
export function viewRect(cam: Camera, vw: number, vh: number): Box {
  return { x: -cam.x / cam.k, y: -cam.y / cam.k, w: vw / cam.k, h: vh / cam.k };
}

export function grow(b: Box, fraction: number): Box {
  const dx = b.w * fraction;
  const dy = b.h * fraction;
  return { x: b.x - dx, y: b.y - dy, w: b.w + dx * 2, h: b.h + dy * 2 };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export type Direction = "left" | "right" | "up" | "down";

/** Nearest node in a direction (90° cone, distance plus a penalty for sideways offset). */
export function nearestInDirection(nodes: readonly DiagramNode[], fromId: string, dir: Direction): string | null {
  const from = nodes.find((n) => n.id === fromId);
  if (!from) return null;
  const fb = nodeBox(from);
  const fx = fb.x + fb.w / 2;
  const fy = fb.y + fb.h / 2;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n.id === fromId) continue;
    const b = nodeBox(n);
    const dx = b.x + b.w / 2 - fx;
    const dy = b.y + b.h / 2 - fy;
    const main = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const side = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (main <= 4 || side > main * 1.6 + 40) continue;
    const score = main + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}

/** Ids within `hops` edges of `id` (undirected), including `id`. */
export function neighbourhood(edges: readonly DiagramEdge[], id: string, hops: number): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set([id]);
  let frontier = [id];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const t of adj.get(f) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        next.push(t);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Level of detail from the zoom factor: full cards, compact (bar + name), or tiny blocks. */
export type Lod = "full" | "compact" | "tiny";

export function lodFor(k: number): Lod {
  if (k >= 0.5) return "full";
  if (k >= 0.2) return "compact";
  return "tiny";
}
