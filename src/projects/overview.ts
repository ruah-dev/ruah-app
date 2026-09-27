// src/projects/overview.ts — every recent project at a glance (CONTRACTS §20.5,
// GET /api/projects/overview): the Home page's cards in ONE batched answer.
//
// Cheap on purpose (the Home page asks whenever activity changes): the activity
// log is read once per answer and grouped per project; git runs at most 4 repos
// at a time and gitState() caches each repo for 5 s; a chat's last prompt /
// reply is re-read only when the chat's updatedAt moves; cloud health comes from
// the project's cloud cache (no provider call) scoped with the §14 library,
// cached 30 s per project; the whole static part is cached a few seconds. Live
// parts (running / waiting counts, pending permissions, preview states) come
// from the daemon on every call.
import { productSummary } from "../product/summary.js";
import * as fs from "node:fs";
import type { ActivityEvent, PermissionOption, ProjectInfo } from "../contracts/ws.js";
import type { OverviewCloud, ProjectOverview, ProjectsOverview } from "../contracts/overview.js";
import type { PreviewState } from "../contracts/preview.js";
import type { ActivityLog } from "../activity/log.js";
import { summarizeSince } from "../resume/resume.js";
import { gitState, type GitOptions } from "../resume/git.js";
import { applyScope, loadScopeUnits, SignalsCache } from "../integrations/scope/index.js";
import { CloudCacheStore } from "../integrations/store.js";
import type { ChatStore } from "./chat-store.js";
import type { ProjectsStore } from "./projects-store.js";

export const OVERVIEW_DEFAULT_LIMIT = 24;
export const OVERVIEW_MAX_LIMIT = 50;
const STATIC_TTL_MS = 4000;
const CLOUD_TTL_MS = 30_000;
const GIT_CONCURRENCY = 4;
const PREVIEW_MAX = 200;
const EVENT_KINDS = new Set(["turn.finished", "permission.requested", "agent.error"]);

export interface LiveCounts {
  running: number;
  waitingPermission: number;
}

export interface PendingPermission {
  projectId: string;
  chatId: string | null;
  turnId: string;
  requestId: string;
  title: string;
  options: PermissionOption[];
}

export interface OverviewSources {
  home: string;
  projects: ProjectsStore;
  chats: ChatStore;
  /** `recent` (in memory) tells when something happened since the cached answer. */
  log: Pick<ActivityLog, "read"> & Partial<Pick<ActivityLog, "recent">>;
  /** The open project (null: launcher). */
  current?: () => ProjectInfo | null;
  live?: () => ReadonlyMap<string, LiveCounts>;
  permissions?: () => readonly PendingPermission[];
  preview?: (projectId: string) => { state: PreviewState; url: string | null; exitCode: number | null } | null;
  /** false = no cloud health (tests); default: the project's cloud cache, scoped (§14). */
  cloud?: false | ((root: string) => OverviewCloud | null);
  git?: GitOptions | false;
  now?: () => number;
}

function oneLine(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type StaticPart = Omit<ProjectOverview, "current" | "live" | "permissions" | "preview">;

/** Cloud health of a project from its cached snapshot, in the §14 scope; null = nothing synced / in scope. */
export function cloudHealthFromCache(root: string, cache: CloudCacheStore, signals: SignalsCache): OverviewCloud | null {
  const snapshot = cache.read(root);
  if (snapshot.resources.length === 0) return null;
  const units = loadScopeUnits(root, { signals: (r, names) => signals.get(r, names) });
  const scoped = applyScope({ units, resources: snapshot.resources, nodes: [], manualLinks: snapshot.manualLinks }).filter((r) => r.scope?.in === true);
  if (scoped.length === 0) return null;
  const counts = { healthy: 0, degraded: 0, down: 0, deploying: 0 };
  for (const r of scoped) {
    if (r.health === "healthy") counts.healthy += 1;
    else if (r.health === "degraded") counts.degraded += 1;
    else if (r.health === "down") counts.down += 1;
    else if (r.health === "deploying") counts.deploying += 1;
  }
  const unhealthy = [...scoped.filter((r) => r.health === "down"), ...scoped.filter((r) => r.health === "degraded")].slice(0, 5).map((r) => r.name);
  return { inScope: scoped.length, ...counts, unhealthy, syncedAt: snapshot.syncedAt };
}

export class ProjectOverviewService {
  private staticCache: { at: number; limit: number; marker: string | undefined; value: StaticPart[] } | undefined;
  private inflight: Promise<StaticPart[]> | undefined;
  private readonly chatPreview = new Map<string, { updatedAt: string; lastPrompt: string | null; lastReply: string | null }>();
  private readonly cloudCache = new Map<string, { at: number; value: OverviewCloud | null }>();
  private readonly cloudStore: CloudCacheStore;
  private readonly signals = new SignalsCache(CLOUD_TTL_MS);

  constructor(private readonly sources: OverviewSources) {
    this.cloudStore = new CloudCacheStore(sources.home);
  }

  /** Forget the cached static part (a project's chats / git changed a moment ago). */
  invalidate(): void {
    this.staticCache = undefined;
  }

  async overview(limit = OVERVIEW_DEFAULT_LIMIT): Promise<ProjectsOverview> {
    const n = Math.min(Math.max(1, Math.floor(limit)), OVERVIEW_MAX_LIMIT);
    const now = this.now();
    let parts: StaticPart[];
    const cached = this.staticCache;
    // The newest activity event: a turn that finished since the cached answer makes it stale.
    const marker = this.sources.log.recent?.(1)[0]?.id;
    if (cached !== undefined && cached.limit === n && cached.marker === marker && now - cached.at < STATIC_TTL_MS) parts = cached.value;
    else {
      this.inflight ??= this.computeStatic(n).finally(() => {
        this.inflight = undefined;
      });
      parts = await this.inflight;
      this.staticCache = { at: this.now(), limit: n, marker, value: parts };
    }
    const current = this.sources.current?.() ?? null;
    const live = this.sources.live?.() ?? new Map<string, LiveCounts>();
    const permissions = this.sources.permissions?.() ?? [];
    const projects: ProjectOverview[] = parts.map((part) => {
      const id = part.project.id;
      const preview = this.sources.preview?.(id) ?? null;
      return {
        ...part,
        // The open project's info is the freshest (name after a rescan, pins).
        project: current !== null && current.id === id ? { ...part.project, name: current.name } : part.project,
        current: current !== null && current.id === id,
        live: live.get(id) ?? { running: 0, waitingPermission: 0 },
        permissions: permissions
          .filter((p) => p.projectId === id)
          .map(({ projectId: _p, ...rest }) => rest),
        preview: preview !== null && preview.state !== "stopped" ? preview : null,
      };
    });
    return { at: new Date(now).toISOString(), projects };
  }

  private now(): number {
    return this.sources.now?.() ?? Date.now();
  }

  private async computeStatic(limit: number): Promise<StaticPart[]> {
    const recent = this.sources.projects.list().filter((p) => fs.existsSync(p.root)).slice(0, limit);
    const byProject = new Map<string, ActivityEvent[]>();
    for (const event of this.sources.log.read()) {
      const list = byProject.get(event.projectId);
      if (list !== undefined) list.push(event);
      else byProject.set(event.projectId, [event]);
    }
    return mapLimit(recent, GIT_CONCURRENCY, (p) => this.projectPart(p, byProject.get(p.id) ?? []));
  }

  private async projectPart(project: ProjectInfo, events: ActivityEvent[]): Promise<StaticPart> {
    const { chats } = this.sources;
    const state = chats.state.read(project.id);
    const lastViewedAt = state.lastViewedAt ?? null;
    const since = summarizeSince(lastViewedAt !== null ? events.filter((e) => e.at >= lastViewedAt) : events, lastViewedAt);
    const lastEvent = [...events].reverse().find((e) => EVENT_KINDS.has(e.kind)) ?? null;
    const unread = Object.values(state.unread ?? {}).reduce((sum, n) => sum + n, 0);

    const list = chats.list(project.id);
    const persisted = chats.activeChat(project.id);
    const chatId = typeof persisted === "string" && list.some((c) => c.id === persisted) ? persisted : list[0]?.id;
    const header = chatId !== undefined ? list.find((c) => c.id === chatId) : undefined;
    let lastChat: ProjectOverview["lastChat"] = null;
    if (header !== undefined) {
      const key = `${project.id}/${header.id}`;
      let preview = this.chatPreview.get(key);
      if (preview === undefined || preview.updatedAt !== header.updatedAt) {
        const last = chats.history(project.id, header.id).at(-1);
        const texts = (last?.events ?? []).filter((e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text");
        const reply = (texts.at(-1)?.text ?? "").trim();
        preview = { updatedAt: header.updatedAt, lastPrompt: last !== undefined ? oneLine(last.text) : null, lastReply: reply.length > 0 ? oneLine(reply) : null };
        this.chatPreview.set(key, preview);
      }
      lastChat = {
        id: header.id,
        title: header.title,
        agentId: header.agentId,
        updatedAt: header.updatedAt,
        turnCount: header.turnCount,
        lastPrompt: preview.lastPrompt,
        lastReply: preview.lastReply,
      };
    }

    const git = this.sources.git === false ? { available: false as const, reason: "skipped" } : await gitState(project.root, this.sources.git ?? {});
    return {
      project,
      exists: true,
      lastViewedAt,
      lastChat,
      since: {
        from: since.from,
        turnsFinished: since.turnsFinished,
        turnsFailed: since.turnsFailed,
        permissionsRequested: since.permissionsRequested,
        filesTotal: since.filesTotal,
        mapChanges: since.mapChanges,
      },
      lastEvent,
      unread,
      git,
      cloud: this.cloud(project.root),
      product: productSummary(project.root),
    };
  }

  private cloud(root: string): OverviewCloud | null {
    const source = this.sources.cloud;
    if (source === false) return null;
    const hit = this.cloudCache.get(root);
    if (hit !== undefined && this.now() - hit.at < CLOUD_TTL_MS) return hit.value;
    let value: OverviewCloud | null = null;
    try {
      value = source !== undefined ? source(root) : cloudHealthFromCache(root, this.cloudStore, this.signals);
    } catch {
      value = null; // a broken cache or scope file must not break the Home page
    }
    this.cloudCache.set(root, { at: this.now(), value });
    return value;
  }
}
