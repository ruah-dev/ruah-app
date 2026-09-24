// src/projects/project-state.ts — small per-project state that must survive a
// daemon restart (CONTRACTS §5.5, §13.5): $RUAH_HOME/projects/<id>/state.json.
// It holds the chat that was last active in the project (reopening lands in
// the same conversation), when the user last left the project, the element
// last focused, the unread markers per chat (activity badges) and the
// viewer's opaque view state. Writes are atomic; an unreadable file counts as
// "no state"; unknown keys are kept (other features may add their own).
// One instance per process (ChatStore.state): two instances would overwrite
// each other's fields.
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./fs-util.js";

export const STATE_FILE = "state.json";
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** §13.5: the view blob, serialized, is at most this many bytes. */
export const MAX_VIEW_BYTES = 16 * 1024;
const MAX_VIEW_DEPTH = 16;
/** Unread markers kept per project (oldest dropped first). */
const MAX_UNREAD_CHATS = 200;

const ProjectStateSchema = z
  .object({
    version: z.literal(1),
    /** null = the user left the project with no chat active (e.g. deleted it). */
    activeChatId: z.string().nullable().optional(),
    /** §13.4: when the user last left the project (switch away, daemon stop). ISO. */
    lastViewedAt: z.string().optional(),
    /** §13.4: the element last focused (focus.set). */
    lastFocus: z.object({ nodeId: z.string(), at: z.string() }).optional(),
    /** §13.2: unread turns / permission requests per chat id ("none" = no chat). */
    unread: z.record(z.string(), z.number().int().nonnegative()).optional(),
    /** §13.5: viewer-owned, opaque. */
    view: z.record(z.string(), z.unknown()).optional(),
    viewUpdatedAt: z.string().optional(),
  })
  .passthrough();
export type ProjectState = z.infer<typeof ProjectStateSchema>;

/**
 * §13.5 shape check for the viewer's view state: a JSON object (not an array
 * or null), at most MAX_VIEW_BYTES serialized, nested at most 16 deep.
 * Returns why it is refused, or undefined when it is fine.
 */
export function checkView(view: unknown): string | undefined {
  if (view === null || typeof view !== "object" || Array.isArray(view)) return "view must be a JSON object";
  let json: string;
  try {
    json = JSON.stringify(view);
  } catch {
    return "view is not serializable";
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_VIEW_BYTES) return `view is ${bytes} bytes (max ${MAX_VIEW_BYTES})`;
  const depth = (value: unknown, level: number): number => {
    if (value === null || typeof value !== "object") return level;
    let max = level + 1;
    for (const child of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, depth(child, level + 1));
      if (max > MAX_VIEW_DEPTH) break;
    }
    return max;
  };
  if (depth(view, 0) > MAX_VIEW_DEPTH) return `view is nested deeper than ${MAX_VIEW_DEPTH} levels`;
  return undefined;
}

export class ProjectStateStore {
  private readonly cache = new Map<string, ProjectState>();

  constructor(
    readonly home: string,
    private readonly options: { onError?: (line: string) => void; now?: () => Date } = {},
  ) {}

  file(projectId: string): string {
    return path.join(this.home, "projects", projectId, STATE_FILE);
  }

  read(projectId: string): ProjectState {
    if (!PROJECT_ID.test(projectId)) return { version: 1 };
    const cached = this.cache.get(projectId);
    if (cached !== undefined) return cached;
    let state: ProjectState = { version: 1 };
    try {
      const parsed = ProjectStateSchema.safeParse(JSON.parse(fs.readFileSync(this.file(projectId), "utf8")));
      if (parsed.success) state = parsed.data;
    } catch {
      // no state yet, or a corrupt file (replaced on the next write)
    }
    this.cache.set(projectId, state);
    return state;
  }

  /** Forgets cached state (another process, e.g. the CLI, may have written it). */
  reload(projectId?: string): void {
    if (projectId === undefined) this.cache.clear();
    else this.cache.delete(projectId);
  }

  /** The persisted active chat: a chat id, null (explicitly none), or undefined (never recorded). */
  activeChat(projectId: string): string | null | undefined {
    return this.read(projectId).activeChatId;
  }

  setActiveChat(projectId: string, chatId: string | null): void {
    if (this.read(projectId).activeChatId === chatId) return;
    this.write(projectId, (s) => ({ ...s, activeChatId: chatId }));
  }

  // ----- §13 -----

  setLastViewed(projectId: string, at: string = this.now()): void {
    this.write(projectId, (s) => ({ ...s, lastViewedAt: at }));
  }

  setFocus(projectId: string, nodeId: string | null): void {
    const current = this.read(projectId).lastFocus;
    if (nodeId === null || current?.nodeId === nodeId) return;
    this.write(projectId, (s) => ({ ...s, lastFocus: { nodeId: nodeId.slice(0, 512), at: this.now() } }));
  }

  unread(projectId: string): Record<string, number> {
    return { ...(this.read(projectId).unread ?? {}) };
  }

  addUnread(projectId: string, chatKey: string): void {
    this.write(projectId, (s) => {
      const unread = { ...(s.unread ?? {}) };
      unread[chatKey] = (unread[chatKey] ?? 0) + 1;
      const keys = Object.keys(unread);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_UNREAD_CHATS))) delete unread[key];
      return { ...s, unread };
    });
  }

  /** Clears one chat's marker, or every marker of the project. True when something changed. */
  clearUnread(projectId: string, chatKey?: string): boolean {
    const unread = this.read(projectId).unread ?? {};
    if (chatKey !== undefined ? (unread[chatKey] ?? 0) === 0 : Object.keys(unread).length === 0) return false;
    this.write(projectId, (s) => {
      if (chatKey === undefined) {
        const { unread: _drop, ...rest } = s;
        return rest as ProjectState;
      }
      const next = { ...(s.unread ?? {}) };
      delete next[chatKey];
      return { ...s, unread: next };
    });
    return true;
  }

  view(projectId: string): { view: Record<string, unknown> | null; updatedAt: string | null } {
    const state = this.read(projectId);
    return { view: state.view ?? null, updatedAt: state.viewUpdatedAt ?? null };
  }

  /** Stores the viewer's view state; returns why it was refused (checkView), else undefined. */
  setView(projectId: string, view: unknown): string | undefined {
    if (!PROJECT_ID.test(projectId)) return "invalid project id";
    const problem = checkView(view);
    if (problem !== undefined) return problem;
    this.write(projectId, (s) => ({ ...s, view: view as Record<string, unknown>, viewUpdatedAt: this.now() }));
    return undefined;
  }

  // ----- internals -----

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private write(projectId: string, change: (state: ProjectState) => ProjectState): void {
    if (!PROJECT_ID.test(projectId)) return;
    const next: ProjectState = { ...change(this.read(projectId)), version: 1 };
    this.cache.set(projectId, next);
    try {
      atomicWriteFileSync(this.file(projectId), `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`${this.file(projectId)} write failed: ${(err as Error).message}`);
    }
  }
}
