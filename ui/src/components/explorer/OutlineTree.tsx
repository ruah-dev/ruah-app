// Outline: the whole hierarchy as a tree (system → repo → package → folder → file → symbol),
// lazily expanded through the same on-demand endpoint as the canvas, synced with the open
// level and the selection. Windowed, so a 1,000-element system scrolls smoothly.
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, Network, Search, X } from "lucide-react";
import type { ArchNode } from "@/lib/contracts";
import { ancestry, indexArchitecture, kindFor, parseDiagramId } from "@/lib/architecture";
import { asExpanded, requestExpansion, requestPeek, type ExpansionState } from "@/lib/expand";
import { styleFor } from "./kinds";
import { VirtualList } from "@/components/common/VirtualList";
import { Phantom } from "@/components/brand/Phantom";
import { cn } from "@/lib/utils";
import type { Architecture } from "@/lib/contracts";

type Row = { node: ArchNode; depth: number; hasKids: boolean; canOpen: boolean; count: number | undefined };

const ROW_H = 26;

export function OutlineTree({
  architecture,
  expansions,
  activeDiagramId,
  selectedId,
  onSelect,
  onOpenLevel,
  onOpenRoot,
  rootLabel,
}: {
  architecture: Architecture;
  expansions: ExpansionState;
  activeDiagramId: string;
  selectedId: string | null;
  /** Select an element on its level. */
  onSelect: (nodeId: string) => void;
  /** Open the level inside an element. */
  onOpenLevel: (nodeId: string) => void;
  /** Open the top level (the tree's root row). */
  onOpenRoot?: (() => void) | undefined;
  rootLabel?: string | undefined;
}) {
  const index = useMemo(() => indexArchitecture(architecture), [architecture]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");

  const levelId = useMemo(() => {
    const ref = parseDiagramId(activeDiagramId);
    return ref?.mode === "architecture" ? ref.parentId : null;
  }, [activeDiagramId]);

  // Follow the canvas: open the path to the current level and to the selection.
  useEffect(() => {
    const ids = [...ancestry(index, levelId).map((n) => n.id), ...ancestry(index, selectedId).slice(0, -1).map((n) => n.id)];
    if (ids.length === 0) return;
    setOpen((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, [index, levelId, selectedId]);

  const kidsOf = (id: string | null) => (index.children.get(id) ?? []).filter((n) => !index.workflowOnly.has(n.id));

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const q = filter.trim().toLowerCase();
    // With a filter: every loaded element whose name or path matches, plus its ancestors.
    let keep: Set<string> | null = null;
    if (q) {
      keep = new Set();
      for (const n of architecture.nodes) {
        if (index.workflowOnly.has(n.id)) continue;
        if (n.name.toLowerCase().includes(q) || (n.path ?? "").toLowerCase().includes(q)) {
          for (const a of ancestry(index, n.id)) keep.add(a.id);
        }
      }
    }
    const walk = (parent: string | null, depth: number) => {
      for (const n of kidsOf(parent)) {
        if (keep && !keep.has(n.id)) continue;
        const x = asExpanded(n);
        const kids = index.children.get(n.id)?.length ?? 0;
        const peek = expansions.peeks.get(n.id);
        const unknown = kids === 0 && x?.expandable === undefined && peek === undefined && !!n.path && !x?.symbol;
        const canOpen = kids > 0 || x?.expandable === true || unknown;
        const count = kids > 0 ? kids : (x?.childCount ?? undefined);
        out.push({ node: n, depth, hasKids: kids > 0, canOpen, count: count || undefined });
        if ((keep || open.has(n.id)) && kids > 0) walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [architecture, index, open, filter, expansions.peeks]);

  // Counts for stored leaves in view (peeks are batched and cached).
  useEffect(() => {
    const ids = rows.filter((r) => !r.hasKids && r.canOpen && !asExpanded(r.node)?.ephemeral).map((r) => r.node.id);
    if (ids.length) requestPeek(ids.slice(0, 400));
  }, [rows]);

  const toggle = (row: Row) => {
    const id = row.node.id;
    const isOpen = open.has(id);
    setOpen((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!isOpen && !row.hasKids && row.canOpen) void requestExpansion(id);
  };

  const activeIndex = rows.findIndex((r) => r.node.id === selectedId);

  return (
    <div className="flex min-h-0 flex-col">
      <label className="mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2 ring-1 ring-hairline focus-within:ring-ring/50">
        <Search className="size-3 shrink-0 text-faint" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
          placeholder="Filter elements"
          aria-label="Filter the outline"
          className="min-w-0 flex-1 bg-transparent text-ui-sm text-foreground outline-none placeholder:text-faint"
        />
        {filter ? (
          <button type="button" aria-label="Clear filter" onClick={() => setFilter("")} className="text-faint hover:text-foreground">
            <X className="size-3" />
          </button>
        ) : null}
      </label>
      {onOpenRoot ? (
        <button
          type="button"
          onClick={onOpenRoot}
          className={cn(
            "flex h-[26px] min-w-0 items-center gap-1.5 rounded-md ps-1.5 pe-1.5 text-left text-ui-sm transition-colors hover:bg-accent/60",
            activeDiagramId === "arch:root" ? "font-medium text-foreground" : "text-foreground/70 hover:text-foreground",
          )}
          title="Open the top level"
        >
          <Network className="size-3.5 shrink-0 text-faint" />
          <span className="truncate">{rootLabel || "Top level"}</span>
          {activeDiagramId === "arch:root" ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
        </button>
      ) : null}
      {rows.length === 0 ? (
        <p className="px-2 py-1 text-label text-faint">{filter ? "No loaded element matches" : "Nothing on the map yet"}</p>
      ) : (
        <VirtualList
          items={rows}
          itemHeight={ROW_H}
          getKey={(r) => r.node.id}
          {...(activeIndex >= 0 ? { activeIndex } : {})}
          role="tree"
          aria-label="Architecture outline"
          className="max-h-[46vh]"
          renderItem={(r) => {
            const n = r.node;
            const x = asExpanded(n);
            const style = styleFor({ kind: kindFor(n.type), symbol: x?.symbol });
            const Icon = style.icon;
            const isOpen = open.has(n.id);
            const entry = expansions.entries.get(n.id);
            const loading = entry?.status === "loading" && !r.hasKids;
            const selected = n.id === selectedId;
            const current = n.id === levelId;
            return (
              <div
                role="treeitem"
                aria-expanded={r.canOpen ? isOpen : undefined}
                aria-selected={selected}
                className={cn(
                  "group/row flex h-[26px] min-w-0 items-center rounded-md pe-1.5 text-ui-sm transition-colors",
                  selected ? "bg-accent text-foreground" : "text-foreground/70 hover:bg-accent/60 hover:text-foreground",
                )}
                style={{ paddingInlineStart: 2 + r.depth * 12 }}
                title={n.path ?? n.name}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={isOpen ? `Collapse ${n.name}` : `Expand ${n.name}`}
                  disabled={!r.canOpen}
                  onClick={() => toggle(r)}
                  className="grid size-5 shrink-0 place-items-center rounded text-faint hover:text-foreground disabled:invisible"
                >
                  {loading ? (
                    <Phantom expression="loading" size={13} label={`Loading ${n.name}`} />
                  ) : (
                    <ChevronRight className={cn("size-3 transition-transform", isOpen && r.hasKids && "rotate-90")} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  onDoubleClick={() => r.canOpen && onOpenLevel(n.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <Icon className={cn("size-3.5 shrink-0", style.color)} />
                  <span className={cn("truncate", current && "font-medium text-foreground")}>{n.name}</span>
                  {current ? <span className="size-1.5 shrink-0 rounded-full bg-primary" title="Open on the canvas" /> : null}
                  {r.count ? <span className="ms-auto shrink-0 ps-1 text-caption text-faint tabular-nums">{r.count}</span> : null}
                </button>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
