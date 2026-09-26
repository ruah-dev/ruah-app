// src/usage/limits/opencode.ts — OpenCode has no plan limits of its own (it
// bills through the providers you connect: API keys, or OpenCode Zen), so the
// card says that and shows what `opencode stats --days 30 --models` recorded
// locally: sessions, tokens, cost, per model. The stats are a box-drawn table
// with rounded figures ("9.6M"), hence `approximate`.
import type { AgentLimits, LocalUsage, ModelUsage } from "../../contracts/agent-limits.js";
import { resolveAgentBinary } from "../../acp/presets.js";
import { agentLimits, parseCompactNumber, plainText, runOptions, safeMessage, type LimitsProvider } from "./common.js";

export const OPENCODE_ID = "opencode";
export const OPENCODE_NAME = "OpenCode";
const DAYS = 30;
const DAY = 86_400_000;

interface Row {
  label: string;
  value: string | undefined;
}

/** One table line → label and value ("│Total Cost      $0.00 │"); undefined for borders. */
function rowOf(line: string): Row | undefined {
  const inner = /^\s*[│|](.*)[│|]\s*$/.exec(line)?.[1];
  if (inner === undefined) return undefined;
  const text = inner.replace(/\s+$/, "");
  if (text.trim().length === 0) return undefined;
  const m = /^\s*(\S.*?)\s{2,}(\S.*)$/.exec(text);
  return m !== null ? { label: m[1]!.trim(), value: m[2]!.trim() } : { label: text.trim(), value: undefined };
}

/** `opencode stats --models` → totals and per-model rows (pure). */
export function parseOpencodeStats(stdout: string, since: string | null, source: string): LocalUsage | undefined {
  let section = "";
  let found = false;
  const totals = { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null as number | null };
  const models: Array<ModelUsage & { turns: number }> = [];
  let current: (ModelUsage & { turns: number }) | undefined;
  for (const line of plainText(stdout).split("\n")) {
    const row = rowOf(line);
    if (row === undefined) continue;
    if (row.value === undefined) {
      if (/^[A-Z &]+$/.test(row.label)) {
        section = row.label;
        current = undefined;
      } else if (section === "MODEL USAGE") {
        current = { model: row.label, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
        models.push(current);
      }
      continue;
    }
    const n = parseCompactNumber(row.value.replace(/\s.*$/, ""));
    if (n === undefined) continue;
    if (section === "MODEL USAGE" && current !== undefined) {
      if (row.label === "Messages") current.turns = n;
      else if (row.label === "Input Tokens") current.inputTokens = n;
      else if (row.label === "Output Tokens") current.outputTokens = n;
      else if (row.label === "Cache Read") current.cacheReadTokens = n;
      else if (row.label === "Cache Write") current.cacheWriteTokens = n;
      else if (row.label === "Cost") current.costUsd = n;
      continue;
    }
    found = true;
    if (row.label === "Sessions") totals.sessions = n;
    else if (row.label === "Input") totals.input = n;
    else if (row.label === "Output") totals.output = n;
    else if (row.label === "Cache Read") totals.cacheRead = n;
    else if (row.label === "Cache Write") totals.cacheWrite = n;
    else if (row.label === "Total Cost") totals.cost = n;
  }
  if (!found) return undefined;
  return {
    source,
    since,
    sessions: totals.sessions,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    costUsd: totals.cost,
    approximate: true,
    byModel: models,
  };
}

export function opencodeProvider(): LimitsProvider {
  return {
    id: OPENCODE_ID,
    name: OPENCODE_NAME,
    // Local stats only.
    ttlMs: 10 * 60_000,
    async read(ctx): Promise<AgentLimits> {
      const now = ctx.now();
      const checkedAt = new Date(now).toISOString();
      const bin = resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [".opencode/bin"], ctx.env);
      if (bin === undefined) {
        return agentLimits(OPENCODE_ID, OPENCODE_NAME, "not_installed", {
          checkedAt,
          source: "opencode",
          installed: false,
          reason: "OpenCode is not installed.",
          action: "Install OpenCode (https://opencode.ai), then run `opencode auth login`.",
        });
      }
      let local: LocalUsage | undefined;
      try {
        const res = await ctx.run(bin, ["stats", "--days", String(DAYS), "--models"], runOptions(ctx, 20_000));
        if (res.code === 0) local = parseOpencodeStats(res.stdout, new Date(now - DAYS * DAY).toISOString(), `opencode stats --days ${DAYS}`);
      } catch (err) {
        ctx.debug(`opencode stats failed: ${safeMessage(err)}`);
      }
      return agentLimits(OPENCODE_ID, OPENCODE_NAME, "unsupported", {
        checkedAt,
        source: "opencode stats",
        reason: "OpenCode has no plan limits of its own: it bills through the providers you connect (API keys, or OpenCode Zen credits).",
        ...(local !== undefined ? { local } : {}),
      });
    },
  };
}
