// src/extensions/launcher.ts — `ruah app ext exec --secrets <scopeKey>:<id>
// --env NAME… -- <command> [args…]`: the stdio MCP server wrapper agents
// start when a server needs secrets. It reads each NAME from the Keychain
// (service "ruah", account ext:<scopeKey>:<id>:<NAME>) — else keeps the
// value it inherited — and execs the real command with stdio passed through,
// so the MCP protocol flows untouched. Values never appear in argv, stdout
// or logs; stdout belongs to the protocol, messages go to stderr.
import { spawn } from "node:child_process";
import { searchPath } from "../integrations/exec.js";
import { Keychain, type SecretStore } from "../integrations/keychain.js";
import { EnvNameSchema } from "../contracts/extensions.js";
import { secretAccount } from "./model.js";

export interface ExecPlan {
  scopeKey: string;
  id: string;
  names: string[];
  command: string;
  args: string[];
}

export function parseExecArgs(argv: readonly string[]): ExecPlan | string {
  let secrets: string | undefined;
  const names: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--secrets") secrets = argv[++i];
    else if (arg === "--env") {
      const name = argv[++i] ?? "";
      if (!EnvNameSchema.safeParse(name).success) return `invalid env name: ${name}`;
      names.push(name);
    } else return `unexpected argument: ${arg}`;
  }
  const command = argv[i];
  if (command === undefined || command.length === 0) return "missing command after --";
  const match = secrets !== undefined ? /^([^:]+):([a-z0-9][a-z0-9._-]{0,62})$/.exec(secrets) : null;
  if (match === null) return "--secrets <scopeKey>:<id> is required";
  return { scopeKey: match[1] ?? "", id: match[2] ?? "", names, command, args: argv.slice(i + 1) };
}

/** The environment the server starts with (inherited + Keychain values). */
export async function execEnv(plan: ExecPlan, store: SecretStore, base: NodeJS.ProcessEnv = process.env): Promise<{ env: NodeJS.ProcessEnv; missing: string[] }> {
  const env: NodeJS.ProcessEnv = { ...base, PATH: searchPath(base) };
  const missing: string[] = [];
  for (const name of plan.names) {
    let value: string | null = null;
    try {
      value = await store.get(secretAccount(plan.scopeKey, plan.id, name));
    } catch {
      value = null;
    }
    if (value !== null) env[name] = value;
    else if (base[name] === undefined || base[name] === "") missing.push(name);
  }
  return { env, missing };
}

export async function runExec(argv: readonly string[], deps: { secrets?: SecretStore } = {}): Promise<number> {
  const plan = parseExecArgs(argv);
  if (typeof plan === "string") {
    process.stderr.write(`ruah app ext exec: ${plan}\n`);
    return 2;
  }
  const { env, missing } = await execEnv(plan, deps.secrets ?? new Keychain());
  if (missing.length > 0) process.stderr.write(`ruah: ${plan.id}: no value for ${missing.join(", ")} (set it in Ruah → Extensions)\n`);
  return new Promise<number>((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: "inherit", env });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) process.on(signal, forward);
    child.once("error", (err) => {
      process.stderr.write(`ruah app ext exec: cannot start ${plan.command}: ${(err as NodeJS.ErrnoException).code ?? "error"}\n`);
      resolve(127);
    });
    child.once("exit", (code, signal) => {
      for (const s of signals) process.off(s, forward);
      resolve(code ?? (signal !== null ? 128 + 15 : 1));
    });
  });
}
