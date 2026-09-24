// src/engines/cli.ts — run `ruah <tool> … --json` (or a direct bin) via the
// shared integrations/exec runner. Engines are never reimplemented here.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CliError,
  IntegrationError,
  parseJson,
  resolveBin,
  type Runner,
  defaultRunner,
} from "../integrations/exec.js";

export const ENGINE_TIMEOUT_MS = 120_000;

export type EngineNamespace = "verify" | "eval" | "opt" | "conv" | "guard";

const DIRECT_BINS: Record<EngineNamespace, string> = {
  verify: "ruah-verify",
  eval: "ruah-eval",
  opt: "ruah-opt",
  conv: "ruah-conv",
  guard: "ruah-guard",
};

export interface EngineCliDeps {
  runner?: Runner;
  /** Prefer workspace sibling CLIs when running from the ruah-tools monorepo. */
  workspaceRoot?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface EngineJsonResult<T> {
  ok: true;
  data: T;
  code: number;
}

export interface EngineCliFailure {
  ok: false;
  status: number;
  error: string;
  kind: "missing" | "timeout" | "failed" | "user";
}

function workspaceCli(namespace: EngineNamespace, workspaceRoot: string | undefined): string | undefined {
  if (!workspaceRoot) return undefined;
  const folder = `ruah-${namespace === "conv" ? "conv" : namespace}`;
  const candidates = [
    path.join(workspaceRoot, folder, "dist", "cli.js"),
    path.join(workspaceRoot, folder, "packages", "core", "dist", "cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve how to invoke an engine: prefer `ruah <ns>`, then direct bin, then
 * a workspace dist/cli.js when RUAH_WORKSPACE / sibling layout is known.
 */
export function resolveEngineInvocation(
  namespace: EngineNamespace,
  deps: EngineCliDeps = {},
): { kind: "ruah"; bin: string; prefix: string[] } | { kind: "direct"; bin: string; prefix: string[] } | null {
  const env = deps.env ?? process.env;
  const workspace = deps.workspaceRoot ?? (env.RUAH_WORKSPACE?.trim() || undefined);
  const ruah = resolveBin("ruah", env);
  if (ruah) return { kind: "ruah", bin: ruah, prefix: [namespace] };

  const direct = resolveBin(DIRECT_BINS[namespace], env);
  if (direct) return { kind: "direct", bin: direct, prefix: [] };

  const ws = workspaceCli(namespace, workspace);
  if (ws) return { kind: "direct", bin: process.execPath, prefix: [ws] };

  return null;
}

export async function runEngineJson<T>(
  namespace: EngineNamespace,
  args: readonly string[],
  options: {
    cwd: string;
    deps?: EngineCliDeps;
    timeoutMs?: number;
  },
): Promise<EngineJsonResult<T> | EngineCliFailure> {
  const deps = options.deps ?? {};
  const runner = deps.runner ?? defaultRunner;
  const inv = resolveEngineInvocation(namespace, deps);
  if (!inv) {
    return {
      ok: false,
      status: 424,
      kind: "missing",
      error: `ruah ${namespace} is not installed. npm i -g @ruah-dev/cli @ruah-dev/${namespace}`,
    };
  }
  const fullArgs = [...inv.prefix, ...args];
  if (!fullArgs.includes("--json")) fullArgs.push("--json");
  try {
    const result = await runner(inv.bin, fullArgs, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? ENGINE_TIMEOUT_MS,
    });
    const parsed = parseJson(result.stdout);
    if (parsed === undefined) {
      return {
        ok: false,
        status: 502,
        kind: "failed",
        error: `ruah ${namespace} returned non-JSON (exit ${result.code})`,
      };
    }
    return { ok: true, data: parsed as T, code: result.code };
  } catch (err) {
    if (err instanceof CliError) {
      return {
        ok: false,
        status: err.kind === "missing" ? 424 : err.kind === "timeout" ? 504 : 502,
        kind: err.kind,
        error: err.message,
      };
    }
    if (err instanceof IntegrationError) {
      return { ok: false, status: err.status, kind: "user", error: err.message };
    }
    return {
      ok: false,
      status: 502,
      kind: "failed",
      error: err instanceof Error ? err.message : "engine failed",
    };
  }
}
