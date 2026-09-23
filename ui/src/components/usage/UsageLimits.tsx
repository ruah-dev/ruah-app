// Adapted from t3code apps/web/src/components/usage/UsageLimits.tsx (MIT): one row per window —
// label and percent left, a bar whose fill is quota left with a hairline where even spending
// would be, pace glyph and reset countdown. Reset credits and pooled accounts are t3code-specific
// and not ported.
import { Fragment } from "react";
import { Gauge, TrendingDown, TrendingUp } from "lucide-react";
import {
  elapsedShare,
  formatResetsIn,
  paceOf,
  remainingPercent,
  type LimitPace,
  type UsageLimitProvider,
  type UsageLimitWindow,
} from "@/lib/usage";
import { AgentMark } from "@/components/agent/ComposerControls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const PACE: Record<LimitPace, { label: string; icon: typeof Gauge }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUp },
  on: { label: "On pace with the window", icon: Gauge },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDown },
};

function PaceIcon({ pace }: { pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={PACE[pace].label} className="inline-flex text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{PACE[pace].label}</TooltipContent>
    </Tooltip>
  );
}

function WindowBar({ color, window, now }: { color: string; window: UsageLimitWindow; now: number }) {
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  // The fill is quota left, so the even-spending mark is the time left.
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }).format(
        new Date(window.resetsAt),
      )
    : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          tabIndex={0}
          aria-label={`${window.label}: ${remaining ?? "unknown"}% left${resetsIn ? `, ${resetsIn}` : ""}`}
          className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="absolute inset-x-0 inset-y-2 rounded-full bg-foreground/[0.07]" />
          {remaining !== null && remaining > 0 ? (
            <div
              className="absolute inset-y-2 left-0 rounded-full"
              style={{ width: `${remaining}%`, backgroundColor: color }}
            />
          ) : null}
          {timeLeft !== null ? (
            <span
              aria-hidden
              className="absolute inset-y-1 w-px -translate-x-1/2 bg-foreground/60"
              style={{ left: `${timeLeft}%` }}
            />
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <span>
            {remaining === null ? "Usage unknown" : `${remaining}% left`}
            {timeLeft !== null ? ` · ${timeLeft}% of the window left` : ""}
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">The line is where even spending would be.</span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function LimitWindows({ windows, color, now }: { windows: UsageLimitWindow[]; color: string; now: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_8.5rem] gap-x-4 gap-y-1 max-sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
      {windows.map((w) => {
        const pace = paceOf(w, now);
        const left = remainingPercent(w);
        return (
          <Fragment key={w.id}>
            <span className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="truncate text-muted-foreground">{w.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {left === null ? "—" : `${left}% left`}
              </span>
            </span>
            <WindowBar color={color} window={w} now={now} />
            <span className="flex items-center gap-2 text-[12px] whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto">{formatResetsIn(w, now) ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

export function UsageLimitsSection({
  providers,
  colors,
  now,
}: {
  providers: UsageLimitProvider[];
  colors: ReadonlyMap<string, string>;
  now: number;
}) {
  return (
    <div className="divide-y divide-hairline">
      {providers.map((p) => (
        <section key={p.agentId} className="flex flex-col gap-3 py-5 first:pt-0">
          <div className="flex items-center gap-2">
            <AgentMark name={p.name} />
            <h2 className="text-[13.5px] font-medium text-foreground">{p.name}</h2>
            <span
              className={cn(
                "text-[12px]",
                p.status === "available" ? "text-muted-foreground" : "text-warn",
              )}
            >
              {p.status === "available" ? "" : p.status === "unavailable" ? "Unavailable" : "Unknown"}
            </span>
          </div>
          {p.windows.length ? (
            <LimitWindows windows={p.windows} color={colors.get(p.agentId) ?? "var(--series-1)"} now={now} />
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              {p.note ?? "This agent does not report subscription limits."}
            </p>
          )}
          {p.windows.length && p.note ? (
            <p className="text-[12px] text-muted-foreground">{p.note}</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
