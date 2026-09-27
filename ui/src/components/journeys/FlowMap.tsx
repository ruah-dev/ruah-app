// Flow map (JOURNEYS.md §5.1, Graph view): the app's screens as boxes and every journey's steps as
// coloured arrows between them. Journeys that share a screen meet there; branches are dashed;
// screens no journey reaches sit dimmed in the last column. Hovering a journey in the legend (or
// an arrow) isolates it. Scrolls both ways; zoom with the buttons or ⌘ + wheel.
import { useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import { Minus, Plus, ScanSearch } from "lucide-react";
import type { ProductFile } from "@/lib/contracts";
import { FLOW_NODE_H, FLOW_NODE_W, flowGraph, journeyColorIndex, type FlowEdge, type FlowNode } from "@/lib/journeys";
import { JOURNEY_COLORS } from "./fields";
import { cn } from "@/lib/utils";

export function FlowMap({
  product,
  journeys,
  selectedScreen,
  selectedJourney,
  onSelectScreen,
  onSelectStep,
}: {
  product: ProductFile;
  /** Only these journeys (a persona's); undefined = all. */
  journeys?: readonly string[];
  selectedScreen: string | null;
  selectedJourney: string | null;
  onSelectScreen: (screenId: string) => void;
  onSelectStep: (journeyId: string, stepId: string) => void;
}) {
  const graph = useMemo(() => flowGraph(product, journeys !== undefined ? { journeys } : {}), [product, journeys]);
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const focus = hover ?? selectedJourney;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const shown = [...new Set(graph.edges.map((e) => e.journey))];

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  };

  if (graph.nodes.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center text-ui-sm text-muted-foreground">
        No screens or journeys yet. Scan the project to find its screens, or add a journey.
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {shown.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-2" aria-label="Journeys on the map">
          {shown.map((id) => {
            const j = product.journeys.find((x) => x.id === id);
            if (!j) return null;
            return (
              <button
                key={id}
                type="button"
                onMouseEnter={() => setHover(id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(id)}
                onBlur={() => setHover(null)}
                onClick={() => j.steps[0] && onSelectStep(id, j.steps[0].id)}
                className={cn("inline-flex items-center gap-1.5 rounded-md px-1 text-meta transition-opacity", focus !== null && focus !== id && "opacity-40")}
              >
                <span className="h-0.5 w-4 rounded-full" style={{ background: JOURNEY_COLORS[journeyColorIndex(product, id)] }} aria-hidden />
                {j.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <div ref={scroller} className="grid-canvas min-h-0 flex-1 overflow-auto" onWheel={onWheel}>
        <svg
          width={graph.width * zoom}
          height={graph.height * zoom}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          role="img"
          aria-label="Screens and the journeys between them"
          className="block"
        >
          <defs>
            {JOURNEY_COLORS.map((c, i) => (
              <marker key={c} id={`flow-arrow-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
              </marker>
            ))}
          </defs>
          {graph.edges.map((e) => (
            <Edge
              key={e.id}
              edge={e}
              from={byId.get(e.from)}
              to={byId.get(e.to)}
              color={journeyColorIndex(product, e.journey)}
              dim={focus !== null && focus !== e.journey}
              onHover={(on) => setHover(on ? e.journey : null)}
              onClick={() => onSelectStep(e.journey, e.step)}
            />
          ))}
          {graph.nodes.map((n) => (
            <Node key={n.id} node={n} selected={selectedScreen === n.id} dim={n.orphan || (focus !== null && !n.journeys.includes(focus))} onClick={() => n.screen && onSelectScreen(n.id)} />
          ))}
        </svg>
      </div>
      <div className="control-glass absolute end-3 bottom-3 flex items-center gap-0.5 rounded-lg p-0.5">
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((z) => clampZoom(z / 1.2))} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <Minus className="size-3.5" />
        </button>
        <button type="button" aria-label="Actual size" title="Actual size" onClick={() => setZoom(1)} className="grid h-7 min-w-10 place-items-center rounded-md px-1 text-meta tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground">
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((z) => clampZoom(z * 1.2))} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Fit to view"
          title="Fit to view"
          onClick={() => {
            const el = scroller.current;
            if (!el) return;
            setZoom(clampZoom(Math.min(el.clientWidth / graph.width, el.clientHeight / graph.height)));
          }}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ScanSearch className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

const clampZoom = (z: number) => Math.min(2, Math.max(0.25, z));

function Node({ node, selected, dim, onClick }: { node: FlowNode; selected: boolean; dim: boolean; onClick: () => void }) {
  const entry = node.screen === undefined;
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      className={cn("transition-opacity", dim && "opacity-35", node.screen && "cursor-pointer")}
      onClick={onClick}
      role={node.screen ? "button" : undefined}
      tabIndex={node.screen ? 0 : undefined}
      aria-label={node.screen ? `Screen ${node.label}${node.orphan ? ", in no journey" : ""}` : node.label}
      onKeyDown={(e) => {
        if (node.screen && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <rect
        width={FLOW_NODE_W}
        height={FLOW_NODE_H}
        rx={10}
        fill="var(--surface-1)"
        stroke={selected ? "var(--primary)" : "var(--hairline)"}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={entry || node.orphan ? "4 3" : undefined}
      />
      <rect x={0} y={12} width={3} height={FLOW_NODE_H - 24} rx={1.5} fill="var(--node-frontend)" opacity={entry ? 0 : 0.9} />
      <text x={14} y={24} fontSize={12.5} fontWeight={600} fill="var(--foreground)">
        {truncate(node.label, 24)}
      </text>
      <text x={14} y={42} fontSize={11} fill="var(--muted-foreground)" fontFamily="var(--font-mono, ui-monospace)">
        {truncate(node.sub, 28)}
      </text>
    </g>
  );
}

function Edge({
  edge,
  from,
  to,
  color,
  dim,
  onHover,
  onClick,
}: {
  edge: FlowEdge;
  from: FlowNode | undefined;
  to: FlowNode | undefined;
  color: number;
  dim: boolean;
  onHover: (on: boolean) => void;
  onClick: () => void;
}) {
  if (!from || !to) return null;
  // Forward (to a later column): side to side. Back or within a column: over the top of the boxes.
  const forward = to.x > from.x;
  const sx = forward ? from.x + FLOW_NODE_W : from.x + FLOW_NODE_W / 2 + 12;
  const sy = forward ? from.y + FLOW_NODE_H / 2 : from.y;
  const tx = forward ? to.x : to.x + FLOW_NODE_W / 2 - 12;
  const ty = forward ? to.y + FLOW_NODE_H / 2 : to.y;
  const bend = 14 + edge.lane * 14;
  const top = Math.min(sy, ty) - 44 - edge.lane * 16;
  const path = forward
    ? `M ${sx} ${sy} C ${sx + 70} ${sy + (edge.lane ? bend : 0)}, ${tx - 70} ${ty + (edge.lane ? bend : 0)}, ${tx} ${ty}`
    : `M ${sx} ${sy} C ${sx} ${top}, ${tx} ${top}, ${tx} ${ty}`;
  const mx = (sx + tx) / 2;
  const my = forward ? (sy + ty) / 2 + (edge.lane ? bend * 0.75 : 0) - 7 : top + 8;
  const stroke = JOURNEY_COLORS[color];
  return (
    <g
      className={cn("cursor-pointer transition-opacity", dim && "opacity-15")}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={onClick}
    >
      <title>{`${edge.branch ? "Branch: when " : ""}${edge.label}`}</title>
      <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.75} strokeDasharray={edge.branch ? "5 4" : undefined} markerEnd={`url(#flow-arrow-${color})`} />
      <text x={mx} y={my} fontSize={10.5} textAnchor="middle" fill="var(--muted-foreground)" paintOrder="stroke" stroke="var(--canvas)" strokeWidth={3}>
        {truncate(edge.branch ? `when ${edge.label}` : edge.label, 28)}
      </text>
    </g>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
