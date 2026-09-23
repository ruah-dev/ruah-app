// src/projects/project-state.ts — small per-project state that must survive a
// daemon restart (CONTRACTS §5.5): $RUAH_HOME/projects/<id>/state.json.
// Today it holds the chat that was last active in the project, so reopening
// the project (after a switch or a restart) lands in the same conversation.
// Writes are atomic; an unreadable file counts as "no state".
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./fs-util.js";

export const STATE_FILE = "state.json";
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const ProjectStateSchema = z.object({
  version: z.literal(1),
  /** null = the user left the project with no chat active (e.g. deleted it). */
  activeChatId: z.string().nullable().optional(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export class ProjectStateStore {
  private readonly cache = new Map<string, ProjectState>();

  constructor(
    readonly home: string,
    private readonly options: { onError?: (line: string) => void } = {},
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

  /** The persisted active chat: a chat id, null (explicitly none), or undefined (never recorded). */
  activeChat(projectId: string): string | null | undefined {
    return this.read(projectId).activeChatId;
  }

  setActiveChat(projectId: string, chatId: string | null): void {
    if (!PROJECT_ID.test(projectId)) return;
    const current = this.read(projectId);
    if (current.activeChatId === chatId) return;
    const next: ProjectState = { ...current, version: 1, activeChatId: chatId };
    this.cache.set(projectId, next);
    try {
      atomicWriteFileSync(this.file(projectId), `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`${this.file(projectId)} write failed: ${(err as Error).message}`);
    }
  }
}
