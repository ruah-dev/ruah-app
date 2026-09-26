// Home (§20.5, option C of the layout mockups): every recent and pinned project as a card, sorted
// by what needs you — a permission waiting, a failed turn, cloud down, a crashed preview, work
// finished while you were away, cloud degraded, an agent working, uncommitted work, quiet. Each card
// has the one-line "where you left off" and quick actions (open, continue the chat, answer the
// permission right here, open the preview). Filters: All · Pinned · the groups (tags) in use.
// Data: one batched GET /api/projects/overview (cached by the daemon), refreshed when activity
// arrives on the socket and every 30 s while visible; live counts come from the activity feed.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Hash,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { ProjectActivity, ProjectInfo, ProjectOverview, ProjectsOverview } from "@/lib/contracts";
import { useActivity } from "@/lib/activity";
import { answerPermissionAnywhere, fetchOverview, prefetchProject } from "@/lib/daemon";
import {
  greeting,
  groupOf,
  groupSpellings,
  homeCard,
  homeFilters,
  homeSummary,
  matchesFilter,
  sortCards,
  type CardTone,
  type HomeCard,
} from "@/lib/home";
import { openSystemDialog } from "@/lib/system";
import { prettyPath } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { Phantom } from "@/components/brand/Phantom";
import { PhantomPose } from "@/components/brand/PhantomPose";
import { KindBadge, ProjectTile } from "@/components/projects/ProjectBits";
import { setTagsDialog } from "@/components/projects/TagsDialog";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { setShellDialog } from "@/components/shell/shellState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSegmentedKeys } from "@/components/ui/segmented";

const FILTER_KEY = "ruah.home.filter.v1";
const POLL_MS = 30_000;

const PILL_TONE: Record<CardTone, string> = {
  warn: "bg-warn/12 text-warn",
  bad: "bg-bad/12 text-bad",
  ok: "bg-ok/12 text-ok",
  ai: "bg-ai/12 text-ai",
  muted: "bg-surface-3 text-muted-foreground",
};
const BORDER_TONE: Record<CardTone, string> = {
  warn: "border-warn/45",
  bad: "border-bad/45",
  ok: "border-ok/35",
  ai: "border-hairline",
  muted: "border-hairline",
};

function readFilter(): string {
  try {
    return window.localStorage.getItem(FILTER_KEY) ?? "all";
  } catch {
    return "all";
  }
}

/** The batched overview, refreshed on activity (debounced) and every 30 s while the page is visible. */
function useOverview(enabled: boolean) {
  const [data, setData] = useState<ProjectsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activity = useActivity();
  const { daemon } = useWorkspace();
  const lastEvent = activity.recent.at(-1)?.id ?? "";
  const listKey = daemon.recentProjects.map((p) => p.id).join(",");
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    setLoading(true);
    fetchOverview(24)
      .then((res) => {
        if (mine !== seq.current) return;
        setData(res);
        setError(null);
      })
      .catch((err: unknown) => mine === seq.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => mine === seq.current && setLoading(false));
  }, [enabled]);

  // Something happened in some project (or the list changed): refresh shortly after.
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(load, data ? 450 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, lastEvent, listKey, daemon.project?.id, load]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, load]);

  return { data, error, loading, reload: load };
}

function QuickButton({ children, onClick, primary, title }: { children: ReactNode; onClick: () => void; primary?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "pointer-events-auto relative z-10 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-surface-2 text-foreground hover:bg-surface-3",
      )}
    >
      {children}
    </button>
  );
}

function ProjectCard({ card, onChanged, spellings }: { card: HomeCard; onChanged: () => void; spellings: ReadonlyMap<string, string> }) {
  const actions = useProjectActions();
  const o = card.overview;
  const p = o.project;
  const group = groupOf(p, spellings);
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  const permission = card.status === "permission" ? o.permissions[0] : undefined;
  const previewUrl = o.preview?.state === "running" ? o.preview.url : null;

  const open = () => {
    if (!o.current) void actions.openRecent(p);
  };
  const answer = (optionId: string, name: string) => {
    if (!permission) return;
    if (answerPermissionAnywhere(permission.requestId, optionId)) {
      toast(`${name}: ${permission.title}`, { description: p.name });
      setTimeout(onChanged, 300);
    } else toast.error("Not connected to the daemon — open the project to answer");
  };

  const meta = [group, p.kind === "system" ? "system" : null, prettyPath(p.root)].filter(Boolean).join(" · ");
  const allowOnce = permission?.options.find((x) => x.kind === "allow_once") ?? permission?.options.find((x) => x.kind.startsWith("allow"));
  const reject = permission?.options.find((x) => x.kind === "reject_once") ?? permission?.options.find((x) => x.kind.startsWith("reject"));

  return (
    <article
      aria-label={`${p.name}: ${card.pill}`}
      onMouseEnter={() => {
        if (o.current) return;
        clearTimeout(hover.current);
        hover.current = setTimeout(() => void prefetchProject(p.id), 120);
      }}
      onMouseLeave={() => clearTimeout(hover.current)}
      className={cn(
        "group/card relative flex min-h-[11.5rem] flex-col gap-2.5 rounded-2xl border bg-card p-4 shadow-[var(--elev-card)] transition-colors hover:bg-surface-1",
        card.attention ? BORDER_TONE[card.tone] : "border-hairline",
      )}
    >
      {/* The whole card opens the project (the quick actions sit above it). */}
      <button
        type="button"
        onClick={open}
        aria-label={o.current ? `${p.name} (open now)` : `Open ${p.name}`}
        className="absolute inset-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none flex items-center gap-2.5">
        <ProjectTile project={p} className="size-8 rounded-lg text-[13px]" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5">
            <span className="truncate text-ui font-semibold text-foreground" title={p.name}>
              {p.name}
            </span>
            {p.pinned ? <Pin className="size-3 shrink-0 text-faint" aria-label="Pinned" /> : null}
            {o.current ? <span className="shrink-0 rounded-pill bg-primary/12 px-1.5 text-[10.5px] font-medium text-brand">open</span> : null}
          </p>
          <p className="truncate text-meta text-muted-foreground" title={p.root}>
            {meta}
          </p>
        </div>
        {/* A quiet project needs no pill: the name keeps the room. */}
        {card.status !== "quiet" ? (
          <span className={cn("flex h-5.5 shrink-0 items-center gap-1 rounded-pill px-2 text-[11px] font-medium", PILL_TONE[card.tone])}>
            {card.status === "running" ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ai motion-reduce:animate-none" /> : null}
            {card.pill}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More for ${p.name}`}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto relative z-10 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-60 outline-none transition-opacity group-hover/card:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 rounded-xl border-hairline p-1">
            <DropdownMenuItem disabled={o.current} onSelect={open}>
              <ArrowRight className="text-muted-foreground" /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void actions.togglePin(p)}>
              {p.pinned ? <PinOff className="text-muted-foreground" /> : <Pin className="text-muted-foreground" />}
              {p.pinned ? "Unpin" : "Pin (⌘1…⌘9)"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTagsDialog(p.id)}>
              <Hash className="text-muted-foreground" /> Group…
            </DropdownMenuItem>
            {bridge ? (
              <DropdownMenuItem onSelect={() => bridge.revealInFinder(p.root)}>
                <SquareArrowOutUpRight className="text-muted-foreground" /> Reveal in Finder
              </DropdownMenuItem>
            ) : null}
            {!o.current ? (
              <>
                <DropdownMenuSeparator className="bg-hairline" />
                <DropdownMenuItem onSelect={() => void actions.forget(p)}>
                  <X className="text-muted-foreground" /> Remove from recents
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {card.headline ? (
        <p className={cn("pointer-events-none line-clamp-2 text-ui leading-snug", card.tone === "bad" ? "text-bad" : "text-foreground")}>{card.headline}</p>
      ) : null}
      <p className="pointer-events-none line-clamp-2 text-ui-sm leading-snug text-muted-foreground">{card.leftOff}</p>

      <div className="pointer-events-none mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        {permission && allowOnce ? (
          <>
            <QuickButton primary onClick={() => answer(allowOnce.optionId, allowOnce.name)} title="Answer without switching">
              {allowOnce.name}
            </QuickButton>
            {reject ? <QuickButton onClick={() => answer(reject.optionId, reject.name)}>{reject.name}</QuickButton> : null}
          </>
        ) : null}
        {o.lastChat && !permission ? (
          <QuickButton
            onClick={() => void actions.showChat({ id: o.lastChat!.id, projectId: p.id, projectRoot: p.root, projectName: p.name })}
            title={o.lastChat.title}
          >
            <MessageSquare className="size-3.5" /> Continue chat
          </QuickButton>
        ) : null}
        {previewUrl ? (
          <QuickButton
            onClick={() => {
              if (o.current) setShellDialog("preview", true);
              else window.open(previewUrl, "_blank", "noopener");
            }}
            title={previewUrl}
          >
            <ExternalLink className="size-3.5" /> Preview
          </QuickButton>
        ) : null}
        <span className="ms-auto truncate ps-2 font-mono text-[11px] text-faint" title={card.foot}>
          {card.foot}
        </span>
      </div>
    </article>
  );
}

function StartCard() {
  const actions = useProjectActions();
  return (
    <div className="flex min-h-[11.5rem] flex-col gap-2 rounded-2xl border border-dashed border-border p-4">
      <p className="text-ui font-semibold text-foreground">Start something</p>
      <p className="text-ui-sm leading-snug text-muted-foreground">Create a project from a template, open a repo, or combine repos into a system.</p>
      <div className="mt-auto flex flex-wrap gap-1.5">
        <QuickButton primary onClick={actions.newProject}>
          <FolderPlus className="size-3.5" /> New project
        </QuickButton>
        <QuickButton onClick={() => void actions.pickFolder()}>
          <FolderOpen className="size-3.5" /> Open folder
        </QuickButton>
        <QuickButton onClick={() => openSystemDialog({ kind: "new" })}>
          <Layers className="size-3.5" /> New system
        </QuickButton>
      </div>
    </div>
  );
}

function withLive(o: ProjectOverview, fresh: ProjectInfo | undefined): ProjectOverview {
  // Pins and tags change in any window without a refetch: the live list is the truth for them.
  return fresh ? { ...o, project: { ...fresh, name: o.current ? o.project.name : fresh.name } } : o;
}

export function HomePage({ header }: { header: ReactNode }) {
  const { daemon } = useWorkspace();
  const activity = useActivity();
  const actions = useProjectActions();
  const enabled = daemon.source === "daemon" && !!daemon.httpOrigin;
  const { data, error, loading, reload } = useOverview(enabled);
  const [filter, setFilterState] = useState<string>(readFilter);
  const setFilter = (id: string) => {
    setFilterState(id);
    try {
      window.localStorage.setItem(FILTER_KEY, id);
    } catch {
      /* storage unavailable */
    }
  };

  const agentName = useCallback(
    (id: string) => daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id,
    [daemon.agent?.agents?.available],
  );
  const filters = useMemo(() => homeFilters(daemon.recentProjects), [daemon.recentProjects]);
  // Cards name a group the way its filter chip does ("Job", not one project's "job").
  const spellings = useMemo(() => groupSpellings(daemon.recentProjects), [daemon.recentProjects]);
  const activeFilter = filters.some((f) => f.id === filter) ? filter : "all";
  // The filter pills are one radio group: one Tab stop, arrows change the filter.
  const filterKeys = useSegmentedKeys(filters.map((f) => f.id), activeFilter, setFilter);

  const cards = useMemo(() => {
    if (!data) return [];
    const byId = new Map(daemon.recentProjects.map((p) => [p.id, p]));
    const now = Date.now();
    const zero = (id: string, name: string): ProjectActivity => ({ projectId: id, projectName: name, running: 0, waitingPermission: 0, unread: 0, chats: {} });
    return sortCards(
      data.projects
        .map((o) => withLive(o, byId.get(o.project.id)))
        .filter((o) => matchesFilter(o.project, activeFilter))
        .map((o) =>
          homeCard(o, {
            agentName,
            now,
            // The feed lists only projects with something going on: absent = nothing (once it is live).
            ...(activity.supported ? { activity: activity.projects[o.project.id] ?? zero(o.project.id, o.project.name) } : {}),
          }),
        ),
    );
  }, [data, daemon.recentProjects, activeFilter, activity, agentName]);

  const allCards = data?.projects.length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Columns follow the room the page has (the agent panel may take some): a container query. */}
        <div className="@container mx-auto flex w-full max-w-[76rem] flex-col gap-5 px-8 py-7 max-md:px-4 max-md:py-5">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <h2 className="heading text-[22px] text-foreground">{greeting()}</h2>
            <p className="pb-0.5 text-ui-sm text-muted-foreground">
              {data ? `${homeSummary(cards)} · sorted by what needs you` : enabled ? "Loading your projects…" : "Connect the Ruah app to see your projects"}
            </p>
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Refresh"
                  onClick={reload}
                  disabled={!enabled}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RefreshCw className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Refresh (it also refreshes by itself when agents do something)</TooltipContent>
            </Tooltip>
          </div>

          {filters.length > 1 ? (
            <div {...filterKeys.groupProps} aria-label="Filter projects" className="flex flex-wrap items-center gap-1.5">
              {filters.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  {...filterKeys.itemProps(i)}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-pill border px-3 text-ui-sm transition-colors",
                    activeFilter === f.id ? "border-primary/40 bg-primary/10 text-foreground" : "border-hairline text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {f.id.startsWith("tag:") ? <Hash className="size-3" /> : f.id === "pinned" ? <Pin className="size-3" /> : null}
                  {f.label}
                  <span className="text-[10.5px] text-faint tabular-nums">{f.count}</span>
                </button>
              ))}
              <span className="ms-1 text-meta text-faint">Group a project from its ⋯ menu</span>
            </div>
          ) : null}

          {error && !data ? (
            <div className="flex items-center gap-3 rounded-xl border border-hairline bg-surface-1 px-4 py-3 text-ui-sm text-muted-foreground">
              <Phantom expression="error" size={20} still />
              Couldn’t load the overview: {error}
              <button type="button" onClick={reload} className="ms-auto text-primary hover:underline">
                Try again
              </button>
            </div>
          ) : null}

          {!data && enabled && !error ? (
            <div className="grid grid-cols-1 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-3" aria-busy="true">
              {Array.from({ length: Math.min(6, Math.max(3, daemon.recentProjects.length)) }, (_, i) => (
                <div key={i} className="h-[11.5rem] animate-pulse rounded-2xl border border-hairline bg-surface-1 motion-reduce:animate-none" />
              ))}
            </div>
          ) : null}

          {data && allCards === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <PhantomPose pose="waving" size={96} noGlow />
              <p className="text-ui text-foreground">No projects yet</p>
              <p className="max-w-sm text-ui-sm text-muted-foreground">Create one from a template or open a repo — it shows up here with what it needs from you.</p>
              <div className="flex gap-2">
                <QuickButton primary onClick={actions.newProject}>
                  <FolderPlus className="size-3.5" /> New project
                </QuickButton>
                <QuickButton onClick={() => void actions.pickFolder()}>
                  <FolderOpen className="size-3.5" /> Open folder
                </QuickButton>
              </div>
            </div>
          ) : null}

          {data && allCards > 0 ? (
            <div className="grid grid-cols-1 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-3">
              {cards.map((c) => (
                <ProjectCard key={c.id} card={c} onChanged={reload} spellings={spellings} />
              ))}
              {cards.length === 0 ? (
                <p className="col-span-full py-6 text-center text-ui-sm text-muted-foreground">
                  No project in this group.{" "}
                  <button type="button" className="text-primary hover:underline" onClick={() => setFilter("all")}>
                    Show all
                  </button>
                </p>
              ) : null}
              {activeFilter === "all" ? <StartCard /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
