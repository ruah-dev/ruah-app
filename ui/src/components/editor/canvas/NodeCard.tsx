// One element on the map, at three levels of detail (full card · compact bar + name · tiny
// block). Memoised: panning never re-renders cards; only cards whose props change do.
// `--inv-k` (1 / zoom, set on the world layer in coarse steps) keeps text and the toolbar at a
// readable screen size without re-rendering.
import { memo, useEffect, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Check, ChevronRight, ChevronsDown, ClipboardCopy, Code2, Link2, Sparkles, Trash2 } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { NODE_H, NODE_W, styleFor } from "@/components/explorer/kinds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { daemonActions } from "@/lib/daemon";
import { keepAgentElement } from "@/lib/architecture-edit";
import { useMapFlash } from "@/lib/map-activity";
import type { Lod } from "./geometry";
import { isGroupNodeId } from "./view-model";

export type NodeHandlers = {
  pointerDown: (e: ReactPointerEvent, node: DiagramNode) => void;
  click: (e: ReactMouseEvent, node: DiagramNode) => void;
  doubleClick: (e: ReactMouseEvent, node: DiagramNode) => void;
  hover: (id: string | null) => void;
  drill: (node: DiagramNode) => void;
  openCode: (node: DiagramNode) => void;
  ask: (node: DiagramNode) => void;
  copyContext?: ((node: DiagramNode) => Promise<boolean>) | undefined;
  toggleLink: (id: string) => void;
  startLink: (id: string) => void;
  remove: (id: string) => void;
  rename: (id: string, label: string) => void;
  cancelRename: () => void;
  toggleGroup: (layer: string) => void;
};

export type NodeTone = "normal" | "dimmed" | "match" | "current";

/** Full cards between 50 % and 85 % zoom: grow the text so it stays readable on screen. */
const BOOST = (px: number) => `calc(${px}px * max(1, 0.85 * var(--inv-k, 1)))`;

type Props = {
  node: DiagramNode;
  lod: Lod;
  selected: boolean;
  tone: NodeTone;
  editable: boolean;
  renaming: boolean;
  linking: boolean;
  h: NodeHandlers;
};

function CopyContextButton({ node, onCopy }: { node: DiagramNode; onCopy: (node: DiagramNode) => Promise<boolean> }) {
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

function Toolbar({ node, editable, linking, h }: { node: DiagramNode; editable: boolean; linking: boolean; h: NodeHandlers }) {
  const stop = (e: ReactPointerEvent) => e.stopPropagation();
  return (
    <div
      className="control-glass absolute bottom-[calc(100%+6px)] left-0 z-10 flex origin-bottom-left items-center gap-0.5 rounded-lg p-0.5"
      style={{ transform: "scale(var(--inv-k, 1))" }}
      onPointerDown={stop}
    >
      {node.drill ? (
        <Button variant="ghost" size="icon" className="size-6" aria-label="Open inside" title="Open inside (Enter)" onClick={() => h.drill(node)}>
          <ChevronsDown className="size-3.5" />
        </Button>
      ) : null}
      <Button variant="ghost" size="icon" className="size-6" aria-label="Open code" title="Open code" onClick={() => h.openCode(node)}>
        <Code2 className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 text-ai hover:bg-ai/12 hover:text-ai"
        aria-label="Ask agent"
        title="Ask the agent about this"
        onClick={() => h.ask(node)}
      >
        <Sparkles className="size-3.5" />
      </Button>
      {h.copyContext ? <CopyContextButton node={node} onCopy={h.copyContext} /> : null}
      {node.origin === "agent" && !node.ephemeral ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-ai hover:bg-ai/12 hover:text-ai"
          aria-label="Keep this agent-made element"
          title="An agent drew this. Keep it (removes the AI marker)."
          onClick={() => daemonActions.editArchitecture((a) => keepAgentElement(a, node.id))}
        >
          <Check className="size-3.5" />
          Keep
        </Button>
      ) : null}
      {editable ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-6", linking ? "text-primary" : "")}
            aria-label="Connect to another element"
            onClick={() => h.toggleLink(node.id)}
          >
            <Link2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            aria-label="Delete element"
            onClick={() => h.remove(node.id)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** "▸ 12" — the element has a level inside; click drills in. */
function InsideChip({ node, h, compact }: { node: DiagramNode; h: NodeHandlers; compact: boolean }) {
  const group = isGroupNodeId(node.id);
  const n = node.childCount;
  const title = group
    ? `Expand the ${node.label} group`
    : n
      ? `${n} inside — open (double-click or Enter)`
      : "Open inside (double-click or Enter)";
  const onClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (group && node.layer) h.toggleGroup(node.layer);
    else h.drill(node);
  };
  if (compact) {
    // Zoomed out: a folded corner (no room for a chip next to the name).
    return (
      <button
        type="button"
        data-chip
        title={title}
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClick}
        className="absolute top-0 right-0 size-7 overflow-hidden rounded-tr-xl"
      >
        <span aria-hidden className="absolute top-0 right-0 border-t-[22px] border-l-[22px] border-t-primary/55 border-l-transparent transition-colors hover:border-t-primary" />
      </button>
    );
  }
  return (
    <button
      type="button"
      data-chip
      title={title}
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className="absolute right-1.5 bottom-1.5 flex h-[18px] items-center gap-0.5 rounded-md border border-hairline bg-surface-2 px-1 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/12 hover:text-primary"
    >
      <ChevronRight className="size-2.5" />
      {n ? <span className="tabular-nums">{n}</span> : null}
    </button>
  );
}

/** §1.7: lavender dot on elements an agent drew, until the user keeps or edits them. */
function AiMark({ compact }: { compact?: boolean }) {
  return (
    <span
      aria-label="Added by an agent"
      title="Added by an agent — select it and Keep to accept"
      className={cn(
        "pointer-events-auto absolute rounded-full bg-ai ring-2 ring-card",
        compact ? "-top-1 -left-1 size-2.5" : "top-1.5 right-1.5 size-2",
      )}
    />
  );
}

function NodeCardImpl({ node, lod, selected, tone, editable, renaming, linking, h }: Props) {
  const flash = useMapFlash(node.id);
  const style = styleFor(node);
  const Icon = style.icon;
  const group = isGroupNodeId(node.id);
  const w = node.w ?? NODE_W;
  const hgt = node.h ?? NODE_H;
  const opacity = tone === "dimmed" ? "opacity-60" : "opacity-100";
  const ring =
    tone === "current"
      ? "border-warn! ring-4 ring-warn/35"
      : tone === "match"
        ? "border-warn/70! ring-2 ring-warn/25"
        : selected
          ? "ring-3 ring-primary/25"
          : "";
  const common = {
    "data-node": true,
    "data-id": node.id,
    ...(flash ? { "data-flash": flash } : {}),
    style: { left: node.x, top: node.y, width: w, height: hgt },
    onPointerDown: (e: ReactPointerEvent) => h.pointerDown(e, node),
    onClick: (e: ReactMouseEvent) => h.click(e, node),
    onDoubleClick: (e: ReactMouseEvent) => h.doubleClick(e, node),
    onMouseEnter: () => h.hover(node.id),
    onMouseLeave: () => h.hover(null),
  };
  const border = selected ? "border-primary" : group ? "border-dashed border-group/60" : "border-hairline";

  if (lod === "tiny") {
    return (
      <div
        {...common}
        className={cn("absolute rounded-lg border-2", style.tint, selected ? "border-primary" : style.border, ring, opacity)}
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-2 rounded-s-md", style.bar)} />
        {selected || tone === "current" || tone === "match" ? (
          <span
            className="absolute bottom-[calc(100%+4px)] left-0 max-w-[400%] truncate rounded bg-popover px-1 font-medium whitespace-nowrap text-foreground shadow-sm"
            style={{ fontSize: "calc(12px * var(--inv-k, 1))" }}
          >
            {node.label}
          </span>
        ) : null}
        {selected ? <Toolbar node={node} editable={editable} linking={linking} h={h} /> : null}
      </div>
    );
  }

  if (lod === "compact") {
    return (
      <div
        {...common}
        className={cn(
          "absolute flex items-center rounded-xl border bg-card ps-4 pe-2",
          editable ? "cursor-grab" : "cursor-pointer",
          border,
          ring,
          opacity,
        )}
      >
        <span aria-hidden className={cn("absolute inset-y-2 left-0 w-[5px] rounded-e-pill", style.bar)} />
        <span
          className="line-clamp-2 min-w-0 leading-[1.12] font-medium [overflow-wrap:anywhere] text-foreground"
          style={{ fontSize: "min(26px, calc(10.5px * var(--inv-k, 1)))" }}
          title={node.label}
        >
          {node.label}
        </span>
        {node.childCount ? (
          <span
            className="ms-[0.4em] shrink-0 pe-5 font-mono text-faint tabular-nums"
            style={{ fontSize: "min(22px, calc(9.5px * var(--inv-k, 1)))" }}
          >
            {node.childCount}
          </span>
        ) : null}
        {node.drill || group ? <InsideChip node={node} h={h} compact /> : null}
        {node.origin === "agent" ? <AiMark compact /> : null}
        {selected ? <Toolbar node={node} editable={editable} linking={linking} h={h} /> : null}
      </div>
    );
  }

  return (
    <div
      {...common}
      className={cn(
        "node-elevated group absolute flex flex-col justify-center gap-0.5 rounded-xl border bg-card px-3 transition-[border-color,background-color] duration-150",
        editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        selected ? "bg-surface-2" : "hover:border-surface-4 hover:bg-surface-2",
        border,
        ring,
        opacity,
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-3 left-0 w-[3px] rounded-e-pill opacity-80", style.bar)} />
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", style.tint)}>
          <Icon className={cn("size-3.5", style.color)} />
        </span>
        {renaming ? (
          <input
            autoFocus
            defaultValue={node.label}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => h.rename(node.id, e.target.value.trim() || node.label)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") h.cancelRename();
            }}
            className="w-full min-w-0 rounded-md border border-ring/50 bg-surface-3 px-1 text-[13px] text-foreground outline-none"
          />
        ) : (
          <span className="truncate font-medium text-foreground" style={{ fontSize: BOOST(13) }} title={node.label}>
            {node.label}
          </span>
        )}
      </span>
      {node.subtitle ? (
        <span
          className={cn("truncate pl-8 font-mono text-muted-foreground", node.drill || group ? "pr-9" : "")}
          style={{ fontSize: BOOST(11) }}
        >
          {node.subtitle}
        </span>
      ) : null}
      {node.drill || group ? <InsideChip node={node} h={h} compact={false} /> : null}
      {node.origin === "agent" ? <AiMark /> : null}
      {selected ? (
        <>
          <Toolbar node={node} editable={editable} linking={linking} h={h} />
          {editable && !group ? (
            <button
              type="button"
              aria-label="Drag a connection"
              onPointerDown={(e) => {
                e.stopPropagation();
                h.startLink(node.id);
              }}
              className="absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 rounded-full border border-ring bg-surface-1"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export const NodeCard = memo(NodeCardImpl);
