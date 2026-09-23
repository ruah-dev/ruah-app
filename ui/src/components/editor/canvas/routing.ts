// Edge routing for the map: orthogonal paths with rounded corners.
// - Ports are spread along each node side, ordered by where the other end is, so parallel
//   edges do not pile up on one point.
// - A simple Z route is used when it crosses no other element; otherwise the edge runs in the
//   gutters between elements (the column gap next to each end and the row gap next to the
//   target), which never cross cards on grid layouts. Edges sharing a gutter read as a bundle.
// Pure; recomputed only when nodes or edges change (a spatial hash keeps it ~O(E)).
import type { Box } from "./geometry";

export type Side = "left" | "right" | "top" | "bottom";

export type Route = {
  d: string;
  /** Label anchor: middle of the route's middle segment. */
  lx: number;
  ly: number;
  /** Bounding box, for viewport culling. */
  box: Box;
};

type Pt = { x: number; y: number };

const MIN_GAP = 14;
const RADIUS = 10;
const GUTTER = 22;
const CELL = 256;

type Plan = { fromSide: Side; toSide: Side } | null;

function plan(a: Box, b: Box): Plan {
  const gapRight = b.x - (a.x + a.w);
  const gapLeft = a.x - (b.x + b.w);
  const gapDown = b.y - (a.y + a.h);
  const gapUp = a.y - (b.y + b.h);
  const gx = Math.max(gapRight, gapLeft);
  const gy = Math.max(gapDown, gapUp);
  if (gx >= MIN_GAP && (gx >= gy || gy < MIN_GAP)) {
    return gapRight >= gapLeft ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  if (gy >= MIN_GAP) return gapDown >= gapUp ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
  return null; // overlapping boxes: a straight line between centres
}

const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Spatial hash of element boxes for "does this segment cross an element?". */
class Obstacles {
  private readonly cells = new Map<string, { id: string; b: Box }[]>();
  constructor(boxes: ReadonlyMap<string, Box>) {
    for (const [id, b] of boxes) {
      for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
        for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) {
          const k = `${cx},${cy}`;
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push({ id, b });
        }
      }
    }
  }
  /** Axis-aligned segment p→q crosses a box other than `skipA` / `skipB`. */
  hits(p: Pt, q: Pt, skipA: string, skipB: string): boolean {
    const minX = Math.min(p.x, q.x);
    const maxX = Math.max(p.x, q.x);
    const minY = Math.min(p.y, q.y);
    const maxY = Math.max(p.y, q.y);
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        for (const { id, b } of this.cells.get(`${cx},${cy}`) ?? []) {
          if (id === skipA || id === skipB) continue;
          if (maxX > b.x + 2 && minX < b.x + b.w - 2 && maxY > b.y + 2 && minY < b.y + b.h - 2) return true;
        }
      }
    }
    return false;
  }
  pathHits(pts: Pt[], a: string, b: string): boolean {
    for (let i = 0; i + 1 < pts.length; i++) if (this.hits(pts[i]!, pts[i + 1]!, a, b)) return true;
    return false;
  }
}

/** Rounded orthogonal polyline through `pts`. */
function roundedPath(pts: Pt[]): string {
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const n = pts[i + 1]!;
    const inLen = Math.hypot(c.x - p.x, c.y - p.y);
    const outLen = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(RADIUS, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${c.x} ${c.y}`;
      continue;
    }
    const ax = c.x - ((c.x - p.x) / inLen) * r;
    const ay = c.y - ((c.y - p.y) / inLen) * r;
    const bx = c.x + ((n.x - c.x) / outLen) * r;
    const by = c.y + ((n.y - c.y) / outLen) * r;
    d += ` L ${ax} ${ay} Q ${c.x} ${c.y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

/** Drop zero-length segments and merge collinear points. */
function clean(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) out.splice(i, 1);
  }
  return out;
}

export function routeEdges(boxes: ReadonlyMap<string, Box>, edges: readonly { from: string; to: string }[]): (Route | null)[] {
  const plans = edges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    return a && b ? plan(a, b) : null;
  });

  // Ports: every (node, side) gets its endpoints spread along the side, ordered by the other end.
  type Slot = { edge: number; end: "from" | "to"; key: number };
  const sides = new Map<string, Slot[]>();
  edges.forEach((e, i) => {
    const p = plans[i];
    if (!p) return;
    const ca = center(boxes.get(e.from)!);
    const cb = center(boxes.get(e.to)!);
    const horizontal = p.fromSide === "left" || p.fromSide === "right";
    const push = (node: string, side: Side, end: "from" | "to", other: Pt) => {
      const k = `${node}\u0000${side}`;
      (sides.get(k) ?? sides.set(k, []).get(k)!).push({ edge: i, end, key: horizontal ? other.y : other.x });
    };
    push(e.from, p.fromSide, "from", cb);
    push(e.to, p.toSide, "to", ca);
  });
  const ports = new Map<string, Pt>(); // `${edge}:${end}`
  for (const [k, slots] of sides) {
    const [node, side] = k.split("\u0000") as [string, Side];
    const b = boxes.get(node)!;
    slots.sort((s, t) => s.key - t.key || s.edge - t.edge);
    const along = side === "left" || side === "right" ? b.h : b.w;
    const span = slots.length > 1 ? along * Math.min(0.64, 0.12 * (slots.length - 1)) : 0;
    slots.forEach((s, i) => {
      const t = slots.length > 1 ? i / (slots.length - 1) - 0.5 : 0;
      const off = t * span;
      const p =
        side === "left" ? { x: b.x, y: b.y + b.h / 2 + off }
        : side === "right" ? { x: b.x + b.w, y: b.y + b.h / 2 + off }
        : side === "top" ? { x: b.x + b.w / 2 + off, y: b.y }
        : { x: b.x + b.w / 2 + off, y: b.y + b.h };
      ports.set(`${s.edge}:${s.end}`, p);
    });
  }

  const obstacles = boxes.size > 2 ? new Obstacles(boxes) : null;

  return edges.map((e, i) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return null;
    const p = plans[i];
    let pts: Pt[];
    if (!p) {
      pts = [center(a), center(b)];
    } else {
      const s = ports.get(`${i}:from`)!;
      const t = ports.get(`${i}:to`)!;
      if (p.fromSide === "left" || p.fromSide === "right") {
        const dir = p.fromSide === "right" ? 1 : -1;
        // Z route with its vertical run in the gutter next to the target.
        const mx = Math.abs(t.x - s.x) > GUTTER * 3 ? t.x - dir * GUTTER : (s.x + t.x) / 2;
        pts = clean([s, { x: mx, y: s.y }, { x: mx, y: t.y }, t]);
        if (obstacles?.pathHits(pts, e.from, e.to)) {
          // Gutter route: out to the column gap, along the row gap next to the target, back in.
          const x1 = s.x + dir * GUTTER;
          const x2 = t.x - dir * GUTTER;
          const yc = t.y >= s.y ? b.y - GUTTER : b.y + b.h + GUTTER;
          const alt = clean([s, { x: x1, y: s.y }, { x: x1, y: yc }, { x: x2, y: yc }, { x: x2, y: t.y }, t]);
          const yc2 = t.y >= s.y ? a.y + a.h + GUTTER : a.y - GUTTER;
          const alt2 = clean([s, { x: x1, y: s.y }, { x: x1, y: yc2 }, { x: x2, y: yc2 }, { x: x2, y: t.y }, t]);
          pts = !obstacles.pathHits(alt, e.from, e.to) ? alt : !obstacles.pathHits(alt2, e.from, e.to) ? alt2 : alt;
        }
      } else {
        const dir = p.fromSide === "bottom" ? 1 : -1;
        const my = Math.abs(t.y - s.y) > GUTTER * 3 ? t.y - dir * GUTTER : (s.y + t.y) / 2;
        pts = clean([s, { x: s.x, y: my }, { x: t.x, y: my }, t]);
        if (obstacles?.pathHits(pts, e.from, e.to)) {
          const y1 = s.y + dir * GUTTER;
          const y2 = t.y - dir * GUTTER;
          const xc = t.x >= s.x ? b.x - GUTTER : b.x + b.w + GUTTER;
          const alt = clean([s, { x: s.x, y: y1 }, { x: xc, y: y1 }, { x: xc, y: y2 }, { x: t.x, y: y2 }, t]);
          const xc2 = t.x >= s.x ? a.x + a.w + GUTTER : a.x - GUTTER;
          const alt2 = clean([s, { x: s.x, y: y1 }, { x: xc2, y: y1 }, { x: xc2, y: y2 }, { x: t.x, y: y2 }, t]);
          pts = !obstacles.pathHits(alt, e.from, e.to) ? alt : !obstacles.pathHits(alt2, e.from, e.to) ? alt2 : alt;
        }
      }
    }
    // Label on the longest segment (the one most likely to have room).
    let li = 0;
    let best = -1;
    for (let j = 0; j + 1 < pts.length; j++) {
      const len = Math.abs(pts[j + 1]!.x - pts[j]!.x) + Math.abs(pts[j + 1]!.y - pts[j]!.y);
      if (len > best) {
        best = len;
        li = j;
      }
    }
    const mid = { x: (pts[li]!.x + pts[li + 1]!.x) / 2, y: (pts[li]!.y + pts[li + 1]!.y) / 2 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of pts) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
    return {
      d: pts.length === 2 ? `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}` : roundedPath(pts),
      lx: mid.x,
      ly: mid.y,
      box: { x: minX - 4, y: minY - 4, w: maxX - minX + 8, h: maxY - minY + 8 },
    };
  });
}
