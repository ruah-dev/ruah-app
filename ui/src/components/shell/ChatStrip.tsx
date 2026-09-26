// The project's recent chats, always in view (Standard layout): one row of chips under the agent
// panel's header and the Agent page's header — status dot (working / waiting / done / failed),
// title (bold when unread), click to open, "New" (⌘N). As many as fit the width, 1…5, the chat
// in front always among them (lib/recent-chats.ts). The Advanced layout lists chats in its
// sidebar instead, so the strip steps aside there.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { prefetchChat } from "@/lib/daemon";
import { CHAT_STATE_LABEL, stripCapacity, stripChats } from "@/lib/recent-chats";
import { relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useShellLayout } from "./layout";
import { CHAT_DOT, useChatStatuses } from "./useChatStatuses";

export function ChatStrip({ className }: { className?: string }) {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const layout = useShellLayout();
  const statuses = useChatStatuses();
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);

  const hidden =
    layout.effective === "advanced" ||
    !daemon.projectsSupported ||
    !daemon.project ||
    // Nothing to switch to: no chat besides the one in front.
    daemon.chats.every((c) => c.id === daemon.activeChatId);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);

  if (hidden) return null;
  const chats = stripChats(daemon.chats, daemon.activeChatId, stripCapacity(width));
  const agentName = (id: string) => daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;

  return (
    <div
      ref={box}
      role="toolbar"
      aria-label="Recent chats"
      className={cn("flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2", className)}
    >
      {chats.map((c) => {
        const st = statuses.get(c.id) ?? { state: "idle" as const, unread: 0 };
        const active = c.id === daemon.activeChatId;
        const title = c.title || "Untitled chat";
        const stateLabel = CHAT_STATE_LABEL[st.state];
        return (
          <Tooltip key={c.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                aria-label={`${active ? "Current chat" : "Open chat"}: ${title}${stateLabel ? ` — ${stateLabel}` : ""}${st.unread ? `, ${st.unread} unread` : ""}`}
                onClick={() => {
                  if (!active) void actions.showChat({ id: c.id, projectId: c.projectId });
                }}
                onMouseEnter={() => {
                  if (active) return;
                  clearTimeout(hover.current);
                  hover.current = setTimeout(() => void prefetchChat(c.projectId, c.id), 80);
                }}
                onMouseLeave={() => clearTimeout(hover.current)}
                className={cn(
                  "flex h-6 max-w-44 min-w-0 grow basis-0 items-center gap-1.5 rounded-md px-2 text-[12px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
                  active
                    ? "bg-accent text-foreground"
                    : st.unread > 0
                      ? "font-medium text-foreground hover:bg-accent/60"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", CHAT_DOT[st.state])} />
                <span className="min-w-0 truncate">{title}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-80">
              <span className="block font-medium">{title}</span>
              <span className="block text-muted-foreground">
                {[stateLabel, st.unread ? `${st.unread} unread` : "", agentName(c.agentId), relativeTime(c.updatedAt)].filter(Boolean).join(" · ")}
              </span>
              {active ? <span className="block text-muted-foreground">⌘[ ⌘] previous / next chat</span> : null}
            </TooltipContent>
          </Tooltip>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={actions.startChat}
            aria-label="New chat"
            className="ms-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
            New
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          New chat <span className="ms-1 text-muted-foreground">⌘N</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
