// src/usage/limits/kiro.ts — Kiro CLI: sign-in from `kiro-cli whoami --format
// json`; credits used / remaining, bonus and trial grants, overages and the
// reset date from Kiro's own /usage command, run over its ACP server
// (`kiro-cli acp` → initialize → session/new → `_kiro.dev/commands/execute`
// { command: "usage" }). Kiro authenticates itself; Ruah never sees a token.
// The command answers from CodeWhisperer GetUsageLimits (usageBreakdownList,
// nextDateReset, subscriptionInfo…), parsed defensively; when Kiro returns
// only text, the text is parsed and shown as Kiro wrote it.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentLimits, LimitMeter, OnDemandSpend } from "../../contracts/agent-limits.js";
import { resolveAgentBinary } from "../../acp/presets.js";
import {
  agentLimits,
  arr,
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
import { StdioRpc, defaultSpawner, type Spawner } from "./stdio-rpc.js";

export const KIRO_ID = "kiro";
export const KIRO_NAME = "Kiro CLI";
const DASHBOARD = "https://app.kiro.dev/account/usage";
const SOURCE = "kiro-cli /usage over ACP (Kiro's own login)";

/** `kiro-cli whoami --format json`: `{"account":null}` when signed out. */
export function parseKiroWhoami(stdout: string): { loggedIn: boolean; plan: string | null } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const o = obj(value);
  if (o === undefined || !("account" in o)) return undefined;
  const account = obj(o.account);
  if (account === undefined) return { loggedIn: false, plan: null };
  const plan = str(obj(account.subscription)?.title) ?? str(account.subscriptionTitle) ?? str(account.plan);
  return { loggedIn: true, plan: planName(plan) };
}

export interface KiroUsage {
  plan: string | null;
  meters: LimitMeter[];
  onDemand?: OnDemandSpend;
  /** Kiro's own text when it sent no numbers we recognise. */
  message?: string;
}

const USAGE_KEYS = ["usageBreakdownList", "usageBreakdown", "subscriptionInfo", "nextDateReset"];

/** The GetUsageLimits-shaped object anywhere in the command result (breadth-first, shallow). */
function findUsage(value: unknown): Json | undefined {
  const queue: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
  while (queue.length > 0) {
    const { v, depth } = queue.shift()!;
    const o = obj(v);
    if (o === undefined) continue;
    if (USAGE_KEYS.some((k) => k in o)) return o;
    if (depth < 4) for (const child of Object.values(o)) if (typeof child === "object" && child !== null) queue.push({ v: child, depth: depth + 1 });
  }
  return undefined;
}

function monthBefore(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}

const precise = (o: Json, key: string): number | undefined => num(o[`${key}WithPrecision`]) ?? num(o[key]);

function creditMeter(b: Json, fallbackReset: string | null): LimitMeter | undefined {
  const used = precise(b, "currentUsage");
  const limit = precise(b, "usageLimit");
  if (used === undefined && limit === undefined) return undefined;
  const resetsAt = isoFrom(b.nextDateReset) ?? fallbackReset;
  const type = str(b.resourceType)?.toLowerCase();
  return {
    id: type === undefined || type === "credit" ? "credits" : type,
    label: str(b.displayNamePlural) ?? (type === undefined || type === "credit" ? "Credits" : str(b.displayName) ?? type),
    kind: "credits",
    usedPercent: percentOf(used, limit),
    used: used !== undefined ? round(used) : null,
    limit: limit !== undefined ? round(limit) : null,
    unit: "credits",
    resetsAt,
    periodStart: monthBefore(resetsAt),
  };
}

function grantMeter(id: string, label: string, g: Json, expiresKey: string): LimitMeter | undefined {
  const used = precise(g, "currentUsage");
  const limit = precise(g, "usageLimit");
  if (limit === undefined) return undefined;
  return {
    id,
    label,
    kind: "credits",
    usedPercent: percentOf(used ?? 0, limit),
    used: round(used ?? 0),
    limit: round(limit),
    unit: "credits",
    resetsAt: isoFrom(g[expiresKey]),
    detail: "Expires instead of resetting",
  };
}

/** Kiro's text answer ("… 50.2 of 1000 credits … (5% used) … resets on Oct 01, 2026 …"). */
export function parseKiroUsageText(text: string): LimitMeter | undefined {
  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(text);
  const amounts = /([\d,]+(?:\.\d+)?)\s*(?:\/|of)\s*([\d,]+(?:\.\d+)?)\s*(?:credits?)?/i.exec(text);
  const reset = /resets?\s+on\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4})/i.exec(text);
  const used = amounts !== null ? Number(amounts[1]!.replace(/,/g, "")) : undefined;
  const limit = amounts !== null ? Number(amounts[2]!.replace(/,/g, "")) : undefined;
  const usedPercent = pct !== null ? Math.min(100, Number(pct[1])) : percentOf(used, limit);
  if (usedPercent === null) return undefined;
  const resetsAt = reset !== null ? isoFrom(`${reset[1]!.replace(".", "")} 00:00:00 UTC`) : null;
  return {
    id: "credits",
    label: "Credits",
    kind: "credits",
    usedPercent,
    used: used ?? null,
    limit: limit ?? null,
    unit: "credits",
    resetsAt,
    periodStart: monthBefore(resetsAt),
    detail: "From Kiro's /usage text",
  };
}

/** The /usage command result → plan, meters and overages (pure). */
export function parseKiroUsage(result: unknown): KiroUsage | undefined {
  const envelope = obj(result);
  const message = str(envelope?.message);
  const usage = findUsage(envelope?.data ?? result);
  if (usage === undefined) {
    if (message === undefined) return undefined;
    const meter = parseKiroUsageText(message);
    return { plan: null, meters: meter !== undefined ? [meter] : [], message: message.slice(0, 400) };
  }
  const fallbackReset = isoFrom(usage.nextDateReset);
  const list = arr(usage.usageBreakdownList).map(obj).filter((b): b is Json => b !== undefined);
  const single = obj(usage.usageBreakdown);
  const breakdowns = list.length > 0 ? list : single !== undefined ? [single] : [];
  const meters: LimitMeter[] = [];
  let overage: OnDemandSpend | undefined;
  const overageConfig = obj(usage.overageConfiguration);
  for (const b of breakdowns) {
    const meter = creditMeter(b, fallbackReset);
    if (meter !== undefined) meters.push(meter);
    const trial = obj(b.freeTrialInfo);
    if (trial !== undefined && (str(trial.freeTrialStatus) ?? "ACTIVE").toUpperCase() === "ACTIVE") {
      const m = grantMeter("trial", "Free trial credits", trial, "freeTrialExpiry");
      if (m !== undefined) meters.push(m);
    }
    for (const bonus of arr(b.bonuses).map(obj)) {
      if (bonus === undefined || (str(bonus.status) ?? "ACTIVE").toUpperCase() !== "ACTIVE") continue;
      const code = str(bonus.bonusCode) ?? str(bonus.displayName) ?? String(meters.length);
      const m = grantMeter(`bonus:${code.toLowerCase()}`, str(bonus.displayName) ?? "Bonus credits", bonus, "expiresAt");
      if (m !== undefined) meters.push(m);
    }
    if (overage === undefined && overageConfig !== undefined) {
      const enabled = (str(overageConfig.overageStatus) ?? "").toUpperCase() === "ENABLED";
      const overCredits = precise(b, "currentOverages");
      overage = {
        enabled,
        used: num(b.overageCharges) ?? (enabled ? 0 : null),
        limit: num(b.overageCap) ?? num(overageConfig.overageLimit) ?? null,
        currency: (str(b.currency) ?? "USD").toUpperCase(),
        ...(overCredits !== undefined && overCredits > 0 ? { note: `${round(overCredits)} overage credits` } : {}),
      };
    }
  }
  const plan = planName(str(obj(usage.subscriptionInfo)?.subscriptionTitle));
  return { plan, meters, ...(overage !== undefined ? { onDemand: overage } : {}), ...(meters.length === 0 && message !== undefined ? { message: message.slice(0, 400) } : {}) };
}

/** Runs Kiro's /usage over ACP and returns the raw command result. */
export async function kiroAcpUsage(bin: string, ctx: LimitsContext, spawner: Spawner = defaultSpawner): Promise<unknown> {
  // A Ruah-owned empty folder, so no project's hooks or steering load.
  const cwd = path.join(tmpdir(), "ruah-kiro-usage");
  mkdirSync(cwd, { recursive: true });
  const rpc = new StdioRpc(spawner(bin, ["acp"], { cwd, env: { ...ctx.env, NO_COLOR: "1" } }));
  try {
    await rpc.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ruah", version: ctx.version } },
      20_000,
    );
    const session = obj(await rpc.request("session/new", { cwd, mcpServers: [] }, 30_000));
    const sessionId = str(session?.sessionId);
    if (sessionId === undefined) throw new Error("Kiro started no session");
    return await rpc.request("_kiro.dev/commands/execute", { sessionId, command: { command: "usage", args: {} } }, 30_000);
  } finally {
    rpc.close();
  }
}

export function kiroProvider(options: { spawner?: Spawner } = {}): LimitsProvider {
  return {
    id: KIRO_ID,
    name: KIRO_NAME,
    // Each read starts `kiro-cli acp`; credits move slowly.
    ttlMs: 10 * 60_000,
    async read(ctx): Promise<AgentLimits> {
      const checkedAt = new Date(ctx.now()).toISOString();
      const bin = resolveAgentBinary("kiro-cli", "RUAH_KIRO_BIN", [], ctx.env);
      if (bin === undefined) {
        return agentLimits(KIRO_ID, KIRO_NAME, "not_installed", {
          checkedAt,
          source: "kiro-cli",
          installed: false,
          reason: "kiro-cli is not installed.",
          action: "Install Kiro CLI (https://kiro.dev/docs/cli/), then run `kiro-cli login`.",
        });
      }
      let who: ReturnType<typeof parseKiroWhoami>;
      try {
        const res = await ctx.run(bin, ["whoami", "--format", "json"], runOptions(ctx, 15_000));
        who = parseKiroWhoami(res.stdout);
      } catch (err) {
        ctx.debug(`kiro-cli whoami failed: ${safeMessage(err)}`);
      }
      if (who !== undefined && !who.loggedIn) {
        return agentLimits(KIRO_ID, KIRO_NAME, "not_logged_in", {
          checkedAt,
          source: "kiro-cli whoami",
          loggedIn: false,
          reason: "Kiro CLI is not signed in.",
          action: "Run `kiro-cli login`.",
          dashboardUrl: DASHBOARD,
        });
      }
      let usage: KiroUsage | undefined;
      try {
        usage = parseKiroUsage(await kiroAcpUsage(bin, ctx, options.spawner));
      } catch (err) {
        return agentLimits(KIRO_ID, KIRO_NAME, "error", {
          checkedAt,
          source: SOURCE,
          loggedIn: who?.loggedIn ?? null,
          plan: who?.plan ?? null,
          reason: `Kiro's /usage did not answer: ${safeMessage(err)}`,
          dashboardUrl: DASHBOARD,
        });
      }
      if (usage === undefined || usage.meters.length === 0) {
        return agentLimits(KIRO_ID, KIRO_NAME, "partial", {
          checkedAt,
          source: SOURCE,
          loggedIn: who?.loggedIn ?? null,
          plan: usage?.plan ?? who?.plan ?? null,
          reason: usage?.message !== undefined ? `Kiro reported: ${usage.message}` : "Kiro's /usage returned no credit figures.",
          dashboardUrl: DASHBOARD,
        });
      }
      return agentLimits(KIRO_ID, KIRO_NAME, "ok", {
        checkedAt,
        source: SOURCE,
        loggedIn: true,
        plan: usage.plan ?? who?.plan ?? null,
        meters: usage.meters,
        ...(usage.onDemand !== undefined ? { onDemand: usage.onDemand } : {}),
        dashboardUrl: DASHBOARD,
      });
    },
  };
}
