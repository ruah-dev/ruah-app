// src/usage/limits/common.ts — what every limits provider shares: the context
// it runs in (clock, env, CLI runner, fetch — tests pass fakes), the provider
// interface, and small defensive helpers for untyped JSON.
import type { AgentLimits, AgentLimitsStatus, LimitMeter } from "../../contracts/agent-limits.js";
import { defaultRunner, redact, type Runner } from "../../integrations/exec.js";

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: "GET" }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export interface LimitsContext {
  now: () => number;
  env: NodeJS.ProcessEnv;
  /** Runs agent CLIs (execFile, args array, bounded output). */
  run: Runner;
  /** Read-only HTTP GET (Cursor's usage endpoint). */
  fetch: FetchLike;
  /** Ruah's version, for User-Agent headers. */
  version: string;
  debug: (line: string) => void;
  /**
   * Aborted when the service gives up on this read (its timeout): providers
   * pass it to the CLIs and requests they start, so nothing outlives the read.
   */
  signal?: AbortSignal;
}

/** Run options for a provider's CLI call: its timeout plus the read's abort signal. */
export function runOptions(ctx: LimitsContext, timeoutMs: number): { timeoutMs: number; signal?: AbortSignal } {
  return ctx.signal !== undefined ? { timeoutMs, signal: ctx.signal } : { timeoutMs };
}

export interface LimitsProvider {
  readonly id: string;
  readonly name: string;
  /** How long a reading is reused before the source is asked again. */
  readonly ttlMs: number;
  read(ctx: LimitsContext): Promise<AgentLimits>;
}

export function defaultContext(patch: Partial<LimitsContext> = {}): LimitsContext {
  return {
    now: Date.now,
    env: process.env,
    run: defaultRunner,
    fetch: (url, init) => fetch(url, { ...init, method: "GET", redirect: "error" }),
    version: "0.0.0",
    debug: () => {},
    ...patch,
  };
}

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** A finite number, also from a numeric string (proto int64 comes as "1759276800000"). */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function percentOf(used: number | undefined, limit: number | undefined): number | null {
  if (used === undefined || limit === undefined || !(limit > 0)) return null;
  return round(clampPercent((used / limit) * 100));
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * An instant from whatever a provider sends: ISO string, epoch milliseconds
 * (number or digit string, ≥ 1e11) or epoch seconds. Null when unusable.
 */
export function isoFrom(value: unknown): string | null {
  const n = num(value);
  if (n !== undefined) {
    if (!(n > 0)) return null;
    const ms = n >= 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = str(value);
  if (s === undefined) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "pro_plus" → "Pro+", "KIRO PRO" → "Kiro Pro", "max" → "Max". */
export function planName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const known: Record<string, string> = {
    pro_plus: "Pro+",
    "pro-plus": "Pro+",
    proplus: "Pro+",
    free_trial: "Free trial",
    enterprise: "Enterprise",
    team: "Team",
  };
  const key = raw.trim().toLowerCase();
  if (known[key] !== undefined) return known[key];
  if (/[+]/.test(raw)) return raw.trim();
  return key
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** An error message that is safe to show: no secrets, no stack, bounded. */
export function safeMessage(err: unknown, secrets: readonly (string | undefined)[] = []): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = redact(raw.replace(/\s+/g, " ").trim(), secrets);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The skeleton every provider fills in. */
export function agentLimits(
  id: string,
  name: string,
  status: AgentLimitsStatus,
  fields: Partial<Omit<AgentLimits, "agentId" | "name" | "status">> & { checkedAt: string; source: string },
): AgentLimits {
  return {
    agentId: id,
    name,
    installed: fields.installed ?? true,
    loggedIn: fields.loggedIn ?? null,
    plan: fields.plan ?? null,
    status,
    meters: fields.meters ?? [],
    ...fields,
  } as AgentLimits;
}

/** Meters sorted: session, weekly, monthly, credits, other; stable within a kind. */
export function sortMeters(meters: LimitMeter[]): LimitMeter[] {
  const order: Record<LimitMeter["kind"], number> = { session: 0, weekly: 1, monthly: 2, credits: 3, other: 4 };
  return meters
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order[a.m.kind] - order[b.m.kind] || a.i - b.i)
    .map(({ m }) => m);
}

/** Drops ANSI escapes (colours, cursor moves) from CLI output. */
export function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/** Parses "9.6M", "206.7K", "1,449", "$0.00" (approximate for suffixed values). */
export function parseCompactNumber(text: string): number | undefined {
  const m = /^\$?\s*(-?[\d,]*\.?\d+)\s*([KMBT])?$/i.exec(text.trim());
  if (m === null) return undefined;
  const base = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Math.round(base * (m[2] !== undefined ? mult[m[2].toUpperCase()]! : 1) * 1e6) / 1e6;
}
