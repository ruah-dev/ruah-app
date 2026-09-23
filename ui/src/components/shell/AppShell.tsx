// Visual patterns adapted from t3code apps/web/src/components/AppSidebarLayout.tsx and
// Sidebar.tsx (MIT), in Cursor's flat idiom: one slim sidebar that is the app menu, hairline
// separators instead of boxes, compact rows, an icon rail when collapsed.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  CircleHelp,
  Cloud,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Map as MapIcon,
  Menu,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { kindFor } from "@/lib/architecture";
import { requestModelPicker } from "@/lib/bus";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { useIsMobile } from "@/hooks/use-mobile";
import { agentDotClass, agentStatusLabel } from "@/components/agent/AgentPanel";
import { kindStyles } from "@/components/explorer/kinds";
import { ChatsSection } from "@/components/chats/ChatsSection";
import { Launcher } from "@/components/launcher/Launcher";
import { NewProjectDialog, OpenFolderDialog } from "@/components/projects/ProjectDialogs";
import { ProjectMenu, useCurrentProjectLabel } from "@/components/projects/ProjectMenu";
import { ProjectPalette } from "@/components/projects/ProjectPalette";
import { ProjectTile } from "@/components/projects/ProjectBits";
import { useProjectActions } from "@/components/projects/useProjectActions";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RuahLogo, RuahMark } from "@/components/brand/RuahLogo";
import { Phantom } from "@/components/brand/Phantom";
import { agentExpressionLabel, useAgentExpression } from "@/components/brand/agentExpression";
import { AgentSidebarSection, MapSidebarSection } from "./SidebarSections";
import { ProjectsSection } from "./ProjectsSection";
import { RecentChatsSwitcher } from "@/components/chats/RecentChatsSwitcher";
import { useRecordChatVisits } from "@/lib/mru";
import { neighborChat } from "@/lib/switching";
import { reportSwitchPainted, switchPending } from "@/lib/switch-timing";
import { sameRoot, type DaemonState } from "@/lib/daemon";
import { TerminalPanel, TerminalToggleButton } from "@/components/terminal/TerminalPanel";
import { useTerminal } from "@/lib/terminal";

/** Reports when a pending project / chat switch shows on screen (see lib/switch-timing.ts). */
function useSwitchPaintProbe(daemon: DaemonState) {
  useEffect(() => {
    const pending = switchPending();
    if (!pending) return;
    if (pending.kind === "project") {
      const sw = daemon.projectSwitch;
      const isTarget = (id: string | undefined, root: string | null | undefined) =>
        id === pending.target || (!!root && sameRoot(root, pending.target));
      if (sw?.preview && isTarget(sw.projectId, sw.root) && daemon.architecture)
        reportSwitchPainted("project", pending.target, "preview");
      if (!sw && daemon.project && isTarget(daemon.project.id, daemon.project.root) && daemon.architecture) {
        reportSwitchPainted("project", pending.target, "preview");
        reportSwitchPainted("project", pending.target, "live");
      }
    } else if (daemon.activeChatId === pending.target) {
      if (daemon.turns.length > 0 || !daemon.chatLoading) reportSwitchPainted("chat", pending.target, "preview");
      if (!daemon.chatLoading) reportSwitchPainted("chat", pending.target, "live");
    }
  }, [daemon]);
}
import { NavBadge } from "@/components/orchestration/navBadges";

export { RuahMark };

type NavItemDef = {
  to: string;
  label: string;
  icon: LucideIcon;
  key: string;
  /** Reserved slot: shown only once a route with this path is registered (another package adds it). */
  optional?: boolean;
};

export const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, key: "d" },
  { to: "/map", label: "Map", icon: MapIcon, key: "m" },
  { to: "/agent", label: "Agent", icon: MessageSquare, key: "a" },
  { to: "/chats", label: "Chats", icon: MessagesSquare, key: "c" },
  { to: "/tasks", label: "Tasks", icon: ListChecks, key: "t" },
  { to: "/cloud", label: "Cloud", icon: Cloud, key: "l" },
  { to: "/usage", label: "Usage", icon: BarChart3, key: "u" },
  { to: "/integrations", label: "Integrations", icon: Plug, key: "i" },
  { to: "/settings", label: "Settings", icon: Settings, key: "s" },
] as const satisfies readonly NavItemDef[];

export type NavPath = (typeof NAV)[number]["to"];
/** Reserved entries are only rendered when their route exists, so a registered path is safe here. */
type LinkPath = "/";

/** NAV without the reserved entries whose routes do not exist (yet). */
export function useNavItems(): readonly NavItemDef[] {
  const router = useRouter();
  return useMemo(() => {
    const byPath = router.routesByPath as unknown as Record<string, unknown>;
    return NAV.filter((n) => !("optional" in n && n.optional) || n.to in byPath);
  }, [router]);
}

function usePathname() {
  return useRouterState({ select: (s) => s.location.pathname });
}

function isActive(pathname: string, to: string) {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Global shortcuts: "/" search, G then a letter to switch pages, ⌘B sidebar, ⌘K / ⌘P project +
 * chat switcher, ⌘J recent chats (RecentChatsSwitcher), ⌘[ / ⌘] previous / next chat, ⌘O open
 * folder, ⌘N new chat (⇧⌘N new project), ⌘1…⌘9 pinned projects, ⌘. agent · model picker.
 */
function useShellKeys() {
  const router = useRouter();
  const wb = useWorkbench();
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const nav = useNavItems();
  const pendingG = useRef<number>(0);
  const latest = useRef({ wb, daemon, actions, nav });
  latest.current = { wb, daemon, actions, nav };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { wb, daemon, actions, nav } = latest.current;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (/input|textarea|select/i.test(target.tagName) || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && e.shiftKey && k === "n") {
        e.preventDefault();
        actions.newProject();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey) {
        if (k === "b") {
          e.preventDefault();
          wb.setSidebarCollapsed((v) => !v);
          return;
        }
        if (k === "k" || k === "p") {
          e.preventDefault();
          wb.setPaletteOpen(!wb.paletteOpen);
          return;
        }
        if (k === "o") {
          e.preventDefault();
          void actions.pickFolder();
          return;
        }
        if (k === "n") {
          // ⌘N: a new chat while a project is open (the start screen: a new project).
          e.preventDefault();
          if (daemon.projectsSupported && daemon.project && !wb.launcherOpen) actions.startChat();
          else actions.newProject();
          return;
        }
        if (e.key === "[" || e.key === "]") {
          // ⌘[ / ⌘]: previous / next chat of this project (list order), where a chat is shown.
          const path = router.state.location.pathname;
          if (path !== "/agent" && path !== "/map") return;
          const next = neighborChat(daemon.chats, daemon.activeChatId, e.key === "]" ? 1 : -1);
          e.preventDefault();
          if (next) void actions.showChat({ id: next.id, projectId: next.projectId });
          return;
        }
        if (e.key === ".") {
          e.preventDefault();
          if (!requestModelPicker()) void router.navigate({ to: "/agent" });
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          const pinned = daemon.recentProjects.filter((p) => p.pinned);
          const p = pinned[Number(e.key) - 1];
          if (p) {
            e.preventDefault();
            if (daemon.project?.id !== p.id) void actions.openRecent(p);
          }
          return;
        }
      }
      if (typing || mod || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        wb.setSearchOpen(true);
        return;
      }
      if (k === "g") {
        pendingG.current = Date.now();
        return;
      }
      if (Date.now() - pendingG.current < 1200) {
        const item = nav.find((n) => n.key === k);
        pendingG.current = 0;
        if (item) {
          e.preventDefault();
          wb.setLauncherOpen(false);
          void router.navigate({ to: item.to as LinkPath });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
}

function NavItem({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItemDef;
  active: boolean;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to as LinkPath}
      onClick={onNavigate}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav relative flex h-row-lg items-center gap-2.5 rounded-md text-ui transition-colors",
        collapsed ? "w-8 justify-center" : "px-2",
        active
          ? "bg-accent text-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-pill bg-primary",
            collapsed ? "-start-2" : "-start-2",
          )}
        />
      ) : null}
      <Icon className={cn("size-4 shrink-0", active && "text-brand")} strokeWidth={active ? 2.1 : 1.8} />
      {collapsed ? (
        <NavBadge path={item.to} collapsed />
      ) : (
        <>
          <span className="truncate">{item.label}</span>
          <kbd className="ms-auto font-sans text-[10.5px] font-normal tracking-wider text-transparent transition-colors group-hover/nav:text-faint">
            G {item.key.toUpperCase()}
          </kbd>
          <NavBadge path={item.to} collapsed={false} />
        </>
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {item.label} <span className="ms-1 text-faint">G {item.key.toUpperCase()}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function StatusLine({ collapsed }: { collapsed: boolean }) {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
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
        ? `Warming ${daemon.agentSwitch.name}…`
        : daemon.connection !== "open"
          ? daemon.source === null
            ? "Connecting…"
            : "Reconnecting…"
          : [agentName, model].filter(Boolean).join(" · ") || "Agent";
  const expression = useAgentExpression(daemon);
  const dot = (
    <Phantom
      expression={expression}
      tone={daemon.source === "sample" ? "muted" : undefined}
      size="xs"
      label={agentExpressionLabel[expression]}
    />
  );
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={!connected}
          onClick={() => {
            wb.setMobileNavOpen(false);
            if (!requestModelPicker()) wb.setLauncherOpen(false);
          }}
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md text-label text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground",
            collapsed ? "w-8 justify-center" : "px-2",
          )}
        >
          {dot}
          {collapsed ? null : <span className="truncate">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? "right" : "top"} className="max-w-80">
        {agentStatusLabel(daemon)}
        {connected ? <span className="ms-1.5 text-muted-foreground">· ⌘. to switch</span> : null}
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
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const pathname = usePathname();
  const nav = useNavItems();
  const current = useCurrentProjectLabel();
  // A previewed switch (target painted from cache) keeps the sidebar sections up.
  const settled = !daemon.projectSwitch || !!daemon.projectSwitch.preview;
  const page = !settled
    ? null
    : pathname === "/map"
      ? "map"
      : pathname === "/agent"
        ? "agent"
        : null;
  const chats = daemon.projectsSupported && !!daemon.project && settled;
  const projects = daemon.projectsSupported && daemon.recentProjects.length > 0;

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col bg-sidebar",
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
                <RuahMark size={24} className="group-hover/mark:opacity-0" />
                <PanelLeftOpen className="absolute size-4 text-muted-foreground opacity-0 group-hover/mark:opacity-100" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar · ⌘B</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <RuahLogo size="sm" blinkOnHover className="ps-0.5" />
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

      <div className="w-full shrink-0 px-2 pb-2">
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Switch project"
                onClick={() => wb.setPaletteOpen(true)}
                className="relative grid size-8 place-items-center rounded-md hover:bg-accent"
              >
                <ProjectTile project={{ id: current.id, name: current.name }} className="size-5 text-[10px]" />
                <span
                  className={cn(
                    "absolute right-1 bottom-1 size-2 rounded-full ring-2 ring-sidebar",
                    daemon.projectSwitch ? "bg-warn animate-pulse" : agentDotClass(daemon),
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {current.name} <span className="ms-1 text-muted-foreground">⌘K</span>
            </TooltipContent>
          </Tooltip>
        ) : (
          <ProjectMenu dotClass={agentDotClass(daemon)} />
        )}
      </div>

      <nav className="w-full shrink-0 space-y-px px-2 pb-3">
        {nav.map((item) => (
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
            className="group/nav flex h-row-lg w-full items-center gap-2.5 rounded-md px-2 text-ui text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Search className="size-4" strokeWidth={1.8} />
            Search
            <kbd className="kbd ms-auto">/</kbd>
          </button>
        )}
      </nav>

      {!collapsed && (chats || page || projects) ? (
        <div className="min-h-0 w-full flex-1 space-y-2 overflow-y-auto border-t border-hairline px-2 pt-2 pb-3">
          {projects ? <ProjectsSection onNavigate={onNavigate} /> : null}
          {chats ? <ChatsSection onNavigate={onNavigate} /> : null}
          {page === "map" ? (
            <MapSidebarSection onNavigate={onNavigate} />
          ) : page === "agent" ? (
            <AgentSidebarSection onNavigate={onNavigate} />
          ) : null}
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
        {mobile ? null : <TerminalToggleButton side={collapsed ? "right" : "top"} />}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Getting started"
              onClick={() => {
                wb.setMobileNavOpen(false);
                wb.setOnboardingOpen(true);
                wb.setLauncherOpen(true);
              }}
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
  const nav = useNavItems();
  return (
    <CommandDialog open={wb.searchOpen} onOpenChange={wb.setSearchOpen}>
      <CommandInput placeholder="Search elements, paths, workflows, pages…" className="text-body" />
      <CommandList className="max-h-[min(60vh,420px)]">
        <CommandEmpty className="flex flex-col items-center gap-2 py-6 text-center text-[13px] text-muted-foreground">
          <Phantom expression="thinking" size="sm" />
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
                <span className="ms-auto truncate font-mono text-[11.5px] text-faint">
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
          {nav.map((item) => (
            <CommandItem
              key={item.to}
              value={`page ${item.label}`}
              onSelect={() => {
                void router.navigate({ to: item.to as LinkPath });
                wb.setSearchOpen(false);
              }}
              className="gap-2.5 rounded-md text-[13px]"
            >
              <item.icon className="size-4 text-muted-foreground" />
              {item.label}
              <kbd className="kbd ms-auto">G {item.key.toUpperCase()}</kbd>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Placeholder for the page while the daemon switches project: the shell stays put. */
function SwitchingContent({ name }: { name: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <div className="flex h-bar shrink-0 items-center gap-3 border-b border-hairline px-5">
        <Skeleton className="h-3.5 w-40 bg-foreground/[0.06]" />
        <span className="flex-1" />
        <Skeleton className="h-6 w-24 rounded-lg bg-foreground/[0.05]" />
      </div>
      <div className="relative min-h-0 flex-1 p-6">
        <div className="grid grid-cols-3 gap-4 opacity-70 max-md:grid-cols-1">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl bg-foreground/[0.04]" />
          ))}
        </div>
        <div className="absolute inset-0 grid place-items-center">
          <p className="flex items-center gap-2 rounded-full border border-hairline bg-popover px-3.5 py-1.5 text-ui-sm text-muted-foreground shadow-elevated">
            <Phantom expression="loading" size="xs" />
            Opening {name}…
          </p>
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const wb = useWorkbench();
  const { daemon } = useWorkspace();
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const nav = useNavItems();
  const terminal = useTerminal();
  // The SPA ships one prerendered index.html for every path (the daemon's fallback), so the
  // prerender must not contain page content: render the shell only after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useShellKeys();
  useRecordChatVisits(daemon);
  useSwitchPaintProbe(daemon);

  // An open project replaces the (first-run / on-demand) start screen.
  const switching = daemon.projectSwitch;
  useEffect(() => {
    if (switching) wb.setLauncherOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching]);

  if (!mounted) return <div className="h-dvh bg-background" />;

  const dialogs = (
    <>
      <SearchDialog />
      <ProjectPalette />
      <RecentChatsSwitcher />
      <OpenFolderDialog />
      <NewProjectDialog />
    </>
  );

  const launcherState = daemon.projectsSupported && daemon.project === null && !switching;
  if (launcherState || (wb.launcherOpen && !switching)) {
    return (
      <>
        {dialogs}
        <Launcher overlay={!launcherState} />
      </>
    );
  }

  // A cached target renders the real page at once; only a first visit shows the skeleton.
  const content = switching && !switching.preview ? <SwitchingContent name={switching.name} /> : children;

  if (isMobile) {
    const project = { id: daemon.project?.id ?? daemon.root ?? "sample", name: daemon.project?.name ?? daemon.architecture?.name ?? "Ruah" };
    const current = nav.find((n) => isActive(pathname, n.to));
    return (
      <div className="grain flex h-dvh flex-col overflow-hidden bg-background text-foreground">
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
          <span className="heading text-[15px]">{current?.label ?? "Ruah"}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Switch project"
            onClick={() => wb.setPaletteOpen(true)}
            className="grid size-9 place-items-center rounded-md hover:bg-accent"
          >
            <ProjectTile project={project} className="size-6 text-[11px]" />
          </button>
          <button
            type="button"
            aria-label="Search"
            onClick={() => wb.setSearchOpen(true)}
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" />
          </button>
        </header>
        <main className="flex min-h-0 flex-1 flex-col">{content}</main>
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
    <div className="grain flex h-dvh overflow-hidden bg-background text-foreground">
      {dialogs}
      <AppSidebar collapsed={wb.sidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className={cn("flex min-h-0 flex-1 flex-col", terminal.open && terminal.maximized && !!daemon.project && daemon.source === "daemon" && "hidden")}>{content}</div>
        <TerminalPanel />
      </main>
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
        "flex h-bar shrink-0 items-center gap-3 border-b border-hairline px-5 max-md:h-11 max-md:px-3",
        className,
      )}
    >
      <h1 className="heading min-w-0 truncate text-title text-foreground max-md:hidden">
        {title}
      </h1>
      <span className="flex-1" />
      {children}
    </div>
  );
}
