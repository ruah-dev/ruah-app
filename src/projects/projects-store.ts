// src/projects/projects-store.ts — the recent-projects list in
// $RUAH_HOME/projects.json (CONTRACTS §5.3) plus a per-project
// $RUAH_HOME/projects/<id>/project.json (so chat listings can name a project
// even after it was forgotten from the recent list). Every change rewrites the
// file atomically; an unreadable file counts as empty and is replaced on the
// next change.
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ProjectInfoSchema, type ProjectInfo, type ProjectKind } from "../contracts/ws.js";
import { atomicWriteFileSync } from "./fs-util.js";

export const PROJECTS_FILE = "projects.json";
/** Unpinned entries beyond this are dropped (oldest first). */
export const MAX_RECENT_PROJECTS = 50;

const ProjectsFileSchema = z.object({ version: z.literal(1), projects: z.array(ProjectInfoSchema) });

export interface ProjectIdentity {
  id: string;
  name: string;
  root: string;
  kind: ProjectKind;
}

/** Pinned first, then most recently opened. */
export function sortProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((a, b) => {
    const pin = Number(b.pinned === true) - Number(a.pinned === true);
    if (pin !== 0) return pin;
    return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
  });
}

export class ProjectsStore {
  readonly file: string;

  constructor(
    readonly home: string,
    private readonly options: { now?: () => Date; onError?: (line: string) => void } = {},
  ) {
    this.file = path.join(home, PROJECTS_FILE);
  }

  /** Project data dir: $RUAH_HOME/projects/<id>. */
  projectDir(id: string): string {
    return path.join(this.home, "projects", id);
  }

  list(): ProjectInfo[] {
    return sortProjects(this.read());
  }

  get(id: string): ProjectInfo | undefined {
    return this.read().find((p) => p.id === id);
  }

  /** Any project ever opened (recent list first, then project.json in its data dir). */
  lookup(id: string): ProjectIdentity | undefined {
    const recent = this.get(id);
    if (recent !== undefined) return recent;
    try {
      const parsed = ProjectInfoSchema.safeParse(JSON.parse(fs.readFileSync(path.join(this.projectDir(id), "project.json"), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Upserts the project with lastOpenedAt = now (keeps `pinned`), returns the stored entry. */
  touch(identity: ProjectIdentity): ProjectInfo {
    const projects = this.read();
    const existing = projects.find((p) => p.id === identity.id);
    const info: ProjectInfo = {
      id: identity.id,
      name: identity.name,
      root: identity.root,
      kind: identity.kind,
      lastOpenedAt: (this.options.now?.() ?? new Date()).toISOString(),
      ...(existing?.pinned === true ? { pinned: true } : {}),
    };
    const next = [info, ...projects.filter((p) => p.id !== identity.id)];
    this.write(this.cap(next));
    try {
      atomicWriteFileSync(path.join(this.projectDir(info.id), "project.json"), `${JSON.stringify(info, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`project.json write failed: ${(err as Error).message}`);
    }
    return info;
  }

  /** false = unknown id. */
  pin(id: string, pinned: boolean): boolean {
    const projects = this.read();
    const index = projects.findIndex((p) => p.id === id);
    const entry = projects[index];
    if (entry === undefined) return false;
    const { pinned: _drop, ...rest } = entry;
    projects[index] = pinned ? { ...rest, pinned: true } : rest;
    this.write(projects);
    return true;
  }

  /** Removes the project from the recent list only (its chats stay on disk). false = unknown id. */
  forget(id: string): boolean {
    const projects = this.read();
    const next = projects.filter((p) => p.id !== id);
    if (next.length === projects.length) return false;
    this.write(next);
    return true;
  }

  private cap(projects: ProjectInfo[]): ProjectInfo[] {
    const sorted = sortProjects(projects);
    const pinned = sorted.filter((p) => p.pinned === true);
    const rest = sorted.filter((p) => p.pinned !== true).slice(0, Math.max(0, MAX_RECENT_PROJECTS - pinned.length));
    return [...pinned, ...rest];
  }

  private read(): ProjectInfo[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = ProjectsFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data.projects;
      this.options.onError?.(`${this.file} is not a valid projects file; treating it as empty`);
    } catch {
      this.options.onError?.(`${this.file} is not valid JSON; treating it as empty`);
    }
    return [];
  }

  private write(projects: ProjectInfo[]): void {
    atomicWriteFileSync(this.file, `${JSON.stringify({ version: 1, projects: sortProjects(projects) }, null, 2)}\n`);
  }
}
