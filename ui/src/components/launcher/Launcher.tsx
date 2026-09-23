// Start screen: shown when the daemon has no project open (§5 launcher state), on first run,
// and on demand (⌘K → Start screen, Help). Open a folder, create a project, or pick a recent
// one — keyboard-first: ↑↓ + Enter, ⌘O, ⌘N.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleHelp,
  FolderOpen,
  FolderPlus,
  MessagesSquare,
  Pin,
  PinOff,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { ProjectInfo } from "@/lib/contracts";
import { absoluteTime, prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { VirtualList } from "@/components/common/VirtualList";
import { RuahLogo } from "@/components/brand/RuahLogo";
import { PhantomCompanion } from "@/components/brand/Phantom";
import { OnboardingCard } from "@/components/workspace/Onboarding";
import { KindBadge, ProjectTile } from "@/components/projects/ProjectBits";
import { pinnedShortcut } from "@/components/projects/ProjectPalette";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ROW_H = 56;

function ActionRow({
  icon: Icon,
  label,
  hint,
  shortcut,
  onClick,
  disabled,
}: {
  icon: typeof FolderOpen;
  label: string;
  hint?: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group/action flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-hairline bg-surface-1 text-muted-foreground transition-colors group-hover/action:border-primary/40 group-hover/action:text-brand">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-foreground">{label}</span>
        {hint ? <span className="block truncate text-meta text-muted-foreground">{hint}</span> : null}
      </span>
      {shortcut ? <kbd className="kbd shrink-0">{shortcut}</kbd> : null}
    </button>
  );
}

function RecentRow({
  project,
  active,
  current,
  shortcut,
  onOpen,
  onPin,
  onForget,
  onHover,
}: {
  project: ProjectInfo;
  active: boolean;
  current: boolean;
  shortcut: string | null;
  onOpen: () => void;
  onPin: () => void;
  onForget: () => void;
  onHover: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      className={cn(
        "group/recent relative flex h-[calc(100%-4px)] items-center gap-3 rounded-xl px-3 transition-colors",
        active ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-hairline)]" : "hover:bg-surface-2/70",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${project.name}`}
        className="absolute inset-0 rounded-xl"
        tabIndex={-1}
      />
      <ProjectTile project={project} className="pointer-events-none size-8 rounded-lg text-[13px]" />
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-ui font-medium text-foreground">{project.name}</span>
          <KindBadge kind={project.kind} />
          {current ? (
            <span className="shrink-0 rounded-pill bg-primary/12 px-1.5 text-[10.5px] font-medium text-brand">
              open
            </span>
          ) : null}
        </span>
        <span className="block truncate font-mono text-meta text-muted-foreground" title={project.root}>
          {prettyPath(project.root)}
        </span>
      </span>
      <span
        className="pointer-events-none shrink-0 text-meta text-muted-foreground group-hover/recent:hidden"
        title={absoluteTime(project.lastOpenedAt)}
      >
        {relativeTime(project.lastOpenedAt)}
      </span>
      {project.pinned ? (
        <Pin className="pointer-events-none size-3 shrink-0 text-muted-foreground group-hover/recent:hidden" />
      ) : null}
      {shortcut ? (
        <kbd className="kbd pointer-events-none shrink-0 group-hover/recent:hidden">{shortcut}</kbd>
      ) : null}
      <span className="relative hidden shrink-0 items-center gap-0.5 group-hover/recent:flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
              onClick={onPin}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {project.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{project.pinned ? "Unpin" : "Pin to top (⌘1…⌘9)"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Remove ${project.name} from recent`}
              onClick={onForget}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from recent (keeps the folder)</TooltipContent>
        </Tooltip>
      </span>
    </div>
  );
}

export function Launcher({ overlay = false }: { overlay?: boolean }) {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const router = useRouter();
  const actions = useProjectActions();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const sample = daemon.source === "sample";

  const recents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return daemon.recentProjects.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q),
    );
  }, [daemon.recentProjects, query]);
  const pinned = daemon.recentProjects.filter((p) => p.pinned);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, recents.length - 1)));
  }, [recents.length]);

  // ↑↓ Enter on the whole screen (not while a dialog or menu is open).
  const dialogsOpen = wb.openFolderOpen || wb.newProjectOpen || wb.paletteOpen || wb.searchOpen;
  useEffect(() => {
    if (dialogsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const inOtherField =
        !!target &&
        (/textarea|select/i.test(target.tagName) ||
          (target.tagName === "INPUT" && target.id !== "launcher-filter"));
      if (inOtherField) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, recents.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter" && recents[active] && (!target || target.tagName !== "BUTTON")) {
        e.preventDefault();
        void actions.openRecent(recents[active]!);
      } else if (e.key === "Escape" && overlay) {
        e.preventDefault();
        wb.setLauncherOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogsOpen, recents, active, actions, overlay, wb]);

  const backLabel = sample ? "the sample" : (daemon.project?.name ?? daemon.architecture?.name);
  const dismissOnboarding = () => wb.finishOnboarding();

  return (
    <div className="grain flex h-dvh flex-col overflow-y-auto bg-background text-foreground">
      <header className="flex h-bar shrink-0 items-center gap-2 px-5 max-md:px-4">
        <RuahLogo size="sm" className="me-2" />
        {overlay && backLabel ? (
          <button
            type="button"
            onClick={() => wb.setLauncherOpen(false)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to {backLabel}
            <kbd className="kbd ms-1">esc</kbd>
          </button>
        ) : null}
        <span className="flex-1" />
        {daemon.daemonVersion ? (
          <span className="font-mono text-meta text-faint">daemon {daemon.daemonVersion}</span>
        ) : null}
      </header>

      <main className="mx-auto flex w-full max-w-[60rem] flex-1 flex-col px-8 pt-[max(2rem,8vh)] pb-10 max-md:px-4 max-md:pt-4">
        <div className="flex items-center justify-between gap-8">
        <div className="max-w-2xl">
          <p className="eyebrow">Architecture workspace</p>
          <h1 className="heading mt-3 text-[28px] text-foreground max-md:text-[24px]">
            Map a codebase, <span className="text-muted-foreground">then ask about any part of it.</span>
          </h1>
          <p className="mt-3 text-body text-muted-foreground">
            Services down to files, workflows, cloud and issues — with a coding agent on every element.
          </p>
        </div>
          <PhantomCompanion size="lg" className="me-6 shrink-0 max-md:hidden" />
        </div>

        <div className="mt-12 grid grid-cols-[17rem_minmax(0,1fr)] gap-10 max-md:mt-6 max-md:grid-cols-1 max-md:gap-6">
          <section aria-label="Start" className="space-y-1">
            <h2 className="section-label px-3 pb-1.5">Start</h2>
            <ActionRow
              icon={FolderOpen}
              label="Open folder…"
              hint="A repo, or a folder of repos"
              shortcut="⌘O"
              onClick={() => void actions.pickFolder()}
              disabled={sample}
            />
            <ActionRow
              icon={FolderPlus}
              label="New project…"
              hint="Empty map, optional git init"
              shortcut="⌘N"
              onClick={actions.newProject}
              disabled={sample}
            />
            <ActionRow
              icon={MessagesSquare}
              label="All chats"
              hint="Recent conversations, every project"
              onClick={() => {
                wb.setLauncherOpen(false);
                void router.navigate({ to: "/chats" });
              }}
              disabled={sample || !daemon.projectsSupported}
            />
            {!wb.onboardingOpen ? (
              <ActionRow
                icon={CircleHelp}
                label="Getting started"
                hint="Three steps, one minute"
                onClick={() => wb.setOnboardingOpen(true)}
              />
            ) : null}
            {sample ? (
              <div className="mt-4 space-y-2 rounded-xl border border-warn/25 bg-warn/[0.07] p-3">
                <p className="text-ui-sm text-foreground">No Ruah daemon connected</p>
                <p className="text-meta leading-relaxed text-muted-foreground">
                  Opening and creating projects needs the Ruah app (or{" "}
                  <code className="font-mono">ruah app serve</code>). Meanwhile you can explore a
                  sample map.
                </p>
                <button
                  type="button"
                  onClick={() => wb.setLauncherOpen(false)}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-surface-3 px-2.5 text-ui-sm text-foreground transition-colors hover:bg-surface-3/70"
                >
                  <Sparkles className="size-3.5" /> Explore the sample
                </button>
              </div>
            ) : null}
          </section>

          <div className="min-w-0 space-y-6">
            {wb.onboardingOpen ? (
              <OnboardingCard
                onDismiss={dismissOnboarding}
                onOpenFolder={sample ? undefined : () => void actions.pickFolder()}
                onNewProject={sample ? undefined : actions.newProject}
              />
            ) : null}

            <section aria-label="Recent projects" className="min-w-0">
              <div className="flex h-8 items-center gap-2 px-3 pb-1.5">
                <h2 className="section-label">Recent projects</h2>
                {daemon.recentProjects.length > 5 ? (
                  <label className="ms-auto flex h-7 w-52 items-center gap-1.5 rounded-lg bg-surface-2 px-2 shadow-[inset_0_0_0_1px_var(--color-hairline)] max-md:w-40">
                    <Search className="size-3 text-muted-foreground" />
                    <input
                      id="launcher-filter"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                      }}
                      placeholder="Filter…"
                      aria-label="Filter recent projects"
                      className="h-full min-w-0 flex-1 bg-transparent text-ui-sm outline-none placeholder:text-faint"
                    />
                  </label>
                ) : null}
              </div>
              {daemon.recentProjects.length === 0 ? (
                <p className="px-3 py-3 text-ui-sm leading-relaxed text-muted-foreground">
                  {sample
                    ? "Recent projects appear here once Ruah is connected."
                    : "Projects you open appear here — pin the ones you switch to often (⌘1…⌘9)."}
                </p>
              ) : recents.length === 0 ? (
                <p className="px-3 py-3 text-ui-sm text-muted-foreground">No project matches.</p>
              ) : (
                <VirtualList
                  items={recents}
                  itemHeight={ROW_H}
                  getKey={(p) => p.id}
                  activeIndex={active}
                  role="listbox"
                  aria-label="Recent projects"
                  className="max-h-[min(52vh,560px)]"
                  renderItem={(p, i) => {
                    const pinIndex = pinned.findIndex((x) => x.id === p.id);
                    return (
                      <RecentRow
                        project={p}
                        active={i === active}
                        current={daemon.project?.id === p.id}
                        shortcut={pinIndex >= 0 ? pinnedShortcut(pinIndex) : null}
                        onHover={() => setActive(i)}
                        onOpen={() =>
                          daemon.project?.id === p.id
                            ? wb.setLauncherOpen(false)
                            : void actions.openRecent(p)
                        }
                        onPin={() => void actions.togglePin(p)}
                        onForget={() => void actions.forget(p)}
                      />
                    );
                  }}
                />
              )}
            </section>
          </div>
        </div>

        <footer className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-10 text-meta text-faint max-md:hidden">
          <span className="flex items-center gap-1">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> choose
          </span>
          <span className="flex items-center gap-1">
            <kbd className="kbd">↵</kbd> open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="kbd">⌘K</kbd> switch project anywhere
          </span>
          <span className="flex items-center gap-1">
            <kbd className="kbd">⌘.</kbd> agent · model
          </span>
        </footer>
      </main>
    </div>
  );
}
