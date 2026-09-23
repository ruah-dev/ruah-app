// Dashboard: the repo at a glance, built only from what the daemon already serves
// (architecture.json over the socket, agent.status, this session's turns, /api/usage).
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Copy, Map as MapIcon, RefreshCw } from "lucide-react";
import { kindFor } from "@/lib/architecture";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import {
  formatAgo,
  formatCount,
  formatTokens,
  formatUsd,
  costOf,
  usePrices,
  useUsageSummary,
} from "@/lib/usage";
import { agentDotClass } from "@/components/agent/AgentPanel";
import { AgentMark } from "@/components/agent/ComposerControls";
import { kindStyles } from "@/components/explorer/kinds";
import { PageHeader } from "@/components/shell/AppShell";
import { turnStatus, toneDot } from "@/components/shell/SidebarSections";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex h-6 items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={hint}>
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[22px] leading-tight font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[12.5px] leading-relaxed text-muted-foreground">{children}</p>;
}

function RescanButton() {
  const { daemon } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const cmd = `archmap scan ${daemon.root ?? "<repo>"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(cmd).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-ok" /> : <RefreshCw className="size-3.5" />}
          {copied ? "Command copied" : "Rescan"}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        Rescanning runs in a terminal: <span className="font-mono">{cmd}</span>. The map updates by
        itself when architecture.json changes. Click to copy.
      </TooltipContent>
    </Tooltip>
  );
}

export function DashboardPage() {
  const { daemon, architecture, app } = useWorkspace();
  const wb = useWorkbench();
  const [usage] = useUsageSummary("7d");
  const prices = usePrices();

  const agents = daemon.agent?.agents;
  const agentName =
    agents?.available.find((a) => a.id === agents.currentAgentId)?.name ??
    daemon.agent?.agent?.name ??
    null;
  const modelName =
    daemon.agent?.models?.available.find((m) => m.id === daemon.agent?.models?.currentModelId)
      ?.name ?? null;

  const stats = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const n of architecture.nodes) {
      const k = kindFor(n.type);
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
    const degree = new Map<string, number>();
    for (const e of architecture.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const hotspots = architecture.nodes
      .map((n) => ({ node: n, links: degree.get(n.id) ?? 0 }))
      .filter((h) => h.links > 0)
      .sort((a, b) => b.links - a.links)
      .slice(0, 5);
    const layers =
      architecture.layers?.length ??
      new Set(architecture.nodes.map((n) => n.layer).filter(Boolean)).size;
    return { kinds, hotspots, layers };
  }, [architecture]);

  const recent = [...daemon.turns].reverse().slice(0, 5);
  const names = new Map(architecture.nodes.map((n) => [n.id, n.name]));
  const maxKind = stats.kinds[0]?.[1] ?? 1;
  const generated = architecture.generatedAt ? Date.parse(architecture.generatedAt) : NaN;

  const usageCost =
    usage.status === "ok"
      ? (usage.data.totals.costUsd ??
        usage.data.byModel.reduce((s, m) => s + (costOf(m, prices) ?? 0), 0))
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Dashboard">
        <RescanButton />
        <Link
          to="/map"
          className="flex h-7 items-center gap-1.5 rounded-md bg-foreground/[0.06] px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-foreground/10"
        >
          <MapIcon className="size-3.5" />
          Open map
        </Link>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-8 max-md:px-4 max-md:py-6">
          {/* repo header */}
          <header className="flex flex-col gap-2">
            <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-foreground">
              {app.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
              {daemon.root ? <span className="truncate font-mono text-[12px]">{daemon.root}</span> : null}
              {daemon.source === "sample" ? (
                <span className="text-warn">Sample data — no daemon connected</span>
              ) : null}
              <span className="flex items-center gap-2">
                <span className={cn("size-1.5 rounded-full", agentDotClass(daemon))} />
                {daemon.source !== "daemon"
                  ? "Agent offline"
                  : daemon.agentSwitch
                    ? `Starting ${daemon.agentSwitch.name}…`
                    : [agentName, modelName, daemon.agent?.state].filter(Boolean).join(" · ") ||
                      "Connecting…"}
              </span>
            </div>
          </header>

          {/* architecture summary */}
          <Section title="Architecture">
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
              <Stat label="Elements" value={formatCount(architecture.nodes.length)} />
              <Stat label="Links" value={formatCount(architecture.edges.length)} />
              <Stat label="Workflows" value={formatCount(architecture.workflows.length)} />
              <Stat label="Layers" value={formatCount(stats.layers)} />
            </div>
            <div className="grid gap-x-10 gap-y-6 pt-2 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Elements by kind</span>
                {stats.kinds.length === 0 ? <Quiet>No elements yet.</Quiet> : null}
                {stats.kinds.slice(0, 8).map(([k, count]) => {
                  const style = kindStyles[k as keyof typeof kindStyles];
                  const Icon = style.icon;
                  return (
                    <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)_2.5rem] items-center gap-3 text-[12.5px]">
                      <span className="flex min-w-0 items-center gap-2 text-foreground/85">
                        <Icon className={cn("size-3.5 shrink-0", style.color)} />
                        <span className="truncate">{style.label}</span>
                      </span>
                      <span className="h-1.5 rounded-full bg-foreground/[0.06]">
                        <span
                          className="block h-full rounded-full bg-foreground/35"
                          style={{ width: `${Math.max(4, (count / maxKind) * 100)}%` }}
                        />
                      </span>
                      <span className="text-right text-muted-foreground tabular-nums">{count}</span>
                    </div>
                  );
                })}
              </div>
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] content-start gap-x-3 gap-y-1.5 text-[12.5px]">
                <dt className="text-muted-foreground">Scanned</dt>
                <dd className="truncate text-foreground/85">
                  {Number.isFinite(generated) ? formatAgo(generated) : "—"}
                </dd>
                <dt className="text-muted-foreground">By</dt>
                <dd className="truncate text-foreground/85">{architecture.generatedBy ?? "hand-written"}</dd>
                <dt className="text-muted-foreground">Last saved</dt>
                <dd className="truncate text-foreground/85">
                  {daemon.lastSavedAt ? formatAgo(daemon.lastSavedAt) : "Not this session"}
                </dd>
                <dt className="text-muted-foreground">Revision</dt>
                <dd className="text-foreground/85 tabular-nums">{daemon.revision || "—"}</dd>
                {architecture.layers?.length ? (
                  <>
                    <dt className="text-muted-foreground">Layers</dt>
                    <dd className="text-foreground/85">{architecture.layers.join(" · ")}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </Section>

          <div className="grid gap-10 border-t border-hairline pt-8 md:grid-cols-2">
            <Section title="Hotspots">
              {stats.hotspots.length === 0 ? (
                <Quiet>No links between elements yet.</Quiet>
              ) : (
                <ul className="-mx-2">
                  {stats.hotspots.map(({ node, links }) => {
                    const style = kindStyles[kindFor(node.type)];
                    const Icon = style.icon;
                    return (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => wb.openNode(node.id)}
                          className="group/row flex h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-accent"
                        >
                          <Icon className={cn("size-4 shrink-0", style.color)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-foreground">{node.name}</span>
                            {node.path ? (
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                {node.path}
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                            {links} links
                          </span>
                          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>

            <Section
              title="Recent agent turns"
              action={
                recent.length ? (
                  <Link to="/agent" className="text-[12px] text-muted-foreground hover:text-foreground">
                    Open agent
                  </Link>
                ) : null
              }
            >
              {recent.length === 0 ? (
                <Quiet>
                  Nothing asked yet this session. Select an element on the map and ask the agent
                  about it.
                </Quiet>
              ) : (
                <ul className="-mx-2">
                  {recent.map((t) => {
                    const st = turnStatus(t);
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => wb.focusTurn(t.id)}
                          className="flex h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-accent"
                        >
                          <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[st.tone])} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-foreground">{t.text}</span>
                            <span className="block truncate text-[11.5px] text-muted-foreground">
                              {names.get(t.nodeId) ?? t.nodeId} · {st.label}
                            </span>
                          </span>
                          <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                            {formatAgo(t.startedAt)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </div>

          <div className="border-t border-hairline pt-8">
            <Section
              title="Usage · 7 days"
              action={
                <Link to="/usage" className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                  Details <ArrowRight className="size-3" />
                </Link>
              }
            >
              {usage.status === "ok" ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
                  <Stat label="Turns" value={formatCount(usage.data.totals.turns)} />
                  <Stat
                    label="Tokens"
                    value={formatTokens(usage.data.totals.inputTokens + usage.data.totals.outputTokens)}
                  />
                  <Stat label="Cost" value={usageCost === null ? "—" : formatUsd(usageCost)} />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-[12px] text-muted-foreground">Top model</span>
                    {(() => {
                      const top = [...usage.data.byModel].sort(
                        (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
                      )[0];
                      return top ? (
                        <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
                          <AgentMark name={agents?.available.find((a) => a.id === top.agentId)?.name ?? top.agentId} />
                          <span className="truncate">{top.model}</span>
                        </span>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">—</span>
                      );
                    })()}
                  </div>
                </div>
              ) : usage.status === "loading" ? (
                <Quiet>Loading…</Quiet>
              ) : (
                <Quiet>No usage recorded yet.</Quiet>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
