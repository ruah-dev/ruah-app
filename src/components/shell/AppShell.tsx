// Visual patterns adapted from t3code apps/web/src/components/AppSidebarLayout.tsx and
// Sidebar.tsx (MIT), in Cursor's flat idiom: one slim sidebar that is the app menu, hairline
// separators instead of boxes, compact rows, an icon rail when collapsed.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  CircleHelp,
  LayoutDashboard,
  Map as MapIcon,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Wind,
  Workflow,
} from "lucide-react";
import { kindFor } from "@/lib/architecture";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { useIsMobile } from "@/hooks/use-mobile";
import { agentDotClass, agentStatusLabel } from "@/components/agent/AgentPanel";
import { kindStyles } from "@/components/explorer/kinds";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { Onboarding } from "@/components/workspace/Onboarding";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentSidebarSection, MapSidebarSection } from "./SidebarSections";

export const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, key: "d" },
  { to: "/map", label: "Map", icon: MapIcon, key: "m" },
  { to: "/agent", label: "Agent", icon: MessageSquare, key: "a" },
  { to: "/usage", label: "Usage", icon: BarChart3, key: "u" },
  { to: "/settings", label: "Settings", icon: Settings, key: "s" },
] as const;

export type NavPath = (typeof NAV)[number]["to"];

export function RuahMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary",
        className,
      )}
    >
      <Wind className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}

function usePathname() {
  return useRouterState({ select: (s) => s.location.pathname });
}

function isActive(pathname: string, to: string) {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
}

/** Global shortcuts: "/" search, G then D/M/A/U/S to switch pages, ⌘B sidebar. */
function useShellKeys() {
  const router = useRouter();
  const wb = useWorkbench();
  const pendingG = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (/input|textarea|select/i.test(target.tagName) || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && !e.shiftKey) {
        e.preventDefault();
        wb.setSidebarCollapsed((v) => !v);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        wb.setSearchOpen(true);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "g") {
        pendingG.current = Date.now();
        return;
      }
      if (Date.now() - pendingG.current < 1200) {
        const item = NAV.find((n) => n.key === k);
        pendingG.current = 0;
        if (item) {
          e.preventDefault();
          void router.navigate({ to: item.to });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, wb]);
}

function NavItem({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: (typeof NAV)[number];
  active: boolean;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors",
        collapsed ? "w-8 justify-center" : "px-2",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={active ? 2.1 : 1.8} />
      {collapsed ? null : (
        <>
          <span className="truncate">{item.label}</span>
          <kbd className="ms-auto font-sans text-[10.5px] tracking-wider text-muted-foreground/0 transition-colors group-hover/nav:text-muted-foreground/60">
            G {item.key.toUpperCase()}
          </kbd>
        </>
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {item.label} <span className="ms-1 text-muted-foreground">G {item.key.toUpperCase()}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function StatusLine({ collapsed }: { collapsed: boolean }) {
  const { daemon } = useWorkspace();
  const agents = daemon.agent?.agents;
  const agentName =
    agents?.available.find((a) => a.id === agents.currentAgentId)?.name ??
    daemon.agent?.agent?.name;
  const model = daemon.agent?.models?.available.find(
    (m) => m.id === daemon.agent?.models?.currentModelId,
  )?.name;
  const label =
    daemon.source === "sample"
      ? "Sample data"
      : daemon.agentSwitch
        ? `Starting ${daemon.agentSwitch.name}…`
        : daemon.connection !== "open"
          ? daemon.source === null
            ? "Connecting…"
            : "Reconnecting…"
          : [agentName, model].filter(Boolean).join(" · ") || "Agent";
  const dot = <span className={cn("size-1.5 shrink-0 rounded-full", agentDotClass(daemon))} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex h-7 min-w-0 items-center gap-2 rounded-md text-[12px] text-muted-foreground",
            collapsed ? "w-8 justify-center" : "px-2",
          )}
        >
          {dot}
          {collapsed ? null : <span className="truncate">{label}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? "right" : "top"} className="max-w-80">
        {agentStatusLabel(daemon)}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar({
  collapsed,
  onNavigate,
  mobile = false,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  const { workspace, daemon } = useWorkspace();
  const wb = useWorkbench();
  const pathname = usePathname();
  const page = pathname === "/map" ? "map" : pathname === "/agent" ? "agent" : null;

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col bg-surface-1",
        !mobile && "border-e border-hairline",
        collapsed ? "w-12 items-center" : mobile ? "w-full" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-12 shrink-0 items-center gap-2",
          collapsed ? "justify-center" : "ps-3 pe-2",
        )}
      >
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={() => wb.setSidebarCollapsed(false)}
                className="group/mark relative grid size-8 place-items-center rounded-md hover:bg-accent"
              >
                <RuahMark className="group-hover/mark:opacity-0" />
                <PanelLeftOpen className="absolute size-4 text-muted-foreground opacity-0 group-hover/mark:opacity-100" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar · ⌘B</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <RuahMark />
            <span className="text-[14px] font-semibold tracking-tight">Ruah</span>
            <span className="flex-1" />
            {mobile ? null : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Collapse sidebar"
                    onClick={() => wb.setSidebarCollapsed(true)}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <PanelLeftClose className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Collapse · ⌘B</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>

      <div className={cn("shrink-0 pb-2", collapsed ? "px-2" : "px-2")}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="grid size-8 place-items-center">
                <span className={cn("size-2 rounded-full", agentDotClass(daemon))} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{workspace.apps[0]?.name}</TooltipContent>
          </Tooltip>
        ) : (
          <ProjectSwitcher
            workspace={workspace}
            dotClass={agentDotClass(daemon)}
            detail={daemon.root}
            onSelect={() => wb.clearSelection()}
          />
        )}
      </div>

      <nav className={cn("shrink-0 space-y-px pb-3", collapsed ? "px-2" : "px-2")}>
        {NAV.map((item) => (
          <NavItem
            key={item.to}
            item={item}
            active={isActive(pathname, item.to)}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Search"
                onClick={() => wb.setSearchOpen(true)}
                className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Search className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Search · /</TooltipContent>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={() => wb.setSearchOpen(true)}
            className="group/nav flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            <Search className="size-4" strokeWidth={1.8} />
            Search
            <kbd className="ms-auto font-sans text-[10.5px] text-muted-foreground/60">/</kbd>
          </button>
        )}
      </nav>

      {!collapsed && page ? (
        <div className="min-h-0 w-full flex-1 overflow-y-auto border-t border-hairline px-2 pt-3 pb-3">
          {page === "map" ? (
            <MapSidebarSection onNavigate={onNavigate} />
          ) : (
            <AgentSidebarSection onNavigate={onNavigate} />
          )}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div
        className={cn(
          "flex w-full shrink-0 items-center gap-1 border-t border-hairline py-2",
          collapsed ? "flex-col px-2" : "px-2",
        )}
      >
        <StatusLine collapsed={collapsed} />
        {collapsed ? null : <span className="flex-1" />}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Getting started"
              onClick={() => wb.setOnboardingOpen(true)}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CircleHelp className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"}>Getting started</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}

function SearchDialog() {
  const { architecture } = useWorkspace();
  const wb = useWorkbench();
  const router = useRouter();
  return (
    <CommandDialog open={wb.searchOpen} onOpenChange={wb.setSearchOpen}>
      <CommandInput placeholder="Search elements, paths, workflows, pages…" className="text-[13.5px]" />
      <CommandList className="max-h-[min(60vh,420px)]">
        <CommandEmpty className="py-6 text-center text-[13px] text-muted-foreground">
          Nothing matches.
        </CommandEmpty>
        <CommandGroup heading="Elements">
          {architecture.nodes.map((n) => {
            const kind = kindStyles[kindFor(n.type)];
            const Icon = kind.icon;
            return (
              <CommandItem
                key={n.id}
                value={`${n.name} ${n.path ?? ""} ${n.id} ${n.type} ${(n.files ?? []).join(" ")}`}
                onSelect={() => {
                  wb.openNode(n.id);
                  wb.setSearchOpen(false);
                  wb.setMobileNavOpen(false);
                }}
                className="gap-2.5 rounded-md text-[13px]"
              >
                <Icon className={cn("size-4", kind.color)} />
                <span className="truncate">{n.name}</span>
                <span className="ms-auto truncate font-mono text-[11.5px] text-muted-foreground">
                  {n.path ?? n.type}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {architecture.workflows.length ? (
          <CommandGroup heading="Workflows">
            {architecture.workflows.map((w) => (
              <CommandItem
                key={w.id}
                value={`workflow ${w.name} ${w.id}`}
                onSelect={() => {
                  wb.openDiagram(`flow:${w.id}`);
                  wb.setSearchOpen(false);
                }}
                className="gap-2.5 rounded-md text-[13px]"
              >
                <Workflow className="size-4 text-muted-foreground" />
                {w.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Pages">
          {NAV.map((item) => (
            <CommandItem
              key={item.to}
              value={`page ${item.label}`}
              onSelect={() => {
                void router.navigate({ to: item.to });
                wb.setSearchOpen(false);
              }}
              className="gap-2.5 rounded-md text-[13px]"
            >
              <item.icon className="size-4 text-muted-foreground" />
              {item.label}
              <span className="ms-auto text-[11px] text-muted-foreground">
                G {item.key.toUpperCase()}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const wb = useWorkbench();
  const isMobile = useIsMobile();
  const pathname = usePathname();
  // The SPA ships one prerendered index.html for every path (the daemon's fallback), so the
  // prerender must not contain page content: render the shell only after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useShellKeys();

  if (!mounted) return <div className="h-dvh bg-background" />;

  const dialogs = (
    <>
      <SearchDialog />
      <Onboarding
        open={wb.onboardingOpen}
        onOpenChange={(open) => (open ? wb.setOnboardingOpen(true) : wb.finishOnboarding())}
      />
    </>
  );

  if (isMobile) {
    const current = NAV.find((n) => isActive(pathname, n.to));
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        {dialogs}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-2">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => wb.setMobileNavOpen(true)}
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Menu className="size-4.5" />
          </button>
          <span className="text-[14px] font-medium">{current?.label ?? "Ruah"}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Search"
            onClick={() => wb.setSearchOpen(true)}
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" />
          </button>
        </header>
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        <Sheet open={wb.mobileNavOpen} onOpenChange={wb.setMobileNavOpen}>
          <SheetContent side="left" className="w-[86vw] max-w-xs border-hairline p-0 [&>button]:hidden">
            <SheetHeader className="sr-only">
              <SheetTitle>Menu</SheetTitle>
            </SheetHeader>
            <AppSidebar collapsed={false} mobile onNavigate={() => wb.setMobileNavOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {dialogs}
      <AppSidebar collapsed={wb.sidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

/** Page header in the shell's flat style: title on the left, actions on the right. */
export function PageHeader({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-5 max-md:h-11 max-md:px-3",
        className,
      )}
    >
      <h1 className="min-w-0 truncate text-[14px] font-medium text-foreground max-md:hidden">
        {title}
      </h1>
      <span className="flex-1" />
      {children}
    </div>
  );
}
