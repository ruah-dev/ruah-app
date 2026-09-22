import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiagramNode as NodeType } from "@/data/graphs";
import { NODE_H, NODE_W, kindStyles } from "./kinds";

type Props = {
  node: NodeType;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onHover: (id: string | null) => void;
};

export function DiagramNode({
  node,
  selected,
  dimmed,
  onSelect,
  onDoubleClick,
  onHover,
}: Props) {
  const style = kindStyles[node.kind];
  const Icon = style.icon;

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        left: node.x,
        top: node.y,
        width: node.w ?? NODE_W,
        height: node.h ?? NODE_H,
      }}
      className={cn(
        "node-elevated group absolute flex flex-col justify-center gap-0.5 rounded-md border bg-surface-1 px-3 text-left transition-[transform,opacity,border-color,background-color,box-shadow] duration-150",
        style.border,
        "hover:-translate-y-px hover:border-foreground/20 hover:bg-surface-2",
        selected
          ? "border-ring/70 bg-surface-2 ring-1 ring-ring/20"
          : "",
        dimmed ? "opacity-35" : "opacity-100",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-[4px] border border-hairline bg-surface-3/40">
          <Icon className={cn("size-3.5", style.color)} />
        </span>
        <span className="truncate font-mono text-[12px] font-medium text-foreground">
          {node.label}
        </span>
        {node.drill ? (
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        ) : null}
      </span>
      {node.subtitle ? (
          <span className="truncate pl-8 text-[10.5px] text-muted-foreground">{node.subtitle}</span>
      ) : null}
      <span
        className={cn(
          "absolute inset-x-2.5 bottom-0 h-px opacity-60",
          selected ? "bg-ring" : "bg-hairline",
        )}
      />
    </button>
  );
}
