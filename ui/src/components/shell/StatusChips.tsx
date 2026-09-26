// The top bar's status area: small, calm chips readable without a click — the open project's
// cloud health ("9 ok · 1 degraded", amber / red when something is unhealthy, click → Cloud) and
// whatever other features register (./slots.ts registerStatusItem, e.g. the live preview's
// "Preview: running :5173"). `StatusChip` is the shared look for those registrations.
import type { ComponentType, ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Cloud, type LucideIcon } from "lucide-react";
import type { ChipTone } from "@/lib/status-chips";
import { cloudConnected, cloudHealthSummary } from "@/lib/status-chips";
import { useEnsure, useIntegrationsStore } from "@/lib/integrations";
import { useWorkspace } from "@/lib/workspace";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSlots } from "./slots";

export type { ChipTone } from "@/lib/status-chips";

const TONE: Record<ChipTone, { chip: string; mark: string }> = {
  ok: { chip: "border-hairline text-muted-foreground", mark: "bg-ok" },
  warn: { chip: "border-warn/35 bg-warn/[0.07] text-foreground", mark: "bg-warn" },
  bad: { chip: "border-bad/40 bg-bad/[0.08] text-foreground", mark: "bg-bad" },
  muted: { chip: "border-hairline text-muted-foreground", mark: "bg-faint" },
};

export interface StatusChipProps {
  /** Shown before the label (else a tone dot). */
  icon?: LucideIcon | ComponentType<{ className?: string }>;
  /** "Preview: running :5173" */
  label: string;
  /** Shorter text for narrower windows (< 1280 px); defaults to the label. */
  short?: string;
  tone?: ChipTone;
  /** Tooltip (defaults to the label). */
  title?: ReactNode;
  /** Makes the chip a button. */
  onClick?: () => void;
  /** Accessible name when the label alone is not enough. */
  ariaLabel?: string;
}

/** One status chip (h-6, pill). Use it from registerStatusItem renders for a consistent bar. */
export function StatusChip({ icon: Icon, label, short, tone = "muted", title, onClick, ariaLabel }: StatusChipProps) {
  const t = TONE[tone];
  const body = (
    <>
      {Icon ? (
        <span className="relative shrink-0">
          <Icon className="size-3.5" />
          {tone === "warn" || tone === "bad" ? (
            <span aria-hidden className={cn("absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-background", t.mark)} />
          ) : null}
        </span>
      ) : (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", t.mark)} />
      )}
      <span className="min-w-0 truncate max-xl:hidden">{label}</span>
      <span className="min-w-0 truncate xl:hidden">{short ?? label}</span>
    </>
  );
  const cls = cn(
    "flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-1.5 rounded-full border bg-surface-2 px-2 text-[11.5px] whitespace-nowrap tabular-nums outline-none transition-colors",
    t.chip,
    onClick && "hover:bg-surface-3 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <button type="button" onClick={onClick} aria-label={ariaLabel ?? label} className={cls}>
            {body}
          </button>
        ) : (
          <span role="status" tabIndex={0} aria-label={ariaLabel ?? label} className={cls}>
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80">
        {title ?? label}
      </TooltipContent>
    </Tooltip>
  );
}

/** The open project's cloud health; hidden with no connected provider or nothing in scope. */
export function CloudHealthChip() {
  const s = useEnsure("cloud");
  const integrations = useIntegrationsStore().integrations;
  const router = useRouter();
  const snapshot = s.cloud.status === "ok" ? s.cloud.data : null;
  const listed = integrations.status === "ok" ? integrations.data : null;
  const summary = snapshot ? cloudHealthSummary(snapshot.resources, cloudConnected(listed, snapshot)) : null;
  if (!summary) return null;
  const reported = summary.total - summary.unknown;
  const lines = [
    `This project's cloud: ${summary.total} resource${summary.total === 1 ? "" : "s"}${reported ? ` — ${summary.label}` : ", no health reported"}`,
    reported && summary.unknown ? `${summary.unknown} without a known health (scaled to 0, never ran)` : "",
    summary.unhealthy.length ? `Needs a look: ${summary.unhealthy.slice(0, 4).join(", ")}${summary.unhealthy.length > 4 ? ", …" : ""}` : "",
  ].filter(Boolean);
  return (
    <StatusChip
      icon={Cloud}
      tone={summary.tone}
      label={summary.label}
      short={summary.short}
      ariaLabel={`Cloud: ${summary.label}. Open the Cloud page`}
      onClick={() => void router.navigate({ to: "/cloud" })}
      title={
        <>
          {lines.map((l) => (
            <span key={l} className="block">
              {l}
            </span>
          ))}
          <span className="block text-muted-foreground">Open the Cloud page · G L</span>
        </>
      }
    />
  );
}

/** Cloud health + registered status items, between the ⌘K field and the bell. */
export function StatusArea() {
  const { daemon } = useWorkspace();
  const { statusItems } = useSlots();
  const live = daemon.source === "daemon" && !!daemon.project && !daemon.projectSwitch;
  if (!live && statusItems.length === 0) return null;
  return (
    <div role="group" aria-label="Status" className="flex min-w-0 shrink items-center gap-1.5 max-md:hidden">
      {live ? <CloudHealthChip /> : null}
      {statusItems.map(({ id, render: Item }) => (
        <Item key={id} />
      ))}
    </div>
  );
}
