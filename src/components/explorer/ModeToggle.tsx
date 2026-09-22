import { GitBranch, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type ViewMode = "architecture" | "workflows";

export function ModeToggle({
  mode,
  onChange,
  compact = false,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
  compact?: boolean;
}) {
  const items: { id: ViewMode; label: string; icon: typeof Network }[] = [
    { id: "architecture", label: "Architecture", icon: Network },
    { id: "workflows", label: "Workflows", icon: GitBranch },
  ];

  return (
    <div className="flex h-8 items-center rounded-md border border-hairline bg-surface-2 p-0.5">
      {items.map((item) => {
        const active = mode === item.id;
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(item.id)}
            className={cn(
              "h-6.5 gap-1.5 rounded-[4px] text-[11px] font-medium shadow-none transition-colors duration-150",
              compact ? "px-2.5" : "px-3",
              active
                ? "bg-surface-3 text-foreground"
                : "text-muted-foreground hover:bg-surface-3/50 hover:text-foreground",
            )}
          >
            <item.icon className={cn("size-3.5", active ? "text-primary" : "")} />
            {compact ? (active ? item.label : null) : item.label}
          </Button>
        );
      })}
    </div>
  );
}
