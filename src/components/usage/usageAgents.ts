// Adapted from t3code apps/web/src/components/usage/usageProviders.ts (MIT).
// Presentation for the coding agents usage is reported for. Colours come from the design
// tokens (accent first, then neutrals), assigned in a stable order; marks are initials, never
// brand artwork.

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
  const i = active.indexOf(agentId);
  return SERIES[(i === -1 ? active.length : i) % SERIES.length]!;
}
