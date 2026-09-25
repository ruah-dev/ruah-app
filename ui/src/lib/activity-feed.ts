// Pure views of the cross-project activity feed (CONTRACTS.md §13.2) for the shell: the bell's
// unread count, the permission requests still waiting, and what goes into "Needs you".
// No React; unit-tested in ui/test/activity-feed.test.ts.
import type { ActivityEvent, ProjectActivity } from "./contracts";

/** Bell count: unread markers plus waiting permission requests, over every project. */
export function attentionCount(projects: Readonly<Record<string, ProjectActivity>>): number {
  let n = 0;
  for (const p of Object.values(projects)) n += p.unread + p.waitingPermission;
  return n;
}

/**
 * permission.requested events not yet answered: no later permission.answered with the same
 * requestId and no later turn.finished of the same turn. Newest first.
 */
export function pendingPermissions(events: readonly ActivityEvent[]): ActivityEvent[] {
  const answered = new Set<string>();
  const finishedTurns = new Set<string>();
  const out: ActivityEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "permission.answered" && e.requestId) answered.add(e.requestId);
    else if (e.kind === "turn.finished" && e.turnId) finishedTurns.add(e.turnId);
    else if (e.kind === "permission.requested" && e.requestId) {
      if (answered.has(e.requestId) || (e.turnId && finishedTurns.has(e.turnId))) continue;
      answered.add(e.requestId);
      out.push(e);
    }
  }
  return out;
}

/** Whether a turn.finished / permission event of a chat is still marked unread in `projects`. */
export function isUnread(e: ActivityEvent, projects: Readonly<Record<string, ProjectActivity>>): boolean {
  const p = projects[e.projectId];
  if (!p) return false;
  return (p.chats[e.chatId ?? "none"] ?? 0) > 0;
}

export type FeedTone = "ok" | "warn" | "bad" | "ai" | "muted";

/** Dot colour of an event in the feed. */
export function eventTone(e: ActivityEvent): FeedTone {
  switch (e.kind) {
    case "permission.requested":
      return "warn";
    case "turn.finished":
      return e.stopReason === "end_turn" ? "ok" : e.stopReason === "cancelled" ? "muted" : "bad";
    case "agent.error":
      return "bad";
    case "turn.started":
    case "map.changed":
      return "ai";
    default:
      return "muted";
  }
}

/**
 * "Needs you" (launcher, bell): waiting permission requests first, then finished background turns
 * the user has not looked at (newest first, one per chat). `max` rows.
 */
export function needsYou(
  events: readonly ActivityEvent[],
  projects: Readonly<Record<string, ProjectActivity>>,
  max = 5,
): ActivityEvent[] {
  const out = pendingPermissions(events);
  const chats = new Set(out.map((e) => `${e.projectId}:${e.chatId ?? "none"}`));
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i]!;
    if (e.kind !== "turn.finished" || !e.background) continue;
    const key = `${e.projectId}:${e.chatId ?? "none"}`;
    if (chats.has(key) || !isUnread(e, projects)) continue;
    chats.add(key);
    out.push(e);
  }
  return out.slice(0, max);
}

/** The feed as the bell lists it: newest first, without noise (turn.started, answered). */
export function feedEvents(events: readonly ActivityEvent[], max = 30): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i]!;
    if (e.kind === "turn.started" || e.kind === "permission.answered") continue;
    out.push(e);
  }
  return out;
}
