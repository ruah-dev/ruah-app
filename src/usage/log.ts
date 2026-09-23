// src/usage/log.ts — the append-only usage log: one JSON line per finished
// turn in ~/.ruah/usage.jsonl ($RUAH_HOME overrides ~/.ruah), shared by every
// daemon on the machine (all repos). Appends are single O_APPEND writes of one
// short line; reads stream the file and skip lines that do not parse (a
// partial last line from a crash, hand edits).
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { StopReason } from "../contracts/ws.js";

export const USAGE_LOG_FILE = "usage.jsonl";

/** One line of usage.jsonl (v1). */
export interface UsageRecord {
  v: 1;
  /** ISO time the turn finished. */
  ts: string;
  repoRoot: string;
  agentId: string;
  model: string;
  turnId: string;
  stopReason: StopReason;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Agent-reported estimate; null when the agent reported no cost. */
  costUsd: number | null;
  /** Who produced costUsd: always the agent today (Claude reports an API-equivalent estimate even on a subscription). */
  costSource: "agent" | null;
  durationMs: number;
  /** Architecture element the turn was scoped to, when known. */
  nodeId?: string;
}

export function ruahHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RUAH_HOME?.trim();
  return override !== undefined && override.length > 0 ? path.resolve(override) : path.join(env.HOME ?? homedir(), ".ruah");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A parsed line, or undefined when it is not a usable v1 record. */
export function parseUsageLine(line: string): UsageRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || typeof r.ts !== "string" || Number.isNaN(Date.parse(r.ts))) return undefined;
  if (typeof r.agentId !== "string" || typeof r.model !== "string") return undefined;
  if (!isCount(r.inputTokens) || !isCount(r.outputTokens)) return undefined;
  return {
    v: 1,
    ts: r.ts,
    repoRoot: typeof r.repoRoot === "string" ? r.repoRoot : "",
    agentId: r.agentId,
    model: r.model,
    turnId: typeof r.turnId === "string" ? r.turnId : "",
    stopReason: (typeof r.stopReason === "string" ? r.stopReason : "end_turn") as StopReason,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: isCount(r.cacheReadTokens) ? r.cacheReadTokens : 0,
    cacheWriteTokens: isCount(r.cacheWriteTokens) ? r.cacheWriteTokens : 0,
    costUsd: isCount(r.costUsd) ? r.costUsd : null,
    costSource: r.costSource === "agent" ? "agent" : null,
    durationMs: isCount(r.durationMs) ? r.durationMs : 0,
    ...(typeof r.nodeId === "string" && r.nodeId.length > 0 ? { nodeId: r.nodeId } : {}),
  };
}

export class UsageLog {
  readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private checkedTail = false;

  constructor(readonly dir: string) {
    this.file = path.join(dir, USAGE_LOG_FILE);
  }

  /** Appends one record. Appends from this process are serialized; the dir is created on first use (0700). */
  append(record: UsageRecord): Promise<void> {
    const next = this.queue.then(() => this.write(record));
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(record: UsageRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let prefix = "";
    if (!this.checkedTail) {
      // A crash can leave a partial last line; start ours on a fresh line so
      // only the broken one is lost.
      prefix = (await this.endsWithoutNewline()) ? "\n" : "";
      this.checkedTail = true;
    }
    await appendFile(this.file, `${prefix}${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async endsWithoutNewline(): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.file, "r");
      const { size } = await handle.stat();
      if (size === 0) return false;
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0] !== 0x0a;
    } catch {
      return false; // missing file
    } finally {
      await handle?.close();
    }
  }

  /** Streams every readable record in file order; a missing file yields nothing. */
  async *records(): AsyncGenerator<UsageRecord> {
    await this.queue;
    const stream = createReadStream(this.file, { encoding: "utf8" });
    const opened = await new Promise<boolean>((resolve, reject) => {
      stream.once("open", () => resolve(true));
      stream.once("error", (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? resolve(false) : reject(err)));
    });
    if (!opened) return;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const record = parseUsageLine(line);
        if (record !== undefined) yield record;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}
