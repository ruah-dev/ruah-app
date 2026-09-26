// The left edge of the shell, in two layouts (./layout.ts, ⌘\):
//
// - Standard (default): the icon rail, 72 px with a name under each icon (56 px without, Settings
//   → Appearance → Rail labels). The Ruah mark (Home); Map, Agent, Cloud, Tasks; the
//   projects as avatar tiles (./RailProjects.tsx); Usage, Integrations, (Extensions), Settings;
//   the layout control.
// - Advanced: a 240 px labelled sidebar with the same pages as rows, a Projects section and the
//   open project's Chats (./SidebarLists.tsx).
//
// Tooltips carry the G-shortcut; small dots say what needs a look (agent working = lavender,
// waiting = amber; unhealthy cloud of this project = amber; running ruah tasks = amber). The
// width animates between layouts (not with reduced motion). Toggling from the rail keeps the
// keyboard focus: it moves to the new layout's control.
import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useProjectActivity } from "@/lib/activity";
import { RuahLogo, RuahMark } from "@/components/brand/RuahLogo";
import { useRunningTaskCount } from "@/components/orchestration/navBadges";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LAYOUT_SHORTCUT, takeLayoutRefocus, toggleLayout, useShellLayout } from "./layout";
import { isActivePath, useNav, type NavItemDef } from "./nav";
import { RailProjects } from "./RailProjects";
import { SidebarChats, SidebarProjects } from "./SidebarLists";
import { useProjectCloud } from "./useCloudAttention";

type DotTone = "ai" | "warn";

interface NavStatus {
  tone: DotTone;
  label: string;
  /** A count for the sidebar row (tasks). */
  count?: number;
}

function useAgentStatus(): NavStatus | null {
  const { daemon } = useWorkspace();
  const activity = useProjectActivity(daemon.project?.id);
  const latest = daemon.turns[daemon.turns.length - 1];
  const running = !!latest && !latest.stopReason;
  const waiting = (running && !!latest?.permission) || (activity?.waitingPermission ?? 0) > 0;
  if (waiting) return { tone: "warn", label: "The agent is waiting for you" };
  if (running || (activity?.running ?? 0) > 0) return { tone: "ai", label: "The agent is working" };
  return null;
}

function useCloudStatus(): NavStatus | null {
  const { unhealthy } = useProjectCloud();
  if (!unhealthy.length) return null;
  return { tone: "warn", label: `${unhealthy.length} cloud resource${unhealthy.length === 1 ? "" : "s"} down or degraded`, count: unhealthy.length };
}

function useTasksStatus(): NavStatus | null {
  const n = useRunningTaskCount();
  return n ? { tone: "warn", label: `${n} task${n === 1 ? "" : "s"} running`, count: n } : null;
}

/** The status of a page's entry (hooks are called by a component per entry). */
function NavStatusOf({ path, children }: { path: string; children: (s: NavStatus | null) => ReactNode }) {
  if (path === "/agent") return <AgentStatusOf>{children}</AgentStatusOf>;
  if (path === "/cloud") return <CloudStatusOf>{children}</CloudStatusOf>;
  if (path === "/tasks") return <TasksStatusOf>{children}</TasksStatusOf>;
  return <>{children(null)}</>;
}
function AgentStatusOf({ children }: { children: (s: NavStatus | null) => ReactNode }) {
  return <>{children(useAgentStatus())}</>;
}
function CloudStatusOf({ children }: { children: (s: NavStatus | null) => ReactNode }) {
  return <>{children(useCloudStatus())}</>;
}
function TasksStatusOf({ children }: { children: (s: NavStatus | null) => ReactNode }) {
  return <>{children(useTasksStatus())}</>;
}

function StatusDot({ status, className }: { status: NavStatus; className?: string }) {
  return (
    <span
      role="status"
      aria-label={status.label}
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        status.tone === "warn" ? "bg-warn" : "animate-pulse bg-ai motion-reduce:animate-none",
        className,
      )}
    />
  );
}

function RailItem({ item, active, labels }: { item: NavItemDef; active: boolean; labels: boolean }) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={item.to as "/"}
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative flex shrink-0 flex-col items-center justify-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            labels ? "w-16 gap-[3px] py-[7px]" : "size-10",
            active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <span className="relative">
            <Icon className={cn("size-[18px]", active && "text-brand")} strokeWidth={active ? 2.1 : 1.8} />
            <NavStatusOf path={item.to}>
              {(s) => (s ? <StatusDot status={s} className="absolute -top-1 -right-1.5 ring-2 ring-sidebar" /> : null)}
            </NavStatusOf>
          </span>
          {labels ? (
            <span aria-hidden className="max-w-full truncate text-[10px] leading-none font-medium">
              {item.label}
            </span>
          ) : null}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        {item.label} <span className="ms-1 text-muted-foreground">G {item.key.toUpperCase()}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarItem({ item, active }: { item: NavItemDef; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to as "/"}
      aria-current={active ? "page" : undefined}
      data-active={active}
      title={`${item.label} · G ${item.key.toUpperCase()}`}
      className="group/nav list-row h-8 gap-2.5 whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon className={cn("size-4 shrink-0", active && "text-brand")} strokeWidth={active ? 2.1 : 1.8} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <NavStatusOf path={item.to}>
        {(s) =>
          s ? (
            s.count ? (
              <span
                role="status"
                aria-label={s.label}
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warn/15 px-1.5 text-[10.5px] font-medium text-warn tabular-nums group-hover/nav:hidden"
              >
                {s.count}
              </span>
            ) : (
              <StatusDot status={s} className="group-hover/nav:hidden" />
            )
          ) : null
        }
      </NavStatusOf>
      <kbd className="kbd hidden shrink-0 group-hover/nav:inline-flex">G {item.key.toUpperCase()}</kbd>
    </Link>
  );
}

const toggleFromRail = () => toggleLayout({ refocus: true });

/** Standard ⇄ Advanced, at the bottom of the rail / sidebar. */
function LayoutToggle({ expanded, buttonRef }: { expanded: boolean; buttonRef: Ref<HTMLButtonElement> }) {
  const label = expanded ? "Collapse to the icon rail" : "Expand to the sidebar (Advanced layout)";
  if (expanded)
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleFromRail}
        aria-label={label}
        className="list-row mt-1 h-8 gap-2.5 whitespace-nowrap text-faint outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <PanelLeftClose className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Collapse sidebar</span>
        <kbd className="kbd shrink-0">{LAYOUT_SHORTCUT}</kbd>
      </button>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          onClick={toggleFromRail}
          aria-label={label}
          className="mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-faint outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        Advanced layout: sidebar with projects and chats <span className="ms-1 text-muted-foreground">{LAYOUT_SHORTCUT}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function DashboardMark({ home }: { home: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/"
          aria-label="Home"
          aria-current={home ? "page" : undefined}
          className={cn(
            "mb-1.5 grid size-10 shrink-0 place-items-center rounded-[10px] outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
            home && "bg-accent",
          )}
        >
          <RuahMark size={26} blinkOnHover />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        Home: every project <span className="ms-1 text-muted-foreground">G H</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const home = pathname === "/";
  const nav = useNav();
  const layout = useShellLayout();
  const advanced = layout.effective === "advanced";
  const top = nav.filter((n) => n.rail === "top");
  const bottom = nav.filter((n) => n.rail === "bottom");
  const toggle = useRef<HTMLButtonElement | null>(null);

  // A toggle from the rail unmounted the focused control with the old layout: give the focus to
  // the new one (only when it was lost; a folded Advanced keeps the same control, and focus).
  useEffect(() => {
    if (!takeLayoutRefocus()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) toggle.current?.focus();
  }, [layout.mode, layout.effective]);

  return (
    <nav
      aria-label="Pages"
      data-shell-rail=""
      data-layout={layout.effective}
      style={{ width: layout.width }}
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-e border-hairline bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none"
    >
      {advanced ? (
        <div className="flex h-full w-60 min-w-60 flex-col px-2 pb-2">
          <div className="flex h-11 shrink-0 items-center px-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/"
                  aria-label="Home"
                  aria-current={home ? "page" : undefined}
                  className={cn("flex h-8 items-center rounded-lg px-1.5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring", home && "bg-accent")}
                >
                  <RuahLogo size="sm" blinkOnHover />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">
                Home: every project <span className="ms-1 text-muted-foreground">G H</span>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex shrink-0 flex-col gap-px">
            {top.map((n) => (
              <SidebarItem key={n.to} item={n} active={isActivePath(pathname, n.to)} />
            ))}
          </div>
          <div className="-mx-2 mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto border-t border-hairline px-2 pt-2 pb-2">
            <SidebarProjects />
            <SidebarChats />
          </div>
          <div className="flex shrink-0 flex-col gap-px border-t border-hairline pt-2">
            {bottom.map((n) => (
              <SidebarItem key={n.to} item={n} active={isActivePath(pathname, n.to)} />
            ))}
            <LayoutToggle expanded buttonRef={toggle} />
          </div>
        </div>
      ) : (
        <div className={cn("flex h-full flex-col items-center py-2.5", layout.labels ? "w-[72px]" : "w-14")}>
          <DashboardMark home={home} />
          <div className="flex shrink-0 flex-col items-center gap-0.5">
            {top.map((n) => (
              <RailItem key={n.to} item={n} labels={layout.labels} active={isActivePath(pathname, n.to)} />
            ))}
          </div>
          <span aria-hidden className="my-2.5 h-px w-8 shrink-0 bg-hairline" />
          <RailProjects />
          <div className="mt-2 flex shrink-0 flex-col items-center gap-0.5">
            {bottom.map((n) => (
              <RailItem key={n.to} item={n} labels={layout.labels} active={isActivePath(pathname, n.to)} />
            ))}
          </div>
          <LayoutToggle expanded={false} buttonRef={toggle} />
        </div>
      )}
    </nav>
  );
}
