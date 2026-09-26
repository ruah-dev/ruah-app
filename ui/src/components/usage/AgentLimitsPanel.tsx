// Every coding agent's plan limits as cards (signed-in agents first), with the warning
// thresholds and toast switch in a popover and a refresh-all. Self-contained: drop it into a
// page (Usage → Limits, /limits) or a shell panel slot; it fetches GET /api/usage/agents itself
// and degrades to a quiet explanation without a daemon or on an older one.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Bell, BellRing, RefreshCw } from "lucide-react";
import { Phantom } from "@/components/brand/Phantom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { iconButton } from "@/components/ui/controls";
import { cn } from "@/lib/utils";
import { AgentLimitCard } from "./AgentLimitCard";
import { AgentLimitToasts } from "./AgentLimitToasts";
import { formatAgo, orderForDisplay } from "./agentLimitsModel";
import { useAgentLimits, useLimitSettings, useNow, type LimitSettings } from "./agentLimitsStore";

/** A percentage field that commits on blur / Enter, so a half-typed value never clobbers the other. */
function ThresholdInput({ label, value, onChange, tone }: { label: string; value: number; onChange: (v: number) => void; tone: string }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(next)) onChange(next);
    else setDraft(String(value));
  };
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-ui-sm">
      <span aria-hidden className={cn("size-2 rounded-full", tone)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ms-auto inline-flex items-center gap-1">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          value={draft}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          className="h-7 w-14 rounded-md border border-input bg-transparent px-2 text-end text-ui-sm tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <span className="text-faint">%</span>
      </span>
    </label>
  );
}

export function LimitSettingsPopover({ settings, onChange }: { settings: LimitSettings; onChange: (next: LimitSettings) => void }) {
  const toastId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Limit warnings"
          title="Limit warnings"
          className={iconButton}
        >
          <Bell className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-ui font-medium text-foreground">Warn me at</p>
            <p className="text-label text-muted-foreground">Meters and the top-bar hint change colour past these.</p>
          </div>
          <ThresholdInput
            label="Warning"
            tone="bg-warn"
            value={settings.thresholds.warn}
            onChange={(warn) => onChange({ ...settings, thresholds: { ...settings.thresholds, warn } })}
          />
          <ThresholdInput
            label="Critical"
            tone="bg-bad"
            value={settings.thresholds.critical}
            onChange={(critical) => onChange({ ...settings, thresholds: { ...settings.thresholds, critical } })}
          />
          <div className="flex items-center gap-2 border-t border-hairline pt-3">
            <BellRing className="size-3.5 text-muted-foreground" aria-hidden />
            <label htmlFor={toastId} className="text-ui-sm text-foreground">
              Toast when crossed
            </label>
            <Switch
              id={toastId}
              className="ms-auto"
              checked={settings.toasts}
              onCheckedChange={(toasts) => onChange({ ...settings, toasts })}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Quiet({ title, body, failed = false }: { title: string; body: ReactNode; failed?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <Phantom expression={failed ? "error" : "idle"} size="md" className="mb-1" />
      <p className="heading text-headline text-foreground">{title}</p>
      <div className="max-w-sm text-ui leading-relaxed text-muted-foreground">{body}</div>
    </div>
  );
}

const cli = <code className="rounded bg-foreground/[0.07] px-1 py-px font-mono text-label text-foreground">ruah app usage limits</code>;

/**
 * "Checked 2m ago", the warning settings and refresh-all: a row above the cards when the panel
 * is embedded, or the page header's controls on /limits (one row of controls per page).
 */
export function AgentLimitsControls({ refreshButton = true, statusClassName }: { refreshButton?: boolean; statusClassName?: string }) {
  const { load, report, fetchedAt, refreshing, refresh } = useAgentLimits();
  const [settings, setSettings] = useLimitSettings();
  const now = useNow(30_000);
  const all = refreshing.has("*");
  return (
    <>
      <p className={cn("min-w-0 truncate text-label text-muted-foreground", statusClassName)} aria-live="polite">
        {report && fetchedAt
          ? `Checked ${formatAgo(new Date(fetchedAt).toISOString(), now)} · every agent reads its own source`
          : "Plan limits for every coding agent"}
      </p>
      <LimitSettingsPopover settings={settings} onChange={setSettings} />
      {refreshButton ? (
        <button
          type="button"
          aria-label="Refresh all limits"
          title="Refresh all"
          onClick={() => refresh()}
          disabled={load.status === "idle" || all}
          className={iconButton}
        >
          <RefreshCw className={cn("size-3.5", (all || load.status === "loading") && "animate-spin")} />
        </button>
      ) : null}
    </>
  );
}

export function AgentLimitsPanel({
  toasts = true,
  controls = true,
  refreshButton = true,
  className,
}: {
  toasts?: boolean;
  /** The status + settings row above the cards (off when the page header carries it). */
  controls?: boolean;
  /** Refresh-all in that row (off when the page header already has a refresh). */
  refreshButton?: boolean;
  className?: string;
}) {
  const { load, report, refreshing, refresh } = useAgentLimits();
  const [settings] = useLimitSettings();
  const now = useNow(30_000);
  const all = refreshing.has("*");

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {controls ? (
        <div className="flex items-center gap-2">
          <AgentLimitsControls refreshButton={refreshButton} statusClassName="me-auto" />
        </div>
      ) : null}

      {report ? (
        <>
          {load.status === "error" ? (
            <p className="text-ui-sm text-warn">The last refresh failed: {load.message}. Showing the previous reading.</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            {orderForDisplay(report.agents).map((agent) => (
              <AgentLimitCard
                key={agent.agentId}
                agent={agent}
                thresholds={settings.thresholds}
                now={now}
                refreshing={all || refreshing.has(agent.agentId)}
                onRefresh={() => refresh(agent.agentId)}
              />
            ))}
          </div>
        </>
      ) : load.status === "loading" ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : load.status === "unavailable" ? (
        <Quiet title="Limits need a newer daemon" body={<>Restart Ruah to read every agent's limits, or run {cli} in a terminal.</>} />
      ) : load.status === "error" ? (
        <Quiet failed title="Couldn't read limits" body={<>The daemon did not answer: {load.message.replace(/\.$/, "")}. Refresh to try again, or run {cli}.</>} />
      ) : (
        <Quiet title="No daemon running" body={<>Limits come from the Ruah daemon. Without it, run {cli} in a terminal.</>} />
      )}
      {toasts ? <AgentLimitToasts /> : null}
    </div>
  );
}
