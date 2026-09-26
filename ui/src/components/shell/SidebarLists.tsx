// The Advanced layout's sidebar lists (recovered from the sidebar removed in ce7bf2f —
// ProjectsSection and ChatsSection — adapted to the rail shell): Projects (pinned first with
// ⌘1…⌘9, then recent; activity badge; pin / reveal / forget on hover) and the open project's Chats
// (date groups, status dot, unread, rename / delete). No search field (the ⌘K launcher searches
// everything) and no agent footer (the top bar's agent pill says it).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, Pin, PinOff, Plus, SquareArrowOutUpRight, Trash2, X } from "lucide-react";
import type { ChatInfo, ProjectInfo } from "@/lib/contracts";
import { deleteChat, prefetchChat, prefetchProject, renameChat } from "@/lib/daemon";
import { useProjectActivity } from "@/lib/activity";
import { railBadge } from "@/lib/rail";
import { CHAT_STATE_LABEL } from "@/lib/recent-chats";
import { groupByDate } from "@/lib/switching";
import { absoluteTime, prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { Phantom } from "@/components/brand/Phantom";
import { ProjectTile } from "@/components/projects/ProjectBits";
import { useProjectActions } from "@/components/projects/useProjectActions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CollapsibleSection } from "./CollapsibleSection";
import { AddProjectMenu } from "./RailProjects";
import { setShellDialog } from "./shellState";
import { CHAT_DOT, useChatStatuses } from "./useChatStatuses";

/** Recent (unpinned) projects listed before "All projects…". */
const RECENT_ROWS = 8;
/** Chats listed before "All chats…". */
const CHAT_ROWS = 14;

const iconButton =
  "relative grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

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

function HeaderButton({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="grid size-6 place-items-center rounded-md text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function SubLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] font-medium tracking-wide text-faint uppercase">{children}</div>;
}

function ProjectRow({ p, current, shortcut, switching }: { p: ProjectInfo; current: boolean; shortcut: string | null; switching: boolean }) {
  const actions = useProjectActions();
  const badge = railBadge(useProjectActivity(p.id));
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  return (
    <div
      role="listitem"
      data-active={current}
      onMouseEnter={() => {
        if (current) return;
        clearTimeout(hover.current);
        hover.current = setTimeout(() => void prefetchProject(p.id), 90);
      }}
      onMouseLeave={() => clearTimeout(hover.current)}
      title={`${p.name}\n${prettyPath(p.root)}${badge.label ? `\n${badge.label}` : ""}`}
      className="group/proj list-row relative h-7 gap-2 ps-1.5 pe-1"
    >
      <button
        type="button"
        aria-label={current ? `${p.name} (current project)` : `Switch to ${p.name}${badge.label ? ` — ${badge.label}` : ""}`}
        aria-current={current ? "true" : undefined}
        onClick={() => {
          if (!current) void actions.openRecent(p);
        }}
        className="absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span className="pointer-events-none relative">
        <ProjectTile project={p} className={cn("size-[18px] rounded-[5px] text-[9.5px]", switching && "animate-pulse motion-reduce:animate-none")} />
        {badge.dot ? (
          <span
            aria-hidden
            className={cn(
              "absolute -top-0.5 -right-0.5 size-[7px] rounded-full ring-2 ring-sidebar",
              badge.dot === "waiting" ? "bg-warn" : "animate-pulse bg-ai motion-reduce:animate-none",
            )}
          />
        ) : null}
      </span>
      <span className={cn("pointer-events-none min-w-0 flex-1 truncate", current && "font-medium text-foreground")}>{p.name}</span>
      <span className="pointer-events-none flex shrink-0 items-center gap-1 group-focus-within/proj:hidden group-hover/proj:hidden">
        {badge.unread > 0 ? (
          <span className="min-w-4 rounded-full bg-primary/15 px-1 text-center text-[10px] leading-4 font-medium text-primary tabular-nums">
            {badge.unread > 99 ? "99+" : badge.unread}
          </span>
        ) : null}
        {shortcut ? <kbd className="kbd">{shortcut}</kbd> : null}
      </span>
      <span className="relative hidden items-center gap-0.5 group-focus-within/proj:flex group-hover/proj:flex">
        <RowAction label={p.pinned ? "Unpin" : "Pin to top"} onClick={() => void actions.togglePin(p)}>
          {p.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </RowAction>
        {bridge ? (
          <RowAction label="Reveal in Finder" onClick={() => bridge.revealInFinder(p.root)}>
            <SquareArrowOutUpRight className="size-3" />
          </RowAction>
        ) : null}
        {!current ? (
          <RowAction label="Remove from recents" onClick={() => void actions.forget(p)}>
            <X className="size-3" />
          </RowAction>
        ) : null}
      </span>
    </div>
  );
}

export function SidebarProjects() {
  const { daemon } = useWorkspace();
  if (!daemon.projectsSupported) return null;
  const switchTarget = daemon.projectSwitch?.projectId ?? null;
  const currentId = switchTarget ?? daemon.project?.id ?? null;
  const pinned = daemon.recentProjects.filter((p) => p.pinned);
  const recents = daemon.recentProjects.filter((p) => !p.pinned);
  const shown = recents.slice(0, RECENT_ROWS);
  // The open project is always listed.
  const current = recents.find((p) => p.id === currentId);
  if (current && !shown.includes(current)) shown.splice(shown.length - 1, 1, current);
  const more = daemon.recentProjects.length - pinned.length - shown.length;

  return (
    <CollapsibleSection
      id="adv.projects"
      label="Projects"
      count={daemon.recentProjects.length}
      action={
        <AddProjectMenu side="right">
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger
                aria-label="Add a project"
                className="grid size-6 place-items-center rounded-md text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
              >
                <Plus className="size-3.5" />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">Open folder, new project, new system</TooltipContent>
          </Tooltip>
        </AddProjectMenu>
      }
    >
      {daemon.recentProjects.length === 0 ? (
        <p className="px-2 py-1 text-label text-faint">No projects yet. Open a folder to start (⌘O).</p>
      ) : (
        <div role="list" aria-label="Projects" className="space-y-px">
          {pinned.length ? <SubLabel>Pinned</SubLabel> : null}
          {pinned.map((p, i) => (
            <ProjectRow key={p.id} p={p} current={p.id === currentId} shortcut={i < 9 ? `⌘${i + 1}` : null} switching={p.id === switchTarget} />
          ))}
          {pinned.length && shown.length ? <SubLabel>Recent</SubLabel> : null}
          {shown.map((p) => (
            <ProjectRow key={p.id} p={p} current={p.id === currentId} shortcut={null} switching={p.id === switchTarget} />
          ))}
          {more > 0 ? (
            <button
              type="button"
              onClick={() => setShellDialog("allProjects", true)}
              className="list-row h-7 ps-2 text-ui-sm text-faint outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="flex-1">All projects…</span>
              <span className="text-meta tabular-nums">{more} more</span>
            </button>
          ) : null}
        </div>
      )}
    </CollapsibleSection>
  );
}

function RenameInput({ chat, onDone }: { chat: ChatInfo; onDone: () => void }) {
  const [value, setValue] = useState(chat.title);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (value.trim() && value.trim() !== chat.title) renameChat(chat.id, value);
    onDone();
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Chat title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
      maxLength={80}
      className="h-6 min-w-0 flex-1 rounded-md bg-surface-3 px-1.5 text-ui text-foreground outline-none ring-1 ring-ring"
    />
  );
}

export function SidebarChats() {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const statuses = useChatStatuses();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ChatInfo | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);

  const chats = daemon.chats;
  const shown = useMemo(() => {
    const sorted = [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const top = sorted.slice(0, CHAT_ROWS);
    const active = sorted.find((c) => c.id === daemon.activeChatId);
    if (active && !top.includes(active)) top.splice(top.length - 1, 1, active);
    return top;
  }, [chats, daemon.activeChatId]);
  const groups = groupByDate(shown, (c) => c.updatedAt);
  const agentName = (id: string) => daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;
  const showingChat = pathname === "/agent" || pathname === "/map";

  if (!daemon.projectsSupported || !daemon.project) return null;

  return (
    <>
      <CollapsibleSection
        id="adv.chats"
        label="Chats"
        count={chats.length}
        action={
          <HeaderButton label="New chat · ⌘N" onClick={actions.startChat}>
            <Plus className="size-3.5" />
          </HeaderButton>
        }
      >
        {chats.length === 0 ? (
          <div className="flex items-start gap-2 px-2 pt-0.5 pb-1">
            <Phantom expression="idle" size="xs" className="mt-px" />
            <p className="text-label leading-relaxed text-faint">No chats yet. Ask anything, or about an element — each conversation is kept here.</p>
          </div>
        ) : (
          <div role="list" aria-label="Chats" className="space-y-px">
            {groups.map((g) => (
              <div key={g.label} role="presentation">
                <SubLabel>{g.label}</SubLabel>
                {g.items.map((c) => {
                  const st = statuses.get(c.id) ?? { state: "idle" as const, unread: 0 };
                  const active = c.id === daemon.activeChatId && showingChat;
                  const stateLabel = CHAT_STATE_LABEL[st.state];
                  return (
                    <div
                      key={c.id}
                      role="listitem"
                      data-active={active}
                      onMouseEnter={() => {
                        clearTimeout(hover.current);
                        hover.current = setTimeout(() => void prefetchChat(c.projectId, c.id), 80);
                      }}
                      title={`${c.title || "Untitled chat"}\n${[stateLabel, agentName(c.agentId), `${c.turnCount} turns`, absoluteTime(c.updatedAt)].filter(Boolean).join(" · ")}`}
                      className="group/chat list-row relative h-7 gap-2 pe-1"
                    >
                      {renaming === c.id ? (
                        <RenameInput chat={c} onDone={() => setRenaming(null)} />
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => void actions.showChat(c)}
                            onDoubleClick={() => setRenaming(c.id)}
                            className="absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            aria-label={`Open chat ${c.title || "Untitled chat"}${stateLabel ? ` — ${stateLabel}` : ""}${st.unread ? `, ${st.unread} unread` : ""}`}
                            aria-current={active ? "true" : undefined}
                          />
                          <span aria-hidden className={cn("pointer-events-none size-1.5 shrink-0 rounded-full", CHAT_DOT[st.state])} />
                          <span className={cn("pointer-events-none min-w-0 flex-1 truncate", st.unread > 0 && "font-medium text-foreground")}>
                            {c.title || "Untitled chat"}
                          </span>
                          <span className="pointer-events-none shrink-0 text-meta text-faint group-hover/chat:hidden group-has-[[data-state=open]]/chat:hidden">
                            {relativeTime(c.updatedAt)}
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`Chat actions for ${c.title || "Untitled chat"}`}
                              className="relative hidden size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none group-hover/chat:grid hover:bg-accent hover:text-foreground focus-visible:grid data-[state=open]:grid"
                            >
                              <MoreHorizontal className="size-3.5" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" side="right" className="w-40">
                              <DropdownMenuItem onSelect={() => setRenaming(c.id)} className="text-ui">
                                <Pencil className="text-muted-foreground" /> Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setConfirm(c)} className="text-ui text-bad focus:text-bad">
                                <Trash2 /> Delete…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {chats.length > shown.length ? (
              <button
                type="button"
                onClick={() => void router.navigate({ to: "/chats" })}
                className="list-row h-7 ps-2 text-ui-sm text-faint outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="flex-1">All chats…</span>
                <span className="text-meta tabular-nums">{chats.length - shown.length} more</span>
              </button>
            ) : null}
          </div>
        )}
      </CollapsibleSection>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="max-w-sm rounded-xl border-hairline bg-popover p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-title">Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription className="text-ui">
              “{confirm?.title || "Untitled chat"}” and its {confirm?.turnCount ?? 0} {confirm?.turnCount === 1 ? "turn" : "turns"} are removed from
              this project. Files the agent changed stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg border-hairline bg-transparent text-ui">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 rounded-lg bg-destructive text-ui text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirm) deleteChat(confirm.id);
                setConfirm(null);
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
