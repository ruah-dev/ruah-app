// src/engines/opt.ts — ruah-opt usage summary of $RUAH_HOME/usage.jsonl.
import * as fs from "node:fs";
import * as path from "node:path";
import { ruahHome } from "../usage/log.js";
import { resolveEngineInvocation, runEngineJson, type EngineCliDeps } from "./cli.js";

export interface OptUsageReport {
  ok?: boolean;
  schemaVersion?: string;
  source: string;
  records: number;
  summary: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    durationMs: number;
    unpricedTurns: number;
  };
  topSpenders: Array<{ by: string; key: string; turns: number; tokens: number; costUsd: number }>;
  waste: Array<{ signal: string; detail: string; tokens: number }>;
  suggestions: string[];
  error?: string;
}

export function usageLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ruahHome(env), "usage.jsonl");
}

function emptyReport(source: string): OptUsageReport {
  return {
    ok: true,
    schemaVersion: "1",
    source,
    records: 0,
    summary: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
      unpricedTurns: 0,
    },
    topSpenders: [],
    waste: [],
    suggestions: ["No usage recorded yet. Finish an agent turn and run Optimize again."],
  };
}

export async function runOptUsage(options: {
  deps?: EngineCliDeps;
  env?: NodeJS.ProcessEnv;
  /** Override the log path (the app passes $RUAH_HOME/usage.jsonl). */
  file?: string;
}): Promise<{ ok: true; data: OptUsageReport } | { ok: false; status: number; error: string }> {
  const env = options.env ?? options.deps?.env ?? process.env;
  const deps = options.deps ?? {};
  if (resolveEngineInvocation("opt", { ...deps, env }) === null) {
    return {
      ok: false,
      status: 424,
      error: "ruah opt is not installed. npm i -g @ruah-dev/cli @ruah-dev/opt",
    };
  }
  const file = options.file ?? usageLogPath(env);
  if (!fs.existsSync(file)) return { ok: true, data: emptyReport(file) };
  const result = await runEngineJson<OptUsageReport>("opt", ["usage", file], {
    cwd: path.dirname(file),
    deps: { ...deps, env },
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  if (result.data.ok === false) {
    return { ok: false, status: 502, error: result.data.error ?? "ruah opt usage failed" };
  }
  return { ok: true, data: result.data };
}
