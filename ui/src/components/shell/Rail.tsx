// The 56px icon rail: the Ruah mark (Dashboard), the pages you work in on top, the ones you visit
// now and then at the bottom. Tooltips carry the G-shortcut; small dots say what needs a look
// (agent working = lavender, waiting = amber; unhealthy cloud of this project = amber; running
// ruah tasks = amber).
import { Link, useRouterState } from "@tanstack/react-router";
import { useWorkspace } from "@/lib/workspace";
import { useProjectActivity } from "@/lib/activity";
import { RuahMark } from "@/components/brand/RuahLogo";
import { NavBadge } from "@/components/orchestration/navBadges";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isActivePath, useNav, type NavItemDef } from "./nav";
import { useProjectCloud } from "./useCloudAttention";

function Dot({ className, label }: { className: string; label: string }) {
  return <span aria-label={label} role="status" className={cn("absolute top-1.5 right-1.5 size-[7px] rounded-full ring-2 ring-sidebar", className)} />;
}

function AgentDot() {
  const { daemon } = useWorkspace();
  const activity = useProjectActivity(daemon.project?.id);
  const latest = daemon.turns[daemon.turns.length - 1];
  const running = !!latest && !latest.stopReason;
  const waiting = (running && !!latest?.permission) || (activity?.waitingPermission ?? 0) > 0;
  if (waiting) return <Dot className="bg-warn" label="The agent is waiting for you" />;
  if (running || (activity?.running ?? 0) > 0) return <Dot className="animate-pulse bg-ai" label="The agent is working" />;
  return null;
}

function CloudDot() {
  const { unhealthy } = useProjectCloud();
  if (!unhealthy.length) return null;
  return <Dot className="bg-warn" label={`${unhealthy.length} cloud resource${unhealthy.length === 1 ? "" : "s"} down or degraded`} />;
}

function RailItem({ item, active }: { item: NavItemDef; active: boolean }) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={item.to as "/"}
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative grid size-10 place-items-center rounded-[10px] transition-colors",
            active ? "bg-accent text-brand" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <Icon className="size-[18px]" strokeWidth={active ? 2.1 : 1.8} />
          {item.to === "/agent" ? <AgentDot /> : item.to === "/cloud" ? <CloudDot /> : <NavBadge path={item.to} collapsed />}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        {item.label} <span className="ms-1 text-muted-foreground">G {item.key.toUpperCase()}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const home = pathname === "/";
  const nav = useNav();
  return (
    <nav aria-label="Pages" className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-e border-hairline bg-sidebar py-2.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/"
            aria-label="Dashboard"
            aria-current={home ? "page" : undefined}
            className={cn("mb-2.5 grid size-10 place-items-center rounded-[10px] transition-colors hover:bg-accent/60", home && "bg-accent")}
          >
            <RuahMark size={26} blinkOnHover />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          Dashboard <span className="ms-1 text-muted-foreground">G D</span>
        </TooltipContent>
      </Tooltip>
      {nav.filter((n) => n.rail === "top").map((n) => (
        <RailItem key={n.to} item={n} active={isActivePath(pathname, n.to)} />
      ))}
      <span className="flex-1" />
      {nav.filter((n) => n.rail === "bottom").map((n) => (
        <RailItem key={n.to} item={n} active={isActivePath(pathname, n.to)} />
      ))}
    </nav>
  );
}
