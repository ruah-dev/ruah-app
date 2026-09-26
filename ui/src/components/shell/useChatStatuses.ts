// Status of the open project's chats (running / waiting / done / failed + unread) for the chat
// strip and the Advanced sidebar's Chats section: lib/recent-chats.ts over the activity feed and
// the live turns of the chat in front.
import { useMemo } from "react";
import { useActivity } from "@/lib/activity";
import { chatsProjectId } from "@/lib/daemon";
import { chatStatuses, type ChatRunState, type ChatStatus } from "@/lib/recent-chats";
import { useWorkspace } from "@/lib/workspace";

export function useChatStatuses(): Map<string, ChatStatus> {
  const { daemon } = useWorkspace();
  const activity = useActivity();
  const projectId = chatsProjectId(daemon) ?? daemon.project?.id ?? null;
  const project = projectId ? activity.projects[projectId] : undefined;
  return useMemo(
    () =>
      projectId
        ? chatStatuses({
            chatIds: daemon.chats.map((c) => c.id),
            projectId,
            events: activity.recent,
            activity: project,
            activeChatId: daemon.activeChatId,
            activeTurns: daemon.turns,
          })
        : new Map<string, ChatStatus>(),
    [projectId, daemon.chats, daemon.activeChatId, daemon.turns, activity.recent, project],
  );
}

export const CHAT_DOT: Record<ChatRunState, string> = {
  running: "animate-pulse bg-ai motion-reduce:animate-none",
  waiting: "bg-warn",
  done: "bg-ok",
  failed: "bg-bad",
  stopped: "bg-faint",
  idle: "bg-faint/40",
};
