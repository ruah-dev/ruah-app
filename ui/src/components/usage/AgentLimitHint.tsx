// The compact limit hint for the shell's top-bar agent pill: "62% left · resets 4h" for the
// agent's tightest window, amber / red past the viewer's thresholds, the window and the absolute
// reset time on hover. Renders nothing when the agent reports no percentage (so a pill without
// limits stays as it is). Self-contained: it shares the Limits panel's reading, and on its own
// asks the daemon for its agent only (never every agent's CLIs).
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatAbsolute, limitHintText, severityOf, tightestMeter } from "./agentLimitsModel";
import { useAgentLimits, useLimitSettings, useNow } from "./agentLimitsStore";

const TONE = {
  normal: "text-muted-foreground",
  warn: "text-warn",
  critical: "text-bad",
} as const;

const DOT = {
  normal: "bg-primary",
  warn: "bg-warn",
  critical: "bg-bad",
} as const;

export function AgentLimitHint({ agentId, className }: { agentId: string; className?: string }) {
  const id = agentId === "claude-acp" ? "claude" : agentId;
  const { report } = useAgentLimits({ agentId: id });
  const [settings] = useLimitSettings();
  const now = useNow(60_000);
  const agent = report?.agents.find((a) => a.agentId === id);
  if (!agent) return null;
  const text = limitHintText(agent, now);
  const meter = tightestMeter(agent);
  if (text === null || meter === null) return null;
  const severity = severityOf(meter.usedPercent, settings.thresholds);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`${agent.name}: ${text}`}
          className={cn(
            "inline-flex cursor-default items-center gap-1.5 rounded text-[11.5px] whitespace-nowrap tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
            TONE[severity],
            className,
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT[severity])} />
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <span>
            {agent.name} · {meter.label}: {Math.round(meter.usedPercent ?? 0)}% used
          </span>
          {meter.resetsAt ? <span className="text-muted-foreground">Resets {formatAbsolute(meter.resetsAt)}</span> : null}
          {agent.stale ? <span className="text-warn">Last reading; the refresh failed.</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
