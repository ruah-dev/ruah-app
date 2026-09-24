// src/activity/log.ts — the persisted activity feed (CONTRACTS §13.2):
// $RUAH_HOME/activity.jsonl, one ActivityEvent per line, appended by the
// daemon and read by `ruah app activity` / `ruah app resume` with or without
// a daemon running. The file is compacted to the newest KEEP_EVENTS lines once
// it grows past MAX_BYTES (atomic rewrite). Unparseable lines are skipped.
import * as fs from "node:fs";
import * as path from "node:path";
import { ActivityEventSchema, type ActivityEvent } from "../contracts/ws.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";

export const ACTIVITY_FILE = "activity.jsonl";
export const ACTIVITY_MAX_BYTES = 1024 * 1024;
export const ACTIVITY_KEEP_EVENTS = 2000;
/** Events kept in memory for snapshots (the newest). */
const MEMORY_EVENTS = 500;

export interface ActivityQuery {
  /** Only events at or after this instant. */
  since?: Date;
  projectId?: string;
  /** The newest `limit` events (after filtering). */
  limit?: number;
}

/** "90s", "30m", "24h", "7d", "2w" → milliseconds; undefined when it does not parse. */
export function parseDuration(input: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?\s*$/i.exec(input);
  if (match === null) return undefined;
  const value = Number.parseFloat(match[1] ?? "");
  const unit = (match[2] ?? "h").toLowerCase();
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 3_600_000;
  const out = value * ms;
  return Number.isFinite(out) && out >= 0 ? out : undefined;
}

/** A `since` given as an ISO timestamp or a duration back from `now`. */
export function parseSince(input: string, now: Date = new Date()): Date | undefined {
  const duration = parseDuration(input);
  if (duration !== undefined) return new Date(now.getTime() - duration);
  const at = Date.parse(input);
  return Number.isNaN(at) ? undefined : new Date(at);
}

export class ActivityLog {
  readonly file: string;
  private memory: ActivityEvent[] | undefined;
  private appendsSinceCheck = 0;

  constructor(
    readonly home: string,
    private readonly options: { onError?: (line: string) => void; maxBytes?: number; keep?: number } = {},
  ) {
    this.file = path.join(home, ACTIVITY_FILE);
  }

  append(event: ActivityEvent): void {
    const memory = this.loaded();
    memory.push(event);
    if (memory.length > MEMORY_EVENTS) memory.splice(0, memory.length - MEMORY_EVENTS);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
      this.appendsSinceCheck += 1;
      if (this.appendsSinceCheck >= 50) {
        this.appendsSinceCheck = 0;
        this.compact();
      }
    } catch (err) {
      this.options.onError?.(`${this.file} write failed: ${(err as Error).message}`);
    }
  }

  /** The newest events kept in memory (this process's view; read() goes to disk). */
  recent(limit: number, projectId?: string): ActivityEvent[] {
    const list = projectId === undefined ? this.loaded() : this.loaded().filter((e) => e.projectId === projectId);
    return list.slice(Math.max(0, list.length - limit));
  }

  /** Events from disk, oldest first. */
  read(query: ActivityQuery = {}): ActivityEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const since = query.since?.getTime();
    const out: ActivityEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed;
      try {
        parsed = ActivityEventSchema.safeParse(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const event = parsed.data;
      if (query.projectId !== undefined && event.projectId !== query.projectId) continue;
      if (since !== undefined && Date.parse(event.at) < since) continue;
      out.push(event);
    }
    return query.limit !== undefined ? out.slice(Math.max(0, out.length - query.limit)) : out;
  }

  /** Rewrites the file with the newest events once it is too big. */
  compact(): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size <= (this.options.maxBytes ?? ACTIVITY_MAX_BYTES)) return;
    const keep = this.read().slice(-(this.options.keep ?? ACTIVITY_KEEP_EVENTS));
    try {
      atomicWriteFileSync(this.file, keep.map((e) => `${JSON.stringify(e)}\n`).join(""));
    } catch (err) {
      this.options.onError?.(`${this.file} compaction failed: ${(err as Error).message}`);
    }
  }

  private loaded(): ActivityEvent[] {
    this.memory ??= this.read({ limit: MEMORY_EVENTS });
    return this.memory;
  }
}
