// One coding agent's plan limits: plan / tier, a meter per window (used of limit, a bar with the
// even-pace mark, "resets in 3d 4h" with the absolute time on hover), on-demand spend, what the
// agent's CLI recorded locally, Ruah's own estimate, and the source with a refresh. Agents with
// nothing to measure get a compact card that says why and what to do.
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { ArrowUpRight, KeyRound, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AgentMark } from "@/components/agent/ComposerControls";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { costOf, usePrices } from "@/lib/usage";
import { cn } from "@/lib/utils";
import {
  STATUS_LABEL,
  cardAction,
  elapsedShare,
  formatAbsolute,
  formatAgo,
  formatAmount,
  formatMoney,
  formatResetsIn,
  formatTokens,
  severityOf,
  type AgentLimits,
  type LimitMeter,
  type LimitThresholds,
  type Severity,
  type UsageEstimate,
} from "./agentLimitsModel";
import { setReadAppLogins } from "./agentLimitsStore";

const FILL: Record<Severity, string> = {
  normal: "var(--primary)",
  warn: "var(--warn)",
  critical: "var(--bad)",
};

const TEXT: Record<Severity, string> = {
  normal: "text-foreground",
  warn: "text-warn",
  critical: "text-bad",
};

/** Text with `code` spans (CLI commands in reasons and actions). */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="rounded bg-foreground/[0.07] px-1 py-px font-mono text-meta text-foreground">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function ResetTime({ meter, now }: { meter: LimitMeter; now: number }) {
  const text = formatResetsIn(meter, now);
  if (!text || !meter.resetsAt) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{formatAbsolute(meter.resetsAt)}</TooltipContent>
    </Tooltip>
  );
}

export function LimitMeterRow({ meter, thresholds, now }: { meter: LimitMeter; thresholds: LimitThresholds; now: number }) {
  const pct = meter.usedPercent;
  const severity = severityOf(pct, thresholds);
  const elapsed = elapsedShare(meter, now);
  const hasAmounts = meter.used !== null && meter.used !== undefined && meter.limit !== null && meter.limit !== undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-ui-sm">
        <span className="min-w-0 truncate text-muted-foreground">{meter.label}</span>
        <span className={cn("ms-auto shrink-0 font-medium tabular-nums", TEXT[severity])}>
          {pct === null ? (meter.detail ?? "—") : `${Math.round(pct)}% used`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={meter.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct === null ? "unknown" : `${Math.round(pct)}% used`}
        className="relative h-1.5 overflow-visible rounded-full bg-foreground/[0.08]"
      >
        {pct !== null && pct > 0 ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{ width: `${Math.max(2, pct)}%`, backgroundColor: FILL[severity] }}
          />
        ) : null}
        {elapsed !== null && pct !== null ? (
          <span
            aria-hidden
            title="Even pace: where usage would be if spread evenly over the window"
            className="absolute -inset-y-1 w-px -translate-x-1/2 bg-foreground/45"
            style={{ left: `${elapsed * 100}%` }}
          />
        ) : null}
      </div>
      <div className="flex items-baseline gap-2 text-meta text-faint tabular-nums">
        <span className="min-w-0 truncate">
          {hasAmounts ? `${formatAmount(meter.used!, meter.unit)} of ${formatAmount(meter.limit!, meter.unit)}` : ""}
          {meter.detail && pct !== null && !meter.detail.startsWith("Expires") ? `${hasAmounts ? " · " : ""}${meter.detail}` : ""}
        </span>
        <span className="ms-auto shrink-0">
          <ResetTime meter={meter} now={now} />
        </span>
      </div>
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string | undefined }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-ui-sm" title={hint}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ms-auto min-w-0 text-end tabular-nums text-foreground [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

function EstimateRow({ estimate }: { estimate: UsageEstimate }) {
  const prices = usePrices();
  let cost: number | null = null;
  let priced = false;
  let pricedTurns = 0;
  for (const m of estimate.byModel) {
    const c = costOf(m, prices);
    if (c === null) continue;
    if (m.costUsd === null) {
      // No turn of this model reported a cost: the viewer's price covers all of them.
      priced = true;
      pricedTurns += m.turns ?? 0;
    }
    cost = (cost ?? 0) + c;
  }
  // A cost that covers only some turns says so (as the CLI does), instead of passing for the total.
  const costedTurns = Math.min(estimate.turns, estimate.costedTurns + pricedTurns);
  const partialCost = cost !== null && costedTurns < estimate.turns;
  const tokens = estimate.inputTokens + estimate.outputTokens;
  return (
    <Row
      label="Ruah estimate"
      hint={`Turns run through Ruah only, ${estimate.basis}. Cost is what the agent reported${priced ? ", plus your model prices" : ""}${partialCost ? "; turns without a cost count tokens only" : ""}.`}
    >
      <span className="me-1.5 rounded-sm pill-ai px-1 py-px text-micro font-medium tracking-wide uppercase">
        estimate
      </span>
      {estimate.turns} {estimate.turns === 1 ? "turn" : "turns"} · {formatTokens(tokens)} tokens
      {cost !== null ? ` · ${formatMoney(cost)}` : ""}
      {partialCost ? (
        <span className="text-faint">
          {" "}
          ({costedTurns}/{estimate.turns} turns)
        </span>
      ) : null}
      <span className="text-faint"> · {estimate.basis}</span>
    </Row>
  );
}

function localPeriod(since: string | null, checkedAt: string): string {
  if (!since) return "all time";
  const days = Math.round((Date.parse(checkedAt) - Date.parse(since)) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? `last ${days} days` : "recent";
}

/**
 * §21.1: the opt-in for reading the agent app's saved login (Cursor's plan usage). Off by default;
 * locked while RUAH_USAGE_READ_LOGINS decides.
 */
export function AppLoginSwitch({ appLogin }: { appLogin: NonNullable<AgentLimits["appLogin"]> }) {
  const id = useId();
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? appLogin.readAppLogins;
  const locked = appLogin.source === "env";
  // Saved: the switch holds the new position until the re-read card reports it (or 20 s pass).
  useEffect(() => {
    if (pending === null) return;
    if (appLogin.readAppLogins === pending) {
      setPending(null);
      return;
    }
    const t = setTimeout(() => setPending(null), 20_000);
    return () => clearTimeout(t);
  }, [pending, appLogin.readAppLogins]);
  return (
    <div className="flex items-start gap-3 rounded-lg bg-foreground/[0.035] px-3 py-2.5">
      <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-[12.5px] leading-relaxed">
        <span className="block text-foreground">Read Cursor&apos;s saved login to show plan usage</span>
        <span className="block text-muted-foreground">
          {locked
            ? `Set by RUAH_USAGE_READ_LOGINS=${appLogin.readAppLogins ? "1" : "0"} for this Ruah.`
            : "The token stays in memory for one read-only request to cursor.com and is never stored."}
        </span>
      </label>
      <Switch
        id={id}
        checked={checked}
        disabled={locked || pending !== null}
        aria-label="Read Cursor's saved login to show plan usage"
        onCheckedChange={(on) => {
          setPending(on);
          setReadAppLogins(on).catch((err: unknown) => {
            setPending(null);
            toast.error("Couldn't change the setting", { description: err instanceof Error ? err.message : String(err) });
          });
        }}
        className="mt-0.5"
      />
    </div>
  );
}

function StatusPill({ agent }: { agent: AgentLimits }) {
  const label = agent.stale ? "Stale" : STATUS_LABEL[agent.status];
  if (!label) return null;
  const tone =
    agent.stale || agent.status === "error"
      ? "border-warn/40 text-warn"
      : agent.status === "not_logged_in" || agent.status === "partial"
        ? "border-hairline text-muted-foreground"
        : "border-hairline text-faint";
  return <span className={cn("shrink-0 rounded-full border px-2 py-px text-caption", tone)}>{label}</span>;
}

export function AgentLimitCard({
  agent,
  thresholds,
  now,
  refreshing,
  onRefresh,
}: {
  agent: AgentLimits;
  thresholds: LimitThresholds;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const quiet = agent.status === "not_installed" || agent.status === "not_logged_in";
  const hasBody = agent.meters.length > 0 || agent.onDemand || agent.local || agent.estimate;
  const action = cardAction(agent);
  return (
    <section
      aria-label={`${agent.name} limits`}
      className={cn("card-warm flex min-w-0 flex-col gap-4 p-4", quiet && "bg-transparent shadow-none")}
    >
      <header className="flex items-center gap-2.5">
        <AgentMark name={agent.name} className={cn("size-6 rounded-md text-micro", quiet && "opacity-60")} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h3 className={cn("heading truncate text-title-sm", quiet ? "text-muted-foreground" : "text-foreground")}>
            {agent.name}
          </h3>
          {agent.plan ? (
            <span className="shrink-0 rounded-full pill-primary px-2 py-px text-caption font-medium">
              {agent.plan}
            </span>
          ) : null}
          <StatusPill agent={agent} />
        </div>
        <button
          type="button"
          aria-label={`Refresh ${agent.name} limits`}
          title="Refresh"
          onClick={onRefresh}
          disabled={refreshing}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      </header>

      {agent.meters.length > 0 ? (
        <div className="flex flex-col gap-3.5">
          {agent.meters.map((m) => (
            <LimitMeterRow key={m.id} meter={m} thresholds={thresholds} now={now} />
          ))}
        </div>
      ) : null}

      {agent.onDemand || agent.local || agent.estimate ? (
        <div className={cn("flex flex-col gap-1.5", agent.meters.length > 0 && "border-t border-hairline pt-3")}>
          {agent.onDemand ? (
            <Row label="On-demand" hint={agent.onDemand.note}>
              {agent.onDemand.enabled ? (
                <>
                  {agent.onDemand.used !== null ? formatMoney(agent.onDemand.used, agent.onDemand.currency) : "—"}
                  {agent.onDemand.limit !== null ? (
                    <span className="text-faint"> of {formatMoney(agent.onDemand.limit, agent.onDemand.currency)}</span>
                  ) : (
                    <span className="text-faint"> · no cap</span>
                  )}
                  {agent.onDemand.scope === "team" ? <span className="text-faint"> · team</span> : null}
                </>
              ) : (
                <span className="text-faint">Off</span>
              )}
            </Row>
          ) : null}
          {agent.local ? (
            <Row label="Recorded locally" hint={`${agent.local.source}${agent.local.approximate ? " (rounded figures)" : ""}`}>
              {agent.local.sessions !== undefined ? `${agent.local.sessions} sessions · ` : ""}
              {formatTokens(agent.local.inputTokens + agent.local.outputTokens)} tokens
              {agent.local.costUsd !== null ? ` · ${formatMoney(agent.local.costUsd)}` : ""}
              <span className="text-faint"> · {localPeriod(agent.local.since, agent.checkedAt)}</span>
            </Row>
          ) : null}
          {agent.estimate ? <EstimateRow estimate={agent.estimate} /> : null}
        </div>
      ) : null}

      {agent.appLogin ? <AppLoginSwitch appLogin={agent.appLogin} /> : null}

      {agent.reason || action ? (
        <div className={cn("flex flex-col gap-1 text-ui-sm leading-relaxed", hasBody && "border-t border-hairline pt-3")}>
          {agent.reason ? (
            <p className={cn(agent.status === "error" || agent.stale ? "text-warn" : "text-muted-foreground")}>
              <InlineCode text={agent.reason} />
            </p>
          ) : null}
          {action ? (
            <p className="text-foreground">
              <InlineCode text={action} />
            </p>
          ) : null}
        </div>
      ) : null}

      <footer className="mt-auto flex min-w-0 items-center gap-1.5 text-meta text-faint">
        <span className="min-w-0 truncate" title={agent.source}>
          {agent.source}
        </span>
        <span className="shrink-0">· {formatAgo(agent.checkedAt, now)}</span>
        {agent.dashboardUrl ? (
          <a
            href={agent.dashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="ms-auto inline-flex shrink-0 items-center gap-0.5 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Dashboard
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        ) : null}
      </footer>
    </section>
  );
}
