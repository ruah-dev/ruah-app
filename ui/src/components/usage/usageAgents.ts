// Adapted from t3code apps/web/src/components/usage/usageProviders.ts (MIT).
// Presentation for the coding agents usage is reported for. Colours come from the design
// tokens: a known agent always wears its identity tint (--agent-claude, …: the same colour as
// its ghost and its mark, in every palette), other agents get the categorical series in a
// stable order; marks are initials, never brand artwork.
import { agentTintOf } from "@/components/brand/PhantomPose";

const KNOWN_NAMES: Record<string, string> = {
  claude: "Claude Code",
  cursor: "Cursor Agent",
  grok: "Grok Build",
  kiro: "Kiro CLI",
  opencode: "OpenCode",
};

/** Stable reading order across chart, summaries and tables. */
export const AGENT_ORDER = ["claude", "cursor", "grok", "kiro", "opencode"];

const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];

export function agentLabel(agentId: string, names?: ReadonlyMap<string, string>): string {
  return names?.get(agentId) ?? KNOWN_NAMES[agentId] ?? agentId;
}

/** Agents ordered by AGENT_ORDER, unknown ids after, alphabetically. */
export function orderAgents(ids: Iterable<string>): string[] {
  const set = [...new Set(ids)];
  return set.sort((a, b) => {
    const ia = AGENT_ORDER.indexOf(a);
    const ib = AGENT_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
}

export function agentColor(agentId: string, active: readonly string[]): string {
  const tint = agentTintOf(agentId);
  if (tint) return `var(--agent-${tint})`;
  const others = active.filter((a) => !agentTintOf(a));
  const i = others.indexOf(agentId);
  return SERIES[(i === -1 ? others.length : i) % SERIES.length]!;
}
