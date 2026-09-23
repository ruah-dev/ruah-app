// ⌘K / ⌘P: one switcher for everything — projects (pinned first, then recent), chats across ALL
// projects (most recent first, with their project), and actions. Fuzzy search (cmdk), grouped,
// keyboard-only. Picking a chat of another project switches project and opens the chat in one
// step; the highlighted row is prefetched so the switch paints from cache.
import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  Check,
  FolderOpen,
  FolderPlus,
  History,
  Home,
  MessageSquarePlus,
  MessagesSquare,
  Pin,
  SquareTerminal,
} from "lucide-react";
import { prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { prefetchChat, prefetchProject } from "@/lib/daemon";
import { openRecentChatsSwitcher } from "@/components/chats/RecentChatsSwitcher";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentMark } from "@/components/agent/ComposerControls";
import { Phantom } from "@/components/brand/Phantom";
import { KindBadge, ProjectTile } from "./ProjectBits";
import { useProjectActions } from "./useProjectActions";
import { useRecentChats } from "./useRecentChats";
import { newTerminal } from "@/components/terminal/TerminalPanel";
import { openElementInTerminal } from "@/components/terminal/actions";

const itemClass = "gap-2.5 rounded-lg px-2 py-1.5 text-ui data-[selected=true]:bg-accent";
const groupClass = "[&_[cmdk-group-heading]]:section-label";
/** Rendered chat rows: enough for weeks of work, cheap for cmdk to filter. */
const MAX_CHATS = 150;

export function pinnedShortcut(index: number) {
  return index < 9 ? `⌘${index + 1}` : null;
}

type Target = { projectId: string; chatId?: string };

/** cmdk values must be unique; a hidden separator + index keeps ids out of the fuzzy match. */
const SEP = "⁣";
const valueOf = (label: string, key: string) => `${label}${SEP}${key}`;

/** Prefetch what the highlighted row would open (debounced by the caller). */
function prefetchFor(target: Target | undefined) {
  if (!target) return;
  if (target.chatId) void prefetchChat(target.projectId, target.chatId);
  void prefetchProject(target.projectId);
}

export function ProjectPalette() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const router = useRouter();
  const actions = useProjectActions();
  const current = daemon.project;
  const pinned = daemon.recentProjects.filter((p) => p.pinned);
  // The open project goes last, so ⌘K ↵ jumps to the previous project (like app switching).
  const projects = [
    ...daemon.recentProjects.filter((p) => p.id !== current?.id),
    ...daemon.recentProjects.filter((p) => p.id === current?.id),
  ];
  const chats = useRecentChats(daemon, wb.paletteOpen);
  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const targets = new Map<string, Target>();
  const onHighlight = (value: string) => {
    clearTimeout(timer.current);
    const target = targets.get(value);
    timer.current = setTimeout(() => prefetchFor(target), 90);
  };
  const chatRows = chats.slice(0, MAX_CHATS);
  projects.forEach((p, i) => targets.set(valueOf(p.name, `p${i}`), { projectId: p.id }));
  chatRows.forEach((c, i) =>
    targets.set(valueOf(c.title || "Untitled chat", `c${i}`), { projectId: c.projectId, chatId: c.id }),
  );

  return (
    <Dialog open={wb.paletteOpen} onOpenChange={wb.setPaletteOpen}>
      <DialogContent className="top-[14%] w-[calc(100vw-2rem)] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-2xl border-hairline bg-popover p-0 shadow-2xl [&>button]:hidden">
        <DialogTitle className="sr-only">Switch project or chat</DialogTitle>
        <Command className="bg-transparent" loop onValueChange={onHighlight}>
          <CommandInput
            placeholder="Jump to a project or chat, or run an action…"
            className="h-12 text-body"
          />
          <CommandList className="max-h-[min(64vh,520px)] px-1.5 pb-1.5">
            <CommandEmpty className="flex flex-col items-center gap-2 py-8 text-center text-ui-sm text-muted-foreground">
              <Phantom expression="thinking" size="sm" />
              Nothing matches.
            </CommandEmpty>
            {projects.length ? (
              <CommandGroup heading="Projects" className={groupClass}>
                {projects.map((p, i) => {
                  const isCurrent = current?.id === p.id;
                  const pinIndex = pinned.findIndex((x) => x.id === p.id);
                  const shortcut = pinIndex >= 0 ? pinnedShortcut(pinIndex) : null;
                  return (
                    <CommandItem
                      key={p.id}
                      value={valueOf(p.name, `p${i}`)}
                      keywords={[p.root, "project"]}
                      onSelect={() => {
                        wb.setPaletteOpen(false);
                        if (!isCurrent) void actions.openRecent(p);
                      }}
                      className={itemClass}
                    >
                      <ProjectTile project={p} className="size-5 text-[10px]" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-foreground">{p.name}</span>
                          {p.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" /> : null}
                          {p.kind === "system" ? <KindBadge kind={p.kind} /> : null}
                        </span>
                        <span className="block truncate font-mono text-meta text-muted-foreground">
                          {prettyPath(p.root)}
                        </span>
                      </span>
                      {isCurrent ? (
                        <Check className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span className="shrink-0 text-meta text-muted-foreground">
                          {relativeTime(p.lastOpenedAt)}
                        </span>
                      )}
                      {shortcut ? <kbd className="kbd shrink-0">{shortcut}</kbd> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            {chats.length ? (
              <CommandGroup heading="Chats" className={groupClass}>
                {chatRows.map((c, i) => {
                  const here = c.projectId === current?.id;
                  const active = here && c.id === daemon.activeChatId;
                  return (
                    <CommandItem
                      key={c.id}
                      value={valueOf(c.title || "Untitled chat", `c${i}`)}
                      keywords={[c.projectName, agentName(c.agentId), "chat"]}
                      onSelect={() => void actions.showChat(c)}
                      className={itemClass}
                    >
                      <AgentMark name={agentName(c.agentId)} />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {c.title || "Untitled chat"}
                      </span>
                      <span
                        className="flex max-w-[40%] shrink-0 items-center gap-1.5 text-meta text-muted-foreground"
                        title={prettyPath(c.projectRoot)}
                      >
                        <ProjectTile
                          project={{ id: c.projectId, name: c.projectName }}
                          className="size-3.5 rounded-[4px] text-[8px]"
                        />
                        <span className="truncate">{c.projectName}</span>
                      </span>
                      {active ? (
                        <Check className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span className="w-8 shrink-0 text-right text-meta text-faint">
                          {relativeTime(c.updatedAt)}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            <CommandSeparator className="my-1 bg-hairline" />
            <CommandGroup heading="Actions" className={groupClass}>
              {daemon.projectsSupported && current ? (
                <CommandItem value="a:new-chat New chat" onSelect={actions.startChat} className={itemClass}>
                  <MessageSquarePlus className="size-4 text-muted-foreground" />
                  New chat
                  <kbd className="kbd ms-auto">⌘N</kbd>
                </CommandItem>
              ) : null}
              {daemon.source === "daemon" && current ? (
                <CommandItem
                  value="a:new-terminal New terminal shell console"
                  onSelect={() => {
                    wb.setPaletteOpen(false);
                    newTerminal();
                  }}
                  className={itemClass}
                >
                  <SquareTerminal className="size-4 text-muted-foreground" />
                  New terminal
                  <kbd className="kbd ms-auto">⌃`</kbd>
                </CommandItem>
              ) : null}
              {daemon.source === "daemon" && current && wb.selectedNode && (wb.selectedNode.path || wb.selectedNode.filePaths?.length) ? (
                <CommandItem
                  value={`a:element-terminal Open in terminal ${wb.selectedNode.label}`}
                  onSelect={() => {
                    const node = wb.selectedNode;
                    wb.setPaletteOpen(false);
                    if (node) openElementInTerminal(node);
                  }}
                  className={itemClass}
                >
                  <SquareTerminal className="size-4 text-muted-foreground" />
                  Open {wb.selectedNode.label} in terminal
                </CommandItem>
              ) : null}
              <CommandItem
                value="a:recent-chats Recent chats switcher"
                onSelect={() => {
                  wb.setPaletteOpen(false);
                  openRecentChatsSwitcher();
                }}
                className={itemClass}
              >
                <History className="size-4 text-muted-foreground" />
                Recent chats
                <kbd className="kbd ms-auto">⌘J</kbd>
              </CommandItem>
              <CommandItem value="a:open-folder Open folder" onSelect={() => void actions.pickFolder()} className={itemClass}>
                <FolderOpen className="size-4 text-muted-foreground" />
                Open folder…
                <kbd className="kbd ms-auto">⌘O</kbd>
              </CommandItem>
              <CommandItem value="a:new-project New project create" onSelect={actions.newProject} className={itemClass}>
                <FolderPlus className="size-4 text-muted-foreground" />
                New project…
                <kbd className="kbd ms-auto">⇧⌘N</kbd>
              </CommandItem>
              <CommandItem
                value="a:all-chats All chats"
                onSelect={() => {
                  wb.setPaletteOpen(false);
                  void router.navigate({ to: "/chats" });
                }}
                className={itemClass}
              >
                <MessagesSquare className="size-4 text-muted-foreground" />
                All chats
              </CommandItem>
              <CommandItem
                value="a:start-screen Start screen home launcher"
                onSelect={() => {
                  wb.setPaletteOpen(false);
                  wb.setLauncherOpen(true);
                }}
                className={itemClass}
              >
                <Home className="size-4 text-muted-foreground" />
                Start screen
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t border-hairline px-3 py-2 text-meta text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="kbd">↑</kbd>
              <kbd className="kbd">↓</kbd> move
            </span>
            <span className="flex items-center gap-1">
              <kbd className="kbd">↵</kbd> open
            </span>
            <span className="flex items-center gap-1">
              <kbd className="kbd">⌘J</kbd> recent chats
            </span>
            <span className="ms-auto flex items-center gap-1">
              <kbd className="kbd">esc</kbd> close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
