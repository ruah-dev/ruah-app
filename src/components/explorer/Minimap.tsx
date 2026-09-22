import type { Graph } from "@/data/graphs";
import { NODE_H, NODE_W } from "./kinds";

const MAP_W = 168;
const MAP_H = 104;

export function Minimap({ graph, selectedId }: { graph: Graph; selectedId: string | null }) {
  const maxX = Math.max(...graph.nodes.map((n) => n.x + (n.w ?? NODE_W)), 1200);
  const maxY = Math.max(...graph.nodes.map((n) => n.y + (n.h ?? NODE_H)), 560);
  const s = Math.min(MAP_W / maxX, MAP_H / maxY);

  return (
    <div className="control-glass pointer-events-none absolute right-4 bottom-4 z-20 hidden rounded-md border border-hairline p-2 opacity-85 md:block">
      <svg width={MAP_W} height={MAP_H} className="block">
        {graph.groups?.map((g) => (
          <rect
            key={g.id}
            x={g.x * s}
            y={g.y * s}
            width={g.w * s}
            height={g.h * s}
            rx={2}
            fill="none"
            stroke="var(--hairline)"
          />
        ))}
        {graph.nodes.map((n) => (
          <rect
            key={n.id}
            x={n.x * s}
            y={n.y * s}
            width={(n.w ?? NODE_W) * s}
            height={(n.h ?? NODE_H) * s}
            rx={1.5}
            fill={n.id === selectedId ? "var(--edge-active)" : "var(--edge)"}
          />
        ))}
      </svg>
    </div>
  );
}
