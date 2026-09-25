// The one-row top bar (44px): project switcher, git branch, the search / command field (opens the
// ⌘K launcher), the cross-project activity bell, the terminal toggle and the agent pill (toggles
// the right agent panel).
import { useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Bell, CheckCheck, GitBranch, MonitorPlay, Search } from "lucide-react";
import type { ActivityEvent, ResumeInfo } from "@/lib/contracts";
import { useActivity } from "@/lib/activity";
import { attentionCount, eventTone, feedEvents, pendingPermissions, type FeedTone } from "@/lib/activity-feed";
import { answerPermission, markActivityRead, openActivityTarget } from "@/lib/daemon";
import { requestModelPicker } from "@/lib/bus";
import { relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { agentStatusLabel } from "@/components/agent/AgentPanel";
import { Phantom } from "@/components/brand/Phantom";
import { useAgentExpression } from "@/components/brand/agentExpression";
import { ProjectMenu } from "@/components/projects/ProjectMenu";
import { ProjectTile } from "@/components/projects/ProjectBits";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { TerminalToggleButton } from "@/components/terminal/TerminalPanel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { setShellDialog, useShellDialogs } from "./shellState";
import { useSlots } from "./slots";

const dotTone: Record<FeedTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  ai: "bg-ai",
  muted: "bg-faint",
};

export function BranchChip({ resume }: { resume: ResumeInfo | null }) {
  const git = resume?.git;
  if (!git || !git.available) return null;
  const branch = git.branch ?? (git.head ? git.head.slice(0, 7) : "detached");
  const lines = [
    git.branch ? `On ${git.branch}${git.upstream ? ` · tracking ${git.upstream}` : ""}` : `Detached at ${git.head?.slice(0, 7) ?? "?"}`,
    git.ahead ? `${git.ahead} commit${git.ahead === 1 ? "" : "s"} to push` : "",
    git.behind ? `${git.behind} commit${git.behind === 1 ? "" : "s"} to pull` : "",
    git.dirty ? `${git.dirty} uncommitted file${git.dirty === 1 ? "" : "s"}${git.dirtyPaths.length ? `: ${git.dirtyPaths.join(", ")}${git.dirty > git.dirtyPaths.length ? ", …" : ""}` : ""}` : "Working tree clean",
    git.lastCommit ? `Last commit: ${git.lastCommit.subject} (${relativeTime(git.lastCommit.at)})` : "",
  ].filter(Boolean);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={lines.join(". ")}
          className="flex h-6 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full bg-surface-2 px-2 font-mono text-[11.5px] text-muted-foreground max-lg:hidden"
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{branch}</span>
          {git.ahead ? <span className="shrink-0">↑{git.ahead}</span> : null}
          {git.behind ? <span className="shrink-0">↓{git.behind}</span> : null}
          {git.dirty ? <span className="shrink-0 text-warn">●{git.dirty}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-96">
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

export function CommandField() {
  const wb = useWorkbench();
  return (
    <div className="flex min-w-0 flex-1 justify-center px-2">
      <button
        type="button"
        onClick={() => wb.setPaletteOpen(true)}
        aria-label="Search, jump, run (⌘K)"
        className="flex h-[30px] w-full max-w-[420px] min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 text-ui text-faint transition-colors hover:border-primary/40 hover:text-muted-foreground"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search, jump, run…</span>
        <kbd className="shrink-0 font-mono text-[11px]">⌘K</kbd>
      </button>
    </div>
  );
}

function FeedRow({ e, pending, onOpen }: { e: ActivityEvent; pending: boolean; onOpen: () => void }) {
  const { daemon } = useWorkspace();
  // An open question of the open project carries its options (answer right here).
  const request =
    pending && daemon.project?.id === e.projectId
      ? daemon.turns.find((t) => t.permission?.requestId === e.requestId)?.permission ?? null
      : null;
  const allow = request?.options.find((o) => o.kind === "allow_once") ?? request?.options.find((o) => o.kind.startsWith("allow"));
  return (
    <div className={cn("group/feed flex gap-2.5 rounded-lg px-2 py-2", pending ? "bg-warn/[0.07]" : "hover:bg-accent/60")}>
      <span className={cn("mt-[5px] size-[7px] shrink-0 rounded-full", dotTone[eventTone(e)])} />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="block w-full text-left">
          <span className="block text-[12.5px] leading-snug text-foreground">
            <span className="font-semibold">{e.projectName}</span> · {e.summary}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {relativeTime(e.at)}
            {pending && !request ? " · open to answer" : ""}
          </span>
        </button>
        {pending && e.requestId ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {allow ? (
              <button
                type="button"
                onClick={() => answerPermission(request!.requestId, allow.optionId)}
                className="h-6 rounded-md bg-primary px-2 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                {allow.name}
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpen}
                className="h-6 rounded-md bg-primary px-2 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                Open to answer
              </button>
            )}
            <button
              type="button"
              onClick={() => answerPermission(e.requestId!, "cancel")}
              className="h-6 rounded-md border border-hairline bg-surface-2 px-2 text-[11.5px] text-foreground hover:bg-surface-3"
            >
              Deny
            </button>
          </div>
        ) : null}
      </div>
      <ProjectTile project={{ id: e.projectId, name: e.projectName }} className="mt-0.5 size-4 rounded-[4px] text-[8px]" />
    </div>
  );
}

export function ActivityBell() {
  const activity = useActivity();
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const [open, setOpen] = useState(false);
  if (!activity.supported) return null;
  const count = attentionCount(activity.projects);
  const events = feedEvents(activity.recent, 30);
  const pending = new Set(pendingPermissions(activity.recent).map((e) => e.id));

  const openEvent = (e: ActivityEvent) => {
    setOpen(false);
    const root = e.projectRoot ?? daemon.recentProjects.find((p) => p.id === e.projectId)?.root;
    if (e.chatId && root) void actions.showChat({ id: e.chatId, projectId: e.projectId, projectName: e.projectName, projectRoot: root });
    else void openActivityTarget({ projectId: e.projectId, ...(root ? { projectRoot: root } : {}) });
    markActivityRead(e.projectId, e.chatId ?? undefined);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={count ? `Activity: ${count} need${count === 1 ? "s" : ""} you` : "Activity"}
              className="relative grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
            >
              <Bell className="size-[17px]" strokeWidth={1.8} />
              {count ? (
                <span className="absolute top-[3px] right-[3px] grid h-[15px] min-w-[15px] place-items-center rounded-full bg-warn px-1 text-[9.5px] font-bold text-background tabular-nums">
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Activity across your projects</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={6}
        // Esc closes the popover only (the map would take it as "up one level").
        onEscapeKeyDown={(e) => e.stopPropagation()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[340px] rounded-xl border-hairline p-2"
      >
        <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
          <span className="section-label uppercase tracking-[0.08em]">Across your projects</span>
          <span className="flex-1" />
          {count ? (
            <button
              type="button"
              onClick={() => {
                for (const p of Object.values(activity.projects)) if (p.unread > 0) markActivityRead(p.projectId);
              }}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <CheckCheck className="size-3.5" /> Mark read
            </button>
          ) : null}
        </div>
        <div className="max-h-[min(60vh,440px)] space-y-0.5 overflow-y-auto">
          {events.length === 0 ? (
            <p className="flex flex-col items-center gap-2 px-3 py-6 text-center text-ui-sm text-muted-foreground">
              <Phantom expression="idle" size="sm" />
              Nothing yet. When an agent finishes or asks for permission in any project, it shows up here.
            </p>
          ) : (
            events.map((e) => <FeedRow key={e.id} e={e} pending={pending.has(e.id)} onOpen={() => openEvent(e)} />)
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function agentWord(expression: string, daemon: ReturnType<typeof useWorkspace>["daemon"]): string {
  if (daemon.source === "sample") return "sample";
  if (daemon.connection !== "open") return daemon.source === null ? "connecting" : "offline";
  if (daemon.agentSwitch) return "starting";
  switch (expression) {
    case "thinking":
      return "working";
    case "warning":
      return "needs you";
    case "loading":
      return "starting";
    case "error":
      return "error";
    default:
      return "ready";
  }
}

export function AgentPill({ mobile = false }: { mobile?: boolean }) {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const expression = useAgentExpression(daemon);
  const agents = daemon.agent?.agents;
  const name =
    daemon.agentSwitch?.name ??
    agents?.available.find((a) => a.id === agents.currentAgentId)?.name ??
    daemon.agent?.agent?.name ??
    "Agent";
  const word = agentWord(expression, daemon);
  // Room for a per-agent "remaining" hint (Usage limits, ./slots.ts).
  const { limitHints } = useSlots();
  const hint = agents ? limitHints[agents.currentAgentId] : undefined;
  const onAgentPage = pathname === "/agent";
  const pressed = !onAgentPage && wb.showPanel;
  const working = word === "working" || word === "starting";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={onAgentPage ? undefined : pressed}
          onClick={() => {
            if (onAgentPage) requestModelPicker();
            else if (!mobile) wb.setShowPanel((v) => !v);
            // Phones: the Map's agent sheet, or the Agent page.
            else if (pathname === "/map") {
              wb.setPanelView("agent");
              wb.setSheetOpen(true);
            } else void router.navigate({ to: "/agent" });
          }}
          className={cn(
            "flex h-7 max-w-52 min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] text-foreground transition-colors",
            word === "needs you" ? "border-warn/40" : "border-ai/35",
            pressed ? "bg-ai/14" : "bg-surface-2 hover:bg-ai/10",
          )}
        >
          <Phantom expression={expression} size={14} tone={daemon.source === "sample" ? "muted" : undefined} still={!working} />
          <span className="min-w-0 truncate">
            {name} · {word}
          </span>
          {hint ? <span className="shrink-0 text-[11px] text-muted-foreground">· {hint}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80">
        {agentStatusLabel(daemon)}
        <span className="mt-0.5 block text-muted-foreground">
          {onAgentPage ? "Click or ⌘. to switch agent or model" : `${pressed ? "Hide" : "Show"} the agent panel · ⌘I · ⌘. switches agent / model`}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Live preview of the project's dev server (a pane registered through ./slots.ts). */
export function PreviewToggle() {
  const { preview: Pane } = useSlots();
  const open = useShellDialogs().preview;
  // No dead buttons: the toggle appears once a preview pane is registered.
  if (!Pane) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Preview"
          aria-pressed={open}
          onClick={() => setShellDialog("preview", !open)}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
            open ? "text-primary" : "text-muted-foreground",
          )}
        >
          <MonitorPlay className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Live preview</TooltipContent>
    </Tooltip>
  );
}

export function TopBar({ resume }: { resume: ResumeInfo | null }) {
  const { daemon } = useWorkspace();
  const live = daemon.source === "daemon" && !!daemon.project;
  return (
    <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-hairline px-3">
      <ProjectMenu />
      {live ? <BranchChip resume={resume} /> : null}
      <CommandField />
      <ActivityBell />
      {daemon.source === "daemon" ? <TerminalToggleButton side="bottom" /> : null}
      <PreviewToggle />
      <AgentPill />
    </header>
  );
}
