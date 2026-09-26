// One shared reading of GET /api/usage/agents for every consumer (the Limits panel, the top-bar
// hint, the toasts): a module store read with useSyncExternalStore. Each mounted consumer asks for
// what it shows and no more — the panel for every agent, a hint for its own agent only
// (?agent=<id>), the toasts for nothing (they announce what the others read). Every read makes the
// daemon run that agent's CLIs (kiro-cli acp, grok usage…), so a lone top-bar hint must not keep
// every installed agent's CLIs running in the background. Polled every 3 minutes while something
// is mounted and the window is visible; refreshed per agent or all at once. Viewer preferences
// (thresholds, toasts) live in localStorage — per-viewer conveniences only.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useDaemonSelector } from "@/lib/daemon";
import {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  type AgentLimits,
  type AgentLimitsReport,
  type LimitThresholds,
} from "./agentLimitsModel";

export type LimitsLoad =
  | { status: "idle" } // no daemon to ask
  | { status: "loading" }
  | { status: "ok" }
  | { status: "unavailable" } // the daemon predates §16
  | { status: "error"; message: string };

interface Snapshot {
  origin: string | null;
  load: LimitsLoad;
  report: AgentLimitsReport | null;
  /** When every agent was last read; null until a full read (a hint reads one agent). */
  fetchedAt: number | null;
  /** When each agent was last read (a full read counts for each). */
  agentFetchedAt: Readonly<Record<string, number>>;
  /** Agent ids being refreshed; "*" = everything. */
  refreshing: ReadonlySet<string>;
}

/** The scope of a full read (every agent). */
const ALL = "*";
const POLL_MS = 3 * 60_000;
const STALE_MS = 2 * 60_000;

let snapshot: Snapshot = { origin: null, load: { status: "idle" }, report: null, fetchedAt: null, agentFetchedAt: {}, refreshing: new Set() };
const listeners = new Set<() => void>();

function set(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Folds a one-agent answer into the current report. */
export function mergeReport(current: AgentLimitsReport | null, next: AgentLimitsReport, agentId?: string): AgentLimitsReport {
  if (agentId === undefined || current === null) return next;
  const fresh = next.agents.find((a) => a.agentId === agentId);
  if (fresh === undefined) return current;
  const agents: AgentLimits[] = current.agents.some((a) => a.agentId === agentId)
    ? current.agents.map((a) => (a.agentId === agentId ? fresh : a))
    : [...current.agents, fresh];
  return { checkedAt: next.checkedAt, agents };
}

async function load(origin: string, options: { agentId?: string; refresh?: boolean } = {}) {
  const tag = options.agentId ?? ALL;
  set({ refreshing: new Set([...snapshot.refreshing, tag]) });
  const params = new URLSearchParams();
  if (options.agentId) params.set("agent", options.agentId);
  if (options.refresh) params.set("refresh", "1");
  const query = params.toString();
  try {
    const r = await fetch(`${origin}/api/usage/agents${query ? `?${query}` : ""}`);
    if (snapshot.origin !== origin) return;
    const type = r.headers.get("content-type") ?? "";
    // 404 or the SPA's HTML fallback: a daemon from before per-agent limits.
    if (r.status === 404 || !type.includes("json")) {
      if (snapshot.report === null) set({ load: { status: "unavailable" } });
      return;
    }
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      set({ load: { status: "error", message: body.error ?? `${r.status} ${r.statusText}` } });
      return;
    }
    const report = (await r.json()) as AgentLimitsReport;
    const at = Date.now();
    const agentFetchedAt = { ...snapshot.agentFetchedAt };
    for (const a of report.agents) agentFetchedAt[a.agentId] = at;
    set({
      load: { status: "ok" },
      report: mergeReport(snapshot.report, report, options.agentId),
      agentFetchedAt,
      ...(options.agentId ? {} : { fetchedAt: at }),
    });
  } catch (err) {
    if (snapshot.origin === origin) set({ load: { status: "error", message: (err as Error).message } });
  } finally {
    // A daemon switch mid-read already reset the set; the new daemon's reads are not ours to clear.
    if (snapshot.origin === origin) {
      const refreshing = new Set(snapshot.refreshing);
      refreshing.delete(tag);
      set({ refreshing });
    }
  }
}

/** Re-reads one agent (or all) past the daemon's cache (it still throttles to 15 s). */
export function refreshAgentLimits(agentId?: string) {
  const origin = snapshot.origin;
  if (origin) void load(origin, { ...(agentId ? { agentId } : {}), refresh: true });
}

/** §21.1: the daemon's answer to GET/POST /api/usage/settings. */
export interface UsageSettingsView {
  readAppLogins: boolean;
  source: "settings" | "env" | "default";
}

/**
 * §21.1: allow (or stop) reading the Cursor app's saved login for plan usage. Saved by the daemon
 * in settings.json; the daemon drops the old reading, so the card is re-read right away.
 */
export async function setReadAppLogins(on: boolean, originOverride?: string | null): Promise<UsageSettingsView> {
  const origin = originOverride ?? snapshot.origin;
  if (!origin) throw new Error("No daemon connected");
  const r = await fetch(`${origin}/api/usage/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ readAppLogins: on }),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<UsageSettingsView> & { error?: string };
  if (r.status === 404) throw new Error("This setting needs a newer Ruah daemon");
  if (!r.ok || typeof body.readAppLogins !== "boolean") throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  if (snapshot.origin === origin) void load(origin, { agentId: "cursor", refresh: true });
  return { readAppLogins: body.readAppLogins, source: body.source ?? "settings" };
}

/** Mounted consumers per scope ("*" = every agent, else one agent id). */
const scopes = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * What the mounted consumers need read: everything while a full view (the panel) is mounted,
 * else only the agents the hints show. Pure, for tests.
 */
export function scopesToRead(mounted: ReadonlyMap<string, number>): string[] {
  const live = [...mounted].filter(([, n]) => n > 0).map(([scope]) => scope);
  return live.includes(ALL) ? [ALL] : live;
}

function isStale(scope: string): boolean {
  const at = scope === ALL ? snapshot.fetchedAt : (snapshot.agentFetchedAt[scope] ?? null);
  return at === null || Date.now() - at > STALE_MS;
}

function busy(scope: string): boolean {
  return snapshot.refreshing.has(ALL) || snapshot.refreshing.has(scope);
}

function loadScope(origin: string, scope: string) {
  void load(origin, scope === ALL ? {} : { agentId: scope });
}

function startPolling() {
  if (pollTimer !== undefined) return;
  pollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const origin = snapshot.origin;
    if (!origin) return;
    for (const scope of scopesToRead(scopes)) if (!busy(scope)) loadScope(origin, scope);
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
}

/** The current reading without fetching or polling (the toasts, a spinner elsewhere on the page). */
export function useAgentLimitsSnapshot() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * The shared per-agent limits reading; mounting it starts the fetch and the polling for its
 * scope: every agent by default, or only `agentId` (the top-bar hint).
 */
export function useAgentLimits(options: { agentId?: string } = {}) {
  const scope = options.agentId ?? ALL;
  const origin = useDaemonSelector((s) => (s.source === "daemon" ? s.httpOrigin : null));
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  useEffect(() => {
    if (origin !== snapshot.origin) {
      set({ origin, report: null, fetchedAt: null, agentFetchedAt: {}, refreshing: new Set(), load: origin ? { status: "loading" } : { status: "idle" } });
      if (origin) loadScope(origin, scope);
    } else if (origin && !busy(scope) && isStale(scope)) {
      loadScope(origin, scope);
    }
  }, [origin, scope]);

  useEffect(() => {
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
    startPolling();
    const onVisible = () => {
      const current = snapshot.origin;
      if (document.visibilityState === "visible" && current && !busy(scope) && isStale(scope)) loadScope(current, scope);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      const left = (scopes.get(scope) ?? 1) - 1;
      if (left > 0) scopes.set(scope, left);
      else scopes.delete(scope);
      if (scopes.size === 0) stopPolling();
    };
  }, [scope]);

  const refresh = useCallback((agentId?: string) => refreshAgentLimits(agentId), []);
  return { ...snap, refresh };
}

/** A clock that ticks every `intervalMs`, for live countdowns. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------
// viewer settings: warning thresholds and toasts

export interface LimitSettings {
  thresholds: LimitThresholds;
  toasts: boolean;
}

const SETTINGS_KEY = "ruah.usage.limit-settings.v1";
const SETTINGS_EVENT = "ruah:limit-settings";
export const DEFAULT_LIMIT_SETTINGS: LimitSettings = { thresholds: DEFAULT_THRESHOLDS, toasts: true };

export function parseLimitSettings(raw: string | null): LimitSettings {
  if (!raw) return DEFAULT_LIMIT_SETTINGS;
  try {
    const p = JSON.parse(raw) as Partial<{ thresholds: Partial<LimitThresholds>; toasts: unknown }>;
    return {
      thresholds: normalizeThresholds(p.thresholds ?? {}),
      toasts: typeof p.toasts === "boolean" ? p.toasts : DEFAULT_LIMIT_SETTINGS.toasts,
    };
  } catch {
    return DEFAULT_LIMIT_SETTINGS;
  }
}

export function readLimitSettings(): LimitSettings {
  try {
    return parseLimitSettings(window.localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_LIMIT_SETTINGS;
  }
}

export function writeLimitSettings(settings: LimitSettings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: the change lasts for this session */
  }
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: settings }));
}

export function useLimitSettings(): [LimitSettings, (next: LimitSettings) => void] {
  const [settings, setSettings] = useState<LimitSettings>(DEFAULT_LIMIT_SETTINGS);
  useEffect(() => {
    setSettings(readLimitSettings());
    const on = (e: Event) => setSettings((e as CustomEvent<LimitSettings>).detail ?? readLimitSettings());
    window.addEventListener(SETTINGS_EVENT, on);
    return () => window.removeEventListener(SETTINGS_EVENT, on);
  }, []);
  const update = useCallback((next: LimitSettings) => {
    const normalized = { thresholds: normalizeThresholds(next.thresholds), toasts: next.toasts };
    setSettings(normalized);
    writeLimitSettings(normalized);
  }, []);
  return [settings, update];
}

// Announced threshold crossings (so a toast fires once per window and level).
const ANNOUNCED_KEY = "ruah.usage.limit-announced.v1";

export function readAnnounced(): Set<string> {
  try {
    const raw = window.localStorage.getItem(ANNOUNCED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeAnnounced(keys: Set<string>) {
  try {
    window.localStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...keys].slice(-200)));
  } catch {
    /* storage unavailable */
  }
}
