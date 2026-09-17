import { cn } from "../lib/cn.js";
import type { DiagramNode } from "../lib/graphTypes.js";
import { NODE_H, NODE_W, kindStyles } from "./kinds.js";

interface Props {
  node: DiagramNode;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  onAsk: () => void;
  onDrill: () => void;
  onHover: (id: string | null) => void;
}

export function DiagramNodeCard({ node, selected, dimmed, onSelect, onAsk, onDrill, onHover }: Props) {
  const style = kindStyles[node.kind];
  const Icon = style.icon;

  return (
    <div
      className="absolute"
      style={{ left: node.x, top: node.y, width: node.w ?? NODE_W, height: node.h ?? NODE_H }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onSelect();
          onDrill();
        }}
        className={cn(
          "node-shadow group relative flex h-full w-full cursor-pointer flex-col justify-center gap-0.5 rounded-[var(--radius-sm)] border bg-[var(--surface-1)] px-3 text-left transition-[border-color,background-color,opacity] duration-150",
          "hover:bg-[var(--surface-2)]",
          selected ? "border-[var(--accent)]" : "border-[var(--hairline)]",
          dimmed ? "opacity-35" : "opacity-100",
        )}
      >
        {selected ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[var(--radius-sm)]"
            style={{ boxShadow: "0 0 0 1px var(--accent)", opacity: 0.35 }}
          />
        ) : null}
        <span className="flex items-center gap-2">
          <span
            className="grid size-6 shrink-0 place-items-center rounded-[4px] border border-[var(--hairline)]"
            style={{ backgroundColor: "var(--surface-3)" }}
          >
            <Icon className="size-3.5" style={{ color: style.color }} />
          </span>
          <span className="mono truncate text-[12px] font-medium text-[var(--foreground)]">
            {node.label}
          </span>
          {node.drill ? (
            <span
              className="mono ml-auto shrink-0 rounded-sm px-1 text-[9px]"
              style={{ color: "var(--muted-foreground)", backgroundColor: "var(--surface-3)" }}
            >
              ⏎
            </span>
          ) : null}
        </span>
        {node.subtitle ? (
          <span className="mono truncate pl-8 text-[10.5px] text-[var(--muted-foreground)]">
            {node.subtitle}
          </span>
        ) : null}
        <span
          aria-hidden
          className="absolute inset-x-2.5 bottom-0 h-px"
          style={{ backgroundColor: selected ? "var(--accent)" : "var(--hairline)", opacity: 0.6 }}
        />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
        title={`Ask the agent about ${node.label}`}
        className="mono absolute -right-2 -top-2 z-10 grid size-5 cursor-pointer place-items-center rounded-full border text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          backgroundColor: "var(--surface-2)",
          borderColor: "var(--accent)",
          color: "var(--accent)",
        }}
      >
        ✦
      </button>
    </div>
  );
}
