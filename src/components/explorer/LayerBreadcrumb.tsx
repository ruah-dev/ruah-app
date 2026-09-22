import { ChevronRight, CornerLeftUp } from "lucide-react";
import { graphs } from "@/data/graphs";
import { Button } from "@/components/ui/button";

type Props = {
  stack: string[];
  onJump: (index: number) => void;
  onUp: () => void;
};

export function LayerBreadcrumb({ stack, onJump, onUp }: Props) {
  return (
    <div className="flex h-9 items-center gap-1.5 border-b border-hairline bg-surface-1 px-4">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 rounded-[4px] px-1.5 text-[10.5px]"
        disabled={stack.length < 2}
        onClick={onUp}
      >
        <CornerLeftUp className="size-3.5" />
        Up
      </Button>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {stack.map((id, i) => {
          const graph = graphs[id];
          const last = i === stack.length - 1;
          return (
            <span key={`${id}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground" /> : null}
              <button
                type="button"
                onClick={() => onJump(i)}
                className={
                  last
                    ? "truncate font-mono text-[11.5px] text-foreground"
                    : "truncate font-mono text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {graph?.title ?? id}
              </button>
            </span>
          );
        })}
      </div>
      <span className="ml-auto hidden shrink-0 font-mono text-[10.5px] text-muted-foreground md:inline">
        double-click a node to drill in
      </span>
    </div>
  );
}
