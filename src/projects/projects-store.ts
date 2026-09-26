// src/projects/projects-store.ts — the recent-projects list in
// $RUAH_HOME/projects.json (CONTRACTS §5.3) plus a per-project
// $RUAH_HOME/projects/<id>/project.json (so chat listings can name a project
// even after it was forgotten from the recent list). Every change rewrites the
// file atomically; an unreadable file counts as empty and is replaced on the
// next change.
//
// §20: pinned projects keep an explicit order (`pinOrder`, 0 = ⌘1): a new pin
// goes last, opening a project never moves it, POST /api/projects/reorder sets
// it. Registries written before §20 (pins without `pinOrder`) are migrated on
// read — the pins get the order they were listed in (last opened first) — and
// the order is saved with the next change. `tags` are free-form groups.
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

/** Longest tag and most tags a project keeps (§20). */
export const TAG_MAX_LENGTH = 40;
export const MAX_TAGS = 6;

/**
 * §20 tags: control characters removed, whitespace collapsed, ≤ 40 chars each,
 * duplicates (ignoring case) dropped, at most 6, empty ones skipped.
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    // eslint-disable-next-line no-control-regex
    const tag = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, TAG_MAX_LENGTH).trim();
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const byRecent = (a: ProjectInfo, b: ProjectInfo): number => b.lastOpenedAt.localeCompare(a.lastOpenedAt);

/**
 * Pinned first in their explicit order (`pinOrder`; pins without one follow, most
 * recently opened first), then the rest most recently opened first.
 */
export function sortProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((a, b) => {
    const pin = Number(b.pinned === true) - Number(a.pinned === true);
    if (pin !== 0) return pin;
    if (a.pinned === true) {
      const order = (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER);
      if (order !== 0) return order;
    }
    return byRecent(a, b);
  });
}

/**
 * The stored shape: pinned projects numbered 0…n-1 in sorted order (the §20
 * migration for pins without `pinOrder`), no order fields on unpinned ones, no
 * empty tag lists.
 */
export function normalizeProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  let next = 0;
  return sortProjects(projects).map((p) => {
    const { pinned: _p, pinOrder: _o, pinnedAt, tags, ...rest } = p;
    const cleanTags = tags !== undefined ? normalizeTags(tags) : [];
    const tagged = cleanTags.length > 0 ? { tags: cleanTags } : {};
    if (p.pinned !== true) return { ...rest, ...tagged };
    return { ...rest, pinned: true, pinOrder: next++, ...(pinnedAt !== undefined ? { pinnedAt } : {}), ...tagged };
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

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /**
   * Upserts the project with lastOpenedAt = now, returns the stored entry. Keeps
   * `pinned`, its place among the pins (`pinOrder`, §20) and `tags`.
   */
  touch(identity: ProjectIdentity): ProjectInfo {
    const projects = this.read();
    const existing = projects.find((p) => p.id === identity.id);
    const info: ProjectInfo = {
      id: identity.id,
      name: identity.name,
      root: identity.root,
      kind: identity.kind,
      lastOpenedAt: this.now(),
      ...(existing?.pinned === true
        ? { pinned: true, ...(existing.pinOrder !== undefined ? { pinOrder: existing.pinOrder } : {}), ...(existing.pinnedAt !== undefined ? { pinnedAt: existing.pinnedAt } : {}) }
        : {}),
      ...(existing?.tags !== undefined && existing.tags.length > 0 ? { tags: existing.tags } : {}),
    };
    const next = [info, ...projects.filter((p) => p.id !== identity.id)];
    this.write(this.cap(next));
    try {
      // project.json names the project for chat listings; order fields belong to the recent list only.
      const { pinned: _p, pinOrder: _o, pinnedAt: _a, ...identityOnly } = info;
      atomicWriteFileSync(path.join(this.projectDir(info.id), "project.json"), `${JSON.stringify(identityOnly, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`project.json write failed: ${(err as Error).message}`);
    }
    return info;
  }

  /** false = unknown id. A new pin goes last (the next ⌘ number); pinning a pinned project keeps its place. */
  pin(id: string, pinned: boolean): boolean {
    const projects = this.read();
    const index = projects.findIndex((p) => p.id === id);
    const entry = projects[index];
    if (entry === undefined) return false;
    if (pinned && entry.pinned === true) return true;
    const { pinned: _drop, pinOrder: _order, pinnedAt: _at, ...rest } = entry;
    const last = projects.reduce((max, p) => (p.pinned === true ? Math.max(max, p.pinOrder ?? -1) : max), -1);
    projects[index] = pinned ? { ...rest, pinned: true, pinOrder: last + 1, pinnedAt: this.now() } : rest;
    this.write(projects);
    return true;
  }

  /**
   * §20: the pinned projects' order. `ids` first (ids that are not pinned or not
   * known are ignored), then the pins it leaves out in their current order.
   * Returns the sorted list.
   */
  reorder(ids: readonly string[]): ProjectInfo[] {
    const projects = this.read();
    const pinned = sortProjects(projects).filter((p) => p.pinned === true);
    const pinnedIds = new Set(pinned.map((p) => p.id));
    const listed = [...new Set(ids)].filter((id) => pinnedIds.has(id));
    const order = [...listed, ...pinned.map((p) => p.id).filter((id) => !listed.includes(id))];
    const rank = new Map(order.map((id, i) => [id, i]));
    const next = projects.map((p) => (p.pinned === true ? { ...p, pinOrder: rank.get(p.id) ?? order.length } : p));
    if (next.some((p, i) => p.pinOrder !== projects[i]?.pinOrder)) this.write(next);
    return sortProjects(next);
  }

  /** §20: replaces a project's tags (normalizeTags; [] removes them). Undefined = unknown id. */
  setTags(id: string, tags: readonly string[]): ProjectInfo | undefined {
    const projects = this.read();
    const index = projects.findIndex((p) => p.id === id);
    const entry = projects[index];
    if (entry === undefined) return undefined;
    const clean = normalizeTags(tags);
    const { tags: _old, ...rest } = entry;
    const next: ProjectInfo = clean.length > 0 ? { ...rest, tags: clean } : rest;
    projects[index] = next;
    this.write(projects);
    return next;
  }

  /**
   * Every tag in use, most used first (ties: alphabetical). Spellings that differ
   * only in case count as one, shown in the spelling most projects use.
   */
  tags(): string[] {
    const counts = new Map<string, { n: number; spellings: Map<string, number> }>();
    for (const p of this.read()) {
      for (const tag of p.tags ?? []) {
        const key = tag.toLowerCase();
        const hit = counts.get(key) ?? { n: 0, spellings: new Map<string, number>() };
        hit.n += 1;
        hit.spellings.set(tag, (hit.spellings.get(tag) ?? 0) + 1);
        counts.set(key, hit);
      }
    }
    return [...counts.values()]
      .map((c) => ({ n: c.n, tag: [...c.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "" }))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
      .map((c) => c.tag);
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
      // §20 migration: pins without an explicit order get the order they are listed in.
      if (parsed.success) return normalizeProjects(parsed.data.projects);
      this.options.onError?.(`${this.file} is not a valid projects file; treating it as empty`);
    } catch {
      this.options.onError?.(`${this.file} is not valid JSON; treating it as empty`);
    }
    return [];
  }

  private write(projects: ProjectInfo[]): void {
    atomicWriteFileSync(this.file, `${JSON.stringify({ version: 1, projects: normalizeProjects(projects) }, null, 2)}\n`);
  }
}
