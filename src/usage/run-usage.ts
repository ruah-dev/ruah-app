// src/usage/run-usage.ts — `ruah app usage limits [--agent <id>] [--json]`
// (CONTRACTS §16): every coding agent's plan limits without the daemon. Claude
// is read with one short-lived probe (a CLI start, no model request;
// RUAH_CLAUDE_USAGE_PROBE=0 skips it), the others from their own CLIs; the
// estimates come from $RUAH_HOME/usage.jsonl.
import { parseArgs } from "node:util";
import type { AgentLimitsReport } from "../contracts/agent-limits.js";
import { UsageLog, ruahHome } from "./log.js";
import {
  AgentLimitsService,
  UnknownAgentError,
  defaultProviders,
  formatLimitsReport,
  limitsAgentId,
  probeSource,
  type ClaudePlanSource,
  type LimitsContext,
  type LimitsProvider,
} from "./limits/index.js";

export const USAGE_HELP = `ruah app usage — coding-agent usage (no daemon needed)

Usage:
  ruah app usage limits [--agent <id>] [--json] [--refresh]
      plan limits for every agent: Claude Code (5-hour + weekly windows),
      Cursor (included usage, on-demand spend), Kiro (credits), Grok Build and
      OpenCode (what their CLIs expose), plus Ruah's own estimate per agent.
      <id>: claude, cursor, kiro, grok, opencode

Environment:
  RUAH_CLAUDE_USAGE_PROBE=0   do not start Claude Code to read its windows
  RUAH_USAGE_READ_LOGINS=0    do not read the Cursor app's saved login
                              (Cursor then shows its tier only)
`;

export interface UsageCliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  now?: () => number;
  /** Test hooks. */
  providers?: LimitsProvider[];
  context?: Partial<LimitsContext>;
}

const defaultIo: UsageCliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

async function claudeSource(): Promise<ClaudePlanSource> {
  if (process.env.RUAH_CLAUDE_USAGE_PROBE === "0") {
    return async () => ({ snapshot: undefined, error: undefined, canProbe: false });
  }
  const { probeClaudePlanUsage } = await import("./claude-probe.js");
  return probeSource(() => probeClaudePlanUsage(process.cwd()));
}

export async function runUsageLimits(argv: readonly string[], version: string, io: UsageCliIo = defaultIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { agent: { type: "string" }, json: { type: "boolean", default: false }, refresh: { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    io.err(`ruah app usage limits: ${(err as Error).message}\n`);
    return 2;
  }
  const agentId = values.agent !== undefined ? limitsAgentId(values.agent.trim().toLowerCase()) : undefined;
  const now = io.now ?? Date.now;
  const providers = io.providers ?? defaultProviders(await claudeSource());
  const log = new UsageLog(ruahHome());
  const service = new AgentLimitsService({
    providers,
    context: { now, version, ...io.context },
    records: () => log.records(),
  });
  let report: AgentLimitsReport;
  try {
    report = await service.report({ ...(agentId !== undefined ? { agentId } : {}), refresh: values.refresh === true });
  } catch (err) {
    if (err instanceof UnknownAgentError) {
      io.err(`ruah app usage limits: ${err.message}\n`);
      return 2;
    }
    io.err(`ruah app usage limits: ${(err as Error).message}\n`);
    return 1;
  }
  io.out(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatLimitsReport(report, now()));
  return agentId !== undefined && report.agents[0]?.status === "error" ? 1 : 0;
}

export async function runUsage(argv: readonly string[], version: string, io: UsageCliIo = defaultIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(USAGE_HELP);
    return sub === undefined ? 2 : 0;
  }
  if (sub === "limits") return runUsageLimits(rest, version, io);
  io.err(`ruah app usage: unknown command "${sub}"\n\n${USAGE_HELP}`);
  return 2;
}
