// What the top bar's status chips say, as pure functions: the open project's cloud health
// ("9 ok · 1 degraded", §9 health within the §14 scope) and the current agent's remaining limit
// (the hint fed through shell/slots.ts setAgentLimitHint). No React; unit-tested in
// ui/test/status-chips.test.ts.
import type { CloudResource, CloudSyncResult, IntegrationInfo } from "./contracts";

export type ChipTone = "ok" | "warn" | "bad" | "muted";

/** Whether any cloud provider is connected. Uses the integrations list when it was loaded (it
 * spawns provider CLIs, so the chip never asks for it); otherwise a snapshot that was ever synced
 * or holds resources says a provider was connected. */
export function cloudConnected(
  integrations: readonly Pick<IntegrationInfo, "family" | "status">[] | null,
  snapshot: Pick<CloudSyncResult, "resources" | "syncedAt"> | null,
): boolean {
  if (integrations) return integrations.some((i) => i.family === "cloud" && i.status === "connected");
  return !!snapshot && (snapshot.syncedAt !== null || snapshot.resources.length > 0);
}

export interface CloudSummary {
  tone: ChipTone;
  /** "9 ok · 1 degraded" */
  label: string;
  /** Shorter form for narrow windows: "1 degraded" / "9 ok". */
  short: string;
  /** Counts in the project's scope. */
  healthy: number;
  degraded: number;
  down: number;
  deploying: number;
  /** Resources whose provider says "unknown" (scaled to 0, never ran): neither ok nor a problem. */
  unknown: number;
  total: number;
  /** Names of the unhealthy resources (tooltip), worst first. */
  unhealthy: string[];
}

/** A resource without `scope` comes from an older daemon: counted in (as the Cloud page does). */
const inScope = (r: Pick<CloudResource, "scope">) => r.scope === undefined || r.scope.in;

/**
 * The chip for the open project's cloud: null (hidden) when no provider is connected or nothing
 * is in the project's scope. Resources without a health notion count as ok when their status
 * does not say otherwise; "unknown" health (§9.3: scaled to 0, never ran) is left out of the
 * label and the tone.
 */
export function cloudHealthSummary(
  resources: readonly Pick<CloudResource, "name" | "health" | "status" | "scope">[],
  connected: boolean,
): CloudSummary | null {
  if (!connected) return null;
  const scoped = resources.filter(inScope);
  if (scoped.length === 0) return null;
  let healthy = 0;
  let degraded = 0;
  let down = 0;
  let deploying = 0;
  let unknown = 0;
  const bad: string[] = [];
  const warn: string[] = [];
  for (const r of scoped) {
    const h = r.health ?? statusHealth(r.status);
    if (h === "unknown") unknown += 1;
    else if (h === "down") {
      down += 1;
      bad.push(r.name);
    } else if (h === "degraded") {
      degraded += 1;
      warn.push(r.name);
    } else if (h === "deploying") deploying += 1;
    else healthy += 1;
  }
  const parts = [
    healthy ? `${healthy} ok` : "",
    degraded ? `${degraded} degraded` : "",
    down ? `${down} down` : "",
    deploying ? `${deploying} deploying` : "",
  ].filter(Boolean);
  // Nothing reports a health (all unknown): say how many, quietly.
  const count = `${scoped.length} resource${scoped.length === 1 ? "" : "s"}`;
  const tone: ChipTone = down ? "bad" : degraded ? "warn" : parts.length ? "ok" : "muted";
  const short = down
    ? `${down} down`
    : degraded
      ? `${degraded} degraded`
      : deploying
        ? `${deploying} deploying`
        : healthy
          ? `${healthy} ok`
          : count;
  return {
    tone,
    label: parts.length ? parts.join(" · ") : count,
    short,
    healthy,
    degraded,
    down,
    deploying,
    unknown,
    total: scoped.length,
    unhealthy: [...bad, ...warn],
  };
}

/** Older providers report a status string only ("error", "stopped", "running" …). */
function statusHealth(status: string | undefined): "down" | "degraded" | "deploying" | "ok" {
  const s = (status ?? "").toLowerCase();
  if (/(error|fail|unhealthy|crash)/.test(s)) return "down";
  if (/degraded/.test(s)) return "degraded";
  if (/(pending|creating|deploying|updating|progress|starting|provisioning|building)/.test(s)) return "deploying";
  return "ok";
}

/** A remaining-limit hint for the agent pill (setAgentLimitHint). */
export interface LimitHint {
  /** "62% left", "resets 14:00" */
  text: string;
  tone?: ChipTone;
  /** Tooltip line: "5-hour window · resets at 14:00". */
  detail?: string;
}

/**
 * A hint as given (a plain string or a LimitHint). A plain "N% left" gets a tone: ≤ 10 % red,
 * ≤ 25 % amber; anything else stays quiet.
 */
export function normalizeLimitHint(hint: string | LimitHint | null | undefined): LimitHint | null {
  if (hint === null || hint === undefined) return null;
  const h: LimitHint = typeof hint === "string" ? { text: hint } : hint;
  const text = h.text.trim();
  if (!text) return null;
  if (h.tone) return { ...h, text };
  const m = /(\d+(?:\.\d+)?)\s*%\s*(left|remaining)/i.exec(text);
  const left = m ? Number(m[1]) : null;
  const tone: ChipTone = left === null ? "muted" : left <= 10 ? "bad" : left <= 25 ? "warn" : "muted";
  return { ...h, text, tone };
}
