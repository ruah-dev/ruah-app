// Adapted from t3code apps/server/src/provider/Layers/claudeUsageLimits.ts and apps/server/src/provider/providerUsageLimits.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/usage/claude-limits.ts — Claude Code subscription windows. Both sources
// produce windows with the same ids so a turn-driven `rate_limit_event` lands
// on the row the SDK's `get_usage` read established:
//
// - `get_usage` (on demand, a control request — never a model turn) reports
//   every window at once as 0–100 percentages with ISO reset times.
// - `rate_limit_event` (streamed during a turn) names one window at a time
//   with a 0–1 utilization fraction and an epoch-seconds reset.
//
// Effect (Ref, DateTime, Option) replaced by a plain class and Date; t3code's
// windowDurationMins and "monthly" kind are dropped (CONTRACTS §2.3 windows).
import type { UsageWindow } from "../contracts/usage.js";
import type { ClaudePlanUsage, RateLimitSample } from "../acp/bridge.js";

const WINDOW_KIND_ORDER: Record<UsageWindow["kind"], number> = { session: 0, weekly: 1, other: 2 };

/**
 * The account-wide windows, keyed by the SDK's `rateLimitType`. Model-scoped
 * weeklies are additive on top of these: the CLI reports them under
 * `rate_limits.model_scoped[]` on `get_usage` and streams the overage-included
 * model bucket as `seven_day_overage_included`.
 */
const WINDOWS: Readonly<Record<string, Pick<UsageWindow, "kind" | "label">>> = {
  five_hour: { kind: "session", label: "Session" },
  seven_day: { kind: "weekly", label: "Weekly" },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export interface ClaudeLimitsSnapshot {
  readonly checkedAt: string;
  readonly windows: readonly UsageWindow[];
  /** "unsupported": plan limits do not apply (API key, Bedrock, Vertex). */
  readonly unavailable?: { readonly reason: "unsupported" | "probeFailed"; readonly message?: string };
}

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(windows: Iterable<UsageWindow>): UsageWindow[] {
  return [...windows].sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] || left.id.localeCompare(right.id));
}

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(displayName: string, usedPercent: number, resetsAt: string | undefined): UsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    usedPercent: clampPercent(usedPercent),
    resetsAt: resetsAt ?? null,
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings, so it is read
 * structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" && entry !== null && typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoFromString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function makeWindow(id: string, usedPercent: number, resetsAt: string | undefined): UsageWindow {
  const window = WINDOWS[id];
  if (window === undefined) throw new Error(`unknown Claude window: ${id}`);
  return { id, ...window, usedPercent: clampPercent(usedPercent), resetsAt: resetsAt ?? null };
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * event before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
export function claudeRateLimitEventToWindows(info: RateLimitSample, names: ClaudeScopedLimitNames): UsageWindow[] | undefined {
  const type = info.rateLimitType;
  if (type === undefined || type.length === 0 || typeof info.utilization !== "number") return undefined;
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) return [makeWindow(type, usedPercent, resetsAt)];
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded !== undefined) {
    return [scopedWindow(names.overageIncluded, usedPercent, resetsAt)];
  }
  return undefined;
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 */
export function claudeUsageResponseToLimits(input: { readonly response: ClaudePlanUsage; readonly checkedAt: string }): {
  readonly limits: ClaudeLimitsSnapshot;
  readonly names: ClaudeScopedLimitNames;
} {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || response.rate_limits === null || typeof response.rate_limits !== "object") {
    return { limits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } }, names: { overageIncluded: undefined } };
  }
  const windows: UsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id];
    if (window === null || typeof window !== "object") continue;
    const { utilization, resets_at } = window as { utilization?: unknown; resets_at?: unknown };
    if (typeof utilization !== "number") continue;
    windows.push(makeWindow(id, utilization, isoFromString(resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)));
    // Only a bucket that drew a row may receive events; naming one that was
    // skipped would let a mid-turn event open a row the probe never showed.
    overageIncluded ??= entry.display_name;
  }
  return { limits: { checkedAt, windows: sortWindows(windows) }, names: { overageIncluded } };
}

/**
 * Fold a sparse update into the current snapshot. Windows upsert by `id`; a
 * window the update omits keeps its previous values, and a window that
 * arrives without `resetsAt` keeps whatever the last probe resolved for it.
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageWindows(previous: ClaudeLimitsSnapshot | undefined, windows: readonly UsageWindow[], checkedAt: string): ClaudeLimitsSnapshot | undefined {
  if (windows.length === 0 || previous?.unavailable?.reason === "unsupported") return previous;
  const merged = new Map((previous?.windows ?? []).map((window) => [window.id, window] as const));
  for (const window of windows) {
    const existing = merged.get(window.id);
    merged.set(window.id, {
      ...window,
      usedPercent: window.usedPercent === null ? null : clampPercent(window.usedPercent),
      resetsAt: window.resetsAt ?? existing?.resetsAt ?? null,
    });
  }
  return { checkedAt, windows: sortWindows(merged.values()) };
}

/** The Claude account's windows as last seen from either source (t3code's scopedLimitNames Ref + provider snapshot). */
export class ClaudeLimitsState {
  private names: ClaudeScopedLimitNames = { overageIncluded: undefined };
  private current: ClaudeLimitsSnapshot | undefined;

  snapshot(): ClaudeLimitsSnapshot | undefined {
    return this.current;
  }

  /** A get_usage answer replaces the snapshot and remembers the scoped bucket names. */
  recordUsageResponse(response: ClaudePlanUsage, checkedAt: string): ClaudeLimitsSnapshot {
    const { limits, names } = claudeUsageResponseToLimits({ response, checkedAt });
    this.names = names;
    this.current = limits;
    return limits;
  }

  /** A streamed rate_limit_event updates one window. */
  recordRateLimit(info: RateLimitSample, checkedAt: string): void {
    const windows = claudeRateLimitEventToWindows(info, this.names);
    if (windows === undefined) return;
    this.current = applyUsageWindows(this.current, windows, checkedAt);
  }
}
