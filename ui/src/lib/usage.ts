// Usage client for the daemon's /api/usage endpoints, plus the formatting and pace helpers the
// Usage page needs. Formatting and pace maths adapted from t3code
// packages/shared/src/usageFormat.ts and usageLimits.ts (MIT).
import { useCallback, useEffect, useState } from "react";
import { useDaemon } from "./daemon";

export type UsageRange = "24h" | "7d" | "30d";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  turns: number;
}

export interface UsageSeriesPoint {
  t: string; // ISO bucket start
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface UsageByModel {
  agentId: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface UsageSummary {
  range: UsageRange;
  totals: UsageTotals;
  series: UsageSeriesPoint[];
  byModel: UsageByModel[];
  byNode?: Array<{
    nodeId: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }>;
  byWorkflow?: Array<{
    workflowId: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }>;
}

export interface UsageLimitWindow {
  id: string;
  label: string;
  kind: "session" | "weekly" | "other";
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface UsageLimitProvider {
  agentId: string;
  name: string;
  status: "available" | "unavailable" | "unknown";
  windows: UsageLimitWindow[];
  note?: string;
}

export interface UsageLimits {
  providers: UsageLimitProvider[];
}

/** "empty" = the endpoint is missing (404) or has nothing recorded. */
export type Fetched<T> =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ok"; data: T };

async function getJson<T>(origin: string, path: string): Promise<Fetched<T>> {
  try {
    const r = await fetch(`${origin}${path}`);
    if (r.status === 404) return { status: "empty" };
    if (!r.ok) return { status: "error", message: `${r.status} ${r.statusText}` };
    const type = r.headers.get("content-type") ?? "";
    // The SPA fallback answers unknown paths with HTML; treat that as "not available yet".
    if (!type.includes("json")) return { status: "empty" };
    return { status: "ok", data: (await r.json()) as T };
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }
}

function useEndpoint<T>(path: string | null, isEmpty: (data: T) => boolean) {
  const daemon = useDaemon();
  const origin = daemon.source === "daemon" ? daemon.httpOrigin : null;
  const [state, setState] = useState<Fetched<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (daemon.source === null) return;
    if (!origin || !path) {
      setState({ status: "empty" });
      return;
    }
    let live = true;
    setState((s) => (s.status === "ok" ? s : { status: "loading" }));
    void getJson<T>(origin, path).then((res) => {
      if (!live) return;
      setState(res.status === "ok" && isEmpty(res.data) ? { status: "empty" } : res);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, path, tick, daemon.source]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return [state, refresh] as const;
}

export function useUsageSummary(range: UsageRange) {
  return useEndpoint<UsageSummary>(
    `/api/usage/summary?range=${range}`,
    (d) => !d || (d.totals?.turns ?? 0) === 0 && (d.series?.length ?? 0) === 0,
  );
}

export function useUsageLimits() {
  return useEndpoint<UsageLimits>("/api/usage/limits", (d) => !d || !d.providers?.length);
}

// ---------------------------------------------------------------------------
// price overrides (per model id, localStorage) — used when the daemon reports costUsd: null

export interface ModelPrice {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWriteCostPerMillionTokens?: number;
}

const PRICE_KEY = "ruah.usage.prices.v1";
const PRICE_EVENT = "ruah:usage-prices";

export function readPrices(): Record<string, ModelPrice> {
  try {
    const raw = window.localStorage.getItem(PRICE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ModelPrice>) : {};
  } catch {
    return {};
  }
}

export function writePrices(prices: Record<string, ModelPrice>) {
  try {
    window.localStorage.setItem(PRICE_KEY, JSON.stringify(prices));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(PRICE_EVENT));
}

export function usePrices() {
  const [prices, setPrices] = useState<Record<string, ModelPrice>>({});
  useEffect(() => {
    setPrices(readPrices());
    const on = () => setPrices(readPrices());
    window.addEventListener(PRICE_EVENT, on);
    return () => window.removeEventListener(PRICE_EVENT, on);
  }, []);
  return prices;
}

/** Daemon cost when known, else an estimate from a price override, else null (unpriced). */
export function costOf(
  row: { model: string; inputTokens: number; outputTokens: number; costUsd: number | null },
  prices: Record<string, ModelPrice>,
): number | null {
  if (row.costUsd !== null) return row.costUsd;
  const p = prices[row.model];
  if (!p) return null;
  return (
    (row.inputTokens * p.inputCostPerMillionTokens + row.outputTokens * p.outputCostPerMillionTokens) /
    1e6
  );
}

// ---------------------------------------------------------------------------
// formatting (t3code usageFormat.ts)

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const INTEGER = new Intl.NumberFormat("en-US");

export const formatUsd = (v: number) => CURRENCY.format(v);
export const formatCount = (v: number) => INTEGER.format(Math.round(v));
export const formatPercent = (share: number, digits = 1) => `${(share * 100).toFixed(digits)}%`;

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local calendar day (YYYY-MM-DD) of an instant. */
export function localDay(instant: number | string): string {
  const d = new Date(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDayShort(day: string): string {
  const [, month, dom] = day.split("-").map(Number);
  if (!month || !dom) return day;
  return `${MONTHS[month - 1] ?? ""} ${dom}`;
}

export function formatHourShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(d);
}

/** Bucket keys covering the range, oldest first: hour starts (24h) or local days. */
export function bucketsFor(range: UsageRange, now = Date.now()): string[] {
  if (range === "24h") {
    const hour = 3_600_000;
    const end = Math.floor(now / hour) * hour;
    return Array.from({ length: 24 }, (_, i) => new Date(end - (23 - i) * hour).toISOString());
  }
  const days = range === "7d" ? 7 : 30;
  const out: string[] = [];
  const today = new Date(now);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push(localDay(d.getTime()));
  }
  return out;
}

export function bucketOf(range: UsageRange, t: string): string {
  if (range === "24h") {
    const hour = 3_600_000;
    return new Date(Math.floor(Date.parse(t) / hour) * hour).toISOString();
  }
  return localDay(t);
}

// ---------------------------------------------------------------------------
// limits pace (t3code usageLimits.ts). Windows carry no length, so it comes from the kind.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WINDOW_LENGTH: Record<UsageLimitWindow["kind"], number | null> = {
  session: 5 * HOUR,
  weekly: 7 * DAY,
  other: null,
};

export function remainingPercent(w: UsageLimitWindow): number | null {
  if (w.usedPercent === null) return null;
  return Math.round(100 - Math.max(0, Math.min(100, w.usedPercent)));
}

export function elapsedShare(w: UsageLimitWindow, now: number): number | null {
  const length = WINDOW_LENGTH[w.kind];
  const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (length === null || !Number.isFinite(resetsAt)) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(w: UsageLimitWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(w, now);
  if (elapsed === null || w.usedPercent === null) return null;
  const gap = w.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(w: UsageLimitWindow, now: number): string | null {
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!Number.isFinite(at)) return null;
  return at <= now ? "resets now" : `resets in ${formatDuration(at - now)}`;
}

/** "3m ago", "2h ago", "Sep 21". */
export function formatAgo(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 45_000) return "just now";
  if (d < HOUR) return `${Math.round(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d ago`;
  return formatDayShort(localDay(ms));
}
