// Sidebar "Projects": pinned + recent projects in one windowed list; each row expands to its
// last 5 chats (lazy, GET /api/chats/recent?projectId=) so a chat of another project is one
// click away. The current project is highlighted. Hover: prefetch (instant switch), pin, reveal
// in Finder (desktop app), remove from recents.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderOpen, Loader2, Pin, PinOff, SquareArrowOutUpRight, X } from "lucide-react";
import type { ProjectInfo, RecentChat } from "@/lib/contracts";
import { chatsProjectId, fetchRecentChats, prefetchChat, prefetchProject } from "@/lib/daemon";
import { prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { VirtualList } from "@/components/common/VirtualList";
import { AgentMark } from "@/components/agent/ComposerControls";
import { ProjectTile } from "@/components/projects/ProjectBits";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CollapsibleSection } from "./CollapsibleSection";

const PROJECT_H = 30;
const CHAT_H = 26;
const CHATS_PER_PROJECT = 5;
const EXPANDED_KEY = "ruah.sidebar.projects.expanded.v1";

type Row =
  | { type: "project"; key: string; project: ProjectInfo; expanded: boolean }
  | { type: "chat"; key: string; chat: RecentChat }
  | { type: "note"; key: string; text: string; loading?: boolean };

function readExpanded(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Last answer per project, so re-expanding (and re-mounting the sidebar) paints at once.
const chatsByProject = new Map<string, RecentChat[]>();

const iconButton =
  "relative grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-surface-3 hover:text-foreground";

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={iconButton}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ProjectsSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [tick, bump] = useState(0);
  const loading = useRef(new Set<string>());
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  const currentId = daemon.projectSwitch?.projectId ?? daemon.project?.id ?? null;
  // Whose chats daemon.chats are (the previewed target during a cached switch).
  const owner = chatsProjectId(daemon);
  const connected = actions.connected;

  useEffect(() => setExpanded(readExpanded()), []);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  // Lazy: fetch the last chats of expanded projects (the open one comes live from the store).
  const liveKey = daemon.chats.map((c) => `${c.id}:${c.updatedAt}:${c.title}`).join("|");
  useEffect(() => {
    if (!connected) return;
    for (const id of expanded) {
      if (id === owner || loading.current.has(id)) continue;
      loading.current.add(id);
      fetchRecentChats(CHATS_PER_PROJECT, id)
        .then((list) => chatsByProject.set(id, list))
        .catch(() => chatsByProject.set(id, chatsByProject.get(id) ?? []))
        .finally(() => {
          loading.current.delete(id);
          bump((n) => n + 1);
        });
    }
    // liveKey: a turn in the open project moves it; refresh the others when it changes too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, connected, owner, liveKey]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of daemon.recentProjects) {
      const isOpen = expanded.includes(p.id);
      out.push({ type: "project", key: `p:${p.id}`, project: p, expanded: isOpen });
      if (!isOpen) continue;
      const list =
        p.id === owner
          ? daemon.chats.slice(0, CHATS_PER_PROJECT).map((c) => ({ ...c, projectName: p.name, projectRoot: p.root }))
          : chatsByProject.get(p.id);
      if (!list) out.push({ type: "note", key: `n:${p.id}`, text: "Loading chats…", loading: true });
      else if (list.length === 0) out.push({ type: "note", key: `n:${p.id}`, text: "No chats yet" });
      else for (const c of list) out.push({ type: "chat", key: `c:${p.id}:${c.id}`, chat: c });
    }
    return out;
    // bump() re-renders after a fetch lands in chatsByProject
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemon.recentProjects, owner, daemon.chats, expanded, tick]);

  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;

  const later = (fn: () => void) => {
    clearTimeout(hover.current);
    hover.current = setTimeout(fn, 90);
  };

  if (!daemon.projectsSupported || daemon.recentProjects.length === 0) return null;

  const openButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Open folder"
          onClick={() => void actions.pickFolder()}
          className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Open folder · ⌘O</TooltipContent>
    </Tooltip>
  );

  return (
    <CollapsibleSection id="projects" label="Projects" count={daemon.recentProjects.length} action={openButton}>
      <VirtualList
        items={rows}
        itemHeight={(r) => (r.type === "project" ? PROJECT_H : CHAT_H)}
        getKey={(r) => r.key}
        className="max-h-[min(34vh,320px)]"
        role="tree"
        aria-label="Projects"
        renderItem={(r) => {
          if (r.type === "note")
            return (
              <div className="flex h-full items-center gap-1.5 ps-9 text-label text-faint">
                {r.loading ? <Loader2 className="size-3 animate-spin" /> : null}
                {r.text}
              </div>
            );
          if (r.type === "chat") {
            const c = r.chat;
            const active = c.projectId === owner && c.id === daemon.activeChatId;
            return (
              <button
                type="button"
                role="treeitem"
                data-active={active}
                onMouseEnter={() =>
                  later(() => {
                    void prefetchChat(c.projectId, c.id);
                    void prefetchProject(c.projectId);
                  })
                }
                onClick={() => {
                  void actions.showChat(c);
                  onNavigate?.();
                }}
                title={`${c.title}\n${agentName(c.agentId)} · ${relativeTime(c.updatedAt)}`}
                className="list-row h-[calc(100%-2px)] gap-1.5 ps-8 text-ui-sm"
              >
                <AgentMark name={agentName(c.agentId)} className="size-3.5 text-[7px]" />
                <span className="min-w-0 flex-1 truncate">{c.title || "Untitled chat"}</span>
                <span className="shrink-0 text-[10.5px] text-faint">{relativeTime(c.updatedAt)}</span>
              </button>
            );
          }
          const p = r.project;
          const isCurrent = p.id === currentId;
          return (
            <div
              role="treeitem"
              aria-expanded={r.expanded}
              aria-current={isCurrent ? "true" : undefined}
              data-active={isCurrent}
              onMouseEnter={() => !isCurrent && later(() => void prefetchProject(p.id))}
              title={`${p.name}\n${prettyPath(p.root)}`}
              className="group/proj list-row relative h-[calc(100%-2px)] gap-1.5 ps-0.5 pe-1"
            >
              <button
                type="button"
                aria-label={isCurrent ? `${p.name} (open)` : `Open ${p.name}`}
                onClick={() => {
                  if (!isCurrent) void actions.openRecent(p);
                  onNavigate?.();
                }}
                className="absolute inset-0 rounded-md"
              />
              <button
                type="button"
                aria-label={r.expanded ? `Hide chats of ${p.name}` : `Show chats of ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(p.id);
                }}
                className="relative grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-3 hover:text-foreground"
              >
                <ChevronRight className={cn("size-3 transition-transform", r.expanded && "rotate-90")} />
              </button>
              <ProjectTile project={p} className="pointer-events-none size-4.5 rounded-[5px] text-[9px]" />
              <span className={cn("pointer-events-none min-w-0 flex-1 truncate", isCurrent && "font-medium text-foreground")}>
                {p.name}
              </span>
              {isCurrent ? <span className="pointer-events-none size-1.5 shrink-0 rounded-full bg-primary group-hover/proj:hidden" /> : null}
              {p.pinned ? <Pin className="pointer-events-none size-3 shrink-0 text-faint group-hover/proj:hidden" /> : null}
              <span className="hidden items-center gap-0.5 group-hover/proj:flex">
                <RowAction label={p.pinned ? "Unpin" : "Pin to top"} onClick={() => void actions.togglePin(p)}>
                  {p.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                </RowAction>
                {bridge ? (
                  <RowAction label="Reveal in Finder" onClick={() => bridge.revealInFinder(p.root)}>
                    <SquareArrowOutUpRight className="size-3" />
                  </RowAction>
                ) : null}
                {!isCurrent ? (
                  <RowAction label="Remove from recents" onClick={() => void actions.forget(p)}>
                    <X className="size-3" />
                  </RowAction>
                ) : null}
              </span>
            </div>
          );
        }}
      />
    </CollapsibleSection>
  );
}
