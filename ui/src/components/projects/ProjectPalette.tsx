// ⌘K / ⌘P: switch project, jump to a chat, open or create a project. Keyboard-first
// (type to filter, ↑↓, Enter), the same items as the sidebar project menu.
import { useRouter } from "@tanstack/react-router";
import {
  Check,
  FolderOpen,
  FolderPlus,
  Home,
  MessageSquarePlus,
  MessagesSquare,
  Pin,
} from "lucide-react";
import { prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
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
import { cn } from "@/lib/utils";
import { KindBadge, ProjectTile } from "./ProjectBits";
import { useProjectActions } from "./useProjectActions";

const itemClass = "gap-2.5 rounded-lg px-2 py-1.5 text-ui data-[selected=true]:bg-accent";

export function pinnedShortcut(index: number) {
  return index < 9 ? `⌘${index + 1}` : null;
}

export function ProjectPalette() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const router = useRouter();
  const actions = useProjectActions();
  const current = daemon.project;
  const pinned = daemon.recentProjects.filter((p) => p.pinned);
  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;

  return (
    <Dialog open={wb.paletteOpen} onOpenChange={wb.setPaletteOpen}>
      <DialogContent className="top-[16%] w-[calc(100vw-2rem)] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-2xl border-hairline bg-popover p-0 shadow-2xl [&>button]:hidden">
        <DialogTitle className="sr-only">Switch project</DialogTitle>
        <Command className="bg-transparent" loop>
          <CommandInput
            placeholder="Switch project, open a chat, or run an action…"
            className="h-12 text-body"
          />
          <CommandList className="max-h-[min(62vh,460px)] px-1.5 pb-1.5">
            <CommandEmpty className="py-8 text-center text-ui-sm text-muted-foreground">
              Nothing matches.
            </CommandEmpty>
            {daemon.recentProjects.length ? (
              <CommandGroup heading="Projects" className="[&_[cmdk-group-heading]]:section-label">
                {daemon.recentProjects.map((p) => {
                  const isCurrent = current?.id === p.id;
                  const pinIndex = pinned.findIndex((x) => x.id === p.id);
                  const shortcut = pinIndex >= 0 ? pinnedShortcut(pinIndex) : null;
                  return (
                    <CommandItem
                      key={p.id}
                      value={`project ${p.name} ${p.root}`}
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
                          <KindBadge kind={p.kind} />
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
            {daemon.chats.length ? (
              <CommandGroup
                heading={`Chats in ${current?.name ?? "this project"}`}
                className="[&_[cmdk-group-heading]]:section-label"
              >
                {daemon.chats.slice(0, 12).map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`chat ${c.title} ${c.id}`}
                    onSelect={() => void actions.showChat(c)}
                    className={itemClass}
                  >
                    <AgentMark name={agentName(c.agentId)} />
                    <span className="min-w-0 flex-1 truncate">{c.title || "Untitled chat"}</span>
                    {c.id === daemon.activeChatId ? (
                      <Check className="size-3.5 shrink-0 text-primary" />
                    ) : (
                      <span className="shrink-0 text-meta text-muted-foreground">
                        {relativeTime(c.updatedAt)}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandSeparator className="my-1 bg-hairline" />
            <CommandGroup heading="Actions" className="[&_[cmdk-group-heading]]:section-label">
              <CommandItem value="action open folder" onSelect={() => void actions.pickFolder()} className={itemClass}>
                <FolderOpen className="size-4 text-muted-foreground" />
                Open folder…
                <kbd className="kbd ms-auto">⌘O</kbd>
              </CommandItem>
              <CommandItem value="action new project create" onSelect={actions.newProject} className={itemClass}>
                <FolderPlus className="size-4 text-muted-foreground" />
                New project…
                <kbd className="kbd ms-auto">⌘N</kbd>
              </CommandItem>
              {daemon.projectsSupported && current ? (
                <CommandItem
                  value="action new chat"
                  onSelect={actions.startChat}
                  className={itemClass}
                >
                  <MessageSquarePlus className="size-4 text-muted-foreground" />
                  New chat
                </CommandItem>
              ) : null}
              <CommandItem
                value="action all chats recent"
                onSelect={() => {
                  wb.setPaletteOpen(false);
                  void router.navigate({ to: "/chats" });
                }}
                className={cn(itemClass)}
              >
                <MessagesSquare className="size-4 text-muted-foreground" />
                All chats
              </CommandItem>
              <CommandItem
                value="action start screen home launcher"
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
            <span className="ms-auto flex items-center gap-1">
              <kbd className="kbd">esc</kbd> close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
