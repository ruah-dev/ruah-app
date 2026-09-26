// Puts the per-agent limits (CONTRACTS §16) into the shell: the top bar's agent pill shows the
// current agent's tightest window ("62% left · resets 4h") through setAgentLimitHint, and the
// threshold toasts run app-wide. Both are mounted as status items that render no chip (the
// shell mounts status items once, in the top bar). Called once at startup (src/router.tsx).
import { useEffect } from "react";
import { registerStatusItem, setAgentLimitHint } from "@/components/shell/slots";
import { useDaemonSelector } from "@/lib/daemon";
import type { ChipTone } from "@/lib/status-chips";
import { formatAbsolute, limitHintText, severityOf, tightestMeter } from "./agentLimitsModel";
import { useAgentLimits, useLimitSettings, useNow } from "./agentLimitsStore";
import { AgentLimitToasts } from "./AgentLimitToasts";
import { AGENT_ORDER } from "./usageAgents";

const TONE: Record<ReturnType<typeof severityOf>, ChipTone> = { normal: "muted", warn: "warn", critical: "bad" };

/** The limits providers' id for a bridge's agent (Claude is "claude" whichever bridge runs it); null for agents without limits (the mock, custom ACP agents) — never ask the daemon about those. */
function limitsAgentId(agentId: string): string | null {
  const id = agentId === "claude-acp" ? "claude" : agentId;
  return AGENT_ORDER.includes(id) ? id : null;
}

function LimitHintFeeder() {
  const agentId = useDaemonSelector((d) => d.agent?.agents?.currentAgentId ?? null);
  const id = agentId !== null ? limitsAgentId(agentId) : null;
  // Only a known agent reads its limits: an empty scope would ask the daemon for every agent.
  return agentId !== null && id !== null ? <AgentHintFeeder key={agentId} agentId={agentId} limitsId={id} /> : null;
}

function AgentHintFeeder({ agentId, limitsId }: { agentId: string; limitsId: string }) {
  const { report } = useAgentLimits({ agentId: limitsId });
  const [settings] = useLimitSettings();
  const now = useNow(60_000);
  const agent = report?.agents.find((a) => a.agentId === limitsId);
  const text = agent ? limitHintText(agent, now) : null;
  const meter = agent ? tightestMeter(agent) : null;
  const tone = meter ? TONE[severityOf(meter.usedPercent, settings.thresholds)] : "muted";
  const detail =
    agent && meter
      ? `${agent.name} · ${meter.label}: ${Math.round(meter.usedPercent ?? 0)}% used${meter.resetsAt ? ` · resets ${formatAbsolute(meter.resetsAt)}` : ""}`
      : undefined;

  useEffect(() => {
    setAgentLimitHint(agentId, text !== null ? { text, tone, ...(detail !== undefined ? { detail } : {}) } : null);
  }, [agentId, text, tone, detail]);
  useEffect(() => () => setAgentLimitHint(agentId, null), [agentId]);
  return null;
}

function LimitsInShell() {
  return (
    <>
      <LimitHintFeeder />
      <AgentLimitToasts />
    </>
  );
}

export function registerUsageLimits() {
  registerStatusItem({ id: "usage-limits", order: 1000, render: LimitsInShell });
}
