// test/usage-limits.test.ts — per-agent plan limits (CONTRACTS §16): every
// parser against fixture payloads (test/fixtures/usage-limits), each provider
// end to end with fake CLIs / fetch / ACP child, the caching service, the
// Ruah-log estimates, GET /api/usage/agents and `ruah app usage limits`.
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLimitsReportSchema, AgentLimitsSchema, type AgentLimits } from "../src/contracts/agent-limits.js";
import { claudeAccountAuth, type ClaudePlanUsage } from "../src/acp/bridge.js";
import { probeClaudePlanUsage } from "../src/usage/claude-probe.js";
import type { Runner } from "../src/integrations/exec.js";
import { ClaudeLimitsState } from "../src/usage/claude-limits.js";
import { handleUsageRequest } from "../src/usage/http.js";
import { UsageLimitsService, UsageLog, UsageService, type UsageApi, type UsageRecord } from "../src/usage/index.js";
import {
  AgentLimitsService,
  GrokUsageTotals,
  buildEstimates,
  claudeLimitsFromReading,
  claudeProvider,
  cursorProvider,
  cursorSessionCookie,
  cursorStateDbPath,
  estimatePeriod,
  formatLimitsReport,
  grokProvider,
  kiroProvider,
  opencodeProvider,
  parseCursorAbout,
  parseCursorAuthRows,
  parseCursorUsage,
  parseGrokLogin,
  parseGrokSessions,
  parseKiroUsage,
  parseKiroUsageText,
  parseKiroWhoami,
  parseOpencodeStats,
  probeSource,
  recentGrokSessions,
  type FetchLike,
  type LimitsContext,
  type LimitsProvider,
} from "../src/usage/limits/index.js";
import { decodeJwtPayload, tokenExpired } from "../src/usage/limits/cursor.js";
import { agentLimits, parseCompactNumber, isoFrom, planName } from "../src/usage/limits/common.js";
import { SettingsStore } from "../src/projects/settings-store.js";
import { resolveUsageSettings, type UsageSettingsView } from "../src/usage/settings.js";
import type { Spawner } from "../src/usage/limits/stdio-rpc.js";
import { runUsage, runUsageLimits, runUsageSettings } from "../src/usage/run-usage.js";
import { opensDesktop } from "../src/cli.js";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "usage-limits");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");
const fixtureJson = (name: string): unknown => JSON.parse(fixture(name));

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A folder of stub executables (never run: the fake runner answers), usable as PATH and HOME. */
function stubBins(names: string[]): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir("ruah-limits-bin-");
  for (const name of names) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return { dir, env: { PATH: dir, HOME: dir } };
}

type Route = (args: readonly string[]) => { code?: number; stdout?: string; stderr?: string } | Promise<{ code?: number; stdout?: string; stderr?: string }>;

function fakeRunner(routes: Record<string, Route>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    const name = path.basename(file);
    calls.push(`${name} ${args.join(" ")}`);
    const route = routes[name];
    if (route === undefined) throw new Error(`unexpected command ${name}`);
    const r = await route(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

function ctx(patch: Partial<LimitsContext>): LimitsContext {
  return {
    now: () => NOW,
    env: {},
    run: async () => {
      throw new Error("no runner");
    },
    fetch: async () => {
      throw new Error("no fetch");
    },
    version: "0.1.0",
    debug: () => {},
    ...patch,
  };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJl`;
}

const valid = (a: AgentLimits): AgentLimits => AgentLimitsSchema.parse(a);

// ---------- helpers ----------

describe("limits helpers", () => {
  it("reads instants in every shape providers send", () => {
    expect(isoFrom("2026-10-12T08:00:00.000Z")).toBe("2026-10-12T08:00:00.000Z");
    expect(isoFrom("1760256000000")).toBe("2025-10-12T08:00:00.000Z");
    expect(isoFrom(1790812800)).toBe("2026-10-01T00:00:00.000Z");
    expect(isoFrom(0)).toBeNull();
    expect(isoFrom("soon")).toBeNull();
  });

  it("names plans and parses compact numbers", () => {
    expect(planName("pro_plus")).toBe("Pro+");
    expect(planName("KIRO PRO")).toBe("Kiro Pro");
    expect(planName("max")).toBe("Max");
    expect(planName("Pro+")).toBe("Pro+");
    expect(parseCompactNumber("9.6M")).toBe(9_600_000);
    expect(parseCompactNumber("206.7K")).toBe(206_700);
    expect(parseCompactNumber("1,449")).toBe(1449);
    expect(parseCompactNumber("$1.2500")).toBe(1.25);
    expect(parseCompactNumber("████")).toBeUndefined();
  });
});

// ---------- Claude ----------

describe("Claude limits", () => {
  const response = fixtureJson("claude-get-usage.json") as ClaudePlanUsage;

  it("maps windows, plan and extra usage from get_usage", () => {
    const state = new ClaudeLimitsState();
    const snapshot = state.recordUsageResponse(response, "2026-09-25T12:00:00.000Z");
    expect(snapshot.subscriptionType).toBe("max");
    const limits = valid(claudeLimitsFromReading({ snapshot, error: undefined, canProbe: true }, NOW));
    expect(limits).toMatchObject({ agentId: "claude", status: "ok", plan: "Max", loggedIn: true, installed: true });
    expect(limits.meters.map((m) => [m.id, m.label, m.kind, m.usedPercent, m.resetsAt])).toEqual([
      ["five_hour", "Session · 5h", "session", 48, "2026-09-25T16:40:00.000Z"],
      ["seven_day", "Weekly", "weekly", 18.5, "2026-09-29T09:00:00.000Z"],
      ["seven_day_fable", "Weekly · Fable", "weekly", 7, "2026-09-29T09:00:00.000Z"],
    ]);
    expect(limits.meters[0]?.periodStart).toBe("2026-09-25T11:40:00.000Z");
    expect(limits.meters[1]?.periodStart).toBe("2026-09-22T09:00:00.000Z");
    expect(limits.onDemand).toEqual({ enabled: true, used: 4.2, limit: 50, currency: "USD", note: "Extra usage this month" });
    const off = new ClaudeLimitsState().recordUsageResponse(
      { ...response, rate_limits: { ...response.rate_limits, extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null } } },
      "t",
    );
    expect(claudeLimitsFromReading({ snapshot: off, error: undefined, canProbe: true }, NOW).onDemand).toEqual({ enabled: false, used: null, limit: null, currency: "USD" });
    // A streamed event keeps plan and extra usage.
    state.recordRateLimit({ rateLimitType: "five_hour", utilization: 0.6 }, "2026-09-25T12:01:00.000Z");
    expect(state.snapshot()).toMatchObject({ subscriptionType: "max", extraUsage: { used_credits: 420 } });
  });

  it("keeps one reset time when get_usage and a streamed event disagree by a second", () => {
    const state = new ClaudeLimitsState();
    state.recordUsageResponse({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 80, resets_at: "2026-09-26T04:39:59.591Z" } } }, "t");
    // The event's reset is whole epoch seconds: 04:40:00.
    state.recordRateLimit({ rateLimitType: "five_hour", utilization: 0.85, resetsAt: Date.parse("2026-09-26T04:40:00.000Z") / 1000 }, "t2");
    expect(state.snapshot()?.windows[0]).toMatchObject({ usedPercent: 85, resetsAt: "2026-09-26T04:39:59.591Z" });
    // A genuinely new window still moves it.
    state.recordRateLimit({ rateLimitType: "five_hour", utilization: 0.01, resetsAt: Date.parse("2026-09-26T09:40:00.000Z") / 1000 }, "t3");
    expect(state.snapshot()?.windows[0]?.resetsAt).toBe("2026-09-26T09:40:00.000Z");
  });

  it("tells a signed-out CLI from an API key or a cloud provider (all report no windows)", () => {
    const noWindows = (account?: ClaudePlanUsage["account"]) =>
      valid(
        claudeLimitsFromReading(
          {
            snapshot: new ClaudeLimitsState().recordUsageResponse({ rate_limits_available: false, rate_limits: null, subscription_type: null, ...(account ? { account } : {}) }, "t"),
            error: undefined,
            canProbe: true,
          },
          NOW,
        ),
      );
    // What a CLI with no credentials at all answers (a scratch HOME): not "API key".
    expect(noWindows({ tokenSource: "none", apiProvider: "firstParty" })).toMatchObject({
      status: "not_logged_in",
      loggedIn: false,
      plan: null,
      action: expect.stringContaining("/login"),
    });
    expect(noWindows({ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toMatchObject({
      status: "unsupported",
      loggedIn: true,
      plan: "API key",
      reason: expect.stringContaining("API key"),
    });
    expect(noWindows({ apiProvider: "bedrock" })).toMatchObject({ status: "unsupported", loggedIn: null, plan: null, reason: expect.stringContaining("Amazon Bedrock") });
    expect(noWindows({ tokenSource: "claude.ai", apiProvider: "firstParty" })).toMatchObject({ status: "unsupported", loggedIn: true, plan: null });
    // Without the account info nothing is claimed about the login.
    const unknown = noWindows();
    expect(unknown).toMatchObject({ status: "unsupported", loggedIn: null, plan: null, action: expect.stringContaining("/login") });
    expect(unknown.reason).toContain("not signed in");
    expect(claudeLimitsFromReading({ snapshot: undefined, error: undefined, canProbe: false, installed: false }, NOW)).toMatchObject({ status: "not_installed", installed: false });
  });

  it("says why when there is nothing to show", () => {
    expect(claudeLimitsFromReading({ snapshot: undefined, error: "Not logged in · Please run /login", canProbe: true }, NOW)).toMatchObject({
      status: "not_logged_in",
      loggedIn: false,
      action: expect.stringContaining("/login"),
    });
    expect(claudeLimitsFromReading({ snapshot: undefined, error: "Claude initialization timed out after 25000 ms", canProbe: true }, NOW)).toMatchObject({
      status: "error",
      reason: expect.stringContaining("timed out"),
    });
    expect(claudeLimitsFromReading({ snapshot: undefined, error: undefined, canProbe: false }, NOW)).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("RUAH_CLAUDE_USAGE_PROBE=0"),
    });
    const snapshot = new ClaudeLimitsState().recordUsageResponse(response, "2026-09-25T11:00:00.000Z");
    expect(claudeLimitsFromReading({ snapshot, error: "network down", canProbe: true }, NOW)).toMatchObject({ status: "ok", stale: true });
  });

  it("the probe keeps how the CLI signs in, never the email", async () => {
    let closed = false;
    const fakeQuery = (() => ({
      initializationResult: async () => ({ account: { email: "dev@example.com", organization: "Acme", tokenSource: "none", apiProvider: "firstParty" } }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: false, rate_limits: null, subscription_type: null }),
      close: () => {
        closed = true;
      },
    })) as unknown as Parameters<typeof probeClaudePlanUsage>[1];
    const usage = await probeClaudePlanUsage(tempDir("ruah-probe-cwd-"), fakeQuery);
    expect(usage).toEqual({ rate_limits_available: false, rate_limits: null, subscription_type: null, account: { tokenSource: "none", apiProvider: "firstParty" } });
    expect(JSON.stringify(usage)).not.toContain("dev@example.com");
    expect(closed).toBe(true);
    expect(claudeAccountAuth({ email: "x@y.z" })).toBeUndefined();
  });

  it("probes once for the CLI and reads through the daemon's service", async () => {
    let probes = 0;
    const source = probeSource(async () => {
      probes++;
      return response;
    }, () => NOW);
    const limits = await claudeProvider(source).read(ctx({}));
    expect(limits.status).toBe("ok");
    expect(probes).toBe(1);
    const failing = await claudeProvider(probeSource(async () => {
      throw new Error("OAuth token has expired");
    })).read(ctx({}));
    expect(failing.status).toBe("not_logged_in");

    const service = new UsageLimitsService({
      agents: () => [{ id: "claude", name: "Claude Code", installed: true }],
      currentAgentId: () => "cursor",
      currentBridge: () => undefined,
      probeClaude: async () => response,
      now: () => NOW,
    });
    const usage = new UsageService(new UsageLog(tempDir("ruah-limits-log-")), service, { now: () => NOW });
    const report = AgentLimitsReportSchema.parse(await usage.agentLimits({ agentId: "claude" }));
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]).toMatchObject({ agentId: "claude", status: "ok", plan: "Max" });

    // installed comes from the daemon's agent catalog, and nothing is probed without Claude.
    let catalogProbes = 0;
    const without = new UsageLimitsService({
      agents: () => [{ id: "cursor", name: "Cursor Agent", installed: true }],
      currentAgentId: () => "cursor",
      currentBridge: () => undefined,
      probeClaude: async () => {
        catalogProbes++;
        return response;
      },
      now: () => NOW,
    });
    const none = await new UsageService(new UsageLog(tempDir("ruah-limits-log-")), without, { now: () => NOW }).agentLimits({ agentId: "claude" });
    expect(none.agents[0]).toMatchObject({ status: "not_installed", installed: false });
    expect(catalogProbes).toBe(0);
  });
});

// ---------- Cursor ----------

describe("Cursor limits", () => {
  it("parses cursor-agent about", () => {
    expect(parseCursorAbout(fixture("cursor-about.json"))).toEqual({ tier: "Pro+", loggedIn: true, email: "dev@example.com" });
    expect(parseCursorAbout(fixture("cursor-about-logged-out.json"))).toEqual({ tier: null, loggedIn: false, email: null });
    expect(parseCursorAbout("About Cursor CLI")).toBeUndefined();
  });

  it("parses the dashboard usage summary (Pro+)", () => {
    const usage = parseCursorUsage(fixtureJson("cursor-usage-summary-pro-plus.json"))!;
    expect(usage.plan).toBe("Pro+");
    expect(usage.periodEnd).toBe("2026-10-12T08:00:00.000Z");
    expect(usage.meters).toEqual([
      { id: "included", label: "Included usage", kind: "monthly", usedPercent: 44.7, used: 31.29, limit: 70, unit: "usd", resetsAt: "2026-10-12T08:00:00.000Z", periodStart: "2026-09-12T08:00:00.000Z" },
      { id: "auto", label: "Auto + Composer", kind: "monthly", usedPercent: 39.9, resetsAt: "2026-10-12T08:00:00.000Z", periodStart: "2026-09-12T08:00:00.000Z" },
      { id: "api", label: "API models", kind: "monthly", usedPercent: 97.2, resetsAt: "2026-10-12T08:00:00.000Z", periodStart: "2026-09-12T08:00:00.000Z" },
    ]);
    expect(usage.onDemand).toEqual({ enabled: true, used: 12.5, limit: 50, currency: "USD", scope: "personal" });
  });

  it("parses the CLI's DashboardService shape and an Enterprise seat", () => {
    const rpc = parseCursorUsage(fixtureJson("cursor-current-period-usage-rpc.json"))!;
    expect(rpc.meters[0]).toMatchObject({ id: "included", usedPercent: 44.7, used: 31.29, limit: 70, resetsAt: "2025-10-12T08:00:00.000Z" });
    expect(rpc.onDemand).toMatchObject({ enabled: true, used: 12.5, limit: 50, scope: "personal" });
    const enterprise = parseCursorUsage(fixtureJson("cursor-usage-summary-enterprise.json"))!;
    expect(enterprise.plan).toBe("Enterprise");
    expect(enterprise.meters).toEqual([]);
    expect(enterprise.onDemand).toEqual({ enabled: true, used: 23.09, limit: 100, currency: "USD", scope: "team" });
    const unlimited = parseCursorUsage({ billingCycleEnd: "2026-10-01T00:00:00Z", isUnlimited: true, individualUsage: { plan: { used: 100 } } })!;
    expect(unlimited.meters[0]).toMatchObject({ usedPercent: null, limit: null, detail: "Unlimited" });
    expect(parseCursorUsage("nope")).toBeUndefined();
  });

  it("reads the app's login rows and builds the session cookie without exposing the token", () => {
    const token = fakeJwt({ sub: "google-oauth2|user_01TEST", exp: NOW / 1000 + 3600 });
    const rows = JSON.stringify([
      { key: "cursorAuth/accessToken", value: token },
      { key: "cursorAuth/cachedEmail", value: "dev@example.com" },
      { key: "cursorAuth/stripeMembershipType", value: "pro_plus" },
    ]);
    expect(parseCursorAuthRows(rows)).toEqual({ accessToken: token, email: "dev@example.com", membership: "pro_plus" });
    expect(parseCursorAuthRows("[]")).toBeUndefined();
    expect(decodeJwtPayload(token)?.sub).toBe("google-oauth2|user_01TEST");
    expect(cursorSessionCookie(token)).toBe(`WorkosCursorSessionToken=${encodeURIComponent(`user_01TEST::${token}`)}`);
    expect(tokenExpired(token, NOW)).toBe(false);
    expect(tokenExpired(fakeJwt({ sub: "x|y", exp: NOW / 1000 - 1 }), NOW)).toBe(true);
    expect(cursorStateDbPath({ HOME: "/h" }, "darwin")).toBe("/h/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(cursorStateDbPath({ HOME: "/h" }, "linux")).toBe("/h/.config/Cursor/User/globalStorage/state.vscdb");
  });

  function cursorSetup(
    options: {
      email?: string | null;
      token?: string;
      status?: number;
      body?: string;
      about?: string;
      aboutFails?: boolean;
      /** §20.1: the saved "read the app's login" choice; default: allowed (undefined = no setting at all). */
      appLogins?: UsageSettingsView | undefined;
    } = { appLogins: { readAppLogins: true, source: "settings" } },
  ) {
    const bins = stubBins(["cursor-agent", "sqlite3"]);
    const db = path.join(bins.dir, "state.vscdb");
    writeFileSync(db, "");
    const token = options.token ?? fakeJwt({ sub: "auth0|user_42", exp: NOW / 1000 + 3600 });
    const { run, calls } = fakeRunner({
      "cursor-agent": () => {
        if (options.aboutFails === true) throw new Error("cursor-agent timed out after 20 s");
        return { stdout: options.about ?? fixture("cursor-about.json") };
      },
      sqlite3: (args) => {
        expect(args.slice(0, 2)).toEqual(["-readonly", "-json"]);
        const rows = [{ key: "cursorAuth/accessToken", value: token }];
        if (options.email !== null) rows.push({ key: "cursorAuth/cachedEmail", value: options.email ?? "dev@example.com" });
        return { stdout: JSON.stringify(rows) };
      },
    });
    const requests: Array<{ url: string; headers: Record<string, string> | undefined; method: string | undefined }> = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, headers: init?.headers, method: init?.method });
      const status = options.status ?? 200;
      return { status, ok: status >= 200 && status < 300, text: async () => options.body ?? fixture("cursor-usage-summary-pro-plus.json") };
    };
    const debug: string[] = [];
    const allowed = "appLogins" in options ? options.appLogins : { readAppLogins: true, source: "settings" as const };
    const context = ctx({
      env: { ...bins.env, RUAH_CURSOR_STATE_DB: db },
      run,
      fetch,
      debug: (l) => debug.push(l),
      ...(allowed !== undefined ? { appLogins: () => allowed } : {}),
    });
    return { context, calls, requests, token, debug };
  }

  it("§20.1: never opens the Cursor app's login until the user allows it", async () => {
    // No setting at all (the default): tier only, the reason says why, nothing read or fetched.
    const fresh = cursorSetup({ appLogins: undefined });
    const off = valid(await cursorProvider().read(fresh.context));
    expect(off).toMatchObject({
      status: "partial",
      plan: "Pro+",
      reason: expect.stringContaining("only when you allow it"),
      action: expect.stringContaining("Read Cursor's saved login"),
      appLogin: { readAppLogins: false, source: "default", app: "the Cursor app" },
    });
    expect(off.meters).toEqual([]);
    expect(fresh.calls.some((c) => c.startsWith("sqlite3"))).toBe(false);
    expect(fresh.requests).toHaveLength(0);

    // Saved off: the same.
    const savedOff = cursorSetup({ appLogins: { readAppLogins: false, source: "settings" } });
    expect(await cursorProvider().read(savedOff.context)).toMatchObject({ status: "partial", appLogin: { readAppLogins: false, source: "settings" } });
    expect(savedOff.calls.some((c) => c.startsWith("sqlite3"))).toBe(false);

    // RUAH_USAGE_READ_LOGINS=1 turns it on without a saved choice (no hook: the env decides).
    const envOn = cursorSetup({ appLogins: undefined });
    envOn.context.env.RUAH_USAGE_READ_LOGINS = "1";
    expect(await cursorProvider().read(envOn.context)).toMatchObject({ status: "ok", appLogin: { readAppLogins: true, source: "env" } });
    expect(envOn.requests).toHaveLength(1);

    // Allowed: the card still says so (its switch shows on).
    const on = cursorSetup();
    expect(await cursorProvider().read(on.context)).toMatchObject({ status: "ok", appLogin: { readAppLogins: true, source: "settings" } });
  });

  it("§20.1: the saved setting, the environment override and the service invalidation", async () => {
    const home = tempDir("ruah-usage-settings-");
    const store = new SettingsStore(home, { env: {} });
    expect(store.usageSettings()).toEqual({ readAppLogins: false, source: "default" });
    const changes: string[] = [];
    store.onFeaturesChange((before, after, cause) => changes.push(`${before.usage.readAppLogins}->${after.usage.readAppLogins} (${cause})`));
    expect(store.updateFeatures({ usage: { readAppLogins: true } }).usage).toEqual({ readAppLogins: true, source: "settings" });
    store.updateFeatures({ usage: { readAppLogins: true } }); // unchanged: no event
    expect(changes).toEqual(["false->true (update)"]);
    const saved = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")) as { usage?: unknown };
    expect(saved.usage).toEqual({ readAppLogins: true });
    // Another process (the CLI) changes the file: a long-lived store sees it.
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ version: 1, usage: { readAppLogins: false } }));
    utimesSync(path.join(home, "settings.json"), new Date(), new Date(Date.now() + 5_000));
    expect(store.usageSettings()).toEqual({ readAppLogins: false, source: "settings" });
    // ...and tells its listeners (the daemon drops the Cursor reading and updates every window).
    expect(changes).toEqual(["false->true (update)", "true->false (file)"]);
    store.refresh(); // unchanged file: no event
    expect(changes).toHaveLength(2);
    // The environment wins over the saved value, both ways.
    expect(new SettingsStore(home, { env: { RUAH_USAGE_READ_LOGINS: "1" } }).usageSettings()).toEqual({ readAppLogins: true, source: "env" });
    store.updateFeatures({ usage: { readAppLogins: true } });
    expect(new SettingsStore(home, { env: { RUAH_USAGE_READ_LOGINS: "0" } }).usageSettings()).toEqual({ readAppLogins: false, source: "env" });
    expect(resolveUsageSettings({ RUAH_USAGE_READ_LOGINS: "maybe" }, undefined)).toEqual({ readAppLogins: false, source: "default" });

    // The service drops a reading made under the old setting.
    let allowed = false;
    let reads = 0;
    const provider: LimitsProvider = {
      id: "cursor",
      name: "Cursor Agent",
      ttlMs: 60_000,
      read: async (c) => {
        reads += 1;
        return agentLimits("cursor", "Cursor Agent", c.appLogins?.().readAppLogins === true ? "ok" : "partial", { checkedAt: new Date(NOW).toISOString(), source: "test" });
      },
    };
    const service = new AgentLimitsService({ providers: [provider], context: { now: () => NOW, appLogins: () => ({ readAppLogins: allowed, source: "settings" }) } });
    expect((await service.report()).agents[0]?.status).toBe("partial");
    allowed = true;
    expect((await service.report()).agents[0]?.status).toBe("partial"); // cached
    service.invalidate("cursor");
    expect((await service.report()).agents[0]?.status).toBe("ok");
    expect(reads).toBe(2);
  });

  it("reads tier + included usage with one read-only GET", async () => {
    const { context, calls, requests, token, debug } = cursorSetup();
    const limits = valid(await cursorProvider().read(context));
    expect(limits).toMatchObject({ status: "ok", plan: "Pro+", loggedIn: true, source: expect.stringContaining("cursor.com") });
    expect(limits.meters.map((m) => m.id)).toEqual(["included", "auto", "api"]);
    expect(limits.onDemand?.used).toBe(12.5);
    expect(calls).toEqual([expect.stringMatching(/^cursor-agent about --format json$/), expect.stringMatching(/^sqlite3 -readonly -json /)]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://cursor.com/api/usage-summary", method: "GET" });
    expect(requests[0]?.headers?.Cookie).toContain("WorkosCursorSessionToken=");
    // The token never leaves the request.
    expect(JSON.stringify(limits)).not.toContain(token);
    expect(debug.join("\n")).not.toContain(token);
  });

  it("degrades to the tier with a reason (and never shows another account's usage)", async () => {
    const other = cursorSetup({ email: "someone-else@example.com" });
    expect(await cursorProvider().read(other.context)).toMatchObject({ status: "partial", plan: "Pro+", reason: expect.stringContaining("different account") });
    expect(other.requests).toHaveLength(0);

    const expired = cursorSetup({ token: fakeJwt({ sub: "auth0|user_42", exp: NOW / 1000 - 10 }) });
    expect(await cursorProvider().read(expired.context)).toMatchObject({ status: "partial", reason: expect.stringContaining("expired") });
    expect(expired.requests).toHaveLength(0);

    const rejected = cursorSetup({ status: 401 });
    const r = await cursorProvider().read(rejected.context);
    expect(r).toMatchObject({ status: "partial", reason: expect.stringContaining("HTTP 401") });
    expect(JSON.stringify(r)).not.toContain(rejected.token);

    const down = cursorSetup({ status: 503 });
    expect(await cursorProvider().read(down.context)).toMatchObject({ status: "error", reason: "cursor.com answered HTTP 503." });

    const off = cursorSetup();
    off.context.env.RUAH_USAGE_READ_LOGINS = "0";
    expect(await cursorProvider().read(off.context)).toMatchObject({ status: "partial", reason: expect.stringContaining("RUAH_USAGE_READ_LOGINS=0") });
    expect(off.calls.some((c) => c.startsWith("sqlite3"))).toBe(false);

    const noApp = cursorSetup();
    noApp.context.env.RUAH_CURSOR_STATE_DB = path.join(tmpdir(), "ruah-no-such-state.vscdb");
    expect(await cursorProvider().read(noApp.context)).toMatchObject({ status: "partial", reason: expect.stringContaining("Keychain") });

    // cursor-agent's account unknown (about failed, or names no email): the app's login is not used.
    const noAbout = cursorSetup({ aboutFails: true });
    expect(await cursorProvider().read(noAbout.context)).toMatchObject({ status: "error", loggedIn: null, reason: expect.stringContaining("could not be confirmed") });
    expect(noAbout.requests).toHaveLength(0);
    expect(noAbout.calls.some((c) => c.startsWith("sqlite3"))).toBe(false);
    const tierOnly = cursorSetup({ about: JSON.stringify({ subscriptionTier: "Pro" }) });
    expect(await cursorProvider().read(tierOnly.context)).toMatchObject({ status: "partial", plan: "Pro", loggedIn: true, reason: expect.stringContaining("cursor-agent does not say") });
    expect(tierOnly.requests).toHaveLength(0);
    const appNoEmail = cursorSetup({ email: null });
    expect(await cursorProvider().read(appNoEmail.context)).toMatchObject({ status: "partial", reason: expect.stringContaining("The Cursor app does not say") });
    expect(appNoEmail.requests).toHaveLength(0);

    const signedOut = cursorSetup({ about: fixture("cursor-about-logged-out.json") });
    expect(await cursorProvider().read(signedOut.context)).toMatchObject({ status: "not_logged_in", action: "Run `cursor-agent login`." });

    const missing = await cursorProvider().read(ctx({ env: { PATH: "", HOME: tempDir("ruah-empty-home-") } }));
    expect(missing).toMatchObject({ status: "not_installed", installed: false });
  });
});

// ---------- Kiro ----------

/** A fake `kiro-cli acp`: answers initialize, session/new and the usage command over stdio. */
function fakeKiroAcp(usage: unknown): { spawner: Spawner; methods: string[]; killed: () => boolean; cwds: Array<{ cwd: string; mode: number }> } {
  const methods: string[] = [];
  const cwds: Array<{ cwd: string; mode: number }> = [];
  let killed = false;
  const spawner: Spawner = (_command, _args, options) => {
    cwds.push({ cwd: options.cwd, mode: statSync(options.cwd).mode & 0o777 });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let buffer = "";
    const send = (msg: unknown) => stdout.write(`${JSON.stringify(msg)}\n`);
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: { command?: unknown }; result?: unknown };
        if (msg.method === undefined) continue; // our answer to the agent's own request
        methods.push(msg.method);
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (msg.method === "session/new") {
          // Noise a real agent sends: a notification and a request of its own.
          send({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { commands: [{ name: "usage" }] } });
          send({ jsonrpc: "2.0", id: 900, method: "fs/read_text_file", params: { path: "/etc/hosts" } });
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
        } else if (msg.method === "_kiro.dev/commands/execute") {
          expect(msg.params?.command).toEqual({ command: "usage", args: {} });
          send({ jsonrpc: "2.0", id: msg.id, result: usage });
        }
      }
    });
    return {
      stdin,
      stdout,
      kill: () => {
        killed = true;
        events.emit("exit", 0);
        return true;
      },
      once: (event: string, listener: (...args: never[]) => void) => events.once(event, listener as (...args: unknown[]) => void),
    } as unknown as ReturnType<Spawner>;
  };
  return { spawner, methods, killed: () => killed, cwds };
}

describe("Kiro limits", () => {
  it("parses whoami", () => {
    expect(parseKiroWhoami(fixture("kiro-whoami-logged-out.json"))).toEqual({ loggedIn: false, plan: null });
    expect(parseKiroWhoami(fixture("kiro-whoami.json"))).toEqual({ loggedIn: true, plan: "Kiro Pro" });
    expect(parseKiroWhoami("Not logged in")).toBeUndefined();
  });

  it("parses the /usage command result (credits, bonus, overages, reset)", () => {
    const usage = parseKiroUsage(fixtureJson("kiro-usage-command.json"))!;
    expect(usage.plan).toBe("Kiro Pro");
    expect(usage.meters).toEqual([
      { id: "credits", label: "Credits", kind: "credits", usedPercent: 81.24, used: 812.37, limit: 1000, unit: "credits", resetsAt: "2026-10-01T00:00:00.000Z", periodStart: "2026-09-01T00:00:00.000Z" },
      { id: "bonus:welcome", label: "Welcome bonus", kind: "credits", usedPercent: 12.5, used: 12.5, limit: 100, unit: "credits", resetsAt: "2026-10-08T00:00:00.000Z", detail: "Expires instead of resetting" },
    ]);
    expect(usage.onDemand).toEqual({ enabled: true, used: 0.13, limit: 100, currency: "USD", note: "3.25 overage credits" });
  });

  it("falls back to Kiro's text, and to its message", () => {
    const meter = parseKiroUsageText(fixture("kiro-usage-text.txt"))!;
    expect(meter).toMatchObject({ usedPercent: 85, used: 42.5, limit: 50, resetsAt: "2026-10-01T00:00:00.000Z", detail: "From Kiro's /usage text" });
    const fromText = parseKiroUsage({ success: true, message: fixture("kiro-usage-text.txt") })!;
    expect(fromText.meters).toHaveLength(1);
    expect(parseKiroUsage({ success: false, message: "Failed to retrieve usage information: throttled" })).toMatchObject({ meters: [], failed: true, message: expect.stringContaining("throttled") });
    expect(parseKiroUsage(undefined)).toBeUndefined();
    // "42.5 of 50 credits" reads too; a percent on a credits line alone gives a percent-only meter.
    expect(parseKiroUsageText("You have used 1,250.5 of 2,000 credits this month.")).toMatchObject({ used: 1250.5, limit: 2000, usedPercent: 62.53 });
    expect(parseKiroUsageText("Credits: 12% used. Resets on 10/01/2026")).toMatchObject({ usedPercent: 12, used: null, limit: null, resetsAt: null });
  });

  it("never reads a meter out of errors, retry counts or dates", () => {
    // An error envelope is an error, whatever numbers its message holds.
    expect(parseKiroUsage({ success: false, message: "Could not fetch usage (attempt 3 of 3). Try again later." })).toEqual({
      plan: null,
      meters: [],
      failed: true,
      message: "Could not fetch usage (attempt 3 of 3). Try again later.",
    });
    for (const text of [
      "Could not fetch usage (attempt 3 of 3). Try again later.",
      "Usage limit reached for 2026/10",
      "Retrying 2/5 …",
      "Session 1 of 4 started; 30% used of the context window",
      "Updated 10/01/2026 of 12 regions",
    ]) {
      expect(parseKiroUsageText(text), text).toBeUndefined();
      expect(parseKiroUsage({ success: true, message: text })?.meters, text).toEqual([]);
    }
  });

  it("reports Kiro's failed /usage as an error with its message, never as a meter", async () => {
    const bins = stubBins(["kiro-cli"]);
    const { run } = fakeRunner({ "kiro-cli": () => ({ stdout: fixture("kiro-whoami.json") }) });
    const acp = fakeKiroAcp({ success: false, message: "Could not fetch usage (attempt 3 of 3). Try again later." });
    const limits = valid(await kiroProvider({ spawner: acp.spawner }).read(ctx({ env: bins.env, run })));
    expect(limits).toMatchObject({ status: "error", meters: [], plan: "Kiro Pro", reason: "Kiro's /usage failed: Could not fetch usage (attempt 3 of 3). Try again later." });
  });

  it("runs /usage over ACP and closes the agent", async () => {
    const bins = stubBins(["kiro-cli"]);
    const { run } = fakeRunner({ "kiro-cli": () => ({ stdout: fixture("kiro-whoami.json") }) });
    const acp = fakeKiroAcp(fixtureJson("kiro-usage-command.json"));
    const limits = valid(await kiroProvider({ spawner: acp.spawner }).read(ctx({ env: bins.env, run })));
    expect(limits).toMatchObject({ status: "ok", plan: "Kiro Pro", loggedIn: true });
    expect(limits.meters[0]).toMatchObject({ id: "credits", usedPercent: 81.24 });
    expect(acp.methods).toEqual(["initialize", "session/new", "_kiro.dev/commands/execute"]);
    expect(acp.killed()).toBe(true);
    // A fresh private folder per read (never a shared, predictable /tmp name), removed afterwards.
    await kiroProvider({ spawner: acp.spawner }).read(ctx({ env: bins.env, run }));
    expect(acp.cwds).toHaveLength(2);
    for (const { cwd, mode } of acp.cwds) {
      expect(path.basename(cwd)).toMatch(/^ruah-kiro-usage-.+/);
      expect(mode).toBe(0o700);
      expect(existsSync(cwd)).toBe(false);
    }
    expect(acp.cwds[0]?.cwd).not.toBe(acp.cwds[1]?.cwd);
  });

  it("says not logged in without starting ACP", async () => {
    const bins = stubBins(["kiro-cli"]);
    const { run } = fakeRunner({ "kiro-cli": () => ({ stdout: fixture("kiro-whoami-logged-out.json") }) });
    const acp = fakeKiroAcp({});
    expect(await kiroProvider({ spawner: acp.spawner }).read(ctx({ env: bins.env, run }))).toMatchObject({
      status: "not_logged_in",
      action: "Run `kiro-cli login`.",
    });
    expect(acp.methods).toEqual([]);
  });
});

// ---------- Grok ----------

describe("Grok limits", () => {
  it("parses login, sessions and persisted usage (turns in the period, ticks to USD)", () => {
    expect(parseGrokLogin(fixture("grok-models.txt"))).toEqual({ loggedIn: true, via: "grok.com" });
    expect(parseGrokLogin("Not logged in. Run `grok login` to sign in.")).toEqual({ loggedIn: false, via: null });
    expect(parseGrokSessions(fixture("grok-sessions-list.txt")).map((r) => [r.id.slice(-1), r.updated])).toEqual([
      ["1", "2026-09-22"],
      ["2", "2026-09-18"],
      ["3", "2026-07-02"],
    ]);
    const totals = new GrokUsageTotals();
    totals.add(fixtureJson("grok-usage-session.json"), Date.parse("2026-08-26T12:00:00Z"));
    const local = totals.toLocalUsage("2026-08-26T12:00:00.000Z", "grok usage");
    expect(local).toMatchObject({ sessions: 1, inputTokens: 36131, outputTokens: 258, cacheReadTokens: 768, costUsd: 0.0247, approximate: false });
    expect(local.byModel).toEqual([{ model: "grok-4.6-build", turns: 1, inputTokens: 36131, outputTokens: 258, cacheReadTokens: 768, cacheWriteTokens: 0, costUsd: 0.0247 }]);
  });

  it("finds recent sessions in every directory's group of grok's session store", async () => {
    const home = tempDir("ruah-grok-home-");
    const ids = ["0190aaaa-0000-7000-8000-000000000001", "0190aaaa-0000-7000-8000-000000000002", "0190aaaa-0000-7000-8000-000000000003"];
    mkdirSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fa", ids[0]!), { recursive: true });
    mkdirSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fb", ids[1]!), { recursive: true });
    mkdirSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fb", ids[2]!), { recursive: true });
    mkdirSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fb", "not-a-session"), { recursive: true });
    writeFileSync(path.join(home, "sessions", "README"), "");
    const at = (iso: string) => Date.parse(iso) / 1000;
    utimesSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fa", ids[0]!), at("2026-09-22T10:00:00Z"), at("2026-09-22T10:00:00Z"));
    utimesSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fb", ids[1]!), at("2026-09-24T10:00:00Z"), at("2026-09-24T10:00:00Z"));
    utimesSync(path.join(home, "sessions", "%2FUsers%2Fdev%2Fb", ids[2]!), at("2026-07-01T10:00:00Z"), at("2026-07-01T10:00:00Z"));
    expect(recentGrokSessions({ GROK_HOME: home }, Date.parse("2026-08-26T12:00:00Z"))).toEqual([ids[1], ids[0]]);
    expect(recentGrokSessions({ GROK_HOME: path.join(home, "missing") }, 0)).toBeUndefined();

    const bins = stubBins(["grok"]);
    const { run, calls } = fakeRunner({
      grok: (args) => (args[0] === "models" ? { stdout: fixture("grok-models.txt") } : args[0] === "usage" ? { stdout: fixture("grok-usage-session.json") } : { code: 2 }),
    });
    const limits = await grokProvider().read(ctx({ env: { ...bins.env, GROK_HOME: home }, run }));
    expect(limits.local?.sessions).toBe(2);
    expect(calls.some((c) => c.startsWith("grok sessions"))).toBe(false); // the store answered
  });

  it("reports sign-in and local stats, and says the allowance is not readable", async () => {
    const bins = stubBins(["grok"]);
    const { run, calls } = fakeRunner({
      grok: (args) => {
        if (args[0] === "models") return { stdout: fixture("grok-models.txt") };
        if (args[0] === "sessions") return { stdout: fixture("grok-sessions-list.txt") };
        if (args[0] === "usage") return { stdout: fixture("grok-usage-session.json") };
        return { code: 2 };
      },
    });
    const limits = valid(await grokProvider().read(ctx({ env: bins.env, run })));
    expect(limits).toMatchObject({ status: "partial", loggedIn: true, meters: [], reason: expect.stringContaining("only inside the grok app") });
    expect(limits.local?.sessions).toBe(2); // the July session is outside the 30 days
    expect(calls.filter((c) => c.startsWith("grok usage"))).toHaveLength(2);
  });
});

// ---------- OpenCode ----------

describe("OpenCode limits", () => {
  it("parses opencode stats", () => {
    const local = parseOpencodeStats(fixture("opencode-stats.txt"), "2026-08-26T12:00:00.000Z", "opencode stats --days 30")!;
    expect(local).toMatchObject({ sessions: 17, inputTokens: 9_600_000, outputTokens: 206_700, cacheReadTokens: 89_000_000, cacheWriteTokens: 0, costUsd: 1.25, approximate: true });
    expect(local.byModel.map((m) => [m.model, m.turns, m.inputTokens, m.costUsd])).toEqual([
      ["opencode/union-alpha", 1432, 9_600_000, 1.25],
      ["opencode/big-pickle", 1, 22_300, 0],
    ]);
    expect(parseOpencodeStats("no stats yet", null, "x")).toBeUndefined();
  });

  it("is 'no plan limits' with local stats", async () => {
    const bins = stubBins(["opencode"]);
    const { run } = fakeRunner({ opencode: () => ({ stdout: fixture("opencode-stats.txt") }) });
    const limits = valid(await opencodeProvider().read(ctx({ env: bins.env, run })));
    expect(limits).toMatchObject({ status: "unsupported", loggedIn: null, reason: expect.stringContaining("no plan limits") });
    expect(limits.local?.costUsd).toBe(1.25);
  });
});

// ---------- estimates + service ----------

function record(patch: Partial<UsageRecord>): UsageRecord {
  return {
    v: 1,
    ts: "2026-09-24T10:00:00.000Z",
    repoRoot: "/r",
    agentId: "claude",
    model: "claude-opus-5-5",
    turnId: "t",
    stopReason: "end_turn",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    costUsd: 0.5,
    costSource: "agent",
    durationMs: 1000,
    ...patch,
  };
}

function fakeProvider(id: string, value: Partial<AgentLimits> | (() => Promise<AgentLimits>), ttlMs = 60_000): LimitsProvider & { reads: number } {
  const p = {
    id,
    name: id,
    ttlMs,
    reads: 0,
    async read(c: LimitsContext): Promise<AgentLimits> {
      p.reads++;
      if (typeof value === "function") return value();
      return { agentId: id, name: id, installed: true, loggedIn: true, plan: null, status: "ok", meters: [], source: "fake", checkedAt: new Date(c.now()).toISOString(), ...value };
    },
  };
  return p;
}

describe("estimates and the limits service", () => {
  it("picks the period per agent and folds the log", async () => {
    const weekly = { meters: [{ id: "seven_day", label: "Weekly", kind: "weekly", usedPercent: 10, resetsAt: "2026-09-29T09:00:00.000Z", periodStart: "2026-09-22T09:00:00.000Z" }] } as unknown as AgentLimits;
    expect(estimatePeriod(weekly, NOW)).toEqual({ since: Date.parse("2026-09-22T09:00:00.000Z"), basis: "this weekly window" });
    expect(estimatePeriod({ meters: [] } as unknown as AgentLimits, NOW)).toEqual({ since: NOW - 30 * 86_400_000, basis: "last 30 days" });
    const estimates = await buildEstimates(
      [
        record({}),
        record({ agentId: "claude-acp", costUsd: null }),
        record({ ts: "2026-09-20T10:00:00.000Z" }), // before the weekly window
        record({ agentId: "cursor", model: "auto", costUsd: null }),
      ],
      new Map([
        ["claude", { since: Date.parse("2026-09-22T09:00:00.000Z"), basis: "this weekly window" }],
        ["cursor", { since: NOW - 30 * 86_400_000, basis: "last 30 days" }],
      ]),
      NOW,
    );
    expect(estimates.get("claude")).toMatchObject({ label: "estimate", turns: 2, inputTokens: 200, costUsd: 0.5, costedTurns: 1, basis: "this weekly window" });
    expect(estimates.get("cursor")).toMatchObject({ turns: 1, costUsd: null, byModel: [{ model: "auto", turns: 1 }] });
  });

  it("caches per TTL, throttles refresh, keeps the last good reading, orders agents", async () => {
    let now = NOW;
    let fail = false;
    const flaky = fakeProvider("claude", async () => {
      if (fail) throw new Error("network down");
      return { agentId: "claude", name: "Claude Code", installed: true, loggedIn: true, plan: "Max", status: "ok", meters: [], source: "fake", checkedAt: new Date(now).toISOString() };
    });
    const missing = fakeProvider("kiro", { status: "not_installed", installed: false });
    const partial = fakeProvider("grok", { status: "partial" });
    const service = new AgentLimitsService({
      providers: [missing, flaky, partial],
      context: { now: () => now },
      records: () => [record({})],
      minRefreshMs: 10_000,
    });
    const first = AgentLimitsReportSchema.parse(await service.report());
    expect(first.agents.map((a) => a.agentId)).toEqual(["claude", "grok", "kiro"]);
    expect(first.agents[0]?.estimate).toMatchObject({ turns: 1 });
    expect(first.agents.find((a) => a.agentId === "kiro")?.estimate).toBeUndefined(); // not installed: no estimate
    await service.report();
    expect(flaky.reads).toBe(1); // cached
    now += 5_000;
    await service.report({ refresh: true });
    expect(flaky.reads).toBe(1); // refresh within minRefreshMs
    now += 6_000;
    fail = true;
    const stale = await service.report({ agentId: "claude", refresh: true });
    expect(flaky.reads).toBe(2);
    expect(stale.agents[0]).toMatchObject({ status: "ok", plan: "Max", stale: true, reason: expect.stringContaining("network down") });
    await expect(service.report({ agentId: "nope" })).rejects.toThrow(/unknown agent "nope"/);
  });

  it("turns a hanging provider into an error", async () => {
    const hang = fakeProvider("cursor", () => new Promise<AgentLimits>(() => {}));
    const service = new AgentLimitsService({ providers: [hang], context: { now: () => NOW }, readTimeoutMs: 20 });
    const report = await service.report();
    expect(report.agents[0]).toMatchObject({ status: "error", reason: expect.stringContaining("no answer within") });
  });

  it("aborts a timed-out read, never stacks a second one on it, keeps its error briefly", async () => {
    let now = NOW;
    let signal: AbortSignal | undefined;
    let finish: ((value: AgentLimits) => void) | undefined;
    let reads = 0;
    const slow: LimitsProvider = {
      id: "kiro",
      name: "Kiro CLI",
      ttlMs: 10 * 60_000,
      read(c) {
        reads++;
        signal = c.signal;
        return new Promise<AgentLimits>((resolve) => {
          finish = resolve; // ignores the abort, like a CLI that is slow to die
        });
      },
    };
    const service = new AgentLimitsService({ providers: [slow], context: { now: () => now }, readTimeoutMs: 20, timeoutRetryMs: 30_000 });
    expect((await service.report()).agents[0]).toMatchObject({ status: "error", reason: expect.stringContaining("no answer within") });
    expect(signal?.aborted).toBe(true); // the provider was told to kill its children
    now += 31_000; // past the brief retry, but the first read has not settled
    expect((await service.report({ refresh: true })).agents[0]?.status).toBe("error");
    expect(reads).toBe(1);
    // The late answer replaces the error instead of waiting out the provider's TTL.
    finish?.({ agentId: "kiro", name: "Kiro CLI", installed: true, loggedIn: true, plan: "Kiro Pro", status: "ok", meters: [], source: "fake", checkedAt: new Date(now).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.report()).agents[0]).toMatchObject({ status: "ok", plan: "Kiro Pro" });
    expect(reads).toBe(1);
  });
});

// ---------- HTTP + CLI ----------

describe("GET /api/usage/agents", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("serves the report, one agent, refresh, and 400 for an unknown agent", async () => {
    const seen: Array<{ agentId?: string; refresh?: boolean }> = [];
    const service = new AgentLimitsService({ providers: [fakeProvider("claude", {}), fakeProvider("cursor", { status: "partial" })], context: { now: () => NOW } });
    const api: UsageApi = {
      summary: async () => {
        throw new Error("unused");
      },
      limits: async () => ({ providers: [] }),
      agentLimits: (request) => {
        seen.push(request);
        return service.report(request);
      },
    };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!handleUsageRequest(req, res, url, api)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const all = await fetch(`http://127.0.0.1:${port}/api/usage/agents`);
    expect(all.status).toBe(200);
    expect(AgentLimitsReportSchema.parse(await all.json()).agents.map((a) => a.agentId)).toEqual(["claude", "cursor"]);
    const one = await fetch(`http://127.0.0.1:${port}/api/usage/agents?agent=claude-acp&refresh=1`);
    expect(((await one.json()) as { agents: unknown[] }).agents).toHaveLength(1);
    expect(seen[1]).toEqual({ agentId: "claude", refresh: true });
    const bad = await fetch(`http://127.0.0.1:${port}/api/usage/agents?agent=nope`);
    expect(bad.status).toBe(400);
    const post = await fetch(`http://127.0.0.1:${port}/api/usage/agents`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("refuses other sites and DNS rebinding before any agent CLI runs", async () => {
    let calls = 0;
    const api: UsageApi = {
      summary: async () => {
        calls++;
        throw new Error("unused");
      },
      limits: async () => {
        calls++;
        return { providers: [] };
      },
      agentLimits: async () => {
        calls++;
        return { checkedAt: new Date(NOW).toISOString(), agents: [] };
      },
    };
    const access = { originAllowed: (origin: string | undefined) => origin === undefined || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === "https://viewer.example", bindHost: "ruah.lan" };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!handleUsageRequest(req, res, url, api, access)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const get = (pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    const self = `127.0.0.1:${port}`;
    // Another site's page: a CORS fetch carries its Origin; an <img> / no-cors fetch carries Sec-Fetch-Site.
    expect(await get("/api/usage/agents?refresh=1", { host: self, origin: "https://evil.example" })).toMatchObject({ status: 403, body: expect.stringContaining("origin not allowed") });
    expect(await get("/api/usage/agents?refresh=1", { host: self, "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403, body: expect.stringContaining("cross-site") });
    expect(await get("/api/usage/limits", { host: self, origin: "https://evil.example" })).toMatchObject({ status: 403 });
    // DNS rebinding: the page's own name in Host (and a same-origin request, so no Origin at all).
    expect(await get("/api/usage/agents?agent=opencode", { host: `attacker.example:${port}` })).toMatchObject({ status: 403, body: expect.stringContaining("host not allowed") });
    expect(await get("/api/usage/agents", { host: `attacker.example:${port}`, "sec-fetch-site": "same-origin" })).toMatchObject({ status: 403 });
    expect(calls).toBe(0);
    // The viewer (same origin, a loopback dev server, an --allow-origin site), curl, and the bound name.
    expect((await get("/api/usage/agents", { host: self, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get("/api/usage/agents", { host: self, origin: "http://localhost:3000", "sec-fetch-site": "cross-site" })).status).toBe(200);
    expect((await get("/api/usage/agents", { host: self, origin: "https://viewer.example" })).status).toBe(200);
    expect((await get("/api/usage/agents", { host: `localhost:${port}` })).status).toBe(200);
    expect((await get("/api/usage/agents", { host: `ruah.lan:${port}` })).status).toBe(200);
    expect((await get("/api/usage/agents", { host: `[::1]:${port}` })).status).toBe(200);
    expect(calls).toBe(6);
  });
});

describe("§20.1 usage settings over HTTP and the CLI", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
  });
  it("GET/POST /api/usage/settings: saved, re-read, other sites refused, bad bodies 400", async () => {
    const home = tempDir("ruah-usage-http-settings-");
    const store = new SettingsStore(home, { env: {} });
    let invalidated = 0;
    const service = new UsageService(new UsageLog(home), new UsageLimitsService({ agents: () => [], currentAgentId: () => "claude", currentBridge: () => undefined }), {
      agentLimits: Object.assign(new AgentLimitsService({ providers: [] }), { invalidate: () => void (invalidated += 1) }),
      settings: { get: () => store.usageSettings(), set: (patch) => store.updateFeatures({ usage: patch }).usage },
    });
    const access = { originAllowed: (origin: string | undefined) => origin === undefined || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!handleUsageRequest(req, res, url, service, access)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/usage/settings`;
    const own = new URL(base).origin;
    const post = (body: string, origin?: string, type = "application/json") =>
      fetch(base, { method: "POST", headers: { "content-type": type, ...(origin !== undefined ? { origin } : {}) }, body });
    expect(await (await fetch(base)).json()).toEqual({ readAppLogins: false, source: "default" });
    expect((await post(JSON.stringify({ readAppLogins: true }), "https://evil.example")).status).toBe(403);
    // Stricter than the read rule: another localhost port (a dev server in the Preview) may not turn it on,
    const otherPort = await post(JSON.stringify({ readAppLogins: true }), "http://localhost:5173");
    expect(otherPort.status).toBe(403);
    expect(((await otherPort.json()) as { error: string }).error).toContain("viewer this daemon serves");
    // nor may a no-preflight text/plain POST, even from the daemon's own origin.
    expect((await post(JSON.stringify({ readAppLogins: true }), own, "text/plain")).status).toBe(415);
    expect((await post(JSON.stringify({ readAppLogins: true }), undefined, "text/plain")).status).toBe(415);
    expect(store.usageSettings().readAppLogins).toBe(false);
    expect(existsSync(path.join(home, "settings.json"))).toBe(false);
    expect((await post("{", own)).status).toBe(400);
    expect((await post(JSON.stringify({ readAppLogins: "yes" }))).status).toBe(400);
    const on = await post(JSON.stringify({ readAppLogins: true }), own);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ readAppLogins: true, source: "settings" });
    expect(invalidated).toBe(1);
    expect(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))).toMatchObject({ usage: { readAppLogins: true } });
    expect((await fetch(base, { method: "PUT" })).status).toBe(405);
  });

  it("ruah app usage settings shows and changes the choice in $RUAH_HOME", () => {
    const home = tempDir("ruah-usage-cli-settings-");
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: { RUAH_HOME: home } };
    expect(runUsageSettings([], io)).toBe(0);
    expect(out.join("")).toContain("saved login for plan usage: off (default)");
    out.length = 0;
    expect(runUsageSettings(["--read-app-logins", "on", "--json"], io)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ readAppLogins: true, source: "settings" });
    expect(new SettingsStore(home, { env: {} }).usageSettings().readAppLogins).toBe(true);
    out.length = 0;
    expect(runUsageSettings([], { ...io, env: { RUAH_HOME: home, RUAH_USAGE_READ_LOGINS: "0" } })).toBe(0);
    expect(out.join("")).toContain("off (set by RUAH_USAGE_READ_LOGINS");
    // The variable wins: say how to use the saved choice, not the --read-app-logins hint that would not help.
    expect(out.join("")).toContain("The saved choice is on. To use it, unset the variable: unset RUAH_USAGE_READ_LOGINS");
    expect(out.join("")).not.toContain("--read-app-logins on");
    expect(runUsageSettings(["--read-app-logins", "maybe"], io)).toBe(2);
    expect(err.join("")).toContain("on or off");
  });
});

describe("ruah app usage limits", () => {
  it("prints text and JSON, filters by agent, rejects unknown agents", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      now: () => NOW,
      providers: [
        fakeProvider("claude", {
          name: "Claude Code",
          plan: "Max",
          meters: [{ id: "five_hour", label: "Session · 5h", kind: "session", usedPercent: 48, resetsAt: "2026-09-25T16:40:00.000Z" }],
          onDemand: { enabled: true, used: 4.2, limit: 50, currency: "USD" },
        }),
        fakeProvider("kiro", { name: "Kiro CLI", status: "not_logged_in", reason: "Kiro CLI is not signed in.", action: "Run `kiro-cli login`." }),
      ],
    };
    expect(await runUsageLimits([], "0.1.0", io)).toBe(0);
    const text = out.join("");
    expect(text).toContain("Claude Code · Max");
    expect(text).toMatch(/Session · 5h\s+█{10}░{10}\s+48% used\s+·\s+resets in 4h 40m/);
    expect(text).toContain("$4.20 of $50.00");
    expect(text).toMatch(/Kiro CLI\s+not logged in/);
    expect(text).toContain("→ Run `kiro-cli login`.");
    out.length = 0;
    expect(await runUsageLimits(["--agent", "kiro", "--json"], "0.1.0", io)).toBe(0);
    const json = AgentLimitsReportSchema.parse(JSON.parse(out.join("")));
    expect(json.agents.map((a) => a.agentId)).toEqual(["kiro"]);
    expect(await runUsageLimits(["--agent", "nope"], "0.1.0", io)).toBe(2);
    expect(err.join("")).toContain('unknown agent "nope"');
    expect(await runUsageLimits(["--bogus"], "0.1.0", io)).toBe(2);
    expect(await runUsage(["frobnicate"], "0.1.0", io)).toBe(2);
    out.length = 0;
    expect(await runUsage(["help"], "0.1.0", io)).toBe(0);
    expect(out.join("")).toContain("ruah app usage limits");
  });

  it("runs `usage` even where the current folder holds a usage/ folder", () => {
    const everyPathIsAFolder = () => true;
    expect(opensDesktop("usage", everyPathIsAFolder)).toBe(false);
    expect(opensDesktop("cloud", everyPathIsAFolder)).toBe(false);
    expect(opensDesktop("./usage", everyPathIsAFolder)).toBe(true);
    expect(opensDesktop("my-repo", everyPathIsAFolder)).toBe(true);
    expect(opensDesktop("my-repo", () => false)).toBe(false);
    expect(opensDesktop("open")).toBe(true);
    expect(opensDesktop(undefined)).toBe(true);
    expect(opensDesktop("--json", everyPathIsAFolder)).toBe(false);
  });

  it("formats every status", () => {
    const text = formatLimitsReport(
      {
        checkedAt: new Date(NOW).toISOString(),
        agents: [
          { agentId: "opencode", name: "OpenCode", installed: true, loggedIn: null, plan: null, status: "unsupported", reason: "No plan limits.", meters: [], source: "opencode stats", checkedAt: new Date(NOW).toISOString(), local: { source: "opencode stats --days 30", since: null, sessions: 17, inputTokens: 9_600_000, outputTokens: 206_700, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.25, approximate: true, byModel: [] } },
          { agentId: "grok", name: "Grok Build", installed: false, loggedIn: null, plan: null, status: "not_installed", reason: "Not installed.", meters: [], source: "grok", checkedAt: new Date(NOW).toISOString() },
        ],
      },
      NOW,
    );
    expect(text).toMatch(/OpenCode\s+no plan limits/);
    expect(text).toContain("Local stats    17 sessions · 9.81M tokens · $1.25 (rounded)");
    expect(text).toMatch(/Grok Build\s+not installed/);
  });

  it("prints a currency Intl does not know instead of failing the whole report", () => {
    const kiro = parseKiroUsage({ usageBreakdownList: [{ currentUsage: 5, usageLimit: 50, currency: "credits", overageCharges: 1.5 }], overageConfiguration: { overageStatus: "ENABLED" } })!;
    expect(kiro.onDemand?.currency).toBe("CREDITS");
    const text = formatLimitsReport(
      { checkedAt: new Date(NOW).toISOString(), agents: [{ agentId: "kiro", name: "Kiro CLI", installed: true, loggedIn: true, plan: null, status: "ok", meters: kiro.meters, onDemand: kiro.onDemand!, source: "kiro", checkedAt: new Date(NOW).toISOString() }] },
      NOW,
    );
    expect(text).toContain("1.50 CREDITS");
  });
});
