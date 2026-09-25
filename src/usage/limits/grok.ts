// src/usage/limits/grok.ts — Grok Build: sign-in from `grok models` ("You
// are logged in with grok.com."), and what grok itself persisted on this
// machine: per-turn tokens and cost (`grok sessions list` + `grok usage <id>`,
// cost in USD ticks, 1 USD = 1e10 ticks). The plan allowance is only shown
// inside grok's TUI (/usage); there is no headless command for it, so the card
// says so instead of guessing.
import type { AgentLimits, LocalUsage, ModelUsage } from "../../contracts/agent-limits.js";
import { resolveAgentBinary } from "../../acp/presets.js";
import { mapLimit } from "../../integrations/exec.js";
import { agentLimits, arr, num, obj, plainText, round, safeMessage, str, type Json, type LimitsProvider } from "./common.js";

export const GROK_ID = "grok";
export const GROK_NAME = "Grok Build";
const USD_TICKS = 1e10;
const DAY = 86_400_000;
const LOCAL_DAYS = 30;
const MAX_SESSIONS = 60;

export function parseGrokLogin(output: string): { loggedIn: boolean; via: string | null } | undefined {
  const text = plainText(output);
  if (/not (?:logged|signed) in|please (?:log|sign) in|run `?grok login/i.test(text)) return { loggedIn: false, via: null };
  const m = /logged in (?:with|via|using) ([^\n]+?)\.?\s*$/im.exec(text);
  if (m !== null) return { loggedIn: true, via: m[1]!.trim() };
  if (/api key/i.test(text)) return { loggedIn: true, via: "xAI API key" };
  return undefined;
}

export interface GrokSessionRow {
  id: string;
  created: string;
  updated: string;
}

/** `grok sessions list` table rows (id, created, updated dates). */
export function parseGrokSessions(stdout: string): GrokSessionRow[] {
  const rows: GrokSessionRow[] = [];
  for (const line of plainText(stdout).split("\n")) {
    const m = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})/i.exec(line);
    if (m !== null) rows.push({ id: m[1]!, created: m[2]!, updated: m[3]! });
  }
  return rows;
}

interface Acc {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ticks: number;
  turns: number;
}

const emptyAcc = (): Acc => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ticks: 0, turns: 0 });

function addTo(acc: Acc, u: Json, turns: number): void {
  acc.inputTokens += num(u.inputTokens) ?? 0;
  acc.outputTokens += num(u.outputTokens) ?? 0;
  acc.cacheReadTokens += num(u.cachedReadTokens) ?? 0;
  acc.cacheWriteTokens += num(u.cacheCreationTokens) ?? 0;
  acc.ticks += num(u.costUsdTicks) ?? 0;
  acc.turns += turns;
}

export class GrokUsageTotals {
  readonly total = emptyAcc();
  readonly byModel = new Map<string, Acc>();
  sessions = 0;

  /** Adds one `grok usage <id>` answer, counting only turns that ended at or after `sinceMs`. */
  add(answer: unknown, sinceMs: number): void {
    const a = obj(answer);
    if (a === undefined) return;
    let counted = false;
    const turns = arr(a.turns).map(obj).filter((t): t is Json => t !== undefined);
    if (turns.length > 0) {
      for (const turn of turns) {
        const ended = Date.parse(str(turn.endedAt) ?? "");
        if (!(ended >= sinceMs)) continue;
        counted = true;
        this.addTurn(turn);
      }
    } else {
      // No per-turn records: whole-session totals when the session was active in the period.
      const session = obj(a.session);
      const updated = Date.parse(str(a.updatedAt) ?? "");
      if (session !== undefined && updated >= sinceMs) {
        counted = true;
        this.addTurn(session, num(session.turnCount) ?? 1);
      }
    }
    if (counted) this.sessions += 1;
  }

  private addTurn(u: Json, turns = 1): void {
    addTo(this.total, u, turns);
    const models = obj(u.modelUsage);
    const entries = models !== undefined ? Object.entries(models) : [];
    if (entries.length === 0) {
      const model = str(u.primaryModelId) ?? "unknown";
      let row = this.byModel.get(model);
      if (row === undefined) this.byModel.set(model, (row = emptyAcc()));
      addTo(row, u, turns);
      return;
    }
    for (const [model, value] of entries) {
      const m = obj(value);
      if (m === undefined) continue;
      let row = this.byModel.get(model);
      if (row === undefined) this.byModel.set(model, (row = emptyAcc()));
      addTo(row, m, model === (str(u.primaryModelId) ?? model) ? turns : 0);
    }
  }

  toLocalUsage(since: string, source: string): LocalUsage {
    const cost = (ticks: number): number => round(ticks / USD_TICKS, 4);
    const byModel: ModelUsage[] = [...this.byModel]
      .map(([model, a]) => ({ model, turns: a.turns, inputTokens: a.inputTokens, outputTokens: a.outputTokens, cacheReadTokens: a.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens, costUsd: cost(a.ticks) }))
      .sort((x, y) => y.inputTokens + y.outputTokens - (x.inputTokens + x.outputTokens));
    const t = this.total;
    return {
      source,
      since,
      sessions: this.sessions,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      costUsd: cost(t.ticks),
      approximate: false,
      byModel,
    };
  }
}

export function grokProvider(): LimitsProvider {
  return {
    id: GROK_ID,
    name: GROK_NAME,
    ttlMs: 5 * 60_000,
    async read(ctx): Promise<AgentLimits> {
      const now = ctx.now();
      const checkedAt = new Date(now).toISOString();
      const bin = resolveAgentBinary("grok", "RUAH_GROK_BIN", [".grok/bin"], ctx.env);
      if (bin === undefined) {
        return agentLimits(GROK_ID, GROK_NAME, "not_installed", {
          checkedAt,
          source: "grok",
          installed: false,
          reason: "The Grok CLI (grok) is not installed.",
          action: "Install Grok Build and run `grok login`.",
        });
      }
      let login: ReturnType<typeof parseGrokLogin>;
      try {
        const res = await ctx.run(bin, ["models"], { timeoutMs: 20_000 });
        login = parseGrokLogin(`${res.stdout}\n${res.stderr}`);
      } catch (err) {
        ctx.debug(`grok models failed: ${safeMessage(err)}`);
      }
      if (login !== undefined && !login.loggedIn) {
        return agentLimits(GROK_ID, GROK_NAME, "not_logged_in", {
          checkedAt,
          source: "grok models",
          loggedIn: false,
          reason: "Grok is not signed in.",
          action: "Run `grok login`.",
        });
      }
      // What grok recorded locally over the last 30 days.
      const sinceMs = now - LOCAL_DAYS * DAY;
      const since = new Date(sinceMs).toISOString();
      const sinceDay = since.slice(0, 10);
      let local: LocalUsage | undefined;
      try {
        const list = await ctx.run(bin, ["sessions", "list", "-n", "200"], { timeoutMs: 20_000 });
        const rows = parseGrokSessions(list.stdout).filter((r) => r.updated >= sinceDay).slice(0, MAX_SESSIONS);
        const totals = new GrokUsageTotals();
        const answers = await mapLimit(rows, 4, async (row) => {
          try {
            const res = await ctx.run(bin, ["usage", row.id], { timeoutMs: 10_000 });
            return res.code === 0 ? (JSON.parse(res.stdout) as unknown) : undefined;
          } catch {
            return undefined;
          }
        });
        for (const answer of answers) totals.add(answer, sinceMs);
        local = totals.toLocalUsage(since, `grok usage (${totals.sessions} session${totals.sessions === 1 ? "" : "s"}, last ${LOCAL_DAYS} days)`);
      } catch (err) {
        ctx.debug(`grok local usage failed: ${safeMessage(err)}`);
      }
      const via = login?.via ?? null;
      return agentLimits(GROK_ID, GROK_NAME, "partial", {
        checkedAt,
        source: "grok models · grok usage",
        loggedIn: login?.loggedIn ?? null,
        plan: via !== null && /api key/i.test(via) ? "xAI API key" : null,
        reason: `${via !== null ? `Signed in with ${via}. ` : ""}Grok shows its plan allowance only inside the grok app (/usage); it has no command Ruah can read it from.`,
        action: "Run `grok`, then /usage, to see the allowance.",
        ...(local !== undefined ? { local } : {}),
      });
    },
  };
}
