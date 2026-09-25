// src/usage/limits/estimate.ts — Ruah's own per-agent numbers from
// usage.jsonl for the period that matters to each card: Claude's weekly
// window, Cursor's / Kiro's billing period, else the last 30 days. Labelled
// "estimate": it only counts turns run through Ruah, and cost is what the
// agent reported (Claude reports an API-equivalent figure; most ACP agents
// report none).
import type { AgentLimits, ModelUsage, UsageEstimate } from "../../contracts/agent-limits.js";
import type { UsageRecord } from "../log.js";
import { round } from "./common.js";

const DAY = 86_400_000;

export interface EstimatePeriod {
  since: number;
  basis: string;
}

/** Claude via SDK and via claude-agent-acp is one account. */
export function limitsAgentId(agentId: string): string {
  return agentId === "claude-acp" ? "claude" : agentId;
}

export function estimatePeriod(limits: AgentLimits, now: number): EstimatePeriod {
  const start = (kinds: string[]): number | undefined => {
    for (const meter of limits.meters) {
      if (!kinds.includes(meter.kind) || meter.periodStart === null || meter.periodStart === undefined) continue;
      const ms = Date.parse(meter.periodStart);
      if (Number.isFinite(ms) && ms <= now) return ms;
    }
    return undefined;
  };
  const weekly = start(["weekly"]);
  if (weekly !== undefined) return { since: weekly, basis: "this weekly window" };
  const monthly = start(["monthly", "credits"]);
  if (monthly !== undefined) return { since: monthly, basis: "this billing period" };
  return { since: now - 30 * DAY, basis: "last 30 days" };
}

interface Acc {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costedTurns: number;
}

const emptyAcc = (): Acc => ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costedTurns: 0 });

function add(acc: Acc, r: UsageRecord): void {
  acc.turns += 1;
  acc.inputTokens += r.inputTokens;
  acc.outputTokens += r.outputTokens;
  acc.cacheReadTokens += r.cacheReadTokens;
  acc.cacheWriteTokens += r.cacheWriteTokens;
  if (r.costUsd !== null) {
    acc.costUsd = (acc.costUsd ?? 0) + r.costUsd;
    acc.costedTurns += 1;
  }
}

const cost = (v: number | null): number | null => (v === null ? null : round(v, 6));

/** Folds the log into one estimate per agent that has a period and at least one turn in it. */
export async function buildEstimates(
  records: AsyncIterable<UsageRecord> | Iterable<UsageRecord>,
  periods: ReadonlyMap<string, EstimatePeriod>,
  now: number,
): Promise<Map<string, UsageEstimate>> {
  const totals = new Map<string, Acc>();
  const models = new Map<string, Map<string, Acc>>();
  for await (const r of records) {
    const agentId = limitsAgentId(r.agentId);
    const period = periods.get(agentId);
    if (period === undefined) continue;
    const ms = Date.parse(r.ts);
    if (!(ms >= period.since && ms <= now)) continue;
    let total = totals.get(agentId);
    if (total === undefined) totals.set(agentId, (total = emptyAcc()));
    add(total, r);
    let byModel = models.get(agentId);
    if (byModel === undefined) models.set(agentId, (byModel = new Map()));
    let row = byModel.get(r.model);
    if (row === undefined) byModel.set(r.model, (row = emptyAcc()));
    add(row, r);
  }
  const out = new Map<string, UsageEstimate>();
  for (const [agentId, t] of totals) {
    const period = periods.get(agentId)!;
    const byModel: ModelUsage[] = [...(models.get(agentId) ?? new Map<string, Acc>())]
      .map(([model, a]) => ({ model, turns: a.turns, inputTokens: a.inputTokens, outputTokens: a.outputTokens, cacheReadTokens: a.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens, costUsd: cost(a.costUsd) }))
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.model.localeCompare(b.model));
    out.set(agentId, {
      label: "estimate",
      since: new Date(period.since).toISOString(),
      until: new Date(now).toISOString(),
      basis: period.basis,
      turns: t.turns,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      costUsd: cost(t.costUsd),
      costedTurns: t.costedTurns,
      byModel,
    });
  }
  return out;
}
