// src/usage/index.ts — usage tracking: the SessionHub reports every finished
// turn and every streamed rate-limit reading here (UsageSink); the HTTP
// endpoints read the summary (aggregated from usage.jsonl on each request)
// and the limits.
import type { RateLimitSample, TurnUsage } from "../acp/bridge.js";
import type { UsageLimits, UsageRange, UsageSummary } from "../contracts/usage.js";
import type { StopReason } from "../contracts/ws.js";
import { UsageLog, type UsageRecord } from "./log.js";
import { summarizeUsage } from "./summary.js";
import type { UsageLimitsService } from "./limits.js";

export { UsageLog, ruahHome, parseUsageLine, type UsageRecord } from "./log.js";
export { summarizeUsage } from "./summary.js";
export { UsageLimitsService, type UsageLimitsDeps, type LimitsAgent } from "./limits.js";

export interface FinishedTurn {
  repoRoot: string;
  agentId: string;
  /** Fallback when the agent's usage names no model (the picker's current model). */
  model: string | undefined;
  turnId: string;
  stopReason: StopReason;
  usage: TurnUsage | undefined;
  /** Wall time from prompt to turn_finished, used when the agent reports no duration. */
  elapsedMs: number;
  /** Architecture element the turn was scoped to, when known. */
  nodeId?: string;
}

/** What the SessionHub needs (tests pass fakes). */
export interface UsageSink {
  recordTurn(turn: FinishedTurn): void;
  rateLimit(agentId: string, info: RateLimitSample): void;
}

/** What the HTTP endpoints need. */
export interface UsageApi {
  summary(range: UsageRange): Promise<UsageSummary>;
  limits(): Promise<UsageLimits>;
}

export function usageRecord(turn: FinishedTurn, finishedAt: Date): UsageRecord {
  const usage = turn.usage;
  const costUsd = usage?.costUsd ?? null;
  return {
    v: 1,
    ts: finishedAt.toISOString(),
    repoRoot: turn.repoRoot,
    agentId: turn.agentId,
    model: usage?.model ?? turn.model ?? "unknown",
    turnId: turn.turnId,
    stopReason: turn.stopReason,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    costUsd,
    costSource: costUsd !== null ? "agent" : null,
    durationMs: Math.max(0, Math.round(usage?.durationMs ?? turn.elapsedMs)),
    ...(turn.nodeId !== undefined && turn.nodeId.length > 0 ? { nodeId: turn.nodeId } : {}),
  };
}

export class UsageService implements UsageSink, UsageApi {
  constructor(
    readonly log: UsageLog,
    readonly limitsService: UsageLimitsService,
    private readonly options: {
      now?: () => number;
      onError?: (line: string) => void;
      /** Architecture workflows for byWorkflow cost rollups. */
      workflows?: () => Array<{ id: string; steps: string[] }> | undefined;
    } = {},
  ) {}

  recordTurn(turn: FinishedTurn): void {
    const now = this.options.now?.() ?? Date.now();
    this.log.append(usageRecord(turn, new Date(now))).catch((err: unknown) => {
      this.options.onError?.(`usage log append failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  rateLimit(agentId: string, info: RateLimitSample): void {
    this.limitsService.recordRateLimit(agentId, info);
  }

  summary(range: UsageRange): Promise<UsageSummary> {
    return summarizeUsage(
      this.log.records(),
      range,
      this.options.now?.() ?? Date.now(),
      this.options.workflows?.(),
    );
  }

  limits(): Promise<UsageLimits> {
    return this.limitsService.limits();
  }
}
