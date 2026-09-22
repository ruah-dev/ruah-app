import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
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
    <div className="border-b border-hairline px-2 py-2.5">
      <p className="flex items-center justify-between px-1 pb-2 text-[9.5px] font-semibold text-muted-foreground uppercase">
        Elements
        <span className="font-mono text-[9px] normal-case">drag or click</span>
      </p>
      <div className="relative mb-2">
        <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter elements…"
          className="h-7 rounded-[4px] border-hairline bg-surface-2 pl-7 font-mono text-[10.5px] shadow-none"
        />
      </div>

      <div className="space-y-2">
        {filtered.map((group) => {
          const isCollapsed = !query && collapsed[group.label];
          return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [group.label]: !c[group.label] }))}
                className="flex w-full items-center gap-1 px-1 pb-1 text-[9.5px] font-semibold text-muted-foreground uppercase hover:text-foreground"
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                {group.label}
                <span className="ml-auto font-mono text-[9px] normal-case">
                  {group.kinds.length}
                </span>
              </button>
              {isCollapsed ? null : (
                <div className="grid grid-cols-2 gap-1">
                  {group.kinds.map((kind) => {
                    const style = kindStyles[kind];
                    const Icon = style.icon;
                    return (
                      <button
                        key={kind}
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/atlas-kind", kind);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onClick={() => onQuickAdd(kind)}
                        title={style.label}
                        className="flex items-center gap-1.5 rounded-[4px] border border-hairline bg-surface-2 px-2 py-1.5 text-left transition-colors duration-150 hover:border-foreground/20 hover:bg-surface-3"
                      >
                        <Icon className={cn("size-3.5 shrink-0", style.color)} />
                        <span className="truncate font-mono text-[10.5px] text-foreground">
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
          <p className="px-1 text-[10.5px] text-muted-foreground">No element matches that.</p>
        ) : null}
      </div>
    </div>
  );
}
