// Projects in the Standard rail (Arc-spaces style): pinned first (⌘1…⌘9), then recent ones, as
// avatar tiles with the activity badge (amber dot: an agent waits for you; pulsing lavender dot:
// working; a count: unread). Click switches; hover shows name, status and path; right-click pins,
// reveals or forgets. As many as fit the rail's height, then a "+N" tile (All projects), then "+"
// (open folder, new project, new system). Which ones and in what order: lib/rail.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderOpen, FolderPlus, Layers, List, Pin, PinOff, Plus, SquareArrowOutUpRight, X } from "lucide-react";
import type { ProjectInfo } from "@/lib/contracts";
import { useActivity, useProjectActivity } from "@/lib/activity";
import { prefetchProject } from "@/lib/daemon";
import { railBadge, railCapacity, railProjects, unreadText, RAIL_GAP, RAIL_TILE, type RailBadge } from "@/lib/rail";
import { openSystemDialog } from "@/lib/system";
import { prettyPath } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { ProjectTile } from "@/components/projects/ProjectBits";
import { useProjectActions } from "@/components/projects/useProjectActions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { setShellDialog } from "./shellState";

const ORDER_KEY = "ruah.rail.order.v1";

function readOrder(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const menuItem = "gap-2.5 rounded-md px-2 py-1.5 text-ui";

/** Open folder / New project / New system / All projects — the rail's "+" and the sidebar's "+". */
export function AddProjectMenu({
  children,
  side = "right",
  align = "start",
}: {
  children: ReactNode;
  side?: "right" | "bottom";
  align?: "start" | "end";
}) {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  return (
    <DropdownMenu>
      {children}
      <DropdownMenuContent
        side={side}
        align={align}
        sideOffset={8}
        onEscapeKeyDown={(e) => e.stopPropagation()}
        className="w-60 rounded-xl border-hairline p-1"
      >
        <DropdownMenuItem className={menuItem} disabled={!actions.connected} onSelect={() => void actions.pickFolder()}>
          <FolderOpen className="text-muted-foreground" /> Open folder…
          <kbd className="kbd ms-auto">⌘O</kbd>
        </DropdownMenuItem>
        <DropdownMenuItem className={menuItem} disabled={!actions.connected} onSelect={actions.newProject}>
          <FolderPlus className="text-muted-foreground" /> New project…
          <kbd className="kbd ms-auto">⇧⌘N</kbd>
        </DropdownMenuItem>
        <DropdownMenuItem className={menuItem} disabled={!actions.connected} onSelect={() => openSystemDialog({ kind: "new" })}>
          <Layers className="text-muted-foreground" /> New system…
        </DropdownMenuItem>
        {daemon.recentProjects.length ? (
          <>
            <DropdownMenuSeparator className="bg-hairline" />
            <DropdownMenuItem className={menuItem} onSelect={() => setShellDialog("allProjects", true)}>
              <List className="text-muted-foreground" /> All projects…
              <span className="ms-auto text-meta text-faint tabular-nums">{daemon.recentProjects.length}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Dot + unread pill on a project avatar. */
export function BadgeMarks({ badge, className }: { badge: RailBadge; className?: string }) {
  return (
    <>
      {badge.dot ? (
        <span
          aria-hidden
          className={cn(
            "absolute top-0.5 right-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
            badge.dot === "waiting" ? "bg-warn" : "animate-pulse bg-ai motion-reduce:animate-none",
            className,
          )}
        />
      ) : null}
      {badge.unread > 0 ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] leading-none font-semibold text-primary-foreground tabular-nums ring-2 ring-sidebar"
        >
          {unreadText(badge.unread)}
        </span>
      ) : null}
    </>
  );
}

function ProjectTileButton({
  project,
  current,
  shortcut,
  switching,
}: {
  project: ProjectInfo;
  current: boolean;
  shortcut: string | null;
  switching: boolean;
}) {
  const actions = useProjectActions();
  const badge = railBadge(useProjectActivity(project.id));
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  const status = switching ? "Opening…" : current ? "Current project" : badge.label;

  return (
    <div role="listitem" className="group/tile relative flex w-full shrink-0 justify-center">
      {/* The current project's marker on the rail's edge; a short one on hover. */}
      <span
        aria-hidden
        className={cn(
          "absolute start-0 top-1/2 w-[3px] -translate-y-1/2 rounded-e-full transition-[height,background-color] duration-150 motion-reduce:transition-none",
          current ? "h-5 bg-foreground/80" : "h-0 bg-foreground/40 group-hover/tile:h-2",
        )}
      />
      <ContextMenu>
        <Tooltip>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${current ? `${project.name} (current project)` : `Switch to ${project.name}`}${badge.label ? ` — ${badge.label}` : ""}`}
                aria-current={current ? "true" : undefined}
                aria-busy={switching || undefined}
                onClick={() => {
                  if (!current) void actions.openRecent(project);
                }}
                onMouseEnter={() => {
                  if (current) return;
                  clearTimeout(hover.current);
                  hover.current = setTimeout(() => void prefetchProject(project.id), 90);
                }}
                onMouseLeave={() => clearTimeout(hover.current)}
                style={{ width: RAIL_TILE, height: RAIL_TILE }}
                className={cn(
                  "relative grid place-items-center rounded-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  current ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <ProjectTile
                  project={project}
                  className={cn(
                    "size-8 rounded-[9px] text-[13px] transition-opacity",
                    !current && "opacity-80 group-hover/tile:opacity-100",
                    switching && "animate-pulse motion-reduce:animate-none",
                  )}
                />
                <BadgeMarks badge={badge} />
              </button>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent side="right" className="max-w-72">
            <span className="flex items-center gap-2">
              <span className="font-medium">{project.name}</span>
              {shortcut ? <kbd className="kbd">{shortcut}</kbd> : null}
            </span>
            {status ? (
              <span className={cn("block", badge.dot === "waiting" && !current ? "text-warn" : "text-muted-foreground")}>{status}</span>
            ) : null}
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{prettyPath(project.root)}</span>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent className="w-52 rounded-xl border-hairline p-1">
          <ContextMenuItem className={menuItem} disabled={current} onSelect={() => void actions.openRecent(project)}>
            Open
          </ContextMenuItem>
          <ContextMenuItem className={menuItem} onSelect={() => void actions.togglePin(project)}>
            {project.pinned ? <PinOff className="size-4 text-muted-foreground" /> : <Pin className="size-4 text-muted-foreground" />}
            {project.pinned ? "Unpin" : "Pin to top"}
          </ContextMenuItem>
          {bridge ? (
            <ContextMenuItem className={menuItem} onSelect={() => bridge.revealInFinder(project.root)}>
              <SquareArrowOutUpRight className="size-4 text-muted-foreground" /> Reveal in Finder
            </ContextMenuItem>
          ) : null}
          {!current ? (
            <>
              <ContextMenuSeparator className="bg-hairline" />
              <ContextMenuItem className={menuItem} onSelect={() => void actions.forget(project)}>
                <X className="size-4 text-muted-foreground" /> Remove from recents
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

const tileBox = "grid shrink-0 place-items-center rounded-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

export function RailProjects() {
  const { daemon } = useWorkspace();
  const activity = useActivity();
  const box = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const order = useRef<string[] | null>(null);
  if (order.current === null && typeof window !== "undefined") order.current = readOrder();

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const switchTarget = daemon.projectSwitch?.projectId ?? null;
  const currentId = switchTarget ?? daemon.project?.id ?? null;
  // One slot stays free for the "+" tile.
  const capacity = Math.max(0, railCapacity(height) - 1);
  const loaded = daemon.projectsLoaded;
  const layout = useMemo(
    () => railProjects(daemon.recentProjects, currentId, capacity, order.current ?? [], { complete: loaded }),
    [daemon.recentProjects, currentId, capacity, loaded],
  );

  useEffect(() => {
    // Keep the saved order until the rail was measured (height 0: one tile at most) and the project
    // list has loaded (a page that just opened knows no project, then only the open one).
    if (height === 0 || !loaded) return;
    const prev = order.current ?? [];
    if (prev.length === layout.order.length && prev.every((id, i) => id === layout.order[i])) return;
    order.current = layout.order;
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(layout.order));
    } catch {
      /* storage unavailable */
    }
  }, [layout.order, height, loaded]);

  // Waiting / running / unread in projects without a tile: say so on the "+N" tile.
  const hidden = new Set(layout.tiles.map((t) => t.project.id));
  const hiddenAttention = daemon.recentProjects.some((p) => {
    if (hidden.has(p.id)) return false;
    const a = activity.projects[p.id];
    return !!a && (a.waitingPermission > 0 || a.running > 0 || a.unread > 0);
  });

  return (
    <div
      ref={box}
      role="list"
      aria-label="Projects"
      className="flex min-h-0 w-full flex-1 flex-col items-center overflow-hidden"
      style={{ gap: RAIL_GAP }}
    >
      {daemon.projectsSupported ? (
        <>
          {layout.tiles.map((t) => (
            <ProjectTileButton
              key={t.project.id}
              project={t.project}
              current={t.current}
              shortcut={t.shortcut}
              switching={!!switchTarget && t.project.id === switchTarget}
            />
          ))}
          {layout.overflow > 0 ? (
            <div role="listitem" className="flex w-full shrink-0 justify-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${layout.overflow} more project${layout.overflow === 1 ? "" : "s"}: All projects`}
                    onClick={() => setShellDialog("allProjects", true)}
                    style={{ width: RAIL_TILE, height: RAIL_TILE }}
                    className={cn(tileBox, "relative text-[11.5px] font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
                  >
                    <span className="grid size-8 place-items-center rounded-[9px] bg-surface-2 tabular-nums">+{layout.overflow}</span>
                    {hiddenAttention ? (
                      <span aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full bg-warn ring-2 ring-sidebar" />
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {layout.overflow} more · All projects
                  {hiddenAttention ? <span className="block text-warn">Something there needs a look</span> : null}
                </TooltipContent>
              </Tooltip>
            </div>
          ) : null}
          <div role="listitem" className="flex w-full shrink-0 justify-center">
            <AddProjectMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger
                    aria-label="Add a project"
                    style={{ width: RAIL_TILE, height: RAIL_TILE }}
                    className={cn(tileBox, "text-faint hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground")}
                  >
                    <span className="grid size-8 place-items-center rounded-[9px] border border-dashed border-border">
                      <Plus className="size-4" />
                    </span>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">Add a project: open folder, new project, new system</TooltipContent>
              </Tooltip>
            </AddProjectMenu>
          </div>
        </>
      ) : null}
    </div>
  );
}
