// Dashboard: the repo at a glance, built only from what the daemon already serves
// (architecture.json over the socket, agent.status, this session's turns, /api/usage).
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Download, Map as MapIcon, RefreshCw } from "lucide-react";
import { downloadDrawio } from "@/lib/export";
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
import { useProjectActions } from "@/components/projects/useProjectActions";
import { relativeTime } from "@/lib/time";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Phantom } from "@/components/brand/Phantom";

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
    <section className={cn("card-warm flex min-w-0 flex-col gap-3 p-5 max-md:p-4", className)}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="heading text-title text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={hint}>
      <span className="eyebrow">{label}</span>
      <span className="heading text-[24px] text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** The current project's chats (§5), newest first. */
function RecentChats() {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const chats = daemon.chats.slice(0, 5);
  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;
  return (
    <Section
      title="Recent chats"
      action={
        <Link to="/chats" className="text-[12px] text-muted-foreground hover:text-foreground">
          All chats
        </Link>
      }
    >
      {chats.length === 0 ? (
        <div className="flex items-center gap-4 py-2">
          <Phantom expression="agent" size={44} />
          <Quiet>
            No chats in this project yet. Select an element on the map and ask the agent about it —
            or{" "}
            <button type="button" onClick={actions.startChat} className="text-primary underline-offset-2 hover:underline">
              start a chat
            </button>
            .
          </Quiet>
        </div>
      ) : (
        <ul className="-mx-2">
          {chats.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => void actions.showChat(c)}
                className="flex h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-accent"
              >
                <AgentMark name={agentName(c.agentId)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-foreground">{c.title || "Untitled chat"}</span>
                  <span className="block truncate text-meta text-muted-foreground">
                    {c.turnCount} {c.turnCount === 1 ? "turn" : "turns"}
                    {c.model ? ` · ${c.model}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-label text-muted-foreground tabular-nums">
                  {relativeTime(c.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[12.5px] leading-relaxed text-muted-foreground">{children}</p>;
}

function RescanButton() {
  const { daemon } = useWorkspace();
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({ kind: "idle" });
  const disabled = daemon.httpOrigin === null || state.kind === "busy";
  const run = () => {
    if (daemon.httpOrigin === null) return;
    setState({ kind: "busy" });
    // POST /api/rescan re-runs the scanner and keeps hand edits; the new map
    // arrives over the socket as an `architecture` message.
    fetch(`${daemon.httpOrigin}/api/rescan`, { method: "POST" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { nodes?: number; edges?: number; error?: string };
        if (!res.ok) throw new Error(body.error ?? `rescan failed (${res.status})`);
        setState({ kind: "done", text: `${body.nodes ?? 0} elements · ${body.edges ?? 0} links` });
        setTimeout(() => setState({ kind: "idle" }), 2400);
      })
      .catch((err: unknown) => setState({ kind: "error", text: err instanceof Error ? err.message : "rescan failed" }));
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={run}
          disabled={disabled}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {state.kind === "done" ? (
            <Phantom expression="success" size={14} />
          ) : state.kind === "busy" ? (
            <Phantom expression="loading" size={14} />
          ) : state.kind === "error" ? (
            <Phantom expression="error" size={14} />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {state.kind === "busy" ? "Rescanning…" : state.kind === "done" ? state.text : state.kind === "error" ? "Rescan failed" : "Rescan"}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {state.kind === "error"
          ? state.text
          : "Scan the repo again. Descriptions, notes and positions you edited are kept."}
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void downloadDrawio(daemon.httpOrigin)}
              disabled={daemon.source !== "daemon"}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Download className="size-3.5" />
              Export draw.io
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            Download the architecture as a draw.io file: a page per level and workflow, plus a
            Specifications page with every element's tech, files, links, cloud resources and issues.
          </TooltipContent>
        </Tooltip>
        <Link
          to="/map"
          className="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <MapIcon className="size-3.5" />
          Open map
        </Link>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 max-md:px-4 max-md:py-6">
          {/* repo header */}
          <header className="flex flex-col gap-2 pb-2">
            <p className="eyebrow">Project</p>
            <h1 className="heading text-[26px] text-foreground max-md:text-[22px]">
              {app.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
              {daemon.root ? <span className="truncate font-mono text-[12px]">{daemon.root}</span> : null}
              {daemon.source === "sample" ? (
                <span className="rounded-pill bg-warn/12 px-2 py-0.5 text-warn">Sample data — no daemon connected</span>
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
                <span className="eyebrow">Elements by kind</span>
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
                      <span className="h-1.5 rounded-full bg-surface-3">
                        <span
                          className={cn("block h-full rounded-full opacity-85", style.bar)}
                          style={{ width: `${Math.max(4, (count / maxKind) * 100)}%` }}
                        />
                      </span>
                      <span className="text-right text-muted-foreground tabular-nums">{count}</span>
                    </div>
                  );
                })}
              </div>
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] content-start gap-x-3 gap-y-1.5 text-[12.5px]">
                <dt className="text-faint">Scanned</dt>
                <dd className="truncate text-foreground/85">
                  {Number.isFinite(generated) ? formatAgo(generated) : "—"}
                </dd>
                <dt className="text-faint">By</dt>
                <dd className="truncate text-foreground/85">{architecture.generatedBy ?? "hand-written"}</dd>
                <dt className="text-faint">Last saved</dt>
                <dd className="truncate text-foreground/85">
                  {daemon.lastSavedAt ? formatAgo(daemon.lastSavedAt) : "Not this session"}
                </dd>
                <dt className="text-faint">Revision</dt>
                <dd className="text-foreground/85 tabular-nums">{daemon.revision || "—"}</dd>
                {architecture.layers?.length ? (
                  <>
                    <dt className="text-faint">Layers</dt>
                    <dd className="text-foreground/85">{architecture.layers.join(" · ")}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
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
                              <span className="block truncate font-mono text-[11px] text-faint">
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

            {daemon.projectsSupported ? (
              <RecentChats />
            ) : (
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
            )}
          </div>

          <div>
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
                    <span className="eyebrow">Top model</span>
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
