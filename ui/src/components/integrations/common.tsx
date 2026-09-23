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
  Copy,
  Droplet,
  Plug,
  SquareKanban,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationInfo } from "@/lib/contracts";
import type { Remote, StatusTone } from "@/lib/integrations";
import { cn } from "@/lib/utils";
import { RuahMark } from "@/components/brand/RuahLogo";

// Third-party services get the quiet metadata palette (slate / amber / warm), never a vendor's
// own brand colour; ruah itself carries the spirit mark.
const PROVIDER_MARK: Record<string, { icon: LucideIcon; className: string }> = {
  digitalocean: { icon: Droplet, className: "bg-info/15 text-info" },
  aws: { icon: Cloud, className: "bg-warn/15 text-warn" },
  jira: { icon: SquareKanban, className: "bg-info/15 text-info" },
  github: { icon: CircleDot, className: "bg-surface-3 text-foreground/85" },
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

/** A shell command the user runs themselves, with a copy button. */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <div
      className={cn(
        "group/cmd flex h-8 min-w-0 items-center gap-2 rounded-lg bg-surface-0 ps-2.5 pe-1 font-mono text-[12px] text-foreground/90 ring-1 ring-hairline",
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

/** Quiet status chip: dot + label on a faint fill. */
export function Pill({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] whitespace-nowrap",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "warn" && "bg-warn/12 text-warn",
        tone === "bad" && "bg-bad/12 text-bad",
        tone === "idle" && "bg-info/12 text-info",
        className,
      )}
    >
      <StatusDot tone={tone} />
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
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        {body ? <div className="text-[12.5px] leading-relaxed break-words text-muted-foreground">{body}</div> : null}
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

/** Small ghost button used across these pages (matches the shell's quiet controls). */
export const quietButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export const solidButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-40";

export const primaryButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40";
