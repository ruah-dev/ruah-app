// The open project's recent chats as the shell shows them without opening a menu (the agent
// panel's chat strip, the Advanced sidebar's Chats section): which chats, and the status dot of
// each (running / waiting / done / failed) from the cross-project activity feed (§13.2) plus the
// live turn of the chat in front. No React; unit-tested in ui/test/recent-chats.test.ts.
import type { ActivityEvent, ProjectActivity, StopReason } from "./contracts";
import { pendingPermissions } from "./activity-feed";

export type ChatRunState = "running" | "waiting" | "done" | "failed" | "stopped" | "idle";

export interface ChatStatus {
  state: ChatRunState;
  /** Unread markers of this chat (finished or asked while you looked elsewhere). */
  unread: number;
}

export const CHAT_STATE_LABEL: Record<ChatRunState, string> = {
  running: "Agent working",
  waiting: "Waiting for your permission",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "",
};

function finishedState(stopReason: StopReason | undefined): ChatRunState {
  if (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests") return "done";
  if (stopReason === "cancelled") return "stopped";
  if (stopReason === "error" || stopReason === "refusal") return "failed";
  return "stopped";
}

/**
 * Last known state per chat of `projectId`, from the feed (oldest first, as the store keeps it).
 * A permission request counts as waiting only while it is unanswered.
 */
export function chatStatesFromFeed(events: readonly ActivityEvent[], projectId: string): Map<string, ChatRunState> {
  const pending = new Set(pendingPermissions(events).map((e) => e.id));
  const out = new Map<string, ChatRunState>();
  for (const e of events) {
    if (e.projectId !== projectId || !e.chatId) continue;
    switch (e.kind) {
      case "turn.started":
      case "permission.answered":
        out.set(e.chatId, "running");
        break;
      case "permission.requested":
        out.set(e.chatId, pending.has(e.id) ? "waiting" : "running");
        break;
      case "turn.finished":
        out.set(e.chatId, finishedState(e.stopReason));
        break;
      case "agent.error":
        out.set(e.chatId, "failed");
        break;
      default:
        break;
    }
  }
  return out;
}

/** The chat in front, from its turns (the freshest source): null = no turn yet. */
export function liveChatState(turns: readonly { stopReason?: StopReason | undefined; permission?: unknown }[]): ChatRunState | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  if (!last.stopReason) return last.permission ? "waiting" : "running";
  return finishedState(last.stopReason);
}

/** Status of every chat of the project: feed state, the live turn for the active chat, unread. */
export function chatStatuses(input: {
  chatIds: readonly string[];
  projectId: string;
  events: readonly ActivityEvent[];
  activity: Pick<ProjectActivity, "chats"> | undefined;
  activeChatId: string | null;
  activeTurns: readonly { stopReason?: StopReason | undefined; permission?: unknown }[];
}): Map<string, ChatStatus> {
  const feed = chatStatesFromFeed(input.events, input.projectId);
  const out = new Map<string, ChatStatus>();
  for (const id of input.chatIds) {
    const live = id === input.activeChatId ? liveChatState(input.activeTurns) : null;
    out.set(id, { state: live ?? feed.get(id) ?? "idle", unread: input.activity?.chats[id] ?? 0 });
  }
  return out;
}

/**
 * The chats a strip shows: the `max` most recently updated, always including the active chat
 * (it takes the last place when it is older). Keeps the list's own order otherwise.
 */
export function stripChats<T extends { id: string; updatedAt: string }>(
  chats: readonly T[],
  activeChatId: string | null,
  max: number,
): T[] {
  if (max <= 0) return [];
  const sorted = [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const top = sorted.slice(0, max);
  if (activeChatId && !top.some((c) => c.id === activeChatId)) {
    const active = sorted.find((c) => c.id === activeChatId);
    if (active) top.splice(top.length - 1, 1, active);
  }
  return top;
}

/**
 * Chips that fit in a strip `widthPx` wide (each at least ~100 px, the "New" button reserved),
 * 1…5: three in the agent panel's default width, five on the Agent page.
 */
export function stripCapacity(widthPx: number, chip = 100, reserved = 64): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 3;
  return Math.max(1, Math.min(5, Math.floor((widthPx - reserved) / chip)));
}
