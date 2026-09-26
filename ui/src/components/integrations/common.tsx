// Small shared pieces for the integration surfaces (Integrations, Cloud, Tasks, Details):
// provider marks, a copyable command, status pills and quiet notices. Flat Cursor idiom:
// hairlines, muted text, one accent.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  CircleDot,
  Cloud,
  CloudSun,
  Copy,
  Droplet,
  Feather,
  Hexagon,
  Network,
  Plug,
  Server,
  ShipWheel,
  SquareChevronUp,
  SquareKanban,
  SquareTerminal,
  TrainFront,
  Triangle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationInfo } from "@/lib/contracts";
import { setupCommands, type Remote, type StatusTone } from "@/lib/integrations";
import { useTerminal } from "@/lib/terminal";
import { cn } from "@/lib/utils";
import { RuahMark } from "@/components/brand/RuahLogo";
import { Phantom, type PhantomExpression } from "@/components/brand/Phantom";
import { runCommandInTerminal } from "@/components/terminal/actions";

export { PROVIDER_SETUP_LABEL, providerSetupState, setupCommands, type ProviderSetupState } from "@/lib/integrations";

// Third-party services get a categorical tint from the palette (design tokens cat-1…6: brand,
// ai and three extra hues, never a status colour and never a vendor's own brand colour), so
// providers are told apart at a glance while ok / warn / bad stay reserved for health; a few
// stay neutral. ruah itself carries the spirit mark.
const PROVIDER_MARK: Record<string, { icon: LucideIcon; className: string }> = {
  digitalocean: { icon: Droplet, className: "bg-cat-3/15 text-cat-3" },
  aws: { icon: Cloud, className: "bg-cat-5/15 text-cat-5" },
  vercel: { icon: SquareChevronUp, className: "bg-surface-3 text-foreground/85" },
  supabase: { icon: Zap, className: "bg-cat-1/15 text-cat-1" },
  kubernetes: { icon: ShipWheel, className: "bg-cat-2/15 text-cat-2" },
  netlify: { icon: Network, className: "bg-cat-4/15 text-cat-4" },
  hetzner: { icon: Server, className: "bg-surface-3 text-foreground/85" },
  jira: { icon: SquareKanban, className: "bg-cat-2/15 text-cat-2" },
  github: { icon: CircleDot, className: "bg-surface-3 text-foreground/85" },
  // Cloud batch B (CONTRACTS.md §10): generic shapes, never vendor logos or colours.
  gcp: { icon: Hexagon, className: "bg-cat-3/15 text-cat-3" },
  azure: { icon: Triangle, className: "bg-cat-6/15 text-cat-6" },
  cloudflare: { icon: CloudSun, className: "bg-cat-4/15 text-cat-4" },
  railway: { icon: TrainFront, className: "bg-surface-3 text-foreground/85" },
  fly: { icon: Feather, className: "bg-cat-5/15 text-cat-5" },
};

export function ProviderMark({ id, className }: { id: string; className?: string }) {
  if (id === "ruah")
    return (
      <span
        aria-hidden
        className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 ring-1 ring-hairline", className)}
      >
        <RuahMark size={20} />
      </span>
    );
  const mark = PROVIDER_MARK[id] ?? { icon: Plug, className: "bg-foreground/[0.06] text-muted-foreground" };
  const Icon = mark.icon;
  return (
    <span
      aria-hidden
      className={cn("grid size-8 shrink-0 place-items-center rounded-lg", mark.className, className)}
    >
      <Icon className="size-4" strokeWidth={2} />
    </span>
  );
}

export function ProviderGlyph({ id, className }: { id: string; className?: string }) {
  if (id === "ruah") return <RuahMark size={14} className={className} />;
  const mark = PROVIDER_MARK[id] ?? { icon: Plug, className: "" };
  const Icon = mark.icon;
  const color = mark.className.split(" ").find((c) => c.startsWith("text-")) ?? "text-muted-foreground";
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", color, className)} />;
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => setCopied(true))
        .catch(() => {});
    },
  ];
}

/**
 * A shell command the user runs themselves, with a copy button. `runnable` adds "Run in
 * terminal" (a new integrated-terminal tab with the command typed, not executed) while the
 * app's terminal is available; copy always works.
 */
export function CopyCommand({
  command,
  className,
  runnable = false,
}: {
  command: string;
  className?: string;
  runnable?: boolean;
}) {
  const [copied, copy] = useCopy();
  const terminal = useTerminal();
  const canRun = runnable && terminal.connection !== "unavailable";
  return (
    <div
      className={cn(
        "group/cmd flex h-8 min-w-0 items-center gap-2 rounded-lg bg-surface-0 ps-2.5 pe-1 font-mono text-label text-foreground/90 ring-1 ring-hairline",
        className,
      )}
    >
      <span className="shrink-0 text-faint select-none">$</span>
      <span className="min-w-0 flex-1 truncate" title={command}>
        {command}
      </span>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label={copied ? "Copied" : `Copy ${command}`}
        title={copied ? "Copied" : "Copy"}
        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
      {canRun ? (
        <button
          type="button"
          onClick={() => runCommandInTerminal(command)}
          aria-label={`Run ${command} in terminal`}
          title="Run in terminal (opens a tab with the command typed; press Enter to run it)"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SquareTerminal className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Install / log-in commands for a provider, each copyable and runnable in the terminal. */
export function SetupCommands({ info, className }: { info: IntegrationInfo; className?: string }) {
  const commands = setupCommands(info);
  if (!commands.length) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      {commands.map((c) => (
        <div key={c.label} className="flex min-w-0 items-center gap-2">
          <span className="w-12 shrink-0 text-meta text-muted-foreground">{c.label}</span>
          <CopyCommand command={c.command} runnable className="max-w-md min-w-0 flex-1" />
        </div>
      ))}
    </div>
  );
}

export const toneDotClass: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  idle: "bg-info",
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDotClass[tone], className)} />;
}

const INTEGRATION_STATUS: Record<IntegrationInfo["status"], { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "ok" },
  not_connected: { label: "Not connected", tone: "idle" },
  cli_missing: { label: "CLI missing", tone: "warn" },
  error: { label: "Error", tone: "bad" },
};

export function integrationStatus(status: IntegrationInfo["status"]) {
  return INTEGRATION_STATUS[status] ?? { label: status, tone: "idle" as StatusTone };
}

const INTEGRATION_GHOST: Record<IntegrationInfo["status"], PhantomExpression> = {
  connected: "success",
  not_connected: "idle",
  cli_missing: "warning",
  error: "error",
};

/** A 14 px ghost for a status pill, in place of the dot. */
export function PillGhost({ expression }: { expression: PhantomExpression }) {
  return <Phantom expression={expression} size={14} className="-ms-0.5" />;
}

export function integrationGhost(status: IntegrationInfo["status"]) {
  return <PillGhost expression={INTEGRATION_GHOST[status] ?? "idle"} />;
}

/** Quiet status chip: dot (or a small ghost) + label on a faint fill. */
export function Pill({
  tone,
  children,
  className,
  icon,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
  /** Replaces the dot. */
  icon?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 text-meta whitespace-nowrap",
        tone === "ok" && "pill-ok",
        tone === "warn" && "pill-warn",
        tone === "bad" && "pill-bad",
        tone === "idle" && "pill-info",
        className,
      )}
    >
      {icon ?? <StatusDot tone={tone} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Work item status (Jira "In Progress", GitHub "open"/"closed") -> tone. */
export function workStatusTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (/(done|closed|resolved|merged|complete)/.test(s)) return "idle";
  if (/(progress|review|doing|started)/.test(s)) return "warn";
  if (/(block|fail)/.test(s)) return "bad";
  return "ok";
}

/** Page-level notice when the daemon does not serve an endpoint or is not connected. */
export function RemoteNotice({ remote, what }: { remote: Remote<unknown>; what: string }) {
  if (remote.status === "unavailable") {
    const noDaemon = remote.message === "No daemon connected";
    return (
      <Notice
        tone="idle"
        title={noDaemon ? "No daemon connected" : `${what} isn't available on this daemon yet`}
        body={
          noDaemon
            ? "Integrations run inside the Ruah daemon. Start `ruah app serve <repo>` and open the page it serves."
            : "Update ruah: this daemon predates integrations (CONTRACTS.md §6)."
        }
      />
    );
  }
  if (remote.status === "error") {
    return <Notice tone="bad" title={`Couldn't load ${what.toLowerCase()}`} body={remote.message} />;
  }
  return null;
}

export function Notice({
  tone,
  title,
  body,
  action,
}: {
  tone: "idle" | "warn" | "bad";
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3.5 py-3",
        tone === "bad" ? "border-bad/25 bg-bad/[0.06]" : tone === "warn" ? "border-warn/25 bg-warn/[0.06]" : "border-hairline bg-surface-1",
      )}
    >
      <AlertTriangle
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-ui font-medium text-foreground">{title}</p>
        {body ? <div className="text-ui-sm leading-relaxed break-words text-muted-foreground">{body}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function IntegrationsLink({ children = "Integrations" }: { children?: ReactNode }) {
  return (
    <Link to="/integrations" className="text-foreground/90 underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

/** The shared compact controls (components/ui/controls.ts). */
export { quietButton, solidButton, primaryButton, aiButton, iconButton, fieldClass } from "@/components/ui/controls";
