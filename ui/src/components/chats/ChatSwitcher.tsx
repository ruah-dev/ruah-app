// Compact chat switcher for the Agent page header and the Map's chat panel: the current chat's
// title (double-click to rename inline) opening a dropdown with this project's chats (search,
// ↑↓ + Enter, hover prefetch), "New chat" (⌘N) and ⌘[ / ⌘] hints.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, MessageSquarePlus, MessagesSquare, Pencil } from "lucide-react";
import type { ChatInfo } from "@/lib/contracts";
import { prefetchChat, renameChat } from "@/lib/daemon";
import { relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { AgentMark } from "@/components/agent/ComposerControls";
import { Phantom } from "@/components/brand/Phantom";
import { useProjectActions } from "@/components/projects/useProjectActions";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { groupByDate } from "@/lib/switching";
import { cn } from "@/lib/utils";

const itemClass = "gap-2 rounded-md px-2 py-1.5 text-ui data-[selected=true]:bg-accent";
const SEP = "⁣";

function InlineRename({ chat, onDone, className }: { chat: ChatInfo; onDone: () => void; className?: string }) {
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
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
      className={cn(
        "h-7 min-w-0 rounded-md bg-surface-3 px-2 text-ui text-foreground outline-none ring-1 ring-ring",
        className,
      )}
    />
  );
}

export function ChatSwitcher({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!daemon.projectsSupported || !daemon.project) return null;
  const chat = daemon.chats.find((c) => c.id === daemon.activeChatId);
  const running = daemon.turns.some((t) => !t.stopReason);
  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;
  const title = chat ? chat.title || "Untitled chat" : "New chat";
  const groups = groupByDate(daemon.chats, (c) => c.updatedAt);
  const byValue = new Map<string, ChatInfo>();
  daemon.chats.forEach((c, i) => byValue.set(`${c.title || "Untitled chat"}${SEP}${i}`, c));
  const indexOf = new Map(daemon.chats.map((c, i) => [c.id, i]));

  if (renaming && chat) {
    return <InlineRename chat={chat} onDone={() => setRenaming(false)} className={cn(compact ? "w-44" : "w-72", className)} />;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Chat: ${title} — switch chat`}
          title={`${title}\nSwitch chat · ⌘[ ⌘] previous / next · double-click to rename`}
          onDoubleClick={(e) => {
            if (!chat) return;
            e.preventDefault();
            setOpen(false);
            setRenaming(true);
          }}
          className={cn(
            "group/cs flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent",
            compact ? "max-w-[13rem]" : "max-w-[28rem]",
            className,
          )}
        >
          {chat ? <AgentMark name={agentName(chat.agentId)} className="size-4 text-[8px]" /> : <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className={cn("min-w-0 truncate", compact ? "text-ui-sm" : "text-ui font-medium", chat ? "text-foreground" : "text-muted-foreground")}>
            {title}
          </span>
          {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ai" /> : null}
          <ChevronDown className="size-3 shrink-0 text-faint group-hover/cs:text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-80 overflow-hidden rounded-xl border-hairline p-0">
        <Command
          loop
          className="bg-transparent"
          onValueChange={(v) => {
            clearTimeout(timer.current);
            const c = byValue.get(v);
            if (c && daemon.project) {
              const projectId = daemon.project.id;
              timer.current = setTimeout(() => void prefetchChat(projectId, c.id), 80);
            }
          }}
        >
          <CommandInput placeholder={`Search ${daemon.chats.length} chats…`} className="h-10 text-ui" />
          <CommandList className="max-h-[min(52vh,380px)] p-1">
            <CommandEmpty className="flex flex-col items-center gap-2 py-6 text-center text-ui-sm text-muted-foreground">
              <Phantom expression="thinking" size="sm" />
              No chat matches.
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={`New chat${SEP}new`}
                onSelect={() => {
                  setOpen(false);
                  actions.startChat();
                }}
                className={itemClass}
              >
                <MessageSquarePlus className="size-4 text-muted-foreground" />
                New chat
                <kbd className="kbd ms-auto">⌘N</kbd>
              </CommandItem>
              {chat ? (
                <CommandItem
                  value={`Rename this chat${SEP}rename`}
                  onSelect={() => {
                    setOpen(false);
                    setRenaming(true);
                  }}
                  className={itemClass}
                >
                  <Pencil className="size-4 text-muted-foreground" />
                  Rename this chat
                </CommandItem>
              ) : null}
            </CommandGroup>
            {groups.map((g) => (
              <CommandGroup key={g.label} heading={g.label} className="[&_[cmdk-group-heading]]:section-label">
                {g.items.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.title || "Untitled chat"}${SEP}${indexOf.get(c.id)}`}
                    keywords={[agentName(c.agentId)]}
                    onSelect={() => {
                      setOpen(false);
                      void actions.showChat({ id: c.id, projectId: c.projectId });
                    }}
                    className={itemClass}
                  >
                    <AgentMark name={agentName(c.agentId)} className="size-4 text-[8px]" />
                    <span className={cn("min-w-0 flex-1 truncate", c.id === daemon.activeChatId && "font-medium text-foreground")}>
                      {c.title || "Untitled chat"}
                    </span>
                    <span className="shrink-0 text-meta text-faint">
                      {c.id === daemon.activeChatId ? "current" : relativeTime(c.updatedAt)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandSeparator className="my-1 bg-hairline" />
            <CommandItem
              value={`All chats in every project${SEP}all`}
              onSelect={() => {
                setOpen(false);
                void router.navigate({ to: "/chats" });
              }}
              className={itemClass}
            >
              <MessagesSquare className="size-4 text-muted-foreground" />
              All chats…
            </CommandItem>
          </CommandList>
          <div className="flex items-center gap-1 border-t border-hairline px-2.5 py-1.5 text-meta whitespace-nowrap text-muted-foreground">
            <kbd className="kbd">⌘[</kbd>
            <kbd className="kbd">⌘]</kbd>
            <span className="ms-0.5">prev / next</span>
            <span className="ms-auto">double-click title to rename</span>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
