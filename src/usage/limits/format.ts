// src/usage/limits/format.ts — the plain-text report `ruah app usage limits`
// prints: one block per agent, a bar per window, reset countdown with the
// absolute time, on-demand spend, local stats and Ruah's estimate.
import type { AgentLimits, AgentLimitsReport, LimitMeter, LocalUsage, UsageEstimate } from "../../contracts/agent-limits.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BAR = 20;

export function formatDuration(ms: number): string {
  const r = Math.max(0, ms);
  const d = Math.floor(r / DAY);
  const h = Math.floor((r % DAY) / HOUR);
  const m = Math.floor((r % HOUR) / MINUTE);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(iso: string, now: number): string {
  const d = now - Date.parse(iso);
  if (!Number.isFinite(d) || d < 45_000) return "just now";
  if (d < HOUR) return `${Math.round(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return `${Math.round(d / DAY)}d ago`;
}

function when(iso: string, now: number): string {
  const at = new Date(iso);
  const sameWeek = Math.abs(at.getTime() - now) < 6 * DAY;
  return new Intl.DateTimeFormat("en-US", sameWeek
    ? { weekday: "short", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

export function resetText(resetsAt: string | null, now: number, verb = "resets"): string {
  if (resetsAt === null) return "";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  if (at <= now) return `${verb} now`;
  return `${verb} in ${formatDuration(at - now)} (${when(resetsAt, now)})`;
}

function tokens(n: number): string {
  const f = (v: number, s: string) => `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}`.replace(/\.0+$/, "") + s;
  if (n >= 1e9) return f(n / 1e9, "B");
  if (n >= 1e6) return f(n / 1e6, "M");
  if (n >= 1e3) return f(n / 1e3, "K");
  return String(Math.round(n));
}

/** "$4.20"; a currency Intl does not know (a provider's "credits") prints as "4.20 credits" instead of throwing. */
export function money(value: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function amount(value: number, unit: LimitMeter["unit"]): string {
  if (unit === "usd") return money(value);
  const n = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit === undefined ? n : `${n} ${unit}`;
}

function bar(percent: number | null): string {
  if (percent === null) return "·".repeat(BAR);
  const filled = Math.round((percent / 100) * BAR);
  return "█".repeat(filled) + "░".repeat(BAR - filled);
}

function meterLine(m: LimitMeter, now: number, labelWidth: number): string {
  const pct = m.usedPercent === null ? (m.detail ?? "—") : `${Math.round(m.usedPercent)}% used`;
  const amounts = m.used !== null && m.used !== undefined && m.limit !== null && m.limit !== undefined ? ` (${amount(m.used, m.unit)} of ${amount(m.limit, m.unit)})` : "";
  const reset = resetText(m.resetsAt, now, m.detail?.startsWith("Expires") === true ? "expires" : "resets");
  return `  ${m.label.padEnd(labelWidth)}  ${bar(m.usedPercent)}  ${pct}${amounts}${reset ? `  ·  ${reset}` : ""}`;
}

function localLine(local: LocalUsage): string {
  const cost = local.costUsd !== null ? ` · ${money(local.costUsd)}` : "";
  const sessions = local.sessions !== undefined ? `${local.sessions} sessions · ` : "";
  return `  Local stats    ${sessions}${tokens(local.inputTokens + local.outputTokens)} tokens${local.cacheReadTokens > 0 ? ` (+${tokens(local.cacheReadTokens)} cache reads)` : ""}${cost}${local.approximate ? " (rounded)" : ""} — ${local.source}`;
}

function estimateLine(e: UsageEstimate): string {
  const cost = e.costUsd !== null ? ` · ${money(e.costUsd)} agent-reported${e.costedTurns < e.turns ? ` (${e.costedTurns}/${e.turns} turns)` : ""}` : " · no cost reported";
  return `  Ruah estimate  ${e.basis}: ${e.turns} turn${e.turns === 1 ? "" : "s"} · ${tokens(e.inputTokens + e.outputTokens)} tokens${cost}`;
}

const STATUS_TEXT: Record<AgentLimits["status"], string> = {
  ok: "",
  partial: "partial",
  error: "error",
  unsupported: "no plan limits",
  not_logged_in: "not logged in",
  not_installed: "not installed",
};

export function formatAgent(a: AgentLimits, now: number): string {
  const lines: string[] = [];
  const title = `${a.name}${a.plan !== null ? ` · ${a.plan}` : ""}`;
  const status = `${STATUS_TEXT[a.status]}${a.stale === true ? " (stale)" : ""}`;
  lines.push(status ? `${title.padEnd(56)} ${status}` : title);
  const width = Math.max(12, ...a.meters.map((m) => m.label.length));
  for (const m of a.meters) lines.push(meterLine(m, now, width));
  if (a.onDemand !== undefined) {
    const od = a.onDemand;
    const spent = od.used !== null ? money(od.used, od.currency) : "—";
    const cap = od.limit !== null ? ` of ${money(od.limit, od.currency)}` : od.enabled ? " (no cap)" : "";
    lines.push(`  ${"On-demand".padEnd(width)}  ${od.enabled ? `${spent}${cap}` : "off"}${od.scope === "team" ? " · team" : ""}${od.note !== undefined ? ` · ${od.note}` : ""}`);
  }
  if (a.reason !== undefined) lines.push(`  ${a.reason}`);
  if (a.action !== undefined) lines.push(`  → ${a.action}`);
  if (a.local !== undefined) lines.push(localLine(a.local));
  if (a.estimate !== undefined) lines.push(estimateLine(a.estimate));
  lines.push(`  source: ${a.source} · checked ${ago(a.checkedAt, now)}${a.dashboardUrl !== undefined ? ` · ${a.dashboardUrl}` : ""}`);
  return lines.join("\n");
}

export function formatLimitsReport(report: AgentLimitsReport, now: number = Date.now()): string {
  if (report.agents.length === 0) return "No agents.\n";
  return `${report.agents.map((a) => formatAgent(a, now)).join("\n\n")}\n`;
}
