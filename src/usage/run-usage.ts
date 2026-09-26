// src/usage/run-usage.ts — `ruah app usage limits [--agent <id>] [--json]`
// (CONTRACTS §16): every coding agent's plan limits without the daemon. Claude
// is read with one short-lived probe (a CLI start, no model request;
// RUAH_CLAUDE_USAGE_PROBE=0 skips it), the others from their own CLIs; the
// estimates come from $RUAH_HOME/usage.jsonl. Reading the Cursor app's saved
// login follows `usage.readAppLogins` in $RUAH_HOME/settings.json (§21.1,
// default off; `ruah app usage settings --read-app-logins on` turns it on).
import { parseArgs } from "node:util";
import type { AgentLimitsReport } from "../contracts/agent-limits.js";
import { SettingsStore } from "../projects/settings-store.js";
import { UsageLog, ruahHome } from "./log.js";
import { READ_LOGINS_ENV } from "./settings.js";
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
  ruah app usage settings [--read-app-logins on|off] [--json]
      show or change whether Ruah reads the Cursor app's saved login to show
      Cursor's plan usage (off by default; the token stays in memory for one
      read-only request to cursor.com and is never stored). Saved in
      $RUAH_HOME/settings.json, shared with the app.

Environment:
  RUAH_CLAUDE_USAGE_PROBE=0   do not start Claude Code to read its windows
  RUAH_USAGE_READ_LOGINS=0|1  override the saved choice about the Cursor
                              app's login (0: tier only, 1: read it)
`;

export interface UsageCliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  now?: () => number;
  /** Test hooks. */
  providers?: LimitsProvider[];
  context?: Partial<LimitsContext>;
  /** Environment for RUAH_HOME / RUAH_USAGE_READ_LOGINS (tests); default process.env. */
  env?: NodeJS.ProcessEnv;
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
  const env = io.env ?? process.env;
  const log = new UsageLog(ruahHome(env));
  const settings = new SettingsStore(ruahHome(env), { env });
  const service = new AgentLimitsService({
    providers,
    context: { now, version, appLogins: () => settings.usageSettings(), ...io.context },
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

const ON = new Set(["on", "true", "1", "yes"]);
const OFF = new Set(["off", "false", "0", "no"]);

/** `ruah app usage settings [--read-app-logins on|off] [--json]` (§21.1). */
export function runUsageSettings(argv: readonly string[], io: UsageCliIo = defaultIo): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { "read-app-logins": { type: "string" }, json: { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    io.err(`ruah app usage settings: ${(err as Error).message}\n`);
    return 2;
  }
  const env = io.env ?? process.env;
  const store = new SettingsStore(ruahHome(env), { env, onError: (line) => io.err(`${line}\n`) });
  const raw = values["read-app-logins"]?.trim().toLowerCase();
  if (raw !== undefined) {
    if (!ON.has(raw) && !OFF.has(raw)) {
      io.err(`ruah app usage settings: --read-app-logins takes on or off, not "${raw}"\n`);
      return 2;
    }
    store.updateFeatures({ usage: { readAppLogins: ON.has(raw) } });
  }
  const view = store.usageSettings();
  if (values.json === true) {
    io.out(`${JSON.stringify(view, null, 2)}\n`);
    return 0;
  }
  const state = view.readAppLogins ? "on" : "off";
  const why = view.source === "env" ? ` (set by ${READ_LOGINS_ENV}, which wins over the saved choice)` : view.source === "default" ? " (default)" : "";
  const lines = [`Read the Cursor app's saved login for plan usage: ${state}${why}`];
  if (view.readAppLogins) lines.push("  The token is read from the Cursor app, used for one read-only request to cursor.com, and never stored.");
  if (view.source === "env") {
    // --read-app-logins cannot change what this process (or a Ruah started with the variable) uses.
    const saved = new SettingsStore(ruahHome(env), { env: {} }).usageSettings();
    lines.push(`  The saved choice is ${saved.readAppLogins ? "on" : "off"}. To use it, unset the variable: unset ${READ_LOGINS_ENV}`);
  } else if (!view.readAppLogins) {
    lines.push("  Cursor's card shows its tier only. Turn it on with: ruah app usage settings --read-app-logins on");
  }
  if (raw !== undefined && view.source !== "env") lines.push("  A running Ruah picks up the change within a few seconds.");
  io.out(`${lines.join("\n")}\n`);
  return 0;
}

export async function runUsage(argv: readonly string[], version: string, io: UsageCliIo = defaultIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(USAGE_HELP);
    return sub === undefined ? 2 : 0;
  }
  if (sub === "limits") return runUsageLimits(rest, version, io);
  if (sub === "settings") return runUsageSettings(rest, io);
  io.err(`ruah app usage: unknown command "${sub}"\n\n${USAGE_HELP}`);
  return 2;
}
