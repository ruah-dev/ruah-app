// src/usage/limits/claude.ts — Claude Code: the 5-hour session and weekly
// windows (plus any model-scoped weekly) with reset times, the plan, and
// extra-usage spend. The daemon reads them through UsageLimitsService (live
// get_usage on the current query, a short-lived probe otherwise, streamed
// rate_limit events in between); the CLI runs the probe directly. Neither
// makes a model request.
import type { AgentLimits, LimitMeter, OnDemandSpend } from "../../contracts/agent-limits.js";
import { ClaudeLimitsState, claudeAuthKind, claudeProviderName, type ClaudeLimitsSnapshot } from "../claude-limits.js";
import type { ClaudePlanUsage } from "../../acp/bridge.js";
import { agentLimits, planName, round, safeMessage, type LimitsProvider } from "./common.js";

export const CLAUDE_ID = "claude";
export const CLAUDE_NAME = "Claude Code";
const DASHBOARD = "https://claude.ai/settings/usage";
const HOUR = 3_600_000;
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR };

/** What a Claude source yields: the snapshot (if any) and the last error. */
export interface ClaudePlanReading {
  snapshot: ClaudeLimitsSnapshot | undefined;
  error: string | undefined;
  /** False when nothing can ask Claude (probe disabled, Claude not current). */
  canProbe: boolean;
  /** From the daemon's agent catalog; absent = installed (the SDK ships the CLI). */
  installed?: boolean;
}

export type ClaudePlanSource = () => Promise<ClaudePlanReading>;

const LOGIN_ERROR = /not logged in|log ?in|\/login|authenticat|credential|oauth|invalid api key|unauthori[sz]ed|401/i;
const LOGIN_ACTION = "Run `claude` and sign in with /login.";

function meterOf(window: ClaudeLimitsSnapshot["windows"][number]): LimitMeter {
  const length = WINDOW_MS[window.id] ?? (window.kind === "weekly" ? WINDOW_MS.seven_day : undefined);
  const resets = window.resetsAt !== null ? Date.parse(window.resetsAt) : Number.NaN;
  const periodStart = length !== undefined && Number.isFinite(resets) ? new Date(resets - length).toISOString() : null;
  return {
    id: window.id,
    label: window.id === "five_hour" ? "Session · 5h" : window.label,
    kind: window.kind === "session" ? "session" : window.kind === "weekly" ? "weekly" : "other",
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    periodStart,
  };
}

function onDemandOf(snapshot: ClaudeLimitsSnapshot): OnDemandSpend | undefined {
  const extra = snapshot.extraUsage;
  if (extra === undefined || extra === null) return undefined;
  const currency = (extra.currency ?? "USD").toUpperCase();
  return {
    enabled: extra.is_enabled,
    used: extra.used_credits !== null ? round(extra.used_credits / 100) : null,
    limit: extra.monthly_limit !== null ? round(extra.monthly_limit / 100) : null,
    currency,
    ...(extra.is_enabled ? { note: "Extra usage this month" } : {}),
  };
}

type ClaudeBase = { readonly checkedAt: string; readonly source: string; readonly dashboardUrl: string; readonly installed: true };

/**
 * get_usage reported no plan windows. That is the answer for an API key, a
 * third-party provider and a signed-out CLI alike, so the CLI's account info
 * decides which one it is; without it nothing is claimed about the login.
 */
function claudeWithoutWindows(snapshot: ClaudeLimitsSnapshot, plan: string | null, base: ClaudeBase): AgentLimits {
  const account = snapshot.account;
  switch (claudeAuthKind(account)) {
    case "signed_out":
      return agentLimits(CLAUDE_ID, CLAUDE_NAME, "not_logged_in", {
        ...base,
        loggedIn: false,
        reason: "Claude Code is not signed in.",
        action: LOGIN_ACTION,
      });
    case "api_key":
      return agentLimits(CLAUDE_ID, CLAUDE_NAME, "unsupported", {
        ...base,
        loggedIn: true,
        plan: plan ?? "API key",
        reason: "Plan limits don't apply to an API key: usage is billed per token.",
      });
    case "third_party": {
      const provider = claudeProviderName(account?.apiProvider) ?? "a third-party provider";
      return agentLimits(CLAUDE_ID, CLAUDE_NAME, "unsupported", {
        ...base,
        loggedIn: null,
        plan,
        reason: `Plan limits don't apply: Claude Code runs through ${provider}, which bills per token.`,
      });
    }
    case "claude_ai":
    case "token":
      return agentLimits(CLAUDE_ID, CLAUDE_NAME, "unsupported", {
        ...base,
        loggedIn: true,
        plan,
        reason: "Claude Code is signed in, but reports no plan windows for this login.",
      });
    case "unknown":
      return agentLimits(CLAUDE_ID, CLAUDE_NAME, "unsupported", {
        ...base,
        loggedIn: null,
        plan,
        reason: "Claude reported no plan windows: this login uses an API key, Bedrock or Vertex, or is not signed in.",
        action: `If Claude Code is not signed in: ${LOGIN_ACTION}`,
      });
  }
}

/** Maps a Claude reading to the per-agent shape (pure; tests feed fixtures). */
export function claudeLimitsFromReading(reading: ClaudePlanReading, now: number): AgentLimits {
  const checkedAt = reading.snapshot?.checkedAt ?? new Date(now).toISOString();
  if (reading.installed === false) {
    return agentLimits(CLAUDE_ID, CLAUDE_NAME, "not_installed", {
      checkedAt,
      source: "agent catalog",
      installed: false,
      reason: "Claude Code is not available to Ruah.",
      action: "Reinstall Ruah (it ships Claude Code through the Claude Agent SDK).",
    });
  }
  const base = { checkedAt, source: "Claude Agent SDK · get_usage (no model request)", dashboardUrl: DASHBOARD, installed: true } as const;
  const snapshot = reading.snapshot;
  const plan = planName(snapshot?.subscriptionType ?? undefined);
  if (snapshot?.unavailable?.reason === "unsupported") return claudeWithoutWindows(snapshot, plan, base);
  if (snapshot !== undefined && snapshot.windows.length > 0) {
    const onDemand = onDemandOf(snapshot);
    return agentLimits(CLAUDE_ID, CLAUDE_NAME, "ok", {
      ...base,
      loggedIn: true,
      plan,
      meters: snapshot.windows.map(meterOf),
      ...(onDemand !== undefined ? { onDemand } : {}),
      ...(reading.error !== undefined
        ? { stale: true, reason: `Showing the last reading; the refresh failed: ${safeMessage(reading.error)}` }
        : {}),
    });
  }
  if (reading.error !== undefined) {
    if (LOGIN_ERROR.test(reading.error)) {
      return agentLimits(CLAUDE_ID, CLAUDE_NAME, "not_logged_in", {
        ...base,
        loggedIn: false,
        reason: `Claude Code is not signed in (${safeMessage(reading.error)}).`,
        action: LOGIN_ACTION,
      });
    }
    return agentLimits(CLAUDE_ID, CLAUDE_NAME, "error", {
      ...base,
      plan,
      reason: `Could not read Claude's plan limits: ${safeMessage(reading.error)}`,
    });
  }
  return agentLimits(CLAUDE_ID, CLAUDE_NAME, "partial", {
    ...base,
    plan,
    reason: reading.canProbe
      ? "Claude has not reported its plan windows yet."
      : "Claude's limits appear after its next turn (the background probe is off: RUAH_CLAUDE_USAGE_PROBE=0).",
  });
}

/** A provider over any Claude source (the daemon's UsageLimitsService, or a direct probe). */
export function claudeProvider(source: ClaudePlanSource, ttlMs = 0): LimitsProvider {
  return {
    id: CLAUDE_ID,
    name: CLAUDE_NAME,
    // The daemon's source throttles itself (60 s live, 5 min probe); the CLI probes once.
    ttlMs,
    async read(ctx) {
      let reading: ClaudePlanReading;
      try {
        reading = await source();
      } catch (err) {
        reading = { snapshot: undefined, error: safeMessage(err), canProbe: true };
      }
      return claudeLimitsFromReading(reading, ctx.now());
    },
  };
}

/** The CLI's source: one short-lived probe (a CLI start, zero tokens). */
export function probeSource(probe: () => Promise<ClaudePlanUsage>, now: () => number = Date.now): ClaudePlanSource {
  return async () => {
    const state = new ClaudeLimitsState();
    try {
      const response = await probe();
      state.recordUsageResponse(response, new Date(now()).toISOString());
      return { snapshot: state.snapshot(), error: undefined, canProbe: true };
    } catch (err) {
      return { snapshot: undefined, error: safeMessage(err), canProbe: true };
    }
  };
}
