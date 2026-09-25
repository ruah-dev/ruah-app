// The shell (Option A of the 2026-09-25 relayout): a 56px icon rail, one 44px top bar (project,
// branch, the ⌘K field, activity, terminal, agent), the page with one row of controls, the right
// agent panel and the bottom terminal. Everything else lives in the ⌘K launcher, the ⋯ menus and
// the pages' own drawers. Shortcuts are listed in ./nav.ts.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { requestModelPicker } from "@/lib/bus";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { useIsMobile } from "@/hooks/use-mobile";
import { Launcher, AllProjectsHost } from "@/components/launcher/Launcher";
import { NewProjectDialog, OpenFolderDialog } from "@/components/projects/ProjectDialogs";
import { SystemDialogs } from "@/components/system/SystemDialogs";
import { ProjectMenu } from "@/components/projects/ProjectMenu";
import { CommandLauncher } from "@/components/projects/CommandLauncher";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Phantom } from "@/components/brand/Phantom";
import { RuahLogo } from "@/components/brand/RuahLogo";
import { RecentChatsSwitcher } from "@/components/chats/RecentChatsSwitcher";
import { useRecordChatVisits } from "@/lib/mru";
import { neighborChat } from "@/lib/switching";
import { reportSwitchPainted, switchPending } from "@/lib/switch-timing";
import { sameRoot, type DaemonState } from "@/lib/daemon";
import { shouldShowResumeCard } from "@/lib/resume-card";
import { useViewerPrefs } from "@/lib/preferences";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { useTerminal } from "@/lib/terminal";
import { isActivePath, pageLabel, useNav } from "./nav";
import { Rail } from "./Rail";
import { TopBar, ActivityBell, AgentPill } from "./TopBar";
import { RightPanel } from "./RightPanel";
import { ResumeCard } from "./ResumeCard";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useShellDialogs } from "./shellState";
import { useSlots } from "./slots";
import { useProjectView } from "./useProjectView";
import { useShellResume } from "./useShellResume";

export { PageHeader, PageMenu } from "./PageHeader";

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

function usePathname() {
  return useRouterState({ select: (s) => s.location.pathname });
}

/**
 * Global shortcuts (the full list is SHORTCUTS in ./nav.ts): ⌘K / ⌘P / "/" launcher, G then a
 * letter for a page, ⌘B page drawer, ⌘I agent panel, ⌘J recent chats (RecentChatsSwitcher),
 * ⌘[ / ⌘] previous / next chat, ⌘O open folder, ⌘N new chat (⇧⌘N new project), ⌘1…⌘9 pinned
 * projects, ⌘. agent · model picker.
 */
function useShellKeys() {
  const router = useRouter();
  const wb = useWorkbench();
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const pendingG = useRef<number>(0);
  const nav = useNav();
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
      const path = router.state.location.pathname;
      if (mod && !e.altKey && e.shiftKey && k === "n") {
        e.preventDefault();
        actions.newProject();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey) {
        if (k === "k" || k === "p") {
          e.preventDefault();
          wb.setPaletteOpen(!wb.paletteOpen);
          return;
        }
        if (k === "b") {
          e.preventDefault();
          wb.setOutlineOpen((v) => !v);
          return;
        }
        if (k === "i") {
          if (path === "/agent" || wb.launcherOpen) return;
          e.preventDefault();
          wb.setShowPanel((v) => !v);
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
          if (path !== "/agent" && !(wb.showPanel && wb.panelView === "agent")) return;
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
        wb.setPaletteOpen(true);
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
          void router.navigate({ to: item.to as "/" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
}

/** Desktop app: ⌥Space anywhere focuses Ruah and opens the launcher (Settings, off by default). */
function useGlobalLauncherShortcut() {
  const wb = useWorkbench();
  const { globalShortcut } = useViewerPrefs();
  const open = useRef(wb.setPaletteOpen);
  open.current = wb.setPaletteOpen;
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.ruah : undefined;
    if (!bridge?.setLauncherShortcut) return;
    void bridge.setLauncherShortcut(globalShortcut).catch(() => false);
  }, [globalShortcut]);
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.ruah : undefined;
    return bridge?.onLauncherShortcut?.(() => open.current(true));
  }, []);
}

/** Placeholder for the page while the daemon switches project: the shell stays put. */
function SwitchingContent({ name }: { name: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline px-4">
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

const RESUME_DISMISSED_KEY = "ruah.resume.dismissed.v1";

function readDismissed(): Record<string, string> {
  try {
    return JSON.parse(window.sessionStorage.getItem(RESUME_DISMISSED_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Dismissed per visit: the lastViewedAt the user dismissed (a later visit has a newer one). */
function useResumeDismissal(projectId: string | null) {
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  useEffect(() => setDismissed(readDismissed()), []);
  const dismiss = useCallback(
    (lastViewedAt: string | null) => {
      if (!projectId || !lastViewedAt) return;
      setDismissed((prev) => {
        const next = { ...prev, [projectId]: lastViewedAt };
        try {
          window.sessionStorage.setItem(RESUME_DISMISSED_KEY, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
    },
    [projectId],
  );
  return { dismissedFor: projectId ? (dismissed[projectId] ?? null) : null, dismiss };
}

function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const nav = useNav();
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-12 items-center px-4">
        <RuahLogo size="sm" />
      </div>
      <div className="px-3 pb-2">
        <ProjectMenu />
      </div>
      <nav className="flex-1 space-y-px overflow-y-auto px-2" aria-label="Pages">
        {nav.map((n) => {
          const active = isActivePath(pathname, n.to);
          return (
            <Link
              key={n.to}
              to={n.to as "/"}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-row-lg items-center gap-2.5 rounded-md px-2 text-ui transition-colors",
                active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <n.icon className={cn("size-4", active && "text-brand")} />
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const wb = useWorkbench();
  const { daemon } = useWorkspace();
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const terminal = useTerminal();
  const prefs = useViewerPrefs();
  const slots = useSlots();
  const shellUi = useShellDialogs();
  // The SPA ships one prerendered index.html for every path (the daemon's fallback), so the
  // prerender must not contain page content: render the shell only after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useShellKeys();
  useGlobalLauncherShortcut();
  useRecordChatVisits(daemon);
  useSwitchPaintProbe(daemon);
  const { saved, projectId } = useProjectView();
  const resume = useShellResume(projectId);
  const { dismissedFor, dismiss } = useResumeDismissal(projectId);

  // An open project replaces the (first-run / on-demand) start screen.
  const switching = daemon.projectSwitch;
  useEffect(() => {
    if (switching) wb.setLauncherOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching]);

  if (!mounted) return <div className="h-dvh bg-background" />;

  const dialogs = (
    <>
      <CommandLauncher />
      <RecentChatsSwitcher />
      <OpenFolderDialog />
      <NewProjectDialog />
      <SystemDialogs />
      <AllProjectsHost />
      <ShortcutsDialog />
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
  const hideContent = terminal.open && terminal.maximized && !!daemon.project && daemon.source === "daemon";
  const showResume =
    !isMobile &&
    shouldShowResumeCard({
      resume: resume.entry,
      projectId,
      dismissedFor,
      switching: !!switching,
      enabled: prefs.resumeCard,
    });

  if (isMobile) {
    return (
      <div className="grain flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        {dialogs}
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-hairline px-2">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => wb.setMobileNavOpen(true)}
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Menu className="size-4.5" />
          </button>
          <span className="heading min-w-0 truncate text-[15px]">{pageLabel(pathname)}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Search, jump, run"
            onClick={() => wb.setPaletteOpen(true)}
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" />
          </button>
          <ActivityBell />
          <AgentPill />
        </header>
        <main className="flex min-h-0 flex-1 flex-col">{content}</main>
        <Sheet open={wb.mobileNavOpen} onOpenChange={wb.setMobileNavOpen}>
          <SheetContent side="left" className="w-[86vw] max-w-xs border-hairline p-0 [&>button]:hidden">
            <SheetHeader className="sr-only">
              <SheetTitle>Menu</SheetTitle>
            </SheetHeader>
            <MobileNav onNavigate={() => wb.setMobileNavOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  const panel = wb.showPanel && pathname !== "/agent";
  const Preview = shellUi.preview ? slots.preview : null;

  return (
    <div className="grain flex h-dvh overflow-hidden bg-background text-foreground">
      {dialogs}
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar resume={resume.latest} />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div className={cn("relative flex min-h-0 flex-1 flex-col", hideContent && "hidden")}>
              {content}
              {showResume && resume.entry ? (
                <div className="pointer-events-none absolute bottom-5 left-5 z-30 flex max-w-full">
                  <ResumeCard resume={resume.entry} view={saved} onDismiss={() => dismiss(resume.entry?.lastViewedAt ?? null)} />
                </div>
              ) : null}
            </div>
            <TerminalPanel />
          </main>
          {panel || Preview ? <RightPanel agent={panel} Preview={Preview} /> : null}
        </div>
      </div>
    </div>
  );
}
