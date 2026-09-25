// Adapted from t3code apps/web/src/components/usage/UsagePage.tsx (MIT): metric + period
// segmented controls, a big total with per-agent shares beside a layered chart, a totals row and
// a model / time breakdown table. t3code's environments, Effect atoms and RPC are replaced by the
// daemon's /api/usage endpoints (src/lib/usage.ts).
import { useMemo, useState } from "react";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { Phantom } from "@/components/brand/Phantom";
import {
  bucketOf,
  bucketsFor,
  costOf,
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  usePrices,
  useUsageSummary,
  type UsageRange,
} from "@/lib/usage";
import { useWorkspace } from "@/lib/workspace";
import { PageHeader } from "@/components/shell/AppShell";
import { Segmented } from "@/components/map/MapPage";
import { AgentMark } from "@/components/agent/ComposerControls";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { UsageChart, type ChartColumn } from "./UsageChart";
import { AgentLimitsPanel } from "./AgentLimitsPanel";
import { refreshAgentLimits, useAgentLimitsSnapshot } from "./agentLimitsStore";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { OptimizeSection } from "@/components/engines/OptimizeSection";
import { agentColor, agentLabel, orderAgents } from "./usageAgents";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsageMetric,
} from "./usagePagePreferences";

const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] as const;

const RANGE_OPTIONS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span className="heading text-[20px] text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function EmptyState({ title, body, failed = false }: { title: string; body: string; failed?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <Phantom expression={failed ? "error" : "idle"} size="md" className="mb-1" />
      <p className="heading text-[16px] text-foreground">{title}</p>
      <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

export function UsagePage() {
  const { daemon } = useWorkspace();
  const [prefs, setPrefs] = useState(readUsagePagePreferences);
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [pricesOpen, setPricesOpen] = useState(false);
  const { metric, range } = prefs;
  const showingLimits = metric === "limits";
  const [summary, refreshSummary] = useUsageSummary(range);
  // Only the Limits tab's panel fetches; this just follows its state for the header spinner.
  const limits = useAgentLimitsSnapshot();
  const prices = usePrices();

  const names = useMemo(
    () => new Map((daemon.agent?.agents?.available ?? []).map((a) => [a.id, a.name])),
    [daemon.agent?.agents],
  );

  const setPref = (next: Partial<typeof prefs>) => {
    const p = { ...prefs, ...next };
    setPrefs(p);
    saveUsagePagePreferences(p);
  };

  const data = summary.status === "ok" ? summary.data : null;
  const model = useMemo(() => {
    if (!data) return null;
    const agents = orderAgents([...data.series.map((s) => s.agentId), ...data.byModel.map((m) => m.agentId)]);
    const labels = new Map(agents.map((a) => [a, agentLabel(a, names)]));
    const colors = new Map(agents.map((a) => [a, agentColor(a, agents)]));
    const buckets = bucketsFor(range);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const cost = (row: Parameters<typeof costOf>[0]) => costOf(row, prices) ?? 0;
    const value = (row: Parameters<typeof costOf>[0]) =>
      metric === "cost" ? cost(row) : row.inputTokens + row.outputTokens;
    const columns: ChartColumn[] = buckets.map(() => ({ values: new Map(), total: 0 }));
    const periodCost: number[] = buckets.map(() => 0);
    const periodTokens: number[] = buckets.map(() => 0);
    const periodByAgent: Map<string, number>[] = buckets.map(() => new Map());
    for (const s of data.series) {
      const i = index.get(bucketOf(range, s.t));
      if (i === undefined) continue;
      const v = value(s);
      const col = columns[i]!;
      col.values.set(s.agentId, (col.values.get(s.agentId) ?? 0) + v);
      col.total += v;
      periodCost[i]! += cost(s);
      periodTokens[i]! += s.inputTokens + s.outputTokens;
      periodByAgent[i]!.set(s.agentId, (periodByAgent[i]!.get(s.agentId) ?? 0) + cost(s));
    }
    const models = data.byModel.map((m) => ({
      ...m,
      tokens: m.inputTokens + m.outputTokens,
      cost: costOf(m, prices),
    }));
    const totalTokens = models.reduce((s, m) => s + m.tokens, 0) ||
      data.totals.inputTokens + data.totals.outputTokens;
    const pricedCost = models.reduce((s, m) => s + (m.cost ?? 0), 0);
    const totalCost = data.totals.costUsd ?? pricedCost;
    const unpriced = models.filter((m) => m.cost === null).reduce((s, m) => s + m.tokens, 0);
    const perAgent = agents.map((a) => {
      const rows = models.filter((m) => m.agentId === a);
      return {
        agentId: a,
        turns: rows.reduce((s, m) => s + m.turns, 0),
        tokens: rows.reduce((s, m) => s + m.tokens, 0),
        cost: rows.reduce((s, m) => s + (m.cost ?? 0), 0),
      };
    });
    return {
      agents,
      labels,
      colors,
      buckets,
      columns,
      periodCost,
      periodTokens,
      periodByAgent,
      models,
      perAgent,
      totalTokens,
      totalCost,
      unpricedShare: totalTokens ? unpriced / totalTokens : 0,
    };
  }, [data, range, metric, prices, names]);

  const refresh = () => {
    if (showingLimits) refreshAgentLimits();
    else refreshSummary();
  };
  const loading = showingLimits
    ? limits.load.status === "loading" || limits.refreshing.has("*")
    : summary.status === "loading";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Usage">
        <Segmented
          value={metric}
          options={METRIC_OPTIONS}
          onChange={(v: UsageMetric) => setPref({ metric: v })}
        />
        {/* The period does not apply to Limits: it stays in place, disabled, so nothing shifts. */}
        <Segmented
          value={range}
          options={RANGE_OPTIONS.map((o) => ({ ...o, disabled: showingLimits }))}
          onChange={(v: UsageRange) => setPref({ range: v })}
          className={cn(showingLimits && "opacity-50")}
        />
        <button
          type="button"
          aria-label="Model prices"
          title="Model prices"
          onClick={() => setPricesOpen(true)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh"
          onClick={refresh}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 max-md:px-4">
          {showingLimits ? (
            <AgentLimitsPanel />
          ) : summary.status === "loading" ? (
            <UsageSkeleton />
          ) : summary.status !== "ok" || !model ? (
            <EmptyState
              failed={summary.status === "error"}
              title="No usage recorded yet"
              body={
                summary.status === "error"
                  ? `The daemon did not answer: ${summary.message}`
                  : daemon.source === "daemon"
                    ? "Tokens and cost appear here after the agent has worked on a few turns."
                    : "Usage comes from the Ruah daemon. Start ruah app serve <repo> to record it."
              }
            />
          ) : (
            <>
              <section className="grid gap-8 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <div className="flex flex-col gap-1">
                    <span className="text-[34px] leading-none font-semibold tracking-tight text-foreground tabular-nums">
                      {metric === "cost" ? formatUsd(model.totalCost) : formatTokens(model.totalTokens)}
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {formatCount(data!.totals.turns)} turns
                      {metric === "cost"
                        ? model.unpricedShare > 0
                          ? ` · estimate excludes ${formatPercent(model.unpricedShare)} unpriced tokens`
                          : data!.totals.costUsd === null
                            ? " · estimate"
                            : ""
                        : ""}
                    </span>
                  </div>
                  {model.perAgent.map((a) => {
                    const share =
                      metric === "cost"
                        ? model.totalCost ? a.cost / model.totalCost : 0
                        : model.totalTokens ? a.tokens / model.totalTokens : 0;
                    return (
                      <div key={a.agentId} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-4">
                          <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
                            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: model.colors.get(a.agentId) }} />
                            <AgentMark name={model.labels.get(a.agentId) ?? a.agentId} />
                            <span className="truncate">{model.labels.get(a.agentId)}</span>
                            <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
                              {formatCount(a.turns)} {a.turns === 1 ? "turn" : "turns"}
                            </span>
                          </span>
                          <span className="shrink-0 text-[13px] font-medium tabular-nums">
                            {metric === "cost" ? formatUsd(a.cost) : formatTokens(a.tokens)}
                          </span>
                        </div>
                        <span className="text-[12px] text-muted-foreground">
                          {metric === "cost"
                            ? `${formatPercent(share)} of cost · ${formatTokens(a.tokens)} tokens`
                            : `${formatPercent(share)} of tokens · ${formatUsd(a.cost)}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  <h2 className="text-[13px] font-medium text-foreground">
                    {range === "24h" ? "Hourly" : "Daily"} {metric === "tokens" ? "tokens" : "cost"}
                  </h2>
                  <UsageChart
                    agents={model.agents}
                    labels={model.labels}
                    colors={model.colors}
                    buckets={model.buckets}
                    columns={model.columns}
                    metric={metric === "cost" ? "cost" : "tokens"}
                    resolution={range === "24h" ? "hour" : "day"}
                  />
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-[13px] font-medium text-foreground">Totals</h2>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                  <Metric label="Input" value={formatTokens(data!.totals.inputTokens)} />
                  <Metric label="Output" value={formatTokens(data!.totals.outputTokens)} />
                  <Metric label="Cache read" value={formatTokens(data!.totals.cacheReadTokens)} />
                  <Metric label="Cache write" value={formatTokens(data!.totals.cacheWriteTokens)} />
                  <Metric label="Cost" value={formatUsd(model.totalCost)} />
                </div>
              </section>

              {(data!.byNode?.length ?? 0) > 0 || (data!.byWorkflow?.length ?? 0) > 0 ? (
                <section className="grid gap-6 md:grid-cols-2">
                  {(data!.byNode?.length ?? 0) > 0 ? (
                    <div className="flex flex-col gap-2">
                      <h2 className="text-[13px] font-medium text-foreground">Cost by element</h2>
                      <p className="text-[12px] text-muted-foreground">From ~/.ruah/usage.jsonl turns that recorded a nodeId.</p>
                      <ul className="divide-y divide-hairline/60 text-[13px]">
                        {data!.byNode!.slice(0, 12).map((row) => (
                          <li key={row.nodeId} className="flex items-baseline justify-between gap-3 py-2">
                            <span className="truncate font-mono text-[12px]" title={row.nodeId}>
                              {row.nodeId}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {row.costUsd === null ? "—" : formatUsd(row.costUsd)}
                              <span className="ms-2 text-[11px] text-muted-foreground">{formatCount(row.turns)} turns</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {(data!.byWorkflow?.length ?? 0) > 0 ? (
                    <div className="flex flex-col gap-2">
                      <h2 className="text-[13px] font-medium text-foreground">Cost by workflow</h2>
                      <p className="text-[12px] text-muted-foreground">Sum of element costs for steps in each architecture workflow.</p>
                      <ul className="divide-y divide-hairline/60 text-[13px]">
                        {data!.byWorkflow!.map((row) => (
                          <li key={row.workflowId} className="flex items-baseline justify-between gap-3 py-2">
                            <span className="truncate font-mono text-[12px]" title={row.workflowId}>
                              {row.workflowId}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {row.costUsd === null ? "—" : formatUsd(row.costUsd)}
                              <span className="ms-2 text-[11px] text-muted-foreground">{formatCount(row.turns)} turns</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[13px] font-medium text-foreground">Breakdown</h2>
                  <Segmented
                    value={breakdown}
                    onChange={setBreakdown}
                    options={[
                      { value: "model", label: "Model" },
                      { value: "time", label: range === "24h" ? "Hour" : "Day" },
                    ]}
                  />
                </div>
                {breakdown === "model" ? (
                  <table className="w-full table-fixed text-[13px]">
                    <colgroup>
                      <col className="w-2/5" />
                      <col className="w-1/5" />
                      <col className="w-1/5" />
                      <col className="w-1/5" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-hairline text-left text-[12px] text-muted-foreground">
                        <th className="py-2 font-normal">Model</th>
                        <th className="py-2 text-right font-normal">Cost</th>
                        <th className="py-2 text-right font-normal">Share</th>
                        <th className="py-2 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.models.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-muted-foreground">
                            No activity in this window.
                          </td>
                        </tr>
                      ) : (
                        [...model.models]
                          .sort((a, b) => (metric === "tokens" ? b.tokens - a.tokens : (b.cost ?? -1) - (a.cost ?? -1)))
                          .map((m) => (
                            <tr key={`${m.agentId}:${m.model}`} className="border-b border-hairline/60 transition-colors hover:bg-accent/50">
                              <td className="py-2">
                                <span className="flex min-w-0 items-center gap-2">
                                  <AgentMark name={model.labels.get(m.agentId) ?? m.agentId} className="size-3.5 text-[7px]" />
                                  <span className="truncate">{m.model}</span>
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums">
                                {m.cost === null ? <span className="text-muted-foreground">Unpriced</span> : formatUsd(m.cost)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {m.cost === null || !model.totalCost ? "—" : formatPercent(m.cost / model.totalCost)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">{formatTokens(m.tokens)}</td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full table-fixed text-[13px]">
                    <thead>
                      <tr className="border-b border-hairline text-left text-[12px] text-muted-foreground">
                        <th className="w-2/5 py-2 font-normal">{range === "24h" ? "Hour" : "Day"}</th>
                        {model.agents.map((a) => (
                          <th key={a} className="py-2 text-right font-normal">{model.labels.get(a)}</th>
                        ))}
                        <th className="py-2 text-right font-normal">Total</th>
                        <th className="py-2 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.buckets
                        .map((b, i) => ({ b, i }))
                        .reverse()
                        .filter(({ i }) => model.periodTokens[i]! > 0)
                        .map(({ b, i }) => (
                          <tr key={b} className="border-b border-hairline/60 transition-colors hover:bg-accent/50">
                            <td className="py-2">{range === "24h" ? formatHourShort(b) : formatDayShort(b)}</td>
                            {model.agents.map((a) => (
                              <td key={a} className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatUsd(model.periodByAgent[i]!.get(a) ?? 0)}
                              </td>
                            ))}
                            <td className="py-2 text-right tabular-nums">{formatUsd(model.periodCost[i]!)}</td>
                            <td className="py-2 text-right text-muted-foreground tabular-nums">
                              {formatTokens(model.periodTokens[i]!)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
          <OptimizeSection />
        </div>
      </div>
      <UsagePriceOverrides
        open={pricesOpen}
        onOpenChange={setPricesOpen}
        models={model?.models.map((m) => m.model) ?? []}
      />
    </div>
  );
}

/** Stand-in with the loaded page's shape. */
function UsageSkeleton() {
  return (
    <section className="grid gap-8 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-44" />
      </div>
      <Skeleton className="h-56" />
    </section>
  );
}
