// Per-agent plan limits (CONTRACTS §16, GET /api/usage/agents): the viewer's copy of the
// contract types plus the pure helpers the cards, the top-bar hint and the toasts share.
// Kept here, not in lib/contracts.ts, so the feature stays self-contained.

export type AgentLimitsStatus = "ok" | "partial" | "not_installed" | "not_logged_in" | "unsupported" | "error";

export interface LimitMeter {
  id: string;
  label: string;
  kind: "session" | "weekly" | "monthly" | "credits" | "other";
  usedPercent: number | null;
  used?: number | null;
  limit?: number | null;
  unit?: "usd" | "credits" | "requests" | "tokens";
  resetsAt: string | null;
  periodStart?: string | null;
  detail?: string;
}

export interface OnDemandSpend {
  enabled: boolean;
  used: number | null;
  limit: number | null;
  currency: string;
  scope?: "personal" | "team";
  note?: string;
}

export interface ModelUsage {
  model: string;
  turns?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number | null;
}

export interface LocalUsage {
  source: string;
  since: string | null;
  sessions?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  approximate: boolean;
  byModel: ModelUsage[];
}

export interface UsageEstimate {
  label: "estimate";
  since: string;
  until: string;
  basis: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costedTurns: number;
  byModel: ModelUsage[];
}

export interface AgentLimits {
  agentId: string;
  name: string;
  installed: boolean;
  loggedIn: boolean | null;
  plan: string | null;
  status: AgentLimitsStatus;
  reason?: string;
  action?: string;
  meters: LimitMeter[];
  onDemand?: OnDemandSpend;
  local?: LocalUsage;
  estimate?: UsageEstimate;
  source: string;
  checkedAt: string;
  stale?: boolean;
  dashboardUrl?: string;
  /** §21.1: plan usage needs the agent app's saved login; whether reading it is allowed (card switch). */
  appLogin?: { readAppLogins: boolean; source: "settings" | "env" | "default"; app: string };
}

/**
 * The card's "what to do" line. While the §21.1 switch is on the card and off, the daemon's action
 * ("turn on Read Cursor's saved login here or in Settings …") would only repeat the switch right
 * above it; when the environment decides, the switch is locked and the action says how to change it.
 */
export function cardAction(agent: Pick<AgentLimits, "action" | "appLogin">): string | undefined {
  if (agent.appLogin && !agent.appLogin.readAppLogins && agent.appLogin.source !== "env") return undefined;
  return agent.action;
}

export interface AgentLimitsReport {
  checkedAt: string;
  agents: AgentLimits[];
}

// ---------------------------------------------------------------------------
// thresholds

export interface LimitThresholds {
  /** Percent used at which a meter turns amber. */
  warn: number;
  /** Percent used at which a meter turns red. */
  critical: number;
}

export const DEFAULT_THRESHOLDS: LimitThresholds = { warn: 80, critical: 95 };

export type Severity = "normal" | "warn" | "critical";

export function severityOf(usedPercent: number | null, t: LimitThresholds): Severity {
  if (usedPercent === null) return "normal";
  if (usedPercent >= t.critical) return "critical";
  if (usedPercent >= t.warn) return "warn";
  return "normal";
}

/** Keeps thresholds in 1–100 with warn below critical. */
export function normalizeThresholds(input: Partial<LimitThresholds>): LimitThresholds {
  const clamp = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(100, Math.round(v))) : fallback;
  const critical = clamp(input.critical, DEFAULT_THRESHOLDS.critical);
  const warn = Math.min(clamp(input.warn, DEFAULT_THRESHOLDS.warn), Math.max(1, critical - 1));
  return { warn, critical };
}

// ---------------------------------------------------------------------------
// time

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3d 4h", "2h 14m", "25m". */
export function formatDuration(ms: number): string {
  const r = Math.max(0, ms);
  const d = Math.floor(r / DAY);
  const h = Math.floor((r % DAY) / HOUR);
  const m = Math.floor((r % HOUR) / MINUTE);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3d", "4h", "25m" — the top-bar hint's one-unit form. */
export function formatDurationShort(ms: number): string {
  const r = Math.max(0, ms);
  if (r >= DAY) return `${Math.floor(r / DAY)}d`;
  if (r >= HOUR) return `${Math.floor(r / HOUR)}h`;
  return `${Math.max(1, Math.floor(r / MINUTE))}m`;
}

export function msUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at - now : null;
}

/** "resets in 3d 4h" / "expires in 2h 5m" / "resets now"; null without a time. */
export function formatResetsIn(meter: Pick<LimitMeter, "resetsAt" | "detail">, now: number): string | null {
  const ms = msUntil(meter.resetsAt, now);
  if (ms === null) return null;
  const verb = meter.detail?.startsWith("Expires") ? "expires" : "resets";
  return ms <= 0 ? `${verb} now` : `${verb} in ${formatDuration(ms)}`;
}

/** "Mon, Sep 29, 9:00 AM" in the viewer's locale and zone. */
export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** "just now", "3m ago", "2h ago". */
export function formatAgo(iso: string, now: number): string {
  const d = now - Date.parse(iso);
  if (!Number.isFinite(d) || d < 45_000) return "just now";
  if (d < HOUR) return `${Math.round(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return `${Math.round(d / DAY)}d ago`;
}

/** Share of the window already elapsed (0–1), when its start and end are known. */
export function elapsedShare(meter: Pick<LimitMeter, "resetsAt" | "periodStart">, now: number): number | null {
  const end = meter.resetsAt ? Date.parse(meter.resetsAt) : NaN;
  const start = meter.periodStart ? Date.parse(meter.periodStart) : NaN;
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return null;
  return Math.max(0, Math.min(1, (now - start) / (end - start)));
}

// ---------------------------------------------------------------------------
// amounts

export function formatMoney(value: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatAmount(value: number, unit: LimitMeter["unit"]): string {
  if (unit === "usd") return formatMoney(value);
  const n = Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return unit ? `${n} ${unit}` : n;
}

export function formatTokens(value: number): string {
  const trim = (v: number) => v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2).replace(/\.0+$/, "");
  if (value >= 1e9) return `${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// the hint and the headline meter

/** Rate windows beat monthly pools for "what stops me next": session, weekly, then the rest. */
const KIND_WEIGHT: Record<LimitMeter["kind"], number> = { session: 0, weekly: 1, monthly: 2, credits: 3, other: 4 };

/** The meter closest to its limit (ties: the shorter window). Null when no meter has a percent. */
export function tightestMeter(agent: Pick<AgentLimits, "meters">): LimitMeter | null {
  let best: LimitMeter | null = null;
  for (const m of agent.meters) {
    if (m.usedPercent === null) continue;
    if (
      best === null ||
      m.usedPercent > (best.usedPercent ?? -1) ||
      (m.usedPercent === best.usedPercent && KIND_WEIGHT[m.kind] < KIND_WEIGHT[best.kind])
    ) {
      best = m;
    }
  }
  return best;
}

/** "62% left · resets 4h"; null when the agent has no meter with a percent. */
export function limitHintText(agent: Pick<AgentLimits, "meters">, now: number): string | null {
  const m = tightestMeter(agent);
  if (m === null || m.usedPercent === null) return null;
  const left = Math.max(0, Math.round(100 - m.usedPercent));
  const ms = msUntil(m.resetsAt, now);
  const verb = m.detail?.startsWith("Expires") ? "expires" : "resets";
  return ms === null ? `${left}% left` : `${left}% left · ${verb} ${ms <= 0 ? "now" : formatDurationShort(ms)}`;
}

export const STATUS_LABEL: Record<AgentLimitsStatus, string> = {
  ok: "",
  partial: "Partial",
  error: "Could not read",
  unsupported: "No plan limits",
  not_logged_in: "Not signed in",
  not_installed: "Not installed",
};

/** Signed-in agents with data first (the daemon already orders them; this keeps it stable). */
export function orderForDisplay(agents: AgentLimits[]): AgentLimits[] {
  const rank: Record<AgentLimitsStatus, number> = { ok: 0, partial: 1, error: 2, unsupported: 3, not_logged_in: 4, not_installed: 5 };
  return agents.map((a, i) => ({ a, i })).sort((x, y) => rank[x.a.status] - rank[y.a.status] || x.i - y.i).map(({ a }) => a);
}

// ---------------------------------------------------------------------------
// toasts: which crossings to announce, once per window

export interface LimitCrossing {
  /** The dedupe keys to remember once announced (this level and the ones below it). */
  keys: string[];
  agentId: string;
  agentName: string;
  meter: LimitMeter;
  level: Exclude<Severity, "normal">;
}

/**
 * The window a reset time names, to the minute: two sources can report the same reset a second
 * apart (Claude's get_usage "…:59.591Z" vs a streamed event's "…:00.000Z"), which must not look
 * like a new window and toast again.
 */
function windowKey(resetsAt: string | null): string {
  if (!resetsAt) return "none";
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) ? new Date(Math.round(at / MINUTE) * MINUTE).toISOString() : resetsAt;
}

function crossingKey(agentId: string, meter: LimitMeter, level: Exclude<Severity, "normal">): string {
  return `${agentId}|${meter.id}|${level}|${windowKey(meter.resetsAt)}`;
}

/**
 * Meters at or over a threshold not yet announced in this window. One crossing per meter, at its
 * highest level: jumping straight to critical does not also announce warn.
 */
export function limitCrossings(
  agents: AgentLimits[],
  thresholds: LimitThresholds,
  announced: ReadonlySet<string>,
): LimitCrossing[] {
  const out: LimitCrossing[] = [];
  for (const agent of agents) {
    if (agent.stale) continue;
    for (const meter of agent.meters) {
      const level = severityOf(meter.usedPercent, thresholds);
      if (level === "normal") continue;
      const key = crossingKey(agent.agentId, meter, level);
      if (announced.has(key)) continue;
      const keys = level === "critical" ? [key, crossingKey(agent.agentId, meter, "warn")] : [key];
      out.push({ keys, agentId: agent.agentId, agentName: agent.name, meter, level });
    }
  }
  return out;
}
