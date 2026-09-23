// Edges of the current level: routed once per layout (routing.ts), culled to the viewport,
// emphasised around the focus (selection / hover), quiet elsewhere (never below 60 %).
// Labels appear on hover, on emphasised edges, or when zoomed in on an uncrowded view.
import { memo } from "react";
import type { DiagramEdge } from "@/data/graphs";
import { cn } from "@/lib/utils";
import { intersects, type Box, type Lod } from "./geometry";
import type { Route } from "./routing";

export type EdgeRef = { from: string; to: string };

type Props = {
  edges: readonly DiagramEdge[];
  routes: readonly (Route | null)[];
  cull: Box | null;
  lod: Lod;
  /** Which labels the zoom allows: every label (uncrowded), only emphasised edges, or none. */
  labels: "all" | "focus" | "none";
  focusId: string | null;
  selectedEdge: EdgeRef | null;
  hoverEdge: number | null;
  onHoverEdge: (i: number | null) => void;
  onSelectEdge: (edge: EdgeRef) => void;
};

function labelWidth(text: string) {
  return text.length * 6.2 + 12;
}

function EdgeLayerImpl({ edges, routes, cull, lod, labels, focusId, selectedEdge, hoverEdge, onHoverEdge, onSelectEdge }: Props) {
  const visible: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const r = routes[i];
    if (!r) continue;
    if (cull && !intersects(cull, r.box)) continue;
    visible.push(i);
  }
  const crowded = visible.length > 120;
  const quietLabels = labels === "all" && !crowded;
  const animateIdle = lod === "full" && visible.length <= 150;
  const hit = lod === "full";

  const idle: number[] = [];
  const hot: number[] = [];
  for (const i of visible) {
    const e = edges[i]!;
    const isSel = selectedEdge?.from === e.from && selectedEdge.to === e.to;
    if (isSel || i === hoverEdge || (focusId !== null && (e.from === focusId || e.to === focusId))) hot.push(i);
    else idle.push(i);
  }
  const dimIdle = focusId !== null || hoverEdge !== null;
  const width = (e: DiagramEdge, active: boolean) =>
    (active ? 2 : lod === "full" ? 1.3 : 1.1) + Math.min(1.6, Math.log2(Math.max(1, e.weight ?? 1)) * 0.45);

  const label = (i: number, active: boolean) => {
    const e = edges[i]!;
    const r = routes[i]!;
    if (!e.label) return null;
    if (!(active ? labels !== "none" : quietLabels)) return null;
    const w = labelWidth(e.label);
    return (
      <g key={`l${i}`} pointerEvents="none">
        <rect
          x={r.lx - w / 2}
          y={r.ly - 9}
          width={w}
          height={17}
          rx={4}
          fill="var(--canvas)"
          stroke={active ? "var(--edge-active)" : "var(--hairline)"}
          strokeOpacity={active ? 0.55 : 0.8}
        />
        <text
          x={r.lx}
          y={r.ly + 3.5}
          textAnchor="middle"
          className="font-mono"
          fontSize={9.5}
          fill={active ? "var(--edge-active)" : "var(--muted-foreground)"}
        >
          {e.label}
        </text>
      </g>
    );
  };

  return (
    <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <defs>
        <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill="var(--edge)" />
        </marker>
        <marker id="arrow-active" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill="var(--edge-active)" />
        </marker>
      </defs>
      <g opacity={dimIdle || crowded ? 0.6 : 0.95}>
        {idle.map((i) => {
          const e = edges[i]!;
          return (
            <path
              key={i}
              d={routes[i]!.d}
              fill="none"
              stroke="var(--edge)"
              strokeWidth={width(e, false)}
              vectorEffect="non-scaling-stroke"
              markerEnd={lod === "tiny" ? undefined : "url(#arrow)"}
              className={e.animated && animateIdle ? "edge-flow" : undefined}
            />
          );
        })}
        {idle.map((i) => label(i, false))}
      </g>
      <g>
        {hot.map((i) => {
          const e = edges[i]!;
          return (
            <path
              key={i}
              d={routes[i]!.d}
              fill="none"
              stroke="var(--edge-active)"
              strokeWidth={width(e, true)}
              vectorEffect="non-scaling-stroke"
              markerEnd="url(#arrow-active)"
              className="edge-flow"
            />
          );
        })}
        {hot.map((i) => label(i, true))}
      </g>
      {hit ? (
        <g className="pointer-events-auto">
          {visible.map((i) => {
            const e = edges[i]!;
            return (
              <path
                key={`h${i}`}
                d={routes[i]!.d}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                className={cn("cursor-pointer")}
                onPointerDown={(ev) => ev.stopPropagation()}
                onMouseEnter={() => onHoverEdge(i)}
                onMouseLeave={() => onHoverEdge(null)}
                onClick={() => onSelectEdge({ from: e.from, to: e.to })}
              >
                <title>{e.label ? `${e.label}${e.weight && e.weight > 1 ? ` ×${e.weight}` : ""}` : "link"}</title>
              </path>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}

export const EdgeLayer = memo(EdgeLayerImpl);
