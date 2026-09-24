// Small, self-contained activity badge for a project row (CONTRACTS.md §13.2): amber "!" while an
// agent waits for permission, a pulsing dot while a turn runs, else the unread count. Renders
// nothing when the project is quiet (or the daemon has no activity feed).
import { useProjectActivity } from "@/lib/activity";
import { cn } from "@/lib/utils";

export function ProjectActivityBadge({ projectId, className }: { projectId: string; className?: string }) {
  const activity = useProjectActivity(projectId);
  if (!activity) return null;
  const { running, waitingPermission, unread } = activity;
  const parts = [
    waitingPermission > 0 ? `${waitingPermission} waiting for permission` : "",
    running > 0 ? `${running} running` : "",
    unread > 0 ? `${unread} unread` : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const label = parts.join(" · ");
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn("pointer-events-none inline-flex shrink-0 items-center gap-1", className)}
    >
      {waitingPermission > 0 ? (
        <span className="grid size-3.5 place-items-center rounded-full bg-amber-500 text-[9px] font-semibold leading-none text-black">
          !
        </span>
      ) : running > 0 ? (
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      ) : null}
      {unread > 0 ? (
        <span className="min-w-3.5 rounded-full bg-primary/15 px-1 text-center text-[9.5px] font-medium leading-[14px] text-primary">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </span>
  );
}
