// Cross-project activity feed (CONTRACTS.md §13.2) as a useSyncExternalStore store, fed by
// daemon.ts from the `activity`, `activity.project` and `activity.snapshot` frames every viewer
// receives whatever project is open. Also decides when a desktop notification is shown (§13.3):
// a background turn finished or asks for permission while the window is unfocused or its project
// is not the open one (settings.json `notifications`: "background" | "always" | "off").
// No imports from daemon.ts (daemon.ts imports this module).
import { useSyncExternalStore } from "react";
import type {
  ActivityEvent,
  AppFeatures,
  ProjectActivity,
  ServerMessage,
} from "./contracts";

export const ACTIVITY_RECENT_MAX = 200;

export interface ActivityState {
  /** True once the daemon sent an activity.snapshot (older daemons never do). */
  supported: boolean;
  /** Per project id; projects without running / waiting / unread are absent. */
  projects: Record<string, ProjectActivity>;
  /** Newest last. */
  recent: ActivityEvent[];
  settings: AppFeatures;
  maxBackgroundTurns: number;
}

const INITIAL: ActivityState = {
  supported: false,
  projects: {},
  recent: [],
  settings: { backgroundAgents: true, notifications: "background" },
  maxBackgroundTurns: 0,
};

let state: ActivityState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<ActivityState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activityState(): ActivityState {
  return state;
}

function upsert(project: ProjectActivity): Record<string, ProjectActivity> {
  const next = { ...state.projects };
  if (project.running > 0 || project.waitingPermission > 0 || project.unread > 0) next[project.projectId] = project;
  else delete next[project.projectId];
  return next;
}

/** What the viewer shows right now (for the notification decision). */
export interface ViewerContext {
  currentProjectId: string | null;
  activeChatId: string | null;
}

/** §13.3: whether this event deserves an OS notification. */
export function shouldNotify(
  event: ActivityEvent,
  mode: AppFeatures["notifications"],
  ctx: ViewerContext & { focused: boolean },
): boolean {
  if (mode === "off") return false;
  if (event.kind !== "turn.finished" && event.kind !== "permission.requested") return false;
  if (mode === "always") return true;
  return event.background || !ctx.focused || event.projectId !== ctx.currentProjectId;
}

function notificationTitle(event: ActivityEvent): string {
  if (event.kind === "permission.requested") return `${event.projectName}: permission needed`;
  switch (event.stopReason) {
    case "end_turn":
      return `${event.projectName}: agent finished`;
    case "error":
      return `${event.projectName}: agent failed`;
    case "cancelled":
      return `${event.projectName}: turn cancelled`;
    default:
      return `${event.projectName}: agent stopped`;
  }
}

function maybeNotify(event: ActivityEvent, ctx: ViewerContext) {
  if (typeof window === "undefined") return;
  const bridge = window.ruah;
  if (!bridge?.notify) return;
  let focused = true;
  try {
    focused = document.hasFocus();
  } catch {
    // no document (tests)
  }
  if (!shouldNotify(event, state.settings.notifications, { ...ctx, focused })) return;
  void bridge
    .notify({
      title: notificationTitle(event),
      body: event.summary,
      projectId: event.projectId,
      chatId: event.chatId,
      ...(event.projectRoot ? { projectRoot: event.projectRoot } : {}),
    })
    .catch(() => {});
}

/** Handles an activity frame (true) or ignores anything else (false). Called by daemon.ts. */
export function handleActivityMessage(msg: ServerMessage, ctx: ViewerContext): boolean {
  switch (msg.type) {
    case "activity.snapshot": {
      const projects: Record<string, ProjectActivity> = {};
      for (const p of msg.projects) projects[p.projectId] = p;
      set({
        supported: true,
        projects,
        recent: msg.recent.slice(-ACTIVITY_RECENT_MAX),
        settings: msg.settings,
        maxBackgroundTurns: msg.maxBackgroundTurns,
      });
      return true;
    }
    case "activity": {
      const recent = [...state.recent, msg.event];
      set({
        projects: upsert(msg.project),
        recent: recent.length > ACTIVITY_RECENT_MAX ? recent.slice(-ACTIVITY_RECENT_MAX) : recent,
      });
      maybeNotify(msg.event, ctx);
      return true;
    }
    case "activity.project":
      set({ projects: upsert(msg.project) });
      return true;
    default:
      return false;
  }
}

/** Optimistic local clear (the daemon confirms with activity.project). */
export function clearUnreadLocally(projectId: string, chatId?: string) {
  const current = state.projects[projectId];
  if (!current) return;
  const chats = { ...current.chats };
  if (chatId === undefined) for (const key of Object.keys(chats)) delete chats[key];
  else delete chats[chatId];
  const unread = Object.values(chats).reduce((sum, n) => sum + n, 0);
  set({ projects: upsert({ ...current, chats, unread }) });
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useActivity(): ActivityState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** One project's counts (undefined = nothing running, waiting or unread). */
export function useProjectActivity(projectId: string | null | undefined): ProjectActivity | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? state.projects[projectId] : undefined),
    () => undefined,
  );
}
