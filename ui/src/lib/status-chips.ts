// What the top bar's status chips say, as pure functions: the open project's cloud health
// ("9 ok · 1 degraded", §9 health within the §14 scope) and the current agent's remaining limit
// (the hint fed through shell/slots.ts setAgentLimitHint). No React; unit-tested in
// ui/test/status-chips.test.ts.
import type { CloudHealth, CloudResource, CloudSyncResult, IntegrationInfo } from "./contracts";
import { healthCounts, isUnhealthy } from "./integrations";

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
  /** Resources without a health notion (§9.2: domains, buckets, a Vercel project's deployment
   * rows): in `total`, not in the label. */
  unrated: number;
  total: number;
  /** Names of the unhealthy resources (tooltip), worst first. */
  unhealthy: string[];
}

/** A resource without `scope` comes from an older daemon: counted in (as the Cloud page does). */
const inScope = (r: Pick<CloudResource, "scope">) => r.scope === undefined || r.scope.in;

/**
 * The chip for the open project's cloud: null (hidden) when no provider is connected or nothing
 * is in the project's scope. Counts what the Cloud page and the rail's Cloud dot count
 * (healthCounts, isUnhealthy): only resources with a `health`. One without has no health notion
 * (§9.2: domains, buckets, a Vercel project's deployment rows, so the project counts once) and is
 * left out, whatever its status says. Only a snapshot where nothing carries a health (an older
 * daemon) reads the status strings instead. "unknown" health (§9.3: scaled to 0, never ran) is
 * left out of the label and the tone.
 */
export function cloudHealthSummary(
  resources: readonly Pick<CloudResource, "name" | "health" | "status" | "scope">[],
  connected: boolean,
): CloudSummary | null {
  if (!connected) return null;
  const scoped = resources.filter(inScope);
  if (scoped.length === 0) return null;
  const legacy = !resources.some((r) => r.health !== undefined);
  const rated = legacy
    ? scoped.map((r) => ({ name: r.name, health: statusHealth(r.status) }))
    : scoped.flatMap((r) => (r.health ? [{ name: r.name, health: r.health }] : []));
  const { healthy, degraded, down, deploying, unknown } = healthCounts(rated);
  const unhealthy = rated.filter(isUnhealthy);
  const bad = unhealthy.filter((r) => r.health === "down").map((r) => r.name);
  const warn = unhealthy.filter((r) => r.health === "degraded").map((r) => r.name);
  const parts = [
    healthy ? `${healthy} ok` : "",
    degraded ? `${degraded} degraded` : "",
    down ? `${down} down` : "",
    deploying ? `${deploying} deploying` : "",
  ].filter(Boolean);
  // Nothing reports a health (all unknown, or no health notion): say how many, quietly.
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
    unrated: scoped.length - rated.length,
    total: scoped.length,
    unhealthy: [...bad, ...warn],
  };
}

/** An older daemon reports a status string only ("error", "stopped", "running" …). */
function statusHealth(status: string | undefined): Exclude<CloudHealth, "unknown"> {
  const s = (status ?? "").toLowerCase();
  if (/(error|fail|unhealthy|crash)/.test(s)) return "down";
  if (/degraded/.test(s)) return "degraded";
  if (/(pending|creating|deploying|updating|progress|starting|provisioning|building)/.test(s)) return "deploying";
  return "healthy";
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
