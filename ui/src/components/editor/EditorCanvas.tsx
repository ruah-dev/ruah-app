import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronsDown,
  ClipboardCopy,
  Code2,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { DiagramNode as NodeType, NodeKind } from "@/data/graphs";
import type { Diagram } from "@/lib/workspace";
import { DiagramEdge } from "@/components/explorer/DiagramEdge";
import { NODE_H, NODE_W, groupIcon as GroupIcon, kindStyles } from "@/components/explorer/kinds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type EdgeRef = { from: string; to: string };

type Props = {
  diagram: Diagram;
  editable: boolean;
  selectedNodeId: string | null;
  selectedEdge: EdgeRef | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (edge: EdgeRef | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddNode: (kind: NodeKind, x: number, y: number) => void;
  onRenameNode: (id: string, label: string) => void;
  onConnect: (from: string, to: string) => void;
  onDeleteNode: (id: string) => void;
  onDrill: (node: NodeType) => void;
  onOpenCode: (node: NodeType) => void;
  onAsk: (node: NodeType) => void;
  /** Copies the daemon's context pack for the node (GET /api/context/:id). Resolves false on failure. */
  onCopyContext?: (node: NodeType) => Promise<boolean>;
};

function CopyContextButton({
  node,
  onCopy,
}: {
  node: NodeType;
  onCopy: (node: NodeType) => Promise<boolean>;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1400);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-6", state === "fail" ? "text-bad" : state === "ok" ? "text-ok" : "")}
      aria-label="Copy context"
      title={state === "fail" ? "Copy context failed (no daemon?)" : "Copy context"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => void onCopy(node).then((ok) => setState(ok ? "ok" : "fail"))}
    >
      {state === "ok" ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
    </Button>
  );
}

const GRID = 8;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export function EditorCanvas({
  diagram,
  editable,
  selectedNodeId,
  selectedEdge,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onAddNode,
  onRenameNode,
  onConnect,
  onDeleteNode,
  onDrill,
  onOpenCode,
  onAsk,
  onCopyContext,
}: Props) {
  const [zoom, setZoom] = useState(0.85);
  const [pan, setPan] = useState({ x: 16, y: 12 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const dragRef = useRef<{
    id: string;
    dx: number;
    dy: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  // Fit the whole diagram into view when a diagram opens (scanned repos can be wide).
  const fit = useCallback(() => {
    const rect = shellRef.current?.getBoundingClientRect();
    const boxes = [
      ...diagram.nodes.map((n) => ({
        x: n.x,
        y: n.y,
        r: n.x + (n.w ?? NODE_W),
        b: n.y + (n.h ?? NODE_H),
      })),
      ...(diagram.groups ?? []).map((g) => ({ x: g.x, y: g.y - 12, r: g.x + g.w, b: g.y + g.h })),
    ];
    if (!rect || rect.width === 0 || boxes.length === 0) {
      setZoom(0.85);
      setPan({ x: 16, y: 12 });
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.r));
    const maxY = Math.max(...boxes.map((b) => b.b));
    const z = Math.min(
      0.85,
      Math.max(
        0.35,
        Math.min((rect.width - 48) / (maxX - minX), (rect.height - 72) / (maxY - minY)),
      ),
    );
    setZoom(z);
    setPan({ x: 24 - minX * z, y: 20 - minY * z });
  }, [diagram.nodes, diagram.groups]);

  const fitRef = useRef(fit);
  fitRef.current = fit;

  useEffect(() => {
    setEditingId(null);
    setLinkFrom(null);
    fitRef.current();
  }, [diagram.id, diagram.nodes.length === 0]);

  const nodeById = useMemo(() => {
    const map = new Map<string, NodeType>();
    diagram.nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [diagram.nodes]);

  const focusId = hoverId ?? selectedNodeId;
  const connected = useMemo(() => {
    if (!focusId) return null;
    const set = new Set<string>([focusId]);
    diagram.edges.forEach((e) => {
      if (e.from === focusId) set.add(e.to);
      if (e.to === focusId) set.add(e.from);
    });
    return set;
  }, [focusId, diagram.edges]);

  const toGraph = useCallback(
    (clientX: number, clientY: number) => {
      const rect = shellRef.current?.getBoundingClientRect();
      return {
        x: (clientX - (rect?.left ?? 0) - pan.x) / zoom,
        y: (clientY - (rect?.top ?? 0) - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-node]")) return;
      onSelectNode(null);
      onSelectEdge(null);
      setLinkFrom(null);
      panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    },
    [pan, onSelectNode, onSelectEdge],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (panRef.current) {
        const d = panRef.current;
        setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        // A click is not a move: ignore jitter below 4 px so selecting never rewrites positions.
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
        drag.moved = true;
        const p = toGraph(e.clientX, e.clientY);
        onMoveNode(drag.id, snap(p.x - drag.dx), snap(p.y - drag.dy));
      }
    };
    const up = () => {
      panRef.current = null;
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
  }, [toGraph, onMoveNode]);

  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
        e.preventDefault();
        onDeleteNode(selectedNodeId);
      }
      if (e.key === "Escape") setLinkFrom(null);
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const kind: NodeKind = diagram.mode === "workflow" ? "step" : "service";
        onAddNode(kind, snap(120 + Math.random() * 300), snap(100 + Math.random() * 200));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, selectedNodeId, onDeleteNode, onAddNode, diagram.mode]);

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const linkSource = linkFrom ? nodeById.get(linkFrom) : undefined;

  return (
    <div
      ref={shellRef}
      className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (linkFrom) setCursor(toGraph(e.clientX, e.clientY));
      }}
      onDoubleClick={(e) => {
        if (!editable) return;
        if ((e.target as HTMLElement).closest("[data-node]")) return;
        const p = toGraph(e.clientX, e.clientY);
        onAddNode(diagram.mode === "workflow" ? "step" : "service", snap(p.x), snap(p.y));
      }}
      onDragOver={(e) => {
        if (!editable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        if (!editable) return;
        const kind = e.dataTransfer.getData("application/ruah-kind") as NodeKind;
        if (!kind) return;
        e.preventDefault();
        const p = toGraph(e.clientX, e.clientY);
        onAddNode(kind, snap(p.x - NODE_W / 2), snap(p.y - NODE_H / 2));
      }}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom((z) => Math.min(1.8, Math.max(0.35, z - e.deltaY * 0.0015)));
      }}
    >
      <div className="grid-canvas absolute inset-0" />

      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <div className="relative" style={{ width: 1400, height: 760 }}>
          {diagram.groups?.map((g) => (
            <div
              key={g.id}
              className="absolute rounded-xl border border-hairline bg-foreground/[0.015]"
              style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
            >
              <span className="absolute -top-2.5 left-3 flex items-center gap-1.5 bg-canvas px-1.5 text-[11px] text-muted-foreground">
                <GroupIcon className="size-3 opacity-70" />
                {g.label}
              </span>
            </div>
          ))}

          <svg className="absolute inset-0 h-[760px] w-[1400px] overflow-visible">
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
            {diagram.edges.map((edge, i) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              const isSelected = selectedEdge?.from === edge.from && selectedEdge?.to === edge.to;
              const touching = focusId === edge.from || focusId === edge.to;
              const state = isSelected || touching ? "active" : focusId ? "dimmed" : "idle";
              return (
                <g
                  key={`${edge.from}-${edge.to}-${i}`}
                  className="cursor-pointer"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    onSelectEdge({ from: edge.from, to: edge.to });
                    onSelectNode(null);
                  }}
                >
                  <DiagramEdge edge={edge} from={from} to={to} state={state} />
                </g>
              );
            })}
            {linkSource && cursor ? (
              <line
                x1={linkSource.x + (linkSource.w ?? NODE_W)}
                y1={linkSource.y + (linkSource.h ?? NODE_H) / 2}
                x2={cursor.x}
                y2={cursor.y}
                stroke="var(--edge-active)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ) : null}
          </svg>

          {diagram.nodes.map((node) => {
            const style = kindStyles[node.kind];
            const Icon = style.icon;
            const isSelected = selectedNodeId === node.id;
            const dimmed = !!connected && !connected.has(node.id);
            return (
              <div
                key={node.id}
                data-node
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.w ?? NODE_W,
                  height: node.h ?? NODE_H,
                }}
                className={cn(
                  "node-elevated group absolute flex flex-col justify-center gap-0.5 rounded-lg border bg-surface-1 px-3 transition-[opacity,border-color,background-color,box-shadow] duration-150",
                  editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                  isSelected
                    ? "border-primary/70 bg-surface-2 ring-2 ring-primary/15"
                    : "border-hairline hover:border-foreground/15 hover:bg-surface-2",
                  dimmed ? "opacity-35" : "opacity-100",
                )}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelectNode(node.id);
                  onSelectEdge(null);
                  if (linkFrom && linkFrom !== node.id) {
                    onConnect(linkFrom, node.id);
                    setLinkFrom(null);
                    return;
                  }
                  if (editable && editingId !== node.id) {
                    const p = toGraph(e.clientX, e.clientY);
                    dragRef.current = {
                      id: node.id,
                      dx: p.x - node.x,
                      dy: p.y - node.y,
                      sx: e.clientX,
                      sy: e.clientY,
                      moved: false,
                    };
                  }
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  dragRef.current = null;
                  if (editable) setEditingId(node.id);
                  else if (node.drill) onDrill(node);
                }}
                onMouseEnter={() => setHoverId(node.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <span className="flex items-center gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-3/60">
                    <Icon className={cn("size-3.5", style.color)} />
                  </span>
                  {editingId === node.id ? (
                    <input
                      autoFocus
                      defaultValue={node.label}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        onRenameNode(node.id, e.target.value.trim() || node.label);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="w-full min-w-0 rounded-md border border-ring/50 bg-surface-3 px-1 text-[13px] text-foreground outline-none"
                    />
                  ) : (
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {node.label}
                    </span>
                  )}
                </span>
                {node.subtitle ? (
                  <span className="truncate pl-8 text-[11.5px] text-muted-foreground">
                    {node.subtitle}
                  </span>
                ) : null}

                {isSelected ? (
                  <>
                    <div className="control-glass absolute -top-9 left-0 flex items-center gap-0.5 rounded-lg p-0.5">
                      {node.drill ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label="Drill in"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => onDrill(node)}
                        >
                          <ChevronsDown className="size-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label="Open code"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => onOpenCode(node)}
                      >
                        <Code2 className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label="Ask agent"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => onAsk(node)}
                      >
                        <Sparkles className="size-3.5" />
                      </Button>
                      {onCopyContext ? (
                        <CopyContextButton node={node} onCopy={onCopyContext} />
                      ) : null}
                      {editable ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn("size-6", linkFrom === node.id ? "text-primary" : "")}
                            aria-label="Connect to another element"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setLinkFrom((v) => (v === node.id ? null : node.id))}
                          >
                            <Link2 className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 text-muted-foreground hover:text-destructive"
                            aria-label="Delete element"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => onDeleteNode(node.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                    {editable ? (
                      <button
                        type="button"
                        aria-label="Drag a connection"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setLinkFrom(node.id);
                        }}
                        className="absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 rounded-full border border-ring bg-surface-1"
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {diagram.nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="text-[13.5px] font-medium text-foreground">Empty diagram</p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              {editable
                ? "Drag an element from the tray, double-click the canvas, or press N."
                : "Switch to Edit to add elements."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="control-glass absolute right-3 bottom-3 z-20 flex items-center gap-0.5 rounded-lg p-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.35, z - 0.15))}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="w-9 text-center text-[11px] text-muted-foreground tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Fit to view"
          onClick={fit}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>

      {editable ? (
        <span className="pointer-events-none absolute bottom-4 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-1.5 text-[11px] text-muted-foreground/60 md:inline-flex">
          <MousePointer2 className="size-3" />
          {linkFrom
            ? "Click a target element to connect · Esc cancels"
            : "Drag to move · N new · Del removes · ⌘ scroll zooms"}
        </span>
      ) : null}

      {selectedNode && editable && linkFrom === selectedNode.id ? (
        <div className="control-glass absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-lg px-2.5 py-1 text-[12px] text-primary">
          connecting from {selectedNode.label}
        </div>
      ) : null}
    </div>
  );
}
