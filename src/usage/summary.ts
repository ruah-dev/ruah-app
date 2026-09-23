// src/usage/summary.ts — GET /api/usage/summary: folds usage.jsonl records
// into totals, a bucketed series (hourly for 24h, daily for 7d/30d, bucket
// starts in the daemon's local time zone) and a per-model table. A cost is
// null only when no record in its group reported one.
import type { UsageRange, UsageSummary } from "../contracts/usage.js";
import type { UsageRecord } from "./log.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_MS: Record<UsageRange, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

/** Start of the bucket holding `ms`: the local hour for 24h, the local day otherwise. */
export function bucketStart(ms: number, range: UsageRange): number {
  const d = new Date(ms);
  if (range === "24h") d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Acc {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

function emptyAcc(): Acc {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
}

function add(acc: Acc, record: UsageRecord): void {
  acc.turns += 1;
  acc.inputTokens += record.inputTokens;
  acc.outputTokens += record.outputTokens;
  acc.cacheReadTokens += record.cacheReadTokens;
  acc.cacheWriteTokens += record.cacheWriteTokens;
  if (record.costUsd !== null) acc.costUsd = (acc.costUsd ?? 0) + record.costUsd;
}

function cost(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

const KEY_SEP = "\u0000";

export class UsageAggregator {
  private readonly from: number;
  private readonly to: number;
  private readonly totals = emptyAcc();
  private readonly series = new Map<string, Acc>();
  private readonly byModel = new Map<string, Acc>();
  private readonly byNode = new Map<string, Acc>();

  constructor(readonly range: UsageRange, now: number) {
    this.to = now;
    this.from = now - RANGE_MS[range];
  }

  add(record: UsageRecord): void {
    const ms = Date.parse(record.ts);
    if (!(ms >= this.from && ms <= this.to)) return;
    add(this.totals, record);
    const modelKey = `${record.agentId}${KEY_SEP}${record.model}`;
    const seriesKey = `${bucketStart(ms, this.range)}${KEY_SEP}${modelKey}`;
    let point = this.series.get(seriesKey);
    if (point === undefined) this.series.set(seriesKey, (point = emptyAcc()));
    add(point, record);
    let row = this.byModel.get(modelKey);
    if (row === undefined) this.byModel.set(modelKey, (row = emptyAcc()));
    add(row, record);
    if (record.nodeId !== undefined && record.nodeId.length > 0) {
      let nodeRow = this.byNode.get(record.nodeId);
      if (nodeRow === undefined) this.byNode.set(record.nodeId, (nodeRow = emptyAcc()));
      add(nodeRow, record);
    }
  }

  result(workflows?: Array<{ id: string; steps: string[] }>): UsageSummary {
    const series = [...this.series].map(([key, acc]) => {
      const [t = "0", agentId = "", model = ""] = key.split(KEY_SEP);
      return { t: Number(t), agentId, model, acc };
    });
    series.sort((a, b) => a.t - b.t || a.agentId.localeCompare(b.agentId) || a.model.localeCompare(b.model));
    const byModel = [...this.byModel].map(([key, acc]) => {
      const [agentId = "", model = ""] = key.split(KEY_SEP);
      return { agentId, model, acc };
    });
    byModel.sort(
      (a, b) =>
        b.acc.inputTokens + b.acc.outputTokens - (a.acc.inputTokens + a.acc.outputTokens) ||
        b.acc.turns - a.acc.turns ||
        a.agentId.localeCompare(b.agentId) ||
        a.model.localeCompare(b.model),
    );
    const byNode = [...this.byNode].map(([nodeId, acc]) => ({ nodeId, acc }));
    byNode.sort(
      (a, b) =>
        (b.acc.costUsd ?? 0) - (a.acc.costUsd ?? 0) ||
        b.acc.inputTokens + b.acc.outputTokens - (a.acc.inputTokens + a.acc.outputTokens),
    );

    const byWorkflowAcc = new Map<string, Acc>();
    if (workflows !== undefined) {
      for (const wf of workflows) {
        let turns = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let costUsd: number | null = null;
        for (const step of wf.steps) {
          const nodeAcc = this.byNode.get(step);
          if (!nodeAcc) continue;
          turns += nodeAcc.turns;
          inputTokens += nodeAcc.inputTokens;
          outputTokens += nodeAcc.outputTokens;
          cacheReadTokens += nodeAcc.cacheReadTokens;
          cacheWriteTokens += nodeAcc.cacheWriteTokens;
          if (nodeAcc.costUsd !== null) costUsd = (costUsd ?? 0) + nodeAcc.costUsd;
        }
        if (turns > 0) {
          byWorkflowAcc.set(wf.id, {
            turns,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            costUsd,
          });
        }
      }
    }

    const t = this.totals;
    return {
      range: this.range,
      totals: {
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        costUsd: cost(t.costUsd),
        turns: t.turns,
      },
      series: series.map(({ t: start, agentId, model, acc }) => ({
        t: new Date(start).toISOString(),
        agentId,
        model,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        costUsd: cost(acc.costUsd),
      })),
      byModel: byModel.map(({ agentId, model, acc }) => ({
        agentId,
        model,
        turns: acc.turns,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        costUsd: cost(acc.costUsd),
      })),
      byNode: byNode.map(({ nodeId, acc }) => ({
        nodeId,
        turns: acc.turns,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        costUsd: cost(acc.costUsd),
      })),
      byWorkflow: [...byWorkflowAcc].map(([workflowId, acc]) => ({
        workflowId,
        turns: acc.turns,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        costUsd: cost(acc.costUsd),
      })),
    };
  }
}

/** Summary of `records` over the `range` ending at `now`. */
export async function summarizeUsage(
  records: AsyncIterable<UsageRecord> | Iterable<UsageRecord>,
  range: UsageRange,
  now: number = Date.now(),
  workflows?: Array<{ id: string; steps: string[] }>,
): Promise<UsageSummary> {
  const aggregator = new UsageAggregator(range, now);
  for await (const record of records) aggregator.add(record);
  return aggregator.result(workflows);
}
