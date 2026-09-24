// src/resume/resume.ts — "where you left off" (CONTRACTS §13.4) as a library
// with no dependency on the SessionHub: everything comes from $RUAH_HOME
// (chats, state.json, activity.jsonl, projects.json) and the repo (git,
// architecture.json, `ruah task list`). Used by GET /api/projects/:id/resume
// (the daemon adds live counts) and by `ruah app resume` (no daemon needed).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActivityEvent, ProjectKind } from "../contracts/ws.js";
import type { ResumeInfo } from "../contracts/resume.js";
import { ActivityLog } from "../activity/log.js";
import { ChatStore } from "../projects/chat-store.js";
import { ProjectsStore } from "../projects/projects-store.js";
import { expandHome, projectIdFor } from "../projects/fs-util.js";
import { activeRuahTasks } from "../integrations/ruah.js";
import type { Runner } from "../integrations/exec.js";
import { gitState, type GitOptions } from "./git.js";

const PREVIEW_MAX = 200;
const SINCE_EVENTS_MAX = 20;
const SINCE_FILES_MAX = 20;
const PROJECT_ID = /^[a-f0-9]{12}$/;

export interface ResumeTarget {
  id: string;
  name: string;
  root: string;
  kind: ProjectKind;
  lastOpenedAt?: string | undefined;
}

export interface LiveCounts {
  running: number;
  waitingPermission: number;
}

export interface ResumeDeps {
  home: string;
  /** Shared stores (the daemon passes its own; the CLI gets fresh ones). */
  chats?: ChatStore;
  log?: ActivityLog;
  projects?: ProjectsStore;
  /** false = skip git. */
  git?: GitOptions | false;
  /** false = skip `ruah task list`. */
  ruah?: { runner?: Runner; bin?: string; timeoutMs?: number } | false;
}

function oneLine(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function stores(deps: ResumeDeps): { chats: ChatStore; log: ActivityLog; projects: ProjectsStore } {
  return {
    chats: deps.chats ?? new ChatStore(deps.home),
    log: deps.log ?? new ActivityLog(deps.home),
    projects: deps.projects ?? new ProjectsStore(deps.home),
  };
}

/** Name of an element in the repo's architecture.json (falls back to the id's last segment). */
function elementName(root: string, nodeId: string): string {
  try {
    const arch = JSON.parse(fs.readFileSync(path.join(root, "architecture.json"), "utf8")) as { nodes?: { id?: unknown; name?: unknown }[] };
    const node = arch.nodes?.find((n) => n.id === nodeId);
    if (node !== undefined && typeof node.name === "string") return node.name;
  } catch {
    // no (readable) architecture.json
  }
  return nodeId.split(/[/:]/).filter(Boolean).at(-1) ?? nodeId;
}

/**
 * A project by id (12 hex chars, as in projects.json) or by folder path
 * (realpath → id; a folder never opened in Ruah is still described).
 */
export function resolveProject(input: string, deps: ResumeDeps): ResumeTarget | undefined {
  const { projects } = stores(deps);
  const trimmed = input.trim();
  if (PROJECT_ID.test(trimmed)) {
    const known = projects.get(trimmed) ?? projects.lookup(trimmed);
    if (known !== undefined) return { ...known, lastOpenedAt: projects.get(trimmed)?.lastOpenedAt };
  }
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(expandHome(trimmed)));
    if (!fs.statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const id = projectIdFor(root);
  const known = projects.get(id) ?? projects.lookup(id);
  if (known !== undefined) return { ...known, lastOpenedAt: projects.get(id)?.lastOpenedAt };
  return { id, name: path.basename(root), root, kind: fs.existsSync(path.join(root, "ruah.system.json")) ? "system" : "repo" };
}

/** Summarizes activity events (oldest first) into the `since` block. */
export function summarizeSince(events: readonly ActivityEvent[], from: string | null): ResumeInfo["since"] {
  let turnsFinished = 0;
  let turnsFailed = 0;
  let permissionsRequested = 0;
  let mapChanges = 0;
  const files: string[] = [];
  for (const event of [...events].reverse()) {
    if (event.kind === "turn.finished") {
      if (event.stopReason === "error") turnsFailed += 1;
      else turnsFinished += 1;
      for (const file of event.files ?? []) if (!files.includes(file)) files.push(file);
    } else if (event.kind === "permission.requested") permissionsRequested += 1;
    else if (event.kind === "map.changed") mapChanges += event.mapChanges ?? 0;
  }
  return {
    from,
    turnsFinished,
    turnsFailed,
    permissionsRequested,
    files: files.slice(0, SINCE_FILES_MAX),
    filesTotal: files.length,
    mapChanges,
    events: events.slice(Math.max(0, events.length - SINCE_EVENTS_MAX)),
  };
}

/** §13.4 ranking: waiting permissions first, then unread, running, fresh agent work, ruah tasks, a dirty tree. */
export function attentionScore(info: Omit<ResumeInfo, "attention">): number {
  const live = info.live ?? { running: 0, waitingPermission: 0 };
  const tasks = info.ruah.initialized ? info.ruah.tasks.filter((t) => t.status === "in-progress").length : 0;
  const dirty = info.git.available && info.git.dirty > 0 ? 1 : 0;
  return live.waitingPermission * 100 + info.unread * 10 + live.running * 5 + (info.since.turnsFinished + info.since.turnsFailed) * 2 + tasks + dirty;
}

export async function computeResume(target: ResumeTarget, deps: ResumeDeps, live?: LiveCounts): Promise<ResumeInfo> {
  const { chats, log } = stores(deps);
  const state = chats.state.read(target.id);
  const lastViewedAt = state.lastViewedAt ?? null;

  const persisted = chats.activeChat(target.id);
  const list = chats.list(target.id);
  const chatId = typeof persisted === "string" ? persisted : list[0]?.id;
  const header = chatId !== undefined ? list.find((c) => c.id === chatId) : undefined;
  let lastChat: ResumeInfo["lastChat"] = null;
  if (header !== undefined) {
    const last = chats.history(target.id, header.id).at(-1);
    const texts = (last?.events ?? []).filter((e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text");
    const reply = texts.at(-1)?.text;
    lastChat = {
      id: header.id,
      title: header.title,
      agentId: header.agentId,
      updatedAt: header.updatedAt,
      turnCount: header.turnCount,
      lastPrompt: last !== undefined ? oneLine(last.text) : null,
      lastReply: reply !== undefined && reply.trim().length > 0 ? oneLine(reply) : null,
    };
  }

  const lastFocus = state.lastFocus !== undefined
    ? { nodeId: state.lastFocus.nodeId, name: elementName(target.root, state.lastFocus.nodeId), at: state.lastFocus.at }
    : null;

  const events = log.read({ projectId: target.id, ...(lastViewedAt !== null ? { since: new Date(lastViewedAt) } : {}) });
  const since = summarizeSince(events, lastViewedAt);
  const unread = Object.values(state.unread ?? {}).reduce((sum, n) => sum + n, 0);

  const [git, ruah] = await Promise.all([
    deps.git === false ? Promise.resolve({ available: false as const, reason: "skipped" }) : gitState(target.root, deps.git ?? {}),
    deps.ruah === false ? Promise.resolve({ initialized: false as const }) : activeRuahTasks(target.root, deps.ruah ?? {}),
  ]);

  const info: Omit<ResumeInfo, "attention"> = {
    project: { id: target.id, name: target.name, root: target.root, kind: target.kind, lastOpenedAt: target.lastOpenedAt ?? null },
    lastViewedAt,
    lastChat,
    lastFocus,
    since,
    unread,
    ...(live !== undefined ? { live } : {}),
    git,
    ruah,
    view: state.view ?? null,
  };
  return { ...info, attention: attentionScore(info) };
}

/** Every recent project (projects.json, folders that still exist), most in need of attention first. */
export async function resumeAll(deps: ResumeDeps, live: ReadonlyMap<string, LiveCounts> = new Map(), limit = 50): Promise<ResumeInfo[]> {
  const shared = { ...deps, ...stores(deps) };
  const recent = shared.projects.list().filter((p) => fs.existsSync(p.root)).slice(0, limit);
  const out = await Promise.all(recent.map((p) => computeResume(p, shared, live.get(p.id))));
  return out.sort((a, b) => b.attention - a.attention || (b.project.lastOpenedAt ?? "").localeCompare(a.project.lastOpenedAt ?? ""));
}
