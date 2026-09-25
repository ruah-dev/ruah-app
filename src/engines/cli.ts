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

export type EngineNamespace = "verify" | "eval" | "opt" | "conv" | "guard" | "watch";

const DIRECT_BINS: Record<EngineNamespace, string> = {
  verify: "ruah-verify",
  eval: "ruah-eval",
  opt: "ruah-opt",
  conv: "ruah-conv",
  guard: "ruah-guard",
  watch: "ruah-watch",
};

export function engineInstallCommand(namespace: EngineNamespace): string {
  return `npm i -g @ruah-dev/cli @ruah-dev/${namespace}`;
}

export interface EngineAvailability {
  installed: boolean;
  install: string;
}

/** Whether each optional engine binary can be resolved. Does not spawn it. */
export function engineStatus(
  deps: EngineCliDeps = {},
  namespaces: readonly EngineNamespace[] = ["guard", "opt", "watch"],
): Record<string, EngineAvailability> {
  const out: Record<string, EngineAvailability> = {};
  for (const namespace of namespaces) {
    out[namespace] = {
      installed: resolveEngineInvocation(namespace, deps) !== null,
      install: engineInstallCommand(namespace),
    };
  }
  return out;
}

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
 * `ruah` binaries seen to lack a namespace ("unknown command 'guard'": the
 * toolkit is installed, that engine is not). Keyed by bin path + namespace;
 * they are skipped by resolveEngineInvocation from then on.
 */
const ruahWithout = new Set<string>();

/** Whether `ruah`'s output says it has no such namespace. */
export function isUnknownNamespace(output: string, namespace: EngineNamespace): boolean {
  return new RegExp(`unknown command ['"\u2018\u201c]?${namespace}\\b`, "i").test(output);
}

/** Tests: forget what was learned about installed namespaces. */
export function resetEngineProbe(): void {
  ruahWithout.clear();
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
  if (env.RUAH_ENGINES_OFF === "1") return null;
  const workspace = deps.workspaceRoot ?? (env.RUAH_WORKSPACE?.trim() || undefined);
  const ruah = resolveBin("ruah", env);
  if (ruah && !ruahWithout.has(`${ruah}\u0000${namespace}`)) return { kind: "ruah", bin: ruah, prefix: [namespace] };

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
      error: `ruah ${namespace} is not installed. ${engineInstallCommand(namespace)}`,
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
    if (parsed === undefined && inv.kind === "ruah" && isUnknownNamespace(`${result.stdout}\n${result.stderr}`, namespace)) {
      // The ruah toolkit is there but this engine is not: try its own bin, else say how to install it.
      ruahWithout.add(`${inv.bin}\u0000${namespace}`);
      return runEngineJson<T>(namespace, args, options);
    }
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
