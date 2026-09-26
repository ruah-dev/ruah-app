// test/usage.test.ts — usage tracking: the JSONL log (append, lazy 0700 dir,
// corrupt/partial lines), aggregation (ranges, buckets, byModel, null costs),
// both endpoints through a running server (a turn over WS lands in the
// summary), ClaudeSdkBridge usage on turn_finished (fake query), ACP usage
// mapping, and Claude limits from get_usage + rate_limit_event.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ModelInfo, Options, Query, SDKControlInitializeResponse, SDKMessage, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, ClaudePlanUsage, TurnHandle, TurnUsage } from "../src/acp/bridge.js";
import { ClaudeSdkBridge, resultUsage, EMPTY_USAGE_READING } from "../src/acp/claude-sdk-bridge.js";
import { acpTurnUsage } from "../src/acp/acp-bridge.js";
import { UsageLimitsSchema, UsageSummarySchema } from "../src/contracts/usage.js";
import type { AgentState, StopReason } from "../src/contracts/ws.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { ClaudeLimitsState, claudeRateLimitEventToWindows, claudeUsageResponseToLimits } from "../src/usage/claude-limits.js";
import { UsageLimitsService, UsageLog, UsageService, parseUsageLine, ruahHome, summarizeUsage, usageRecord, type UsageRecord } from "../src/usage/index.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

const NOW = Date.parse("2026-09-23T12:30:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function record(overrides: Partial<UsageRecord> & { at: number }): UsageRecord {
  const { at, ...rest } = overrides;
  return {
    v: 1,
    ts: new Date(at).toISOString(),
    repoRoot: "/repo",
    agentId: "claude",
    model: "claude-opus-5-5",
    turnId: `t-${at}`,
    stopReason: "end_turn",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 1000,
    cacheWriteTokens: 50,
    costUsd: 0.01,
    costSource: "agent",
    durationMs: 1200,
    ...rest,
  };
}

function localDayStart(ms: number): string {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function hourStart(ms: number): string {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// ---------- log ----------

describe("usage log", () => {
  it("resolves RUAH_HOME, else ~/.ruah", () => {
    expect(ruahHome({ RUAH_HOME: "/tmp/x-ruah" })).toBe("/tmp/x-ruah");
    expect(ruahHome({ HOME: "/Users/someone" })).toBe("/Users/someone/.ruah");
  });

  it("creates the dir lazily with 0700 and appends one line per record", async () => {
    const dir = path.join(tempDir("ruah-usage-"), "home");
    const log = new UsageLog(dir);
    expect(() => statSync(dir)).toThrow(); // nothing created before the first append
    expect(await collect(log.records())).toEqual([]);
    await Promise.all([log.append(record({ at: NOW - HOUR })), log.append(record({ at: NOW, costUsd: null, costSource: null }))]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const lines = readFileSync(log.file, "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    const records = await collect(log.records());
    expect(records.map((r) => r.costUsd)).toEqual([0.01, null]);
  });

  it("skips corrupt lines and does not glue a new record onto a partial last line", async () => {
    const dir = tempDir("ruah-usage-");
    const file = path.join(dir, "usage.jsonl");
    writeFileSync(file, `${JSON.stringify(record({ at: NOW - 2 * HOUR }))}\nnot json\n{"v":2,"ts":"x"}\n`);
    appendFileSync(file, JSON.stringify(record({ at: NOW - HOUR })).slice(0, 40)); // crash mid-write
    const log = new UsageLog(dir);
    await log.append(record({ at: NOW, turnId: "after-crash" }));
    const records = await collect(log.records());
    expect(records.map((r) => r.turnId)).toEqual([`t-${NOW - 2 * HOUR}`, "after-crash"]);
    expect(parseUsageLine("")).toBeUndefined();
  });

  it("builds records with zeros for turns that reported nothing", () => {
    const at = new Date(NOW);
    const bare = usageRecord({ repoRoot: "/r", agentId: "cursor", model: undefined, turnId: "t1", stopReason: "cancelled", usage: undefined, elapsedMs: 42.4 }, at);
    expect(bare).toEqual({
      v: 1, ts: at.toISOString(), repoRoot: "/r", agentId: "cursor", model: "unknown", turnId: "t1", stopReason: "cancelled",
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costSource: null, durationMs: 42,
    });
    const full = usageRecord({
      repoRoot: "/r", agentId: "claude", model: "default", turnId: "t2", stopReason: "end_turn", elapsedMs: 5,
      usage: { model: "claude-haiku-4-5", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5, durationMs: 900 },
    }, at);
    expect(full).toMatchObject({ model: "claude-haiku-4-5", costUsd: 0.5, costSource: "agent", durationMs: 900 });
  });
});

// ---------- aggregation ----------

describe("summarizeUsage", () => {
  const records = [
    record({ at: NOW - 20 * 60_000 }), // this hour
    record({ at: NOW - 25 * 60_000, model: "claude-haiku-4-5", costUsd: 0.002 }), // same or previous hour, depending on the zone
    record({ at: NOW - 3 * HOUR, agentId: "cursor", model: "gpt-5", costUsd: null, costSource: null, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    record({ at: NOW - 2 * DAY }),
    record({ at: NOW - 10 * DAY }),
    record({ at: NOW - 40 * DAY }),
    record({ at: NOW + HOUR }), // clock skew: in the future, ignored
  ];

  it("filters by range and totals tokens, turns and known costs", async () => {
    const day = await summarizeUsage(records, "24h", NOW);
    expect(UsageSummarySchema.parse(day)).toEqual(day);
    expect(day.range).toBe("24h");
    expect(day.totals).toEqual({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 2000, cacheWriteTokens: 100, costUsd: 0.012, turns: 3 });
    expect((await summarizeUsage(records, "7d", NOW)).totals.turns).toBe(4);
    expect((await summarizeUsage(records, "30d", NOW)).totals.turns).toBe(5);
    // default range handled by the endpoint; the 30d cost is the sum of the four known costs
    expect((await summarizeUsage(records, "30d", NOW)).totals.costUsd).toBe(0.032);
  });

  it("buckets hourly for 24h and daily (local midnight) otherwise", async () => {
    const day = await summarizeUsage(records, "24h", NOW);
    const expected = [
      { t: hourStart(NOW - 3 * HOUR), agentId: "cursor", model: "gpt-5", inputTokens: 100, outputTokens: 10, costUsd: null },
      { t: hourStart(NOW - 25 * 60_000), agentId: "claude", model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 10, costUsd: 0.002 },
      { t: hourStart(NOW - 20 * 60_000), agentId: "claude", model: "claude-opus-5-5", inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
    ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || a.agentId.localeCompare(b.agentId) || a.model.localeCompare(b.model));
    expect(day.series).toEqual(expected);
    const week = await summarizeUsage(records, "7d", NOW);
    const opusByDay = week.series.filter((point) => point.model === "claude-opus-5-5");
    expect(opusByDay.map((point) => point.t)).toEqual([localDayStart(NOW - 2 * DAY), localDayStart(NOW)]);
    expect(week.series.every((point) => new Date(point.t).getHours() === 0 && new Date(point.t).getMinutes() === 0)).toBe(true);
  });

  it("groups byModel per agent and keeps null cost for groups that never reported one", async () => {
    const month = await summarizeUsage(records, "30d", NOW);
    expect(month.byModel).toEqual([
      { agentId: "claude", model: "claude-opus-5-5", turns: 3, inputTokens: 300, outputTokens: 30, costUsd: 0.03 },
      { agentId: "claude", model: "claude-haiku-4-5", turns: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.002 },
      { agentId: "cursor", model: "gpt-5", turns: 1, inputTokens: 100, outputTokens: 10, costUsd: null },
    ]);
    const onlyUnknown = await summarizeUsage([record({ at: NOW, costUsd: null, costSource: null })], "7d", NOW);
    expect(onlyUnknown.totals.costUsd).toBeNull();
    const empty = await summarizeUsage([], "7d", NOW);
    expect(empty).toEqual({
      range: "7d",
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, turns: 0 },
      series: [],
      byModel: [],
      byNode: [],
      byWorkflow: [],
    });
  });
});

// ---------- Claude limits ----------

const GET_USAGE: ClaudePlanUsage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 37.5, resets_at: "2026-09-23T15:00:00+00:00" },
    seven_day: { utilization: 12, resets_at: "2026-09-28T09:00:00Z" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 150, resets_at: null }],
  },
};

describe("Claude usage limits", () => {
  it("maps get_usage windows (sorted, clamped, ISO resets) and remembers the scoped bucket", () => {
    const { limits, names } = claudeUsageResponseToLimits({ response: GET_USAGE, checkedAt: "2026-09-23T12:00:00.000Z" });
    expect(limits.windows).toEqual([
      { id: "five_hour", kind: "session", label: "Session", usedPercent: 37.5, resetsAt: "2026-09-23T15:00:00.000Z" },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 12, resetsAt: "2026-09-28T09:00:00.000Z" },
      { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 100, resetsAt: null },
    ]);
    expect(names.overageIncluded).toBe("Fable");
    const unsupported = claudeUsageResponseToLimits({ response: { rate_limits_available: false, rate_limits: null }, checkedAt: "x" });
    expect(unsupported.limits).toEqual({ checkedAt: "x", windows: [], unavailable: { reason: "unsupported" } });
  });

  it("maps rate_limit_event fractions and epoch resets; drops an unnamed overage bucket", () => {
    expect(claudeRateLimitEventToWindows({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1790179200 }, { overageIncluded: undefined })).toEqual([
      { id: "five_hour", kind: "session", label: "Session", usedPercent: 42, resetsAt: new Date(1790179200 * 1000).toISOString() },
    ]);
    expect(claudeRateLimitEventToWindows({ rateLimitType: "seven_day_overage_included", utilization: 0.5 }, { overageIncluded: undefined })).toBeUndefined();
    expect(claudeRateLimitEventToWindows({ rateLimitType: "seven_day_overage_included", utilization: 0.5 }, { overageIncluded: "Fable" })?.[0]?.id).toBe("seven_day_fable");
    expect(claudeRateLimitEventToWindows({ rateLimitType: "five_hour" }, { overageIncluded: undefined })).toBeUndefined();
  });

  it("folds streamed events into the probed snapshot, keeping known reset times", () => {
    const state = new ClaudeLimitsState();
    state.recordUsageResponse(GET_USAGE, "2026-09-23T12:00:00.000Z");
    state.recordRateLimit({ rateLimitType: "five_hour", utilization: 0.5 }, "2026-09-23T12:05:00.000Z");
    state.recordRateLimit({ rateLimitType: "seven_day_overage_included", utilization: 0.2 }, "2026-09-23T12:05:00.000Z");
    expect(state.snapshot()?.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["five_hour", 50, "2026-09-23T15:00:00.000Z"],
      ["seven_day", 12, "2026-09-28T09:00:00.000Z"],
      ["seven_day_fable", 20, null],
    ]);
    const apiKey = new ClaudeLimitsState();
    apiKey.recordUsageResponse({ rate_limits_available: false, rate_limits: null }, "t");
    apiKey.recordRateLimit({ rateLimitType: "five_hour", utilization: 0.5 }, "t2");
    expect(apiKey.snapshot()?.unavailable?.reason).toBe("unsupported");
  });

  it("lists every catalog agent; Claude via the live query (throttled to 60 s), others unknown", async () => {
    let now = NOW;
    let liveCalls = 0;
    let probeCalls = 0;
    let current = "claude";
    const liveBridge = { claudePlanUsage: async () => { liveCalls++; return GET_USAGE; } } as unknown as AcpBridge;
    const service = new UsageLimitsService({
      agents: () => [
        { id: "claude", name: "Claude Code", installed: true },
        { id: "cursor", name: "Cursor Agent", installed: true },
        { id: "grok", name: "Grok Build", installed: false },
      ],
      currentAgentId: () => current,
      currentBridge: () => (current === "claude" ? liveBridge : ({} as AcpBridge)),
      probeClaude: async () => { probeCalls++; return { rate_limits_available: false, rate_limits: null }; },
      now: () => now,
    });
    const first = await service.limits();
    expect(UsageLimitsSchema.parse(first)).toEqual(first);
    expect(first.providers.map((p) => [p.agentId, p.status])).toEqual([["claude", "available"], ["cursor", "unknown"], ["grok", "unavailable"]]);
    expect(first.providers[0]?.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
    expect(first.providers[0]?.note).toBeUndefined();
    expect(first.providers[1]?.note).toContain("does not report");
    now += 30_000;
    await service.limits();
    expect(liveCalls).toBe(1); // throttled
    now += 31_000;
    await service.limits();
    expect(liveCalls).toBe(2);
    expect(probeCalls).toBe(0); // live query answered, no probe spawned
    // Claude no longer current: the short-lived probe answers (here: an API-key login).
    current = "cursor";
    now += 61_000;
    const viaProbe = await service.limits();
    expect(probeCalls).toBe(1);
    expect(viaProbe.providers[0]).toMatchObject({ agentId: "claude", status: "unavailable", windows: [] });
    // Streamed events from another agent's turns show up for that agent.
    service.recordRateLimit("cursor", { rateLimitType: "five_hour", utilization: 0.1 });
    expect((await service.limits()).providers[1]).toMatchObject({ agentId: "cursor", status: "available" });
  });

  it("without live query or probe: unknown with a note, then filled by rate_limit events", async () => {
    const service = new UsageLimitsService({
      agents: () => [{ id: "claude-acp", name: "Claude Code (ACP)", installed: true }],
      currentAgentId: () => "claude-acp",
      currentBridge: () => undefined,
      now: () => NOW,
    });
    expect((await service.limits()).providers[0]).toMatchObject({ status: "unknown", note: expect.stringContaining("not the current agent") });
    service.recordRateLimit("claude-acp", { rateLimitType: "seven_day", utilization: 0.25, resetsAt: 1790179200 });
    const after = await service.limits();
    expect(after.providers[0]).toMatchObject({ status: "available", windows: [{ id: "seven_day", usedPercent: 25 }] });
  });

  it("reports a failed probe in the note", async () => {
    const service = new UsageLimitsService({
      agents: () => [{ id: "claude", name: "Claude Code", installed: true }],
      currentAgentId: () => "cursor",
      currentBridge: () => undefined,
      probeClaude: async () => { throw new Error("Not logged in"); },
      now: () => NOW,
    });
    expect((await service.limits()).providers[0]).toMatchObject({ status: "unknown", note: "Could not read Claude usage limits: Not logged in" });
  });
});

// ---------- ClaudeSdkBridge ----------

class FakeQuery implements AsyncIterator<SDKMessage> {
  private readonly outbox: SDKMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private ended = false;
  onUserMessage: (() => void) | undefined;

  constructor(prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void (async () => {
      for await (const _message of prompt) this.onUserMessage?.();
    })();
  }

  send(message: Record<string, unknown>): void {
    const sdkMessage = message as unknown as SDKMessage;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value: sdkMessage, done: false });
    else this.outbox.push(sdkMessage);
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const item = this.outbox.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<SDKMessage>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  initializationResult(): Promise<SDKControlInitializeResponse> {
    return Promise.resolve({ commands: [], models: [] } as unknown as SDKControlInitializeResponse);
  }

  supportedModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }

  setModel(): Promise<void> {
    return Promise.resolve();
  }

  interrupt(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<unknown> {
    expect(opts).toEqual({ skipBehaviors: true });
    return Promise.resolve({ session: {}, subscription_type: "max", ...GET_USAGE });
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

const SESSION = "11111111-2222-4333-8444-555555555555";
let uuid = 0;
const base = () => ({ uuid: `u-${++uuid}`, session_id: SESSION, parent_tool_use_id: null });
const modelUsage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
  webSearchRequests: 0, costUSD: cost, contextWindow: 200000, maxOutputTokens: 32000,
});
const result = (extra: Record<string, unknown>) => ({
  type: "result", subtype: "success", ...base(), is_error: false, result: "OK", stop_reason: "end_turn", duration_ms: 1500, ...extra,
});

function claudeSetup() {
  const queries: FakeQuery[] = [];
  const queryImpl = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const fake = new FakeQuery(params.prompt, params.options);
    queries.push(fake);
    return fake as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const bridge = new ClaudeSdkBridge(
    { root: "/tmp/ruah-usage-repo", preset: { command: "unused", args: [], env: { ANTHROPIC_MODEL: "", CLAUDE_CONFIG_DIR: "/nonexistent/ruah-usage-test" } }, clientVersion: "0.1.0" },
    { queryImpl },
  );
  const events: BridgeEvent[] = [];
  bridge.on((event) => events.push(event));
  return { bridge, events, current: () => queries.at(-1)! };
}

describe("ClaudeSdkBridge usage", () => {
  it("reports each turn's share of the cumulative modelUsage / total_cost_usd on turn_finished", async () => {
    const { bridge, events, current } = claudeSetup();
    await bridge.start();
    const fake = current();

    fake.onUserMessage = () => {
      fake.send({ type: "assistant", ...base(), message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } });
      fake.send({ type: "rate_limit_event", ...base(), rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: 1790179200 } });
      fake.send(result({
        total_cost_usd: 0.05,
        usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 },
        modelUsage: { "claude-opus-5-5": modelUsage(3, 5, 10, 20, 0.045), "claude-haiku-4-5": modelUsage(100, 1, 0, 0, 0.005) },
      }));
    };
    await bridge.prompt("t1", [{ type: "text", text: "Reply with exactly: OK" }] as ContentBlock[]).done;
    const first = events.find((e) => e.type === "turn_finished" && e.turnId === "t1");
    expect(first).toEqual({
      type: "turn_finished",
      turnId: "t1",
      stopReason: "end_turn",
      usage: { model: "claude-opus-5-5", inputTokens: 103, outputTokens: 6, cacheReadTokens: 10, cacheWriteTokens: 20, costUsd: 0.05, durationMs: 1500 },
    });
    expect(events).toContainEqual({ type: "rate_limit", info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: 1790179200 } });

    fake.onUserMessage = () => {
      fake.send({ type: "assistant", ...base(), message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } });
      fake.send(result({
        total_cost_usd: 0.08,
        duration_ms: 700,
        usage: { input_tokens: 4, output_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 },
        modelUsage: { "claude-opus-5-5": modelUsage(7, 12, 40, 20, 0.075), "claude-haiku-4-5": modelUsage(100, 1, 0, 0, 0.005) },
      }));
    };
    await bridge.prompt("t2", [{ type: "text", text: "again" }] as ContentBlock[]).done;
    const second = events.find((e) => e.type === "turn_finished" && e.turnId === "t2");
    expect(second).toMatchObject({ usage: { model: "claude-opus-5-5", inputTokens: 4, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 0, costUsd: 0.03, durationMs: 700 } });

    // The plan (subscription_type) rides along for the per-agent limits (§15).
    await expect(bridge.claudePlanUsage()).resolves.toEqual({ ...GET_USAGE, subscription_type: "max" });
    await bridge.stop();
    await expect(bridge.claudePlanUsage()).resolves.toBeUndefined();
  });

  it("differences readings: fallback to per-turn usage, reset after /clear, zeroed results ignored", () => {
    const fallback = resultUsage({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } as never, EMPTY_USAGE_READING, undefined);
    expect(fallback.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    const one = resultUsage({ total_cost_usd: 0.5, modelUsage: { a: modelUsage(10, 10, 0, 0, 0.5) } } as never, EMPTY_USAGE_READING, undefined);
    const cleared = resultUsage({ total_cost_usd: 0.1, modelUsage: { a: modelUsage(2, 3, 0, 0, 0.1) } } as never, one.reading, undefined);
    expect(cleared.usage).toEqual({ model: "a", inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 });
    const zeroed = resultUsage({ total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } } as never, one.reading, undefined);
    expect(zeroed.usage).toBeUndefined();
    expect(zeroed.reading).toBe(one.reading);
  });
});

describe("ACP usage mapping", () => {
  it("maps PromptResponse.usage, the session cost delta and the quota model", () => {
    expect(acpTurnUsage({}, undefined, "gpt-5")).toBeUndefined();
    expect(acpTurnUsage({ usage: { totalTokens: 30, inputTokens: 10, outputTokens: 5, cachedReadTokens: 12, cachedWriteTokens: 3 } }, 0.25, "default")).toEqual({
      model: "default", inputTokens: 10, outputTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 3, costUsd: 0.25,
    });
    const meta = { quota: { model_usage: [
      { model: "claude-haiku-4-5", token_count: { totalTokens: 50 } },
      { model: "claude-opus-5-5", token_count: { totalTokens: 900 } },
    ] } };
    expect(acpTurnUsage({ usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 }, _meta: meta }, undefined, "default")?.model).toBe("claude-opus-5-5");
  });
});

// ---------- endpoints through a running server ----------

class UsageFakeBridge implements AcpBridge {
  state: AgentState = "idle";
  private readonly listeners = new Set<(event: BridgeEvent) => void>();

  constructor(private readonly usage: TurnUsage | undefined) {}

  async start(): Promise<void> {
    this.emit({ type: "status", state: "idle", agent: { name: "fake", version: "1" }, sessionId: "s1", models: { currentModelId: "sonnet", available: [{ id: "sonnet", name: "Sonnet" }] } });
  }
  status(): AgentState {
    return this.state;
  }
  prompt(turnId: string, _blocks: ContentBlock[]): TurnHandle {
    this.state = "busy";
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      setTimeout(() => {
        this.state = "idle";
        this.emit({ type: "rate_limit", info: { rateLimitType: "five_hour", utilization: 0.6 } });
        this.emit({ type: "turn_finished", turnId, stopReason: "end_turn", ...(this.usage !== undefined ? { usage: this.usage } : {}) });
        this.emit({ type: "status", state: "idle" });
        resolve({ stopReason: "end_turn" });
      }, 20);
    });
    return { turnId, done };
  }
  async cancel(): Promise<void> {}
  answerPermission(): boolean {
    return false;
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async reset(): Promise<void> {}
  async stop(): Promise<void> {}
  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async claudePlanUsage(): Promise<ClaudePlanUsage> {
    return GET_USAGE;
  }
  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function runTurnOverWs(url: string, turnId: string): Promise<void> {
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
  cleanups.push(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const finished = new Promise<void>((resolve) => {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { type: string; turnId?: string };
      if (message.type === "turn.finished" && message.turnId === turnId) resolve();
    });
  });
  ws.send(JSON.stringify({ type: "hello", protocol: 1, client: "usage-test" }));
  ws.send(JSON.stringify({ type: "prompt", turnId, nodeId: "api", text: "Reply with exactly: OK" }));
  await finished;
}

async function serveWith(bridge: AcpBridge, agentId: string) {
  const dir = tempDir("ruah-usage-serve-");
  const archPath = path.join(dir, "architecture.json");
  writeFileSync(archPath, JSON.stringify({ version: 1, name: "fixture", nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }));
  const store = createArchitectureStore(archPath);
  await store.load();
  cleanups.push(() => store.close());
  const log = new UsageLog(path.join(dir, "ruah"));
  let hubRef: SessionHub | undefined;
  const limits = new UsageLimitsService({
    agents: () => [{ id: agentId, name: "Claude Code", installed: true }, { id: "cursor", name: "Cursor Agent", installed: false }],
    currentAgentId: () => hubRef?.agentId() ?? agentId,
    currentBridge: () => hubRef?.bridge,
  });
  const usage = new UsageService(log, limits);
  const hub = new SessionHub(store, bridge, { version: "0.1.0", links: false, debug: () => {}, info: () => {}, agentId, usage });
  hubRef = hub;
  await bridge.start();
  const server = await startServer(store, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, usage });
  cleanups.push(() => server.close());
  return { url: server.url, log };
}

describe("usage endpoints", () => {
  it("records a WS turn and serves summary + limits", async () => {
    const { url, log } = await serveWith(
      new UsageFakeBridge({ model: "claude-sonnet-5", inputTokens: 12, outputTokens: 3, cacheReadTokens: 900, cacheWriteTokens: 40, costUsd: 0.0042, durationMs: 800 }),
      "claude",
    );
    await runTurnOverWs(url, "turn-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = await collect(log.records());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentId: "claude", model: "claude-sonnet-5", turnId: "turn-1", stopReason: "end_turn", costUsd: 0.0042, costSource: "agent", durationMs: 800 });

    const summaryRes = await fetch(`${url}/api/usage/summary`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.headers.get("content-type")).toContain("application/json");
    const summary = UsageSummarySchema.parse(await summaryRes.json());
    expect(summary.range).toBe("7d");
    expect(summary.totals).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 900, cacheWriteTokens: 40, costUsd: 0.0042, turns: 1 });
    expect(summary.byModel).toEqual([{ agentId: "claude", model: "claude-sonnet-5", turns: 1, inputTokens: 12, outputTokens: 3, costUsd: 0.0042 }]);
    expect(UsageSummarySchema.parse(await (await fetch(`${url}/api/usage/summary?range=24h`)).json()).series).toHaveLength(1);
    expect((await fetch(`${url}/api/usage/summary?range=1y`)).status).toBe(400);

    const limits = UsageLimitsSchema.parse(await (await fetch(`${url}/api/usage/limits`)).json());
    expect(limits.providers.map((p) => [p.agentId, p.status])).toEqual([["claude", "available"], ["cursor", "unavailable"]]);
    // The streamed rate_limit (60 %) came during the turn; the later get_usage read (37.5 %) replaced it.
    expect(limits.providers[0]?.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 37.5 });
    // The daemon wires the Origin rule into the usage endpoints (they start agent CLIs).
    expect((await fetch(`${url}/api/usage/agents?refresh=1`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${url}/api/usage/limits`, { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
  });

  it("records turns without agent usage as zero-token turns with the picker's model", async () => {
    const { url } = await serveWith(new UsageFakeBridge(undefined), "cursor");
    await runTurnOverWs(url, "turn-2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const summary = UsageSummarySchema.parse(await (await fetch(`${url}/api/usage/summary?range=30d`)).json());
    expect(summary.totals).toMatchObject({ turns: 1, inputTokens: 0, costUsd: null });
    expect(summary.byModel[0]).toMatchObject({ agentId: "cursor", model: "sonnet", turns: 1, costUsd: null });
  });
});
