// A sidebar section with a disclosure header. Open/closed state is remembered per section id.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const KEY = "ruah.sidebar.sections.v1";

function readAll(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function useSectionOpen(id: string, defaultOpen = true) {
  const [open, setOpenState] = useState(defaultOpen);
  useEffect(() => {
    const v = readAll()[id];
    if (typeof v === "boolean") setOpenState(v);
  }, [id]);
  const setOpen = useCallback(
    (v: boolean) => {
      setOpenState(v);
      try {
        window.localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [id]: v }));
      } catch {
        /* storage unavailable */
      }
    },
    [id],
  );
  return [open, setOpen] as const;
}

export function CollapsibleSection({
  id,
  label,
  icon,
  action,
  count,
  defaultOpen = true,
  children,
  className,
}: {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Buttons on the right of the header (e.g. "+"); shown while hovering the header or open. */
  action?: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("group/section", className)}>
      <div className="flex h-row items-center gap-1 ps-1 pe-1">
        <CollapsibleTrigger className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
          {icon}
          <span className="section-label truncate">{label}</span>
          {count !== undefined && count > 0 ? (
            <span className="text-[10.5px] text-muted-foreground/50 tabular-nums">{count}</span>
          ) : null}
        </CollapsibleTrigger>
        {action ? <span className="flex shrink-0 items-center">{action}</span> : null}
      </div>
      <CollapsibleContent className="data-[state=closed]:hidden">{children}</CollapsibleContent>
    </Collapsible>
  );
}
