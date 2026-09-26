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
import type { AgentLimitsReport } from "../contracts/agent-limits.js";
import { AgentLimitsService, defaultProviders } from "./limits/index.js";
import { resolveUsageSettings, type UsageSettingsView } from "./settings.js";

export { UsageLog, ruahHome, parseUsageLine, type UsageRecord } from "./log.js";
export { summarizeUsage } from "./summary.js";
export { UsageLimitsService, type UsageLimitsDeps, type LimitsAgent } from "./limits.js";
export { AgentLimitsService, UnknownAgentError } from "./limits/index.js";

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
  /** Per-agent plan limits (CONTRACTS §16); optional so older fakes still fit. */
  agentLimits?(request: { agentId?: string; refresh?: boolean }): Promise<AgentLimitsReport>;
  /** §21.1 usage settings (whether an agent app's saved login may be read); optional for older fakes. */
  usageSettings?(): UsageSettingsView;
  setUsageSettings?(patch: { readAppLogins: boolean }): UsageSettingsView;
}

/** Where the usage settings live (the daemon's SettingsStore; tests pass a fake). */
export interface UsageSettingsSource {
  get(): UsageSettingsView;
  set(patch: { readAppLogins: boolean }): UsageSettingsView;
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
  /** Per-agent limits (§16): Claude through limitsService, the other agents through their CLIs. */
  readonly agentLimitsService: AgentLimitsService;

  constructor(
    readonly log: UsageLog,
    readonly limitsService: UsageLimitsService,
    private readonly options: {
      now?: () => number;
      onError?: (line: string) => void;
      /** Architecture workflows for byWorkflow cost rollups. */
      workflows?: () => Array<{ id: string; steps: string[] }> | undefined;
      /** Replaces the default per-agent limits service (tests). */
      agentLimits?: AgentLimitsService;
      /** Ruah's version (User-Agent, Kiro's clientInfo). */
      version?: string;
      /** The daemon's debug log (RUAH_DEBUG=1): provider failures land here. */
      debug?: (line: string) => void;
      /** §21.1: the saved usage settings; without it reading app logins follows RUAH_USAGE_READ_LOGINS (default off). */
      settings?: UsageSettingsSource;
    } = {},
  ) {
    const settings = options.settings;
    this.agentLimitsService =
      options.agentLimits ??
      new AgentLimitsService({
        providers: defaultProviders(() => limitsService.claudePlan()),
        records: () => log.records(),
        context: {
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(options.debug !== undefined ? { debug: options.debug } : {}),
          ...(settings !== undefined ? { appLogins: () => settings.get() } : {}),
          version: options.version ?? "0.0.0",
        },
      });
  }

  usageSettings(): UsageSettingsView {
    return this.options.settings?.get() ?? resolveUsageSettings(process.env, undefined);
  }

  /** Saves the setting; readings made under the old one are dropped by the caller's change hook (run-serve) or here. */
  setUsageSettings(patch: { readAppLogins: boolean }): UsageSettingsView {
    const settings = this.options.settings;
    if (settings === undefined) throw new Error("usage settings are not available");
    const before = settings.get();
    const after = settings.set(patch);
    if (before.readAppLogins !== after.readAppLogins) this.agentLimitsService.invalidate("cursor");
    return after;
  }

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

  agentLimits(request: { agentId?: string; refresh?: boolean }): Promise<AgentLimitsReport> {
    return this.agentLimitsService.report(request);
  }
}
