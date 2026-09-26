// src/serve/activity.ts — the cross-project activity feed (CONTRACTS §13.2).
// The SessionHub reports what agents do (turn started / finished, permission
// requested / answered, agent error, map changed); this service keeps the
// live counts per project (running turns, waiting permissions), the unread
// markers (persisted in each project's state.json, so badges survive
// restarts), appends every event to $RUAH_HOME/activity.jsonl and broadcasts
// `activity` frames to every viewer whatever project it has open. It knows
// nothing about bridges or sockets: the hub passes a broadcast function.
import { randomUUID } from "node:crypto";
import type { ActivityEvent, AppFeatures, ProjectActivity, ServerMessage, StopReason, TurnRecord } from "../contracts/ws.js";
import type { ActivityLog } from "../activity/log.js";
import type { ProjectStateStore } from "../projects/project-state.js";
import { DEFAULT_FEATURES } from "../projects/settings-store.js";
import type { LiveCounts } from "../resume/resume.js";

/** Default cap on turns running in projects that are not open (§13.1). */
export const DEFAULT_MAX_BACKGROUND_TURNS = 3;
/** Events in activity.snapshot.recent. */
const SNAPSHOT_EVENTS = 50;
const SUMMARY_MAX = 200;
/** Unread markers use this key for turns that have no chat (chats disabled). */
export const NO_CHAT_KEY = "none";

/** Tool kinds whose locations count as "files the agent edited". */
const EDIT_KINDS = new Set(["edit", "delete", "move"]);
const MAX_EDITED_FILES = 20;
/**
 * Files a turn's edit / delete / move tool calls changed, in order, at most 20.
 * Only tool calls that completed count: a proposed edit (its diff is streamed
 * with the permission request) that was denied, failed or never ran because the
 * turn was cancelled leaves the file untouched, so it is not an "edited file".
 * A diff counts when its tool call completed.
 */
export function editedFiles(record: TurnRecord): string[] {
  const finalStatus = new Map<string, string>();
  for (const event of record.events) {
    if (event.kind === "tool_call" || event.kind === "tool_result") finalStatus.set(event.toolCall.toolCallId, event.toolCall.status);
  }
  const completed = (toolCallId: string): boolean => finalStatus.get(toolCallId) === "completed";
  const out: string[] = [];
  const add = (file: string): void => {
    if (file.length > 0 && !out.includes(file) && out.length < MAX_EDITED_FILES) out.push(file);
  };
  for (const event of record.events) {
    if (event.kind === "diff") {
      if (completed(event.toolCallId)) add(event.path);
    } else if ((event.kind === "tool_call" || event.kind === "tool_result") && EDIT_KINDS.has(event.toolCall.kind) && completed(event.toolCall.toolCallId)) {
      for (const location of event.toolCall.locations) add(location.path);
    }
  }
  return out;
}

/** Who an event is about: a turn of a project (chat and turn optional for agent errors). */
export interface ActivityContext {
  projectId: string;
  projectName: string;
  projectRoot?: string | undefined;
  chatId: string | null;
  turnId?: string | undefined;
  agentId?: string | undefined;
  /** The user's prompt (summaries quote its start). */
  prompt?: string | undefined;
}

export interface ActivityServiceOptions {
  log: ActivityLog;
  /** Unread markers and last-viewed times (share ChatStore.state: one instance per process). */
  state: ProjectStateStore;
  /** Name and root of a project that has no live activity (snapshot of unread-only projects). */
  lookup?: (projectId: string) => { name: string; root: string } | undefined;
  /** Projects whose unread markers the snapshot reports (the recent list). */
  projectIds?: () => readonly string[];
  features?: () => AppFeatures;
  maxBackgroundTurns?: number;
  now?: () => Date;
}

function oneLine(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function quote(prompt: string | undefined): string {
  return prompt !== undefined && prompt.trim().length > 0 ? ` "${oneLine(prompt, 80)}"` : "";
}

const STOP_WORDS: Record<StopReason, string> = {
  end_turn: "Finished",
  max_tokens: "Stopped (output limit)",
  max_turn_requests: "Stopped (turn limit)",
  refusal: "Refused",
  cancelled: "Cancelled",
  error: "Failed",
};

export class ActivityService {
  private broadcast: (message: ServerMessage) => void = () => {};
  /** projectId → turnId → context. */
  private readonly running = new Map<string, Map<string, ActivityContext>>();
  /** projectId → requestId → context. */
  private readonly waiting = new Map<string, Map<string, ActivityContext>>();
  private readonly known = new Map<string, { name: string; root: string | undefined }>();
  private readonly lastEventAt = new Map<string, string>();

  constructor(private readonly options: ActivityServiceOptions) {}

  /** Where `activity` / `activity.snapshot` frames go (the hub's broadcast). */
  attach(broadcast: (message: ServerMessage) => void): void {
    this.broadcast = broadcast;
  }

  get log(): ActivityLog {
    return this.options.log;
  }

  features(): AppFeatures {
    return this.options.features?.() ?? DEFAULT_FEATURES;
  }

  maxBackgroundTurns(): number {
    return this.options.maxBackgroundTurns ?? DEFAULT_MAX_BACKGROUND_TURNS;
  }

  // ---------- what the hub reports ----------

  turnStarted(ctx: ActivityContext, background: boolean): void {
    if (ctx.turnId !== undefined) this.bucket(this.running, ctx.projectId).set(ctx.turnId, ctx);
    this.emit(ctx, { kind: "turn.started", summary: `${ctx.agentId ?? "Agent"} started${quote(ctx.prompt)}`, background }, false);
  }

  turnFinished(
    ctx: ActivityContext,
    result: { stopReason: StopReason; error?: string | undefined; files?: string[]; mapChanges?: number },
    background: boolean,
  ): void {
    if (ctx.turnId !== undefined) this.running.get(ctx.projectId)?.delete(ctx.turnId);
    const waiting = this.waiting.get(ctx.projectId);
    for (const [requestId, other] of [...(waiting?.entries() ?? [])]) if (other.turnId === ctx.turnId) waiting?.delete(requestId);
    const files = result.files ?? [];
    const extra = [
      files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} edited` : "",
      (result.mapChanges ?? 0) > 0 ? `${result.mapChanges} map change${result.mapChanges === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const error = result.stopReason === "error" && result.error !== undefined ? `: ${result.error}` : "";
    const summary = `${STOP_WORDS[result.stopReason] ?? result.stopReason}${quote(ctx.prompt)}${error}${extra.length > 0 ? ` · ${extra.join(", ")}` : ""}`;
    this.emit(
      ctx,
      {
        kind: "turn.finished",
        summary,
        background,
        stopReason: result.stopReason,
        ...(result.error !== undefined ? { error: oneLine(result.error, 500) } : {}),
        ...(files.length > 0 ? { files: files.slice(0, 20) } : {}),
        ...((result.mapChanges ?? 0) > 0 ? { mapChanges: result.mapChanges } : {}),
      },
      background,
    );
  }

  permissionRequested(ctx: ActivityContext, requestId: string, title: string, background: boolean): void {
    this.bucket(this.waiting, ctx.projectId).set(requestId, ctx);
    this.emit(ctx, { kind: "permission.requested", summary: `Needs permission: ${title}`, background, requestId }, background);
  }

  permissionAnswered(ctx: ActivityContext, requestId: string, answer: string, background: boolean): void {
    if (this.waiting.get(ctx.projectId)?.delete(requestId) !== true) return;
    this.emit(ctx, { kind: "permission.answered", summary: `Permission ${answer}`, background, requestId }, false);
  }

  agentError(ctx: ActivityContext, message: string, background: boolean): void {
    this.emit(ctx, { kind: "agent.error", summary: `${ctx.agentId ?? "Agent"} error: ${message}`, background, error: oneLine(message, 500) }, false);
  }

  mapChanged(ctx: ActivityContext, names: readonly string[], background: boolean): void {
    if (names.length === 0) return;
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3}` : "";
    this.emit(
      ctx,
      { kind: "map.changed", summary: `Map: ${names.length} change${names.length === 1 ? "" : "s"} (${shown}${more})`, background, mapChanges: names.length },
      false,
    );
  }

  // ---------- viewing ----------

  /** The user looked at the chat (or the whole project): its unread marker goes. Broadcasts the new counts. */
  markRead(projectId: string, chatId?: string | null): void {
    const key = chatId === undefined ? undefined : (chatId ?? NO_CHAT_KEY);
    if (this.options.state.clearUnread(projectId, key)) this.broadcast({ type: "activity.project", project: this.projectActivity(projectId) });
  }

  /** The user left the project (switch, daemon stop): resume's "since you left" starts here. */
  markViewed(projectId: string): void {
    this.options.state.setLastViewed(projectId, this.now());
  }

  // ---------- reading ----------

  projectActivity(projectId: string): ProjectActivity {
    const chats = this.options.state.unread(projectId);
    const known = this.known.get(projectId) ?? this.lookup(projectId);
    const lastEventAt = this.lastEventAt.get(projectId);
    return {
      projectId,
      projectName: known?.name ?? projectId,
      ...(known?.root !== undefined ? { projectRoot: known.root } : {}),
      running: this.running.get(projectId)?.size ?? 0,
      waitingPermission: this.waiting.get(projectId)?.size ?? 0,
      unread: Object.values(chats).reduce((sum, n) => sum + n, 0),
      chats,
      ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    };
  }

  /** Projects with anything to show (live turns, waiting permissions, unread markers). */
  projects(): ProjectActivity[] {
    const ids = new Set<string>([...this.running.keys(), ...this.waiting.keys(), ...(this.options.projectIds?.() ?? [])]);
    return [...ids].map((id) => this.projectActivity(id)).filter((p) => p.running > 0 || p.waitingPermission > 0 || p.unread > 0);
  }

  liveCounts(): Map<string, LiveCounts> {
    const out = new Map<string, LiveCounts>();
    for (const id of new Set([...this.running.keys(), ...this.waiting.keys()])) {
      out.set(id, { running: this.running.get(id)?.size ?? 0, waitingPermission: this.waiting.get(id)?.size ?? 0 });
    }
    return out;
  }

  snapshotMessage(): Extract<ServerMessage, { type: "activity.snapshot" }> {
    return {
      type: "activity.snapshot",
      projects: this.projects(),
      recent: this.options.log.recent(SNAPSHOT_EVENTS),
      settings: this.features(),
      maxBackgroundTurns: this.maxBackgroundTurns(),
    };
  }

  broadcastSnapshot(): void {
    this.broadcast(this.snapshotMessage());
  }

  // ---------- internals ----------

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private lookup(projectId: string): { name: string; root: string } | undefined {
    try {
      return this.options.lookup?.(projectId);
    } catch {
      return undefined;
    }
  }

  private bucket<T>(map: Map<string, Map<string, T>>, projectId: string): Map<string, T> {
    let inner = map.get(projectId);
    if (inner === undefined) {
      inner = new Map();
      map.set(projectId, inner);
    }
    return inner;
  }

  private emit(
    ctx: ActivityContext,
    fields: Pick<ActivityEvent, "kind" | "summary" | "background"> & Partial<ActivityEvent>,
    countUnread: boolean,
  ): void {
    this.known.set(ctx.projectId, { name: ctx.projectName, root: ctx.projectRoot ?? this.known.get(ctx.projectId)?.root });
    const at = this.now();
    const event: ActivityEvent = {
      ...fields,
      id: randomUUID(),
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      ...(ctx.projectRoot !== undefined ? { projectRoot: ctx.projectRoot } : {}),
      chatId: ctx.chatId,
      ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
      ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      summary: oneLine(fields.summary),
      at,
    };
    this.lastEventAt.set(ctx.projectId, at);
    if (countUnread) this.options.state.addUnread(ctx.projectId, ctx.chatId ?? NO_CHAT_KEY);
    this.options.log.append(event);
    this.broadcast({ type: "activity", event, project: this.projectActivity(ctx.projectId) });
  }
}
