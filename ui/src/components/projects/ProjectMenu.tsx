// Sidebar project header: the current project as a dropdown switcher (same items as ⌘K).
import {
  Check,
  ChevronsUpDown,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import { repoBasename, useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { prettyPath } from "@/lib/time";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { KindBadge, ProjectTile } from "./ProjectBits";
import { pinnedShortcut } from "./ProjectPalette";
import { useProjectActions } from "./useProjectActions";

const itemClass = "gap-2.5 rounded-md px-2 py-1.5 text-ui";

/** Name + id of what the shell shows as "the project", for every daemon generation. */
export function useCurrentProjectLabel() {
  const { daemon, architecture } = useWorkspace();
  if (daemon.projectSwitch) return { id: "switch", name: daemon.projectSwitch.name, root: daemon.projectSwitch.root };
  if (daemon.project) return { id: daemon.project.id, name: daemon.project.name, root: daemon.project.root };
  if (daemon.source === "sample") return { id: "sample", name: `${architecture.name} (sample)`, root: null };
  if (daemon.root) return { id: daemon.root, name: architecture.name || repoBasename(daemon.root) || "Project", root: daemon.root };
  return { id: "none", name: daemon.source === null ? "Connecting…" : "No project", root: null };
}

export function ProjectMenu({ dotClass }: { dotClass: string }) {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const actions = useProjectActions();
  const label = useCurrentProjectLabel();
  const switching = !!daemon.projectSwitch;
  const pinned = daemon.recentProjects.filter((p) => p.pinned);
  const recents = daemon.recentProjects.slice(0, 8);
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={`${label.root ? prettyPath(label.root) : label.name} · switch project (⌘K)`}
        className="group/pm flex h-row-lg w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
      >
        <span className="relative">
          <ProjectTile project={{ id: label.id, name: label.name }} className="size-5 text-[10px]" />
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface-1",
              switching ? "bg-warn animate-pulse" : dotClass,
            )}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{label.name}</span>
        {switching ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-72 rounded-xl border-hairline p-1">
        {recents.length ? (
          <>
            <DropdownMenuLabel className="section-label px-2 pt-1.5 pb-1">Recent projects</DropdownMenuLabel>
            {recents.map((p) => {
              const isCurrent = daemon.project?.id === p.id;
              const pinIndex = pinned.findIndex((x) => x.id === p.id);
              const shortcut = pinIndex >= 0 ? pinnedShortcut(pinIndex) : null;
              return (
                <DropdownMenuItem
                  key={p.id}
                  className={itemClass}
                  onSelect={() => !isCurrent && void actions.openRecent(p)}
                  title={p.root}
                >
                  <ProjectTile project={p} className="size-5 text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.kind === "system" ? <KindBadge kind={p.kind} /> : null}
                  {isCurrent ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                  {shortcut ? <kbd className="kbd shrink-0">{shortcut}</kbd> : null}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator className="bg-hairline" />
          </>
        ) : null}
        <DropdownMenuItem className={itemClass} onSelect={() => wb.setPaletteOpen(true)}>
          <Search className="text-muted-foreground" /> Switch project…
          <kbd className="kbd ms-auto">⌘K</kbd>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={itemClass}
          disabled={!actions.connected}
          onSelect={() => void actions.pickFolder()}
        >
          <FolderOpen className="text-muted-foreground" /> Open folder…
          <kbd className="kbd ms-auto">⌘O</kbd>
        </DropdownMenuItem>
        <DropdownMenuItem className={itemClass} disabled={!actions.connected} onSelect={actions.newProject}>
          <FolderPlus className="text-muted-foreground" /> New project…
          <kbd className="kbd ms-auto">⇧⌘N</kbd>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-hairline" />
        <DropdownMenuItem className={itemClass} onSelect={() => wb.setLauncherOpen(true)}>
          <Home className="text-muted-foreground" /> Start screen
        </DropdownMenuItem>
        {bridge && label.root ? (
          <DropdownMenuItem className={itemClass} onSelect={() => bridge.revealInFinder(label.root!)}>
            <SquareArrowOutUpRight className="text-muted-foreground" /> Reveal in Finder
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
