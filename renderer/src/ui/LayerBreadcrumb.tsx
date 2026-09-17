import { ChevronRight, CornerLeftUp } from "lucide-react";

interface Props {
  stack: (string | null)[];
  names: Record<string, string>;
  onJump: (index: number) => void;
  onUp: () => void;
}

// Breadcrumb over the drill stack; entries hold node ids (root = null).
export function LayerBreadcrumb({ stack, names, onJump, onUp }: Props) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 border-b px-4"
      style={{ backgroundColor: "var(--surface-1)" }}
    >
      <button
        type="button"
        className="mono flex h-6 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-[10.5px] disabled:cursor-default disabled:opacity-40"
        style={{ color: "var(--muted-foreground)" }}
        disabled={stack.length < 2}
        onClick={onUp}
      >
        <CornerLeftUp className="size-3.5" />
        Up
      </button>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {stack.map((id, i) => {
          const last = i === stack.length - 1;
          const label = id === null ? "System" : names[id] ?? id;
          return (
            <span key={`${id ?? "root"}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 ? (
                <ChevronRight className="size-3 shrink-0 text-[var(--muted-foreground)]" />
              ) : null}
              <button
                type="button"
                onClick={() => onJump(i)}
                className={
                  last
                    ? "mono truncate text-[11.5px] text-[var(--foreground)]"
                    : "mono cursor-pointer truncate text-[11.5px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                }
              >
                {label}
              </button>
            </span>
          );
        })}
      </div>
      <span
        className="mono ml-auto hidden shrink-0 text-[10.5px] md:inline"
        style={{ color: "var(--muted-foreground)" }}
      >
        double-click a node to drill in
      </span>
    </div>
  );
}
