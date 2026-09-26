// src/usage/limits/cursor.ts — Cursor: the tier from `cursor-agent about
// --format json` (the CLI's own login), and the billing month's included
// usage (total plus the Auto + Composer / API split), on-demand spend and the
// reset date from GET https://cursor.com/api/usage-summary — the endpoint the
// cursor.com dashboard reads — authenticated with the Cursor app's saved login
// (state.vscdb `cursorAuth/accessToken`, read-only through sqlite3).
//
// The token is only ever in memory for the one GET: never logged, never
// persisted, never part of an error message. RUAH_USAGE_READ_LOGINS=0 turns
// the app-login read off (the card then shows the tier only). cursor-agent's
// own login lives in the macOS Keychain, which Ruah does not read (it would
// prompt).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentLimits, LimitMeter, OnDemandSpend } from "../../contracts/agent-limits.js";
import { resolveAgentBinary } from "../../acp/presets.js";
import { resolveBin } from "../../integrations/exec.js";
import {
  agentLimits,
  clampPercent,
  isoFrom,
  num,
  obj,
  percentOf,
  planName,
  round,
  runOptions,
  safeMessage,
  str,
  type Json,
  type LimitsContext,
  type LimitsProvider,
} from "./common.js";

export const CURSOR_ID = "cursor";
export const CURSOR_NAME = "Cursor Agent";
export const CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary";
const DASHBOARD = "https://cursor.com/dashboard?tab=usage";
const SOURCE_TIER = "cursor-agent about";
const SOURCE_USAGE = "cursor.com usage API (read-only, Cursor app login)";

// ---------- cursor-agent about ----------

export interface CursorAbout {
  tier: string | null;
  /** False when about names no account. */
  loggedIn: boolean;
  email: string | null;
}

/** `cursor-agent about --format json` → tier and whether an account is signed in. */
export function parseCursorAbout(stdout: string): CursorAbout | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const o = obj(value);
  if (o === undefined) return undefined;
  const email = str(o.userEmail) ?? null;
  const tier = str(o.subscriptionTier) ?? null;
  return { tier, loggedIn: email !== null || tier !== null, email };
}

// ---------- the Cursor app's saved login ----------

export function cursorStateDbPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.RUAH_CURSOR_STATE_DB?.trim();
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const home = env.HOME ?? homedir();
  const rel = path.join("Cursor", "User", "globalStorage", "state.vscdb");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", rel);
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), rel);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), rel);
}

export interface CursorAppAuth {
  accessToken: string;
  email: string | null;
  membership: string | null;
}

export type CursorAppAuthResult = { kind: "ok"; auth: CursorAppAuth } | { kind: "missing"; reason: string };

const AUTH_KEYS = ["cursorAuth/accessToken", "cursorAuth/cachedEmail", "cursorAuth/stripeMembershipType"] as const;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // not JSON
    }
  }
  return v;
}

/** `sqlite3 -json` rows → the three auth values (pure). */
export function parseCursorAuthRows(stdout: string): CursorAppAuth | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout.trim() || "[]");
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const values = new Map<string, string>();
  for (const row of rows) {
    const r = obj(row);
    const key = str(r?.key);
    const value = typeof r?.value === "string" ? unquote(r.value) : undefined;
    if (key !== undefined && value !== undefined && value.length > 0) values.set(key, value);
  }
  const accessToken = values.get("cursorAuth/accessToken");
  if (accessToken === undefined) return undefined;
  return {
    accessToken,
    email: values.get("cursorAuth/cachedEmail") ?? null,
    membership: values.get("cursorAuth/stripeMembershipType") ?? null,
  };
}

/** Reads the Cursor app's login read-only. Never returns the token in a reason. */
export async function readCursorAppAuth(ctx: LimitsContext, dbPath = cursorStateDbPath(ctx.env)): Promise<CursorAppAuthResult> {
  if (!existsSync(dbPath)) return { kind: "missing", reason: "The Cursor app is not installed or has never been opened on this machine." };
  const sqlite = resolveBin("sqlite3", ctx.env);
  if (sqlite === undefined) return { kind: "missing", reason: "sqlite3 is not installed, so the Cursor app's login cannot be read." };
  const sql = `SELECT key, value FROM ItemTable WHERE key IN (${AUTH_KEYS.map((k) => `'${k}'`).join(", ")})`;
  let stdout: string;
  try {
    const result = await ctx.run(sqlite, ["-readonly", "-json", dbPath, sql], runOptions(ctx, 5_000));
    if (result.code !== 0) return { kind: "missing", reason: `Could not read the Cursor app's state (sqlite3 exit ${result.code}).` };
    stdout = result.stdout;
  } catch {
    return { kind: "missing", reason: "Could not read the Cursor app's state." };
  }
  const auth = parseCursorAuthRows(stdout);
  if (auth === undefined) return { kind: "missing", reason: "The Cursor app is not signed in." };
  return { kind: "ok", auth };
}

/** The JWT payload (unverified: only `sub` and `exp` are used, locally). */
export function decodeJwtPayload(token: string): Json | undefined {
  const part = token.split(".")[1];
  if (part === undefined) return undefined;
  try {
    return obj(JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

/** Whether the token's `exp` is in the past (false when it has none). */
export function tokenExpired(token: string, now: number): boolean {
  const exp = num(decodeJwtPayload(token)?.exp);
  return exp !== undefined && exp * 1000 <= now;
}

/** The dashboard's session cookie: `WorkosCursorSessionToken=<userId>::<jwt>` (URL-encoded). */
export function cursorSessionCookie(token: string): string | undefined {
  const sub = str(decodeJwtPayload(token)?.sub);
  const userId = sub?.split("|").pop();
  if (userId === undefined || userId.length === 0) return undefined;
  return `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
}

// ---------- the usage summary ----------

export interface CursorUsage {
  plan: string | null;
  meters: LimitMeter[];
  onDemand?: OnDemandSpend;
  periodStart: string | null;
  periodEnd: string | null;
}

const cents = (value: number | undefined): number | null => (value === undefined ? null : round(value / 100));

function onDemandFrom(raw: Json | undefined, scope: "personal" | "team"): OnDemandSpend | undefined {
  if (raw === undefined) return undefined;
  const limit = num(raw.limit);
  return {
    enabled: raw.enabled === true,
    used: cents(num(raw.used)),
    limit: limit === undefined ? null : cents(limit),
    currency: "USD",
    scope,
  };
}

/**
 * The usage summary → meters. Reads the dashboard's JSON (`individualUsage.plan`,
 * ISO cycle dates) and, for resilience, the CLI's DashboardService shape
 * (`planUsage`, epoch-ms strings). Plan amounts are cents on the dollar plans
 * (Pro, Pro+, Ultra, Teams) and requests on request-based Enterprise seats.
 */
export function parseCursorUsage(body: unknown): CursorUsage | undefined {
  const b = obj(body);
  if (b === undefined) return undefined;
  const periodStart = isoFrom(b.billingCycleStart);
  const periodEnd = isoFrom(b.billingCycleEnd);
  const membership = str(b.membershipType);
  const unit: LimitMeter["unit"] = membership !== undefined && /enterprise/i.test(membership) ? "requests" : "usd";
  const amount = (v: number | undefined): number | null => (v === undefined ? null : unit === "usd" ? round(v / 100) : v);
  const window = { resetsAt: periodEnd, periodStart } as const;
  const meters: LimitMeter[] = [];
  const individual = obj(b.individualUsage);
  const planUsage = obj(individual?.plan) ?? obj(b.planUsage);
  if (planUsage !== undefined) {
    const used = num(planUsage.used) ?? num(planUsage.totalSpend) ?? num(planUsage.includedSpend);
    const limit = num(planUsage.limit);
    const total = num(planUsage.totalPercentUsed);
    const unlimited = b.isUnlimited === true;
    meters.push({
      id: "included",
      label: "Included usage",
      kind: "monthly",
      usedPercent: unlimited ? null : total !== undefined ? clampPercent(total) : percentOf(used, limit),
      used: amount(used),
      limit: unlimited ? null : amount(limit),
      unit,
      ...window,
      ...(unlimited ? { detail: "Unlimited" } : {}),
    });
    const auto = num(planUsage.autoPercentUsed);
    const api = num(planUsage.apiPercentUsed);
    if (auto !== undefined) meters.push({ id: "auto", label: "Auto + Composer", kind: "monthly", usedPercent: clampPercent(auto), ...window });
    if (api !== undefined) meters.push({ id: "api", label: "API models", kind: "monthly", usedPercent: clampPercent(api), ...window });
  }
  const overall = obj(individual?.overall);
  const overallLimit = num(overall?.limit);
  if (overall !== undefined && overall.enabled !== false && overallLimit !== undefined) {
    const used = num(overall.used);
    meters.push({ id: "overall", label: "Spend limit", kind: "monthly", usedPercent: percentOf(used, overallLimit), used: cents(used), limit: cents(overallLimit), unit: "usd", ...window });
  }
  let onDemand = onDemandFrom(obj(individual?.onDemand), "personal") ?? onDemandFrom(obj(obj(b.teamUsage)?.onDemand), "team");
  const spend = obj(b.spendLimitUsage); // DashboardService shape
  if (onDemand === undefined && spend !== undefined) {
    const limit = num(spend.individualLimit);
    onDemand = {
      enabled: limit !== undefined && limit > 0,
      used: cents(num(spend.individualUsed) ?? 0),
      limit: limit !== undefined && limit > 0 ? cents(limit) : null,
      currency: "USD",
      scope: str(spend.limitType) === "team" ? "team" : "personal",
    };
  }
  return { plan: planName(membership), meters, ...(onDemand !== undefined ? { onDemand } : {}), periodStart, periodEnd };
}

// ---------- provider ----------

function readLogins(env: NodeJS.ProcessEnv): boolean {
  return env.RUAH_USAGE_READ_LOGINS?.trim() !== "0";
}

async function fetchUsage(ctx: LimitsContext, cookie: string): Promise<{ kind: "ok"; body: unknown } | { kind: "rejected"; reason: string } | { kind: "failed"; reason: string }> {
  let res;
  try {
    res = await ctx.fetch(CURSOR_USAGE_URL, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json", "User-Agent": `ruah-app/${ctx.version}` },
      signal: ctx.signal !== undefined ? AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Never the cookie: the message is built from the error type only.
    const name = err instanceof Error ? err.name : "";
    return { kind: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "cursor.com did not answer within 10 s." : "Could not reach cursor.com." };
  }
  if (res.status === 401 || res.status === 403) return { kind: "rejected", reason: `cursor.com rejected the Cursor app's saved login (HTTP ${res.status}).` };
  if (!res.ok) return { kind: "failed", reason: `cursor.com answered HTTP ${res.status}.` };
  try {
    return { kind: "ok", body: JSON.parse(await res.text()) as unknown };
  } catch {
    return { kind: "failed", reason: "cursor.com answered with something that is not JSON." };
  }
}

export function cursorProvider(): LimitsProvider {
  return {
    id: CURSOR_ID,
    name: CURSOR_NAME,
    // Included usage moves slowly; an explicit refresh still reads at once.
    ttlMs: 5 * 60_000,
    async read(ctx): Promise<AgentLimits> {
      const checkedAt = new Date(ctx.now()).toISOString();
      const bin = resolveAgentBinary("cursor-agent", "RUAH_CURSOR_BIN", [".cursor/bin"], ctx.env);
      if (bin === undefined) {
        return agentLimits(CURSOR_ID, CURSOR_NAME, "not_installed", {
          checkedAt,
          source: SOURCE_TIER,
          installed: false,
          reason: "cursor-agent is not installed.",
          action: "Install the Cursor CLI (https://cursor.com/cli), then run `cursor-agent login`.",
        });
      }
      let about: CursorAbout | undefined;
      try {
        const res = await ctx.run(bin, ["about", "--format", "json"], runOptions(ctx, 20_000));
        about = res.code === 0 ? parseCursorAbout(res.stdout) : undefined;
      } catch (err) {
        ctx.debug(`cursor-agent about failed: ${safeMessage(err)}`);
      }
      if (about !== undefined && !about.loggedIn) {
        return agentLimits(CURSOR_ID, CURSOR_NAME, "not_logged_in", {
          checkedAt,
          source: SOURCE_TIER,
          loggedIn: false,
          reason: "cursor-agent is not signed in.",
          action: "Run `cursor-agent login`.",
          dashboardUrl: DASHBOARD,
        });
      }
      // Without cursor-agent's own answer there is no account to match the
      // app's login against: its saved login is not read, nothing is fetched.
      if (about === undefined) {
        return agentLimits(CURSOR_ID, CURSOR_NAME, "error", {
          checkedAt,
          source: SOURCE_TIER,
          reason: "`cursor-agent about` did not answer, so its account could not be confirmed and the Cursor app's usage was not read.",
          dashboardUrl: DASHBOARD,
        });
      }
      const tier = about.tier;
      const partial = (reason: string, action?: string): AgentLimits =>
        agentLimits(CURSOR_ID, CURSOR_NAME, "partial", {
          checkedAt,
          source: SOURCE_TIER,
          loggedIn: about.loggedIn,
          plan: tier,
          reason,
          ...(action !== undefined ? { action } : {}),
          dashboardUrl: DASHBOARD,
        });
      if (!readLogins(ctx.env)) {
        return partial("Included usage needs the Cursor app's login, and reading it is turned off (RUAH_USAGE_READ_LOGINS=0).", "Open cursor.com/dashboard to see included usage.");
      }
      const app = await readCursorAppAuth(ctx);
      if (app.kind === "missing") {
        return partial(`${app.reason} Included usage is read with the Cursor app's login (cursor-agent keeps its own in the Keychain, which Ruah does not read).`, "Sign in to the Cursor app with the same account, or open cursor.com/dashboard.");
      }
      const { auth } = app;
      // Only usage of the account cursor-agent itself uses: both must name it.
      if (about.email === null || auth.email === null) {
        return partial(
          `${about.email === null ? "cursor-agent" : "The Cursor app"} does not say which account it is signed in to, so the app's usage cannot be matched to cursor-agent and is not shown.`,
          "Open cursor.com/dashboard to see included usage.",
        );
      }
      if (about.email.toLowerCase() !== auth.email.toLowerCase()) {
        return partial("The Cursor app is signed in to a different account than cursor-agent, so its usage is not shown here.", "Sign in to the Cursor app with the account cursor-agent uses.");
      }
      if (tokenExpired(auth.accessToken, ctx.now())) {
        return partial("The Cursor app's saved login has expired.", "Open the Cursor app once to refresh its login.");
      }
      const cookie = cursorSessionCookie(auth.accessToken);
      if (cookie === undefined) return partial("The Cursor app's saved login has an unexpected format.");
      const fetched = await fetchUsage(ctx, cookie);
      if (fetched.kind === "rejected") return partial(fetched.reason, "Open the Cursor app once to refresh its login.");
      if (fetched.kind === "failed") {
        return agentLimits(CURSOR_ID, CURSOR_NAME, "error", { checkedAt, source: SOURCE_USAGE, loggedIn: about.loggedIn, plan: tier, reason: fetched.reason, dashboardUrl: DASHBOARD });
      }
      const usage = parseCursorUsage(fetched.body);
      if (usage === undefined || usage.meters.length === 0) {
        return partial("cursor.com returned no included-usage figures for this plan.", "Open cursor.com/dashboard for the details.");
      }
      return agentLimits(CURSOR_ID, CURSOR_NAME, "ok", {
        checkedAt,
        source: SOURCE_USAGE,
        loggedIn: about.loggedIn,
        plan: tier ?? usage.plan ?? planName(auth.membership ?? undefined),
        meters: usage.meters,
        ...(usage.onDemand !== undefined ? { onDemand: usage.onDemand } : {}),
        dashboardUrl: DASHBOARD,
      });
    },
  };
}
