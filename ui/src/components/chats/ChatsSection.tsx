// Sidebar "Chats" for the current project (§5.2): new chat, list with agent mark, title and
// relative time, inline rename (double-click or menu), delete with confirmation.
import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import type { ChatInfo } from "@/lib/contracts";
import { deleteChat, renameChat } from "@/lib/daemon";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { VirtualList } from "@/components/common/VirtualList";
import { AgentMark } from "@/components/agent/ComposerControls";
import { CollapsibleSection } from "@/components/shell/CollapsibleSection";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ROW_H = 30;

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
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
        e.stopPropagation();
      }}
      maxLength={80}
      className="h-6 min-w-0 flex-1 rounded-md bg-surface-3 px-1.5 text-ui text-foreground outline-none ring-1 ring-ring"
    />
  );
}

export function ChatsSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ChatInfo | null>(null);
  const chats = daemon.chats;
  const running = daemon.turns.some((t) => !t.stopReason);
  const showingChat = pathname === "/agent" || pathname === "/map";

  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;

  const newButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="New chat"
          onClick={() => {
            actions.startChat();
            onNavigate?.();
          }}
          className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">New chat</TooltipContent>
    </Tooltip>
  );

  return (
    <>
      <CollapsibleSection id="chats" label="Chats" count={chats.length} action={newButton}>
        {chats.length === 0 ? (
          <div className="px-2 pt-0.5 pb-1">
            <p className="text-label leading-relaxed text-faint">
              No chats yet. Select an element and ask about it — each conversation is kept here.
            </p>
          </div>
        ) : (
          <VirtualList
            items={chats}
            itemHeight={ROW_H}
            getKey={(c) => c.id}
            className="max-h-[min(38vh,340px)]"
            role="list"
            aria-label="Chats"
            renderItem={(c) => {
              const active = c.id === daemon.activeChatId && showingChat;
              const live = c.id === daemon.activeChatId && running;
              return (
                <div
                  role="listitem"
                  data-active={active}
                  className="group/chat list-row relative h-[calc(100%-2px)] pe-1"
                  title={`${c.title}\n${agentName(c.agentId)} · ${c.turnCount} turns · ${absoluteTime(c.updatedAt)}`}
                >
                  {renaming === c.id ? (
                    <>
                      <AgentMark name={agentName(c.agentId)} />
                      <RenameInput chat={c} onDone={() => setRenaming(null)} />
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void actions.showChat(c);
                          onNavigate?.();
                        }}
                        onDoubleClick={() => setRenaming(c.id)}
                        className="absolute inset-0 rounded-md"
                        aria-label={`Open chat ${c.title}`}
                        aria-current={active ? "true" : undefined}
                      />
                      <AgentMark name={agentName(c.agentId)} className="pointer-events-none" />
                      <span className="pointer-events-none min-w-0 flex-1 truncate">
                        {c.title || "Untitled chat"}
                      </span>
                      {live ? (
                        <span className="pointer-events-none size-1.5 shrink-0 animate-pulse rounded-full bg-ai" />
                      ) : null}
                      <span className="pointer-events-none shrink-0 text-meta text-faint group-hover/chat:hidden group-has-[[data-state=open]]/chat:hidden">
                        {relativeTime(c.updatedAt)}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`Chat actions for ${c.title}`}
                          className="relative hidden size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover/chat:grid data-[state=open]:grid"
                        >
                          <MoreHorizontal className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" side="right" className="w-40">
                          <DropdownMenuItem onSelect={() => setRenaming(c.id)} className="text-ui">
                            <Pencil className="text-muted-foreground" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setConfirm(c)}
                            className="text-ui text-bad focus:text-bad"
                          >
                            <Trash2 /> Delete…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              );
            }}
          />
        )}
      </CollapsibleSection>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="max-w-sm rounded-xl border-hairline bg-popover p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-title">Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription className="text-ui">
              “{confirm?.title || "Untitled chat"}” and its {confirm?.turnCount ?? 0}{" "}
              {confirm?.turnCount === 1 ? "turn" : "turns"} are removed from this project. Files
              the agent changed stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg border-hairline bg-transparent text-ui">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn("h-8 rounded-lg bg-destructive text-ui text-destructive-foreground hover:bg-destructive/90")}
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
