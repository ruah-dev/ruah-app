import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { DiagramNode as NodeType, Graph } from "@/data/graphs";
import { DiagramEdge } from "./DiagramEdge";
import { DiagramNode } from "./DiagramNode";
import { NodePopoverContent } from "./NodePopover";
import { AgentBubble } from "./AgentBubble";
import { Minimap } from "./Minimap";
import { Button } from "@/components/ui/button";
import { groupIcon as GroupIcon } from "./kinds";

type Props = {
  graph: Graph;
  selectedId: string | null;
  contextPathFor: (node: NodeType) => string;
  onSelect: (node: NodeType) => void;
  onDrill: (node: NodeType) => void;
  onOpenCode: (node: NodeType) => void;
  onAsk: (node: NodeType, prompt: string) => void;
};

export function DiagramCanvas({
  graph,
  selectedId,
  contextPathFor,
  onSelect,
  onDrill,
  onOpenCode,
  onAsk,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [popoverId, setPopoverId] = useState<string | null>(null);
  const [bubbleId, setBubbleId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const rect = shellRef.current?.getBoundingClientRect();
    const extentX = Math.max(
      600,
      ...graph.nodes.map((n) => n.x + (n.w ?? 200)),
      ...(graph.groups ?? []).map((g) => g.x + g.w),
    );
    const narrow = (rect?.width ?? 900) < 640;
    const minFit = narrow ? 0.55 : 0.72;
    const fit = rect ? Math.min(1, Math.max(minFit, (rect.width - 24) / extentX)) : 1;
    setPan({ x: narrow ? 8 : 16, y: 8 });
    setZoom(fit);
    setPopoverId(null);
    setBubbleId(null);
  }, [graph.id, graph.nodes, graph.groups]);

  const nodeById = useMemo(() => {
    const map = new Map<string, NodeType>();
    graph.nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [graph]);

  const focusId = hoverId ?? selectedId;
  const connected = useMemo(() => {
    if (!focusId) return null;
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
      setPopoverId(null);
      dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    },
    [pan],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
    };
    const up = () => {
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

  const screenPos = (node: NodeType, panelW: number, dx = 0, dy = 0) => {
    const rect = shellRef.current?.getBoundingClientRect();
    const maxX = Math.max(8, (rect?.width ?? 900) - panelW - 12);
    const maxY = Math.max(8, (rect?.height ?? 600) - 200);
    return {
      x: Math.min(maxX, Math.max(8, pan.x + (node.x + dx) * zoom)),
      y: Math.min(maxY, Math.max(8, pan.y + (node.y + dy) * zoom)),
    };
  };

  const popoverNode = popoverId ? nodeById.get(popoverId) : undefined;
  const bubbleNode = bubbleId ? nodeById.get(bubbleId) : undefined;

  return (
    <div
      ref={shellRef}
      className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
      onPointerDown={onPointerDown}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom((z) => Math.min(1.8, Math.max(0.4, z - e.deltaY * 0.0015)));
      }}
    >
      <div className="grid-canvas absolute inset-0" />

      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <div className="relative" style={{ width: 1220, height: 600 }}>
          {graph.groups?.map((g) => (
            <div
              key={g.id}
              className="absolute rounded-md border border-dashed border-hairline/70 bg-surface-1/10"
              style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
            >
              <span className="absolute -top-2.5 left-3 flex items-center gap-1 bg-canvas px-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                <GroupIcon className="size-3" />
                {g.label}
              </span>
            </div>
          ))}

          <svg className="pointer-events-none absolute inset-0 h-[600px] w-[1220px] overflow-visible">
            <defs>
              <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="var(--edge)" />
              </marker>
              <marker
                id="arrow-active"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7 z" fill="var(--edge-active)" />
              </marker>
            </defs>
            {graph.edges.map((edge, i) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              const touching = focusId === edge.from || focusId === edge.to;
              const state = !focusId ? "idle" : touching ? "active" : "dimmed";
              return (
                <DiagramEdge
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
              <DiagramNode
                node={node}
                selected={selectedId === node.id}
                dimmed={!!connected && !connected.has(node.id)}
                onHover={setHoverId}
                onSelect={() => {
                  onSelect(node);
                  setPopoverId(node.id);
                  setBubbleId(null);
                }}
                onDoubleClick={() => {
                  setPopoverId(null);
                  onDrill(node);
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {popoverNode ? (
        <div
          className="absolute z-30 animate-in fade-in-0 duration-100"
          style={(() => {
            const p = screenPos(popoverNode, 260, (popoverNode.w ?? 200) + 10, 0);
            return { left: p.x, top: p.y };
          })()}
          data-node
        >
          <div className="control-glass rounded-md border border-hairline p-1.5">
            <NodePopoverContent
              node={popoverNode}
              onDrill={() => {
                setPopoverId(null);
                onDrill(popoverNode);
              }}
              onOpenCode={() => {
                setPopoverId(null);
                onOpenCode(popoverNode);
              }}
              onAsk={() => {
                setPopoverId(null);
                setBubbleId(popoverNode.id);
              }}
              onCopy={() => setPopoverId(null)}
              onPin={() => setPopoverId(null)}
            />
          </div>
        </div>
      ) : null}

      {bubbleNode ? (
        <AgentBubble
          node={bubbleNode}
          contextPath={contextPathFor(bubbleNode)}
          screen={screenPos(bubbleNode, 330, (bubbleNode.w ?? 200) + 10, 0)}
          onClose={() => setBubbleId(null)}
          onSubmit={(prompt) => onAsk(bubbleNode, prompt)}
        />
      ) : null}

      <div className="control-glass absolute bottom-4 left-4 z-20 flex items-center gap-0.5 rounded-md border border-hairline p-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="w-9 text-center font-mono text-[10.5px] text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>

      <Minimap graph={graph} selectedId={selectedId} />

      <span className="absolute bottom-6 left-40 z-10 hidden font-mono text-[9.5px] text-muted-foreground/70 md:inline">
        drag to pan · ⌘ + scroll to zoom
      </span>
    </div>
  );
}
