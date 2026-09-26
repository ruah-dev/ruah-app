// src/engines/cli.ts — run `ruah <tool> … --json` (or a direct bin) via the
// shared integrations/exec runner. Engines are never reimplemented here.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  CliError,
  IntegrationError,
  parseJson,
  resolveBin,
  type Runner,
  defaultRunner,
} from "../integrations/exec.js";
import { selfNodeEnv } from "../desktop/child-env.js";

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
  /** How it runs: `ruah <ns>`, its own bin, or a workspace build (absent when not installed). */
  via?: "ruah" | "bin" | "workspace";
}

/**
 * Whether each optional engine can be run. Spawns nothing: `ruah <ns>` counts
 * only when the ruah toolkit next to the `ruah` bin has a package for that
 * namespace (read from its @ruah-dev/* package.json files, as ruah itself
 * discovers them), then the engine's own bin, then a workspace build.
 */
export function engineStatus(
  deps: EngineCliDeps = {},
  namespaces: readonly EngineNamespace[] = ["guard", "opt", "watch"],
): Record<string, EngineAvailability> {
  const out: Record<string, EngineAvailability> = {};
  for (const namespace of namespaces) {
    const inv = resolveEngineInvocation(namespace, deps);
    out[namespace] = {
      installed: inv !== null,
      install: engineInstallCommand(namespace),
      ...(inv !== null ? { via: inv.kind === "ruah" ? "ruah" : inv.prefix.length > 0 ? "workspace" : "bin" } : {}),
    };
  }
  return out;
}

// ---------- which namespaces the installed `ruah` has (no spawn) ----------

/** Namespaces ruah-cli always lists, with the package that provides them. */
const RUAH_KNOWN_PACKAGES: Record<string, string> = { orch: "orch-core", conv: "conv-core" };
const CLI_PATH_RE = /([^\s'"`]*[\\/]@ruah-dev[\\/]cli[\\/][^\s'"`]*)/;

/**
 * The @ruah-dev scope folder of the toolkit behind a `ruah` bin: npm links the
 * bin to `…/@ruah-dev/cli/dist/cli.js`; Homebrew and others install a small
 * shell shim that names that file. Undefined when it cannot be told.
 */
export function ruahScopeDir(bin: string): string | undefined {
  const fromPath = (file: string): string | undefined => {
    const norm = file.replace(/\\/g, "/");
    const i = norm.lastIndexOf("/@ruah-dev/cli/");
    return i >= 0 ? path.join(norm.slice(0, i), "@ruah-dev") : undefined;
  };
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {
    return undefined;
  }
  const direct = fromPath(real);
  if (direct !== undefined) return direct;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > 16 * 1024) return undefined;
    const text = fs.readFileSync(real, "utf8");
    const named = CLI_PATH_RE.exec(text)?.[1];
    if (named === undefined) return undefined;
    let target = named;
    try {
      target = fs.realpathSync(named);
    } catch {
      // the shim names a path that is gone: still tells where the toolkit was meant to be
    }
    return fromPath(target);
  } catch {
    return undefined;
  }
}

const namespaceCache = new Map<string, { mtimeMs: number; namespaces: Set<string> }>();

/**
 * The namespaces the toolkit in `scopeDir` provides, as ruah-cli discovers
 * them: real folders (not symlinks) whose package.json has `ruah.namespace`,
 * plus orch / conv when their -core package is there. Cached per folder
 * until it changes (an install touches it).
 */
export function ruahNamespaces(scopeDir: string): Set<string> | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(scopeDir).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = namespaceCache.get(scopeDir);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.namespaces;
  const namespaces = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "cli") continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(scopeDir, entry.name, "package.json"), "utf8")) as { ruah?: { namespace?: unknown } };
      if (typeof pkg.ruah?.namespace === "string" && pkg.ruah.namespace.length > 0) namespaces.add(pkg.ruah.namespace);
    } catch {
      // not a package
    }
  }
  // Known packages resolve like ruah-cli resolves them: Node resolution from its own file.
  const requireFromCli = createRequire(path.join(scopeDir, "cli", "dist", "cli.js"));
  for (const [namespace, folder] of Object.entries(RUAH_KNOWN_PACKAGES)) {
    try {
      requireFromCli.resolve(`@ruah-dev/${folder}/package.json`);
      namespaces.add(namespace);
    } catch {
      // not installed
    }
  }
  namespaceCache.set(scopeDir, { mtimeMs, namespaces });
  return namespaces;
}

/** Whether the `ruah` at `bin` has `namespace`: true / false, or undefined when it cannot be told without running it. */
export function ruahHasNamespace(bin: string, namespace: string): boolean | undefined {
  const scope = ruahScopeDir(bin);
  if (scope === undefined) return undefined;
  return ruahNamespaces(scope)?.has(namespace);
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
  namespaceCache.clear();
}

/**
 * Resolve how to invoke an engine: prefer `ruah <ns>`, then direct bin, then
 * a workspace dist/cli.js when RUAH_WORKSPACE / sibling layout is known.
 */
export function resolveEngineInvocation(
  namespace: EngineNamespace,
  deps: EngineCliDeps = {},
): { kind: "ruah"; bin: string; prefix: string[] } | { kind: "direct"; bin: string; prefix: string[]; env?: Record<string, string> } | null {
  const env = deps.env ?? process.env;
  if (env.RUAH_ENGINES_OFF === "1") return null;
  const workspace = deps.workspaceRoot ?? (env.RUAH_WORKSPACE?.trim() || undefined);
  const ruah = resolveBin("ruah", env);
  // A toolkit whose packages say it lacks this engine is skipped up front; one that cannot be
  // inspected is tried, and skipped once it answers "unknown command" (ruahWithout).
  if (ruah && !ruahWithout.has(`${ruah}\u0000${namespace}`) && ruahHasNamespace(ruah, namespace) !== false) {
    return { kind: "ruah", bin: ruah, prefix: [namespace] };
  }

  const direct = resolveBin(DIRECT_BINS[namespace], env);
  if (direct) return { kind: "direct", bin: direct, prefix: [] };

  const ws = workspaceCli(namespace, workspace);
  if (ws) return { kind: "direct", bin: process.execPath, prefix: [ws], env: selfNodeEnv() };

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
      // A workspace engine runs on this process's runtime (in the desktop app: its binary, as Node).
      ...(inv.kind === "direct" && inv.env !== undefined ? { env: inv.env } : {}),
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
