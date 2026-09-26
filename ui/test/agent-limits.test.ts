// ui/test/agent-limits.test.ts — the viewer's per-agent limits helpers (CONTRACTS §16): the
// top-bar hint text, the tightest window, thresholds and severities, reset formatting, the
// once-per-window toast decision, and merging a one-agent refresh into the report.
import { describe, expect, it } from "vitest";
import {
  cardAction,
  elapsedShare,
  formatDuration,
  formatDurationShort,
  formatResetsIn,
  limitCrossings,
  limitHintText,
  normalizeThresholds,
  orderForDisplay,
  severityOf,
  tightestMeter,
  type AgentLimits,
  type LimitMeter,
} from "@/components/usage/agentLimitsModel";
import { mergeReport, parseLimitSettings, scopesToRead } from "@/components/usage/agentLimitsStore";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const H = 3_600_000;

const meter = (patch: Partial<LimitMeter>): LimitMeter => ({
  id: "five_hour",
  label: "Session · 5h",
  kind: "session",
  usedPercent: 38,
  resetsAt: new Date(NOW + 4 * H + 10 * 60_000).toISOString(),
  ...patch,
});

const agent = (patch: Partial<AgentLimits>): AgentLimits => ({
  agentId: "claude",
  name: "Claude Code",
  installed: true,
  loggedIn: true,
  plan: "Max",
  status: "ok",
  meters: [],
  source: "test",
  checkedAt: new Date(NOW).toISOString(),
  ...patch,
});

describe("agent limits model", () => {
  it("builds the top-bar hint from the tightest window", () => {
    const claude = agent({
      meters: [
        meter({}),
        meter({ id: "seven_day", label: "Weekly", kind: "weekly", usedPercent: 38, resetsAt: new Date(NOW + 3 * 24 * H).toISOString() }),
      ],
    });
    // A tie goes to the shorter window.
    expect(tightestMeter(claude)?.id).toBe("five_hour");
    expect(limitHintText(claude, NOW)).toBe("62% left · resets 4h");
    const weeklyTight = agent({ meters: [meter({ usedPercent: 10 }), meter({ id: "seven_day", kind: "weekly", usedPercent: 91, resetsAt: new Date(NOW + 3 * 24 * H).toISOString() })] });
    expect(limitHintText(weeklyTight, NOW)).toBe("9% left · resets 3d");
    expect(limitHintText(agent({ meters: [meter({ usedPercent: null })] }), NOW)).toBeNull();
    expect(limitHintText(agent({ meters: [meter({ resetsAt: null })] }), NOW)).toBe("62% left");
    expect(limitHintText(agent({ meters: [meter({ detail: "Expires instead of resetting", resetsAt: new Date(NOW + 30 * 60_000).toISOString() })] }), NOW)).toBe("62% left · expires 30m");
  });

  it("grades meters against the viewer's thresholds", () => {
    const t = normalizeThresholds({ warn: 80, critical: 95 });
    expect([severityOf(79.9, t), severityOf(80, t), severityOf(95, t), severityOf(null, t)]).toEqual(["normal", "warn", "critical", "normal"]);
    expect(normalizeThresholds({ warn: 99, critical: 90 })).toEqual({ warn: 89, critical: 90 });
    expect(normalizeThresholds({ warn: -5, critical: 400 })).toEqual({ warn: 1, critical: 100 });
    expect(normalizeThresholds({})).toEqual({ warn: 80, critical: 95 });
  });

  it("formats resets and the even-pace share", () => {
    expect(formatDuration(3 * 24 * H + 4 * H + 5 * 60_000)).toBe("3d 4h");
    expect(formatDuration(2 * H + 14 * 60_000)).toBe("2h 14m");
    expect(formatDurationShort(25 * 60_000)).toBe("25m");
    expect(formatResetsIn(meter({}), NOW)).toBe("resets in 4h 10m");
    expect(formatResetsIn(meter({ resetsAt: new Date(NOW - 1).toISOString() }), NOW)).toBe("resets now");
    expect(formatResetsIn(meter({ resetsAt: null }), NOW)).toBeNull();
    const m = meter({ periodStart: new Date(NOW - H).toISOString(), resetsAt: new Date(NOW + 3 * H).toISOString() });
    expect(elapsedShare(m, NOW)).toBeCloseTo(0.25);
    expect(elapsedShare(meter({}), NOW)).toBeNull();
  });

  it("announces each crossing once per window, at its highest level", () => {
    const t = { warn: 80, critical: 95 };
    const agents = [
      agent({ meters: [meter({ usedPercent: 85 }), meter({ id: "seven_day", kind: "weekly", usedPercent: 97 })] }),
      agent({ agentId: "cursor", name: "Cursor Agent", stale: true, meters: [meter({ usedPercent: 99 })] }),
    ];
    const first = limitCrossings(agents, t, new Set());
    expect(first.map((c) => [c.agentId, c.meter.id, c.level])).toEqual([
      ["claude", "five_hour", "warn"],
      ["claude", "seven_day", "critical"],
    ]);
    const announced = new Set(first.flatMap((c) => c.keys));
    expect(limitCrossings(agents, t, announced)).toEqual([]);
    // Warn → critical in the same window announces again, once.
    const worse = [agent({ meters: [meter({ usedPercent: 96 })] })];
    expect(limitCrossings(worse, t, announced).map((c) => c.level)).toEqual(["critical"]);
    // A new window (new reset time) starts over.
    const next = [agent({ meters: [meter({ usedPercent: 85, resetsAt: new Date(NOW + 9 * H).toISOString() })] })];
    expect(limitCrossings(next, t, announced)).toHaveLength(1);
  });

  it("does not announce again when the same reset arrives with other seconds", () => {
    const t = { warn: 80, critical: 95 };
    // Claude's get_usage sends fractional seconds, a streamed rate_limit event whole epoch seconds.
    const probed = [agent({ meters: [meter({ usedPercent: 85, resetsAt: "2026-09-26T04:39:59.591Z" })] })];
    const announced = new Set(limitCrossings(probed, t, new Set()).flatMap((c) => c.keys));
    for (const resetsAt of ["2026-09-26T04:39:59.000Z", "2026-09-26T04:40:00.000Z", "2026-09-26T04:40:00.412Z"]) {
      expect(limitCrossings([agent({ meters: [meter({ usedPercent: 86, resetsAt })] })], t, announced), resetsAt).toEqual([]);
    }
  });

  it("orders signed-in agents first and merges a one-agent refresh", () => {
    const list = [agent({ agentId: "kiro", status: "not_logged_in" }), agent({ agentId: "grok", status: "partial" }), agent({ agentId: "claude" })];
    expect(orderForDisplay(list).map((a) => a.agentId)).toEqual(["claude", "grok", "kiro"]);
    const report = { checkedAt: "a", agents: list };
    const fresh = agent({ agentId: "kiro", status: "ok", plan: "Kiro Pro" });
    const merged = mergeReport(report, { checkedAt: "b", agents: [fresh] }, "kiro");
    expect(merged.agents.map((a) => [a.agentId, a.status])).toEqual([["kiro", "ok"], ["grok", "partial"], ["claude", "ok"]]);
    expect(mergeReport(null, { checkedAt: "c", agents: [fresh] })).toEqual({ checkedAt: "c", agents: [fresh] });
  });

  it("reads only what the mounted consumers show", () => {
    // A lone top-bar hint asks for its own agent, never every agent's CLIs.
    expect(scopesToRead(new Map([["claude", 1]]))).toEqual(["claude"]);
    expect(scopesToRead(new Map([["claude", 2], ["kiro", 1]]))).toEqual(["claude", "kiro"]);
    // The panel (every agent) covers the hints.
    expect(scopesToRead(new Map([["claude", 1], ["*", 1]]))).toEqual(["*"]);
    expect(scopesToRead(new Map([["claude", 0]]))).toEqual([]);
    expect(scopesToRead(new Map())).toEqual([]);
  });

  it("reads saved settings defensively", () => {
    expect(parseLimitSettings(null)).toEqual({ thresholds: { warn: 80, critical: 95 }, toasts: true });
    expect(parseLimitSettings('{"thresholds":{"warn":70,"critical":90},"toasts":false}')).toEqual({ thresholds: { warn: 70, critical: 90 }, toasts: false });
    expect(parseLimitSettings("not json")).toEqual({ thresholds: { warn: 80, critical: 95 }, toasts: true });
  });

  it("does not repeat the saved-login switch in the card's action line (§21.1)", () => {
    const action = "Turn on “Read Cursor's saved login” here or in Settings → Features, or open cursor.com/dashboard.";
    const off = { action, appLogin: { readAppLogins: false, source: "default" as const, app: "the Cursor app" } };
    expect(cardAction(off)).toBeUndefined();
    expect(cardAction({ ...off, appLogin: { ...off.appLogin, source: "settings" as const } })).toBeUndefined();
    // Locked by RUAH_USAGE_READ_LOGINS=0: the switch cannot help, the action says what can.
    expect(cardAction({ ...off, appLogin: { ...off.appLogin, source: "env" as const } })).toBe(action);
    // Allowed (a failed read says why), or an agent without the switch: the action stays.
    expect(cardAction({ action: "Log in again.", appLogin: { readAppLogins: true, source: "settings", app: "the Cursor app" } })).toBe("Log in again.");
    expect(cardAction({ action: "Run claude /login." })).toBe("Run claude /login.");
  });
});
