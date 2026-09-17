import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { DiagramNode, Graph } from "../lib/graphTypes.js";
import { cn } from "../lib/cn.js";
import { DiagramEdgeView } from "./DiagramEdgeView.js";
import { DiagramNodeCard } from "./DiagramNodeCard.js";
import { groupIcon as GroupIcon, NODE_H, NODE_W } from "./kinds.js";

interface Props {
  graph: Graph;
  selectedId: string | null;
  onSelect: (node: DiagramNode) => void;
  onAsk: (node: DiagramNode) => void;
  onDrill: (node: DiagramNode) => void;
}

const WORLD_PAD = 80;

export function DiagramCanvas({ graph, selectedId, onSelect, onAsk, onDrill }: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const world = useMemo(() => {
    const w = Math.max(
      640,
      ...graph.nodes.map((n) => n.x + (n.w ?? NODE_W)),
      ...(graph.groups ?? []).map((g) => g.x + g.w),
    );
    const h = Math.max(
      420,
      ...graph.nodes.map((n) => n.y + (n.h ?? NODE_H)),
      ...(graph.groups ?? []).map((g) => g.y + g.h),
    );
    return { w: w + WORLD_PAD, h: h + WORLD_PAD };
  }, [graph.nodes, graph.groups]);

  // fit-to-view on graph change
  useEffect(() => {
    const rect = shellRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const fit = Math.min(1.2, Math.max(0.35, Math.min((rect.width - 40) / world.w, (rect.height - 40) / world.h)));
    setZoom(fit);
    setPan({
      x: Math.max(16, (rect.width - world.w * fit) / 2),
      y: Math.max(16, (rect.height - world.h * fit) / 2),
    });
  }, [graph.id, world.w, world.h]);

  const nodeById = useMemo(() => {
    const map = new Map<string, DiagramNode>();
    graph.nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [graph]);

  const focusId = hoverId ?? selectedId;
  const connected = useMemo(() => {
    if (focusId === null) return null;
    const set = new Set<string>([focusId]);
    graph.edges.forEach((e) => {
      if (e.from === focusId) set.add(e.to);
      if (e.to === focusId) set.add(e.from);
    });
    return set;
  }, [focusId, graph.edges]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-node]")) return;
      dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    },
    [pan],
  );

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (d === null) return;
      setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
    };
    const up = (): void => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  return (
    <div
      ref={shellRef}
      className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
      onPointerDown={onPointerDown}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom((z) => Math.min(2, Math.max(0.35, z - e.deltaY * 0.0015)));
      }}
    >
      <div className="grid-canvas" />

      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <div className="relative" style={{ width: world.w, height: world.h }}>
          {(graph.groups ?? []).map((g) => (
            <div
              key={g.id}
              className="absolute rounded-[var(--radius)] border border-dashed"
              style={{ left: g.x, top: g.y, width: g.w, height: g.h, borderColor: "var(--hairline)" }}
            >
              <span
                className="mono absolute -top-2.5 left-3 flex items-center gap-1 px-1.5 text-[10px] uppercase tracking-wide"
                style={{ backgroundColor: "var(--canvas)", color: "var(--muted-foreground)" }}
              >
                <GroupIcon className="size-3" />
                {g.label}
              </span>
            </div>
          ))}

          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={world.w}
            height={world.h}
          >
            <defs>
              <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="var(--edge)" />
              </marker>
              <marker id="arrow-active" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="var(--edge-active)" />
              </marker>
            </defs>
            {graph.edges.map((edge, i) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (from === undefined || to === undefined) return null;
              const touching = focusId === edge.from || focusId === edge.to;
              const state = focusId === null ? "idle" : touching ? "active" : "dimmed";
              return (
                <DiagramEdgeView
                  key={`${edge.from}-${edge.to}-${i}`}
                  edge={edge}
                  from={from}
                  to={to}
                  state={state}
                />
              );
            })}
          </svg>

          {graph.nodes.map((node) => (
            <div key={node.id} data-node>
              <DiagramNodeCard
                node={node}
                selected={selectedId === node.id}
                dimmed={connected !== null && !connected.has(node.id)}
                onSelect={() => onSelect(node)}
                onAsk={() => onAsk(node)}
                onDrill={() => {
                  if (node.drill === true) onDrill(node);
                }}
                onHover={setHoverId}
              />
            </div>
          ))}
        </div>
      </div>

      <div
        className="panel-shadow absolute bottom-4 left-4 z-20 flex items-center gap-0.5 rounded-[var(--radius)] border p-0.5"
        style={{ backgroundColor: "var(--surface-2)" }}
      >
        <CanvasButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.35, z - 0.15))}>
          <Minus className="size-3.5" />
        </CanvasButton>
        <span className="mono w-9 text-center text-[10.5px] text-[var(--muted-foreground)]">
          {Math.round(zoom * 100)}%
        </span>
        <CanvasButton label="Zoom in" onClick={() => setZoom((z) => Math.min(2, z + 0.15))}>
          <Plus className="size-3.5" />
        </CanvasButton>
        <CanvasButton label="Reset view" onClick={() => setZoom(1)}>
          <Maximize2 className="size-3.5" />
        </CanvasButton>
      </div>

      <span
        className={cn(
          "mono absolute bottom-6 left-40 z-10 hidden text-[9.5px] md:inline",
        )}
        style={{ color: "var(--muted-foreground)", opacity: 0.7 }}
      >
        drag to pan · ⌘ + scroll to zoom
      </span>
    </div>
  );
}

function CanvasButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-6 cursor-pointer place-items-center rounded-[4px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      style={{ backgroundColor: "transparent" }}
    >
      {children}
    </button>
  );
}
