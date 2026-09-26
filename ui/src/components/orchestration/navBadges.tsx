// Cheap counts for the sidebar nav: running ruah tasks. Reads the shared store; refreshes
// slowly only while something is running (the Tasks page polls faster on its own).
import { useEffect } from "react";
import { loadRuah, useEnsure } from "@/lib/integrations";
import { cn } from "@/lib/utils";

export function useRunningTaskCount(): number {
  const s = useEnsure("ruah");
  const running =
    s.ruah.status === "ok" && s.ruah.data.initialized
      ? s.ruah.data.tasks.filter((t) => t.status === "in-progress").length
      : 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void loadRuah();
    }, 20_000);
    return () => clearInterval(t);
  }, [running]);
  return running;
}

/** Badge for a nav entry (null = none). Only /tasks has one today. */
export function NavBadge({ path, collapsed }: { path: string; collapsed: boolean }) {
  if (path !== "/tasks") return null;
  return <TasksBadge collapsed={collapsed} />;
}

function TasksBadge({ collapsed }: { collapsed: boolean }) {
  const n = useRunningTaskCount();
  if (!n) return null;
  if (collapsed)
    return (
      <span
        aria-label={`${n} running`}
        className="absolute top-1 right-1 size-1.5 animate-pulse rounded-full bg-warn"
      />
    );
  return (
    <span
      aria-label={`${n} running`}
      title={`${n} running`}
      className={cn(
        "flex h-4 min-w-4 shrink-0 items-center justify-center gap-1 rounded-full bg-warn/15 px-1.5 text-micro font-medium text-warn tabular-nums",
      )}
    >
      <span className="size-1 animate-pulse rounded-full bg-warn" />
      {n}
    </span>
  );
}
