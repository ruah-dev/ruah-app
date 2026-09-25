// A page's collapsible left drawer (the Map's outline, the Agent page's turns). One open state for
// both (workbench `outlineOpen`, remembered per project in the view state); toggled from the
// page's control row or ⌘B.
import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useWorkbench } from "@/lib/workbench";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function DrawerToggle({ label, className }: { label: string; className?: string }) {
  const wb = useWorkbench();
  const open = wb.outlineOpen;
  const Icon = open ? PanelLeftClose : PanelLeftOpen;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={open}
          onClick={() => wb.setOutlineOpen((v) => !v)}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
            open ? "text-foreground" : "text-muted-foreground",
            className,
          )}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {open ? "Hide" : "Show"} {label.toLowerCase()} <span className="ms-1 text-muted-foreground">⌘B</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function PageDrawer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside
      aria-label={title}
      className="flex h-full w-64 shrink-0 flex-col border-e border-hairline bg-sidebar max-lg:w-56"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3">{children}</div>
    </aside>
  );
}
