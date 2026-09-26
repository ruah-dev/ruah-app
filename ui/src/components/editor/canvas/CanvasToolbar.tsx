// Canvas controls, top right: search (⌘F), filters (kinds, layers, collapse groups),
// "only neighbours of the selection" and fit-to-selection.
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, CornerDownLeft, Filter, Focus, Search, X } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { kindStyles, symbolStyle } from "@/components/explorer/kinds";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { iconButton } from "@/components/ui/controls";
import { filterKindOf, type CanvasFilters } from "./view-model";

export type SearchHit = { id: string; label: string; where: string };

const btn = iconButton;

function Row({ children, active, onClick, title }: { children: ReactNode; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui-sm transition-colors hover:bg-accent",
        active ? "text-foreground" : "text-faint line-through decoration-faint/60",
      )}
    >
      {children}
    </button>
  );
}

export function FilterMenu({
  nodes,
  filters,
  onChange,
  hasSelection,
}: {
  nodes: readonly DiagramNode[];
  filters: CanvasFilters;
  onChange: (f: CanvasFilters) => void;
  hasSelection: boolean;
}) {
  const kinds = useMemo(() => {
    const m = new Map<string, { label: string; n: number; node: DiagramNode }>();
    for (const n of nodes) {
      const k = filterKindOf(n);
      const cur = m.get(k);
      if (cur) cur.n++;
      else m.set(k, { label: n.symbol ? symbolStyle(n.symbol.kind).label : kindStyles[n.kind].label, n: 1, node: n });
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [nodes]);
  const layers = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) if (n.layer) m.set(n.layer, (m.get(n.layer) ?? 0) + 1);
    return [...m.entries()];
  }, [nodes]);
  const active =
    filters.hiddenKinds.size + filters.hiddenLayers.size + filters.collapsedLayers.size + (filters.hops > 0 ? 1 : 0);
  const toggle = (set: ReadonlySet<string>, v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(btn, "flex w-auto gap-1 px-2 text-label", active ? "text-primary" : "")} aria-label="Filters" title="Filter, focus and group">
          <Filter className="size-3.5" />
          {active ? <span className="tabular-nums">{active}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 border-hairline p-1.5" onOpenAutoFocus={(e) => e.preventDefault()}>
        <p className="px-2 pt-1 pb-1 text-meta font-medium text-muted-foreground">Focus on the selection</p>
        <div className="flex gap-1 px-1 pb-2">
          {([0, 1, 2] as const).map((h) => (
            <button
              key={h}
              type="button"
              disabled={h > 0 && !hasSelection}
              onClick={() => onChange({ ...filters, hops: h })}
              className={cn(
                "h-7 flex-1 rounded-md text-label transition-colors disabled:opacity-40",
                filters.hops === h ? "bg-primary/15 text-primary ring-1 ring-primary/40" : "bg-surface-2 text-muted-foreground hover:text-foreground",
              )}
            >
              {h === 0 ? "Everything" : `${h} hop${h === 1 ? "" : "s"}`}
            </button>
          ))}
        </div>
        <p className="px-2 pt-1 pb-1 text-meta font-medium text-muted-foreground">Kinds</p>
        <div className="max-h-44 overflow-y-auto">
          {kinds.map(([k, v]) => {
            const style = v.node.symbol ? symbolStyle(v.node.symbol.kind) : kindStyles[v.node.kind];
            const Icon = style.icon;
            return (
              <Row
                key={k}
                active={!filters.hiddenKinds.has(k)}
                onClick={() => onChange({ ...filters, hiddenKinds: toggle(filters.hiddenKinds, k) })}
              >
                <Icon className={cn("size-3.5 shrink-0", style.color)} />
                <span className="truncate">{v.label}</span>
                <span className="ms-auto text-caption text-faint tabular-nums">{v.n}</span>
              </Row>
            );
          })}
        </div>
        {layers.length ? (
          <>
            <p className="px-2 pt-2 pb-1 text-meta font-medium text-muted-foreground">Layers</p>
            <div className="max-h-44 overflow-y-auto">
              {layers.map(([l, n]) => (
                <div key={l} className="flex items-center gap-0.5">
                  <Row
                    active={!filters.hiddenLayers.has(l)}
                    onClick={() => onChange({ ...filters, hiddenLayers: toggle(filters.hiddenLayers, l) })}
                    title="Show / hide"
                  >
                    <span className="truncate">{l}</span>
                    <span className="ms-auto text-caption text-faint tabular-nums">{n}</span>
                  </Row>
                  <button
                    type="button"
                    title={filters.collapsedLayers.has(l) ? "Expand the group" : "Collapse into one card"}
                    onClick={() => onChange({ ...filters, collapsedLayers: toggle(filters.collapsedLayers, l) })}
                    className={cn(
                      "h-7 shrink-0 rounded-md px-1.5 text-caption transition-colors hover:bg-accent",
                      filters.collapsedLayers.has(l) ? "text-primary" : "text-faint",
                    )}
                  >
                    {filters.collapsedLayers.has(l) ? "collapsed" : "collapse"}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {active ? (
          <button
            type="button"
            onClick={() => onChange({ hiddenKinds: new Set(), hiddenLayers: new Set(), collapsedLayers: new Set(), hops: 0 })}
            className="mt-1.5 h-7 w-full rounded-md text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function SearchBar({
  query,
  onQuery,
  count,
  index,
  onStep,
  onClose,
  elsewhere,
  onReveal,
}: {
  query: string;
  onQuery: (q: string) => void;
  count: number;
  index: number;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  elsewhere: readonly SearchHit[];
  onReveal: (id: string) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="control-glass absolute top-3 left-1/2 z-30 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 rounded-xl" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex h-9 items-center gap-1.5 ps-2.5 pe-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (count === 0 && elsewhere[0]) onReveal(elsewhere[0].id);
              else onStep(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Find on this map…"
          aria-label="Find on this map"
          className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-faint"
        />
        <span className="shrink-0 px-1 text-meta text-muted-foreground tabular-nums">
          {query ? (count ? `${index + 1} of ${count}` : "none here") : ""}
        </span>
        <button type="button" className={btn} aria-label="Previous match" disabled={count < 2} onClick={() => onStep(-1)}>
          <ChevronUp className="size-3.5" />
        </button>
        <button type="button" className={btn} aria-label="Next match" disabled={count < 2} onClick={() => onStep(1)}>
          <ChevronDown className="size-3.5" />
        </button>
        <button type="button" className={btn} aria-label="Close search" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      </div>
      {query && elsewhere.length ? (
        <div className="border-t border-hairline p-1">
          <p className="px-2 pt-0.5 pb-1 text-caption text-faint">Elsewhere in the map</p>
          {elsewhere.map((h, i) => (
            <button
              key={h.id}
              type="button"
              onClick={() => onReveal(h.id)}
              className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui-sm text-foreground/90 transition-colors hover:bg-accent"
            >
              <span className="truncate">{h.label}</span>
              <span className="ms-auto max-w-[55%] shrink-0 truncate font-mono text-caption text-faint">{h.where}</span>
              {i === 0 && count === 0 ? <CornerDownLeft className="size-3 shrink-0 text-faint" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ToolbarButtons({
  onSearch,
  onFit,
  filterMenu,
  hasSelection,
}: {
  onSearch: () => void;
  onFit: () => void;
  filterMenu: ReactNode;
  hasSelection: boolean;
}) {
  return (
    <div className="control-glass absolute top-3 right-3 z-20 flex items-center gap-0.5 rounded-lg p-0.5">
      <button type="button" className={btn} aria-label="Find on this map" title="Find (⌘F)" onClick={onSearch}>
        <Search className="size-3.5" />
      </button>
      {filterMenu}
      <button
        type="button"
        className={btn}
        aria-label={hasSelection ? "Fit to selection" : "Fit to view"}
        title={hasSelection ? "Fit to selection (F)" : "Fit to view (F)"}
        onClick={onFit}
      >
        <Focus className="size-3.5" />
      </button>
    </div>
  );
}
