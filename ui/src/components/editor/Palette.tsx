import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { NodeKind } from "@/data/graphs";
import type { KindGroup } from "@/lib/workspace";
import { kindStyles } from "@/components/explorer/kinds";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = {
  groups: KindGroup[];
  onQuickAdd: (kind: NodeKind) => void;
};

export function Palette({ groups, onQuickAdd }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        kinds: g.kinds.filter(
          (k) => k.includes(q) || kindStyles[k].label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.kinds.length > 0);
  }, [groups, query]);

  return (
    <div className="space-y-2.5">
      <div className="relative">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="h-7 rounded-md border-0 bg-foreground/[0.05] pl-7 text-ui-sm shadow-none focus-visible:ring-1"
        />
      </div>

      <div className="space-y-2.5">
        {filtered.map((group) => {
          const isCollapsed = !query && collapsed[group.label];
          return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [group.label]: !c[group.label] }))}
                className="flex w-full items-center gap-1 px-0.5 pb-1 text-meta font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={cn("size-3 transition-transform", !isCollapsed && "rotate-90")}
                />
                {group.label}
              </button>
              {isCollapsed ? null : (
                <div className="grid grid-cols-2 gap-0.5">
                  {group.kinds.map((kind) => {
                    const style = kindStyles[kind];
                    const Icon = style.icon;
                    return (
                      <button
                        key={kind}
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/ruah-kind", kind);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onClick={() => onQuickAdd(kind)}
                        title={`Add ${style.label} (drag or click)`}
                        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-accent"
                      >
                        <Icon className={cn("size-3.5 shrink-0", style.color)} />
                        <span className="truncate text-label text-foreground/85">
                          {style.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 ? (
          <p className="px-1 text-label text-muted-foreground">No element matches that.</p>
        ) : null}
      </div>
    </div>
  );
}
