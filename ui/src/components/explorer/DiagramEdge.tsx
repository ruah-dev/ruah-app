import type { DiagramEdge as EdgeType, DiagramNode } from "@/data/graphs";
import { NODE_H, NODE_W } from "./kinds";

type Props = {
  edge: EdgeType;
  from: DiagramNode;
  to: DiagramNode;
  state: "idle" | "active" | "dimmed";
};

function anchors(from: DiagramNode, to: DiagramNode) {
  const fw = from.w ?? NODE_W;
  const fh = from.h ?? NODE_H;
  const tw = to.w ?? NODE_W;
  const th = to.h ?? NODE_H;

  const fcx = from.x + fw / 2;
  const fcy = from.y + fh / 2;
  const tcx = to.x + tw / 2;
  const tcy = to.y + th / 2;

  const dx = tcx - fcx;
  const dy = tcy - fcy;

  if (Math.abs(dx) > Math.abs(dy)) {
    const sx = dx > 0 ? from.x + fw : from.x;
    const ex = dx > 0 ? to.x : to.x + tw;
    return { sx, sy: fcy, ex, ey: tcy, horizontal: true as const };
  }
  const sy = dy > 0 ? from.y + fh : from.y;
  const ey = dy > 0 ? to.y : to.y + th;
  return { sx: fcx, sy, ex: tcx, ey, horizontal: false as const };
}

export function DiagramEdge({ edge, from, to, state }: Props) {
  const { sx, sy, ex, ey, horizontal } = anchors(from, to);
  const c = horizontal ? Math.max(36, Math.abs(ex - sx) / 2) : 0;
  const cv = horizontal ? 0 : Math.max(28, Math.abs(ey - sy) / 2);
  const d = `M ${sx} ${sy} C ${sx + c} ${sy + cv}, ${ex - c} ${ey - cv}, ${ex} ${ey}`;

  const isActive = state === "active";
  const stroke = isActive ? "var(--edge-active)" : "var(--edge)";
  const opacity = state === "dimmed" ? 0.2 : isActive ? 1 : 0.9;
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;

  return (
    <g opacity={opacity}>
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={isActive ? 1.8 : 1.3}
        vectorEffect="non-scaling-stroke"
        className={edge.animated || isActive ? "edge-flow" : undefined}
        markerEnd={isActive ? "url(#arrow-active)" : "url(#arrow)"}
      />
      {edge.label ? (
        <g>
          <rect
            x={mx - edge.label.length * 3.3 - 5}
            y={my - 9}
            width={edge.label.length * 6.6 + 10}
            height={17}
            rx={4}
            fill="var(--canvas)"
            stroke={isActive ? "var(--edge-active)" : "var(--hairline)"}
            strokeOpacity={isActive ? 0.5 : 0.7}
          />
          <text
            x={mx}
            y={my + 3.5}
            textAnchor="middle"
            className="font-mono"
            fontSize={9.5}
            fill={isActive ? "var(--edge-active)" : "var(--muted-foreground)"}
          >
            {edge.label}
          </text>
        </g>
      ) : null}
    </g>
  );
}
