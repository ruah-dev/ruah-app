// src/desktop/doctor.ts — `ruah app doctor`: which tools Ruah can find, with
// the PATH the desktop app uses (the login shell's, see login-env.ts), which
// variables it takes from the shell profile, where it keeps its data and which
// app `ruah app` opens. No daemon needed.
import { existsSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { resolveAgentBinary } from "../acp/presets.js";
import { resolveBin } from "../integrations/exec.js";
import { ruahHome } from "../usage/log.js";
import { enclosingAppBundle, findInstalledApp } from "./launch.js";
import { isMinimalPath, loginShell, mergePaths, missingLoginVars, readLoginEnv, type LoginEnvResult } from "./login-env.js";

export type ToolGroup = "agent" | "source" | "cloud";

export interface ToolSpec {
  /** Executable names tried in order. */
  bins: readonly string[];
  label: string;
  group: ToolGroup;
  /** Agent CLIs also live in their installers' own dirs (relative to $HOME), like presets.ts looks them up. */
  homeDirs?: readonly string[];
  /** Env var that points at a specific binary (agents). */
  overrideVar?: string;
}

export const DOCTOR_TOOLS: readonly ToolSpec[] = [
  { bins: ["claude"], label: "Claude Code CLI (optional: the app bundles the Agent SDK's)", group: "agent", homeDirs: [".claude/local"] },
  { bins: ["cursor-agent"], label: "Cursor Agent", group: "agent", homeDirs: [".cursor/bin"], overrideVar: "RUAH_CURSOR_BIN" },
  { bins: ["grok"], label: "Grok Build", group: "agent", homeDirs: [".grok/bin"], overrideVar: "RUAH_GROK_BIN" },
  { bins: ["kiro-cli"], label: "Kiro CLI", group: "agent", overrideVar: "RUAH_KIRO_BIN" },
  { bins: ["opencode"], label: "OpenCode", group: "agent", homeDirs: [".opencode/bin"], overrideVar: "RUAH_OPENCODE_BIN" },
  { bins: ["git"], label: "Git", group: "source" },
  { bins: ["gh"], label: "GitHub CLI", group: "source" },
  { bins: ["ruah"], label: "ruah toolkit (tasks, workflows, engines)", group: "source" },
  { bins: ["doctl"], label: "DigitalOcean", group: "cloud" },
  { bins: ["aws"], label: "AWS", group: "cloud" },
  { bins: ["gcloud"], label: "Google Cloud", group: "cloud" },
  { bins: ["az"], label: "Azure", group: "cloud" },
  { bins: ["wrangler"], label: "Cloudflare", group: "cloud" },
  { bins: ["vercel"], label: "Vercel", group: "cloud" },
  { bins: ["supabase"], label: "Supabase", group: "cloud" },
  { bins: ["kubectl"], label: "Kubernetes", group: "cloud" },
  { bins: ["railway"], label: "Railway", group: "cloud" },
  { bins: ["flyctl", "fly"], label: "Fly.io", group: "cloud" },
  { bins: ["netlify"], label: "Netlify", group: "cloud" },
  { bins: ["hcloud"], label: "Hetzner", group: "cloud" },
];

export interface ToolStatus {
  name: string;
  label: string;
  group: ToolGroup;
  /** Absolute path, or null when not found. */
  path: string | null;
}

export interface DoctorReport {
  version: string;
  shell: string;
  loginShell: { ok: true; ms: number } | { ok: false; ms: number; error: string } | { ok: false; skipped: true };
  /** The PATH tools are looked up on: the login shell's first, then this process's. */
  path: string;
  environment: {
    /** This process has launchd's bare PATH (started from Finder, the Dock or `open`, not a terminal). */
    bare: boolean;
    /** Variables the login shell exports that this process lacks — what the desktop app adds (names only). */
    fromLoginShell: string[];
  };
  tools: ToolStatus[];
  home: string;
  /** The Ruah.app `ruah app` opens, or null (then it runs this checkout's Electron). */
  app: string | null;
}

export function findTool(spec: ToolSpec, env: NodeJS.ProcessEnv): string | null {
  for (const bin of spec.bins) {
    const found = spec.group === "agent" ? resolveAgentBinary(bin, spec.overrideVar ?? "", spec.homeDirs ?? [], env) : resolveBin(bin, env);
    if (found !== undefined) return found;
  }
  return null;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** Skip the login shell and look tools up on this process's PATH only. */
  loginShell?: boolean;
  timeoutMs?: number;
  version: string;
  /** The package root this CLI runs from: inside Ruah.app, `ruah app` opens that bundle. */
  packageRoot?: string;
  /** Test seam: the login shell's answer. */
  readLogin?: (shell: string, env: NodeJS.ProcessEnv) => Promise<LoginEnvResult>;
}

export async function runDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const shell = loginShell(env);
  let loginState: DoctorReport["loginShell"] = { ok: false, skipped: true };
  let searchPath = env.PATH ?? "";
  let fromLoginShell: string[] = [];
  if (options.loginShell !== false) {
    const read = options.readLogin ?? ((s, e) => readLoginEnv({ shell: s, env: e, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }));
    const result = await read(shell, env);
    if (result.ok) {
      searchPath = mergePaths(result.path, env.PATH);
      fromLoginShell = missingLoginVars(env, result.env);
      loginState = { ok: true, ms: result.ms };
    } else {
      loginState = { ok: false, ms: result.ms, error: result.error };
    }
  }
  const lookupEnv: NodeJS.ProcessEnv = { ...env, PATH: searchPath };
  const tools = DOCTOR_TOOLS.map((spec): ToolStatus => ({
    name: spec.bins[0] ?? "",
    label: spec.label,
    group: spec.group,
    path: findTool(spec, lookupEnv),
  }));
  return {
    version: options.version,
    shell,
    loginShell: loginState,
    path: searchPath,
    environment: { bare: isMinimalPath(env.PATH), fromLoginShell },
    tools,
    home: ruahHome(env),
    app:
      process.platform === "darwin" && env.RUAH_APP_DEV !== "1"
        ? ((options.packageRoot !== undefined ? enclosingAppBundle(options.packageRoot) : undefined) ?? findInstalledApp(env, existsSync) ?? null)
        : null,
  };
}

const GROUP_TITLES: Record<ToolGroup, string> = { agent: "Coding agents", source: "Source control & ruah", cloud: "Cloud CLIs" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [`Ruah ${report.version} — doctor`, ""];
  const login = report.loginShell;
  lines.push(
    "skipped" in login
      ? `PATH       this shell's (login shell skipped)`
      : login.ok
        ? `PATH       ${path.basename(report.shell)} login shell (${login.ms} ms) + this process`
        : `PATH       this process only — ${path.basename(report.shell)} login shell failed: ${login.error}`,
  );
  const vars = report.environment.fromLoginShell;
  if (report.environment.bare) {
    lines.push("Env        this process has launchd's bare environment (not started from a terminal)");
  }
  if (vars.length > 0) {
    const shown = vars.slice(0, 12).join(", ");
    lines.push(`Env        ${vars.length} variable${vars.length === 1 ? "" : "s"} from your shell profile the app adds: ${shown}${vars.length > 12 ? ", …" : ""}`);
  } else if (!("skipped" in login) && login.ok) {
    lines.push("Env        the app gets the same variables as this shell");
  }
  lines.push(`Data       ${report.home}`);
  lines.push(`App        ${report.app ?? "not installed (ruah app runs this checkout's Electron)"}`);
  for (const group of ["agent", "source", "cloud"] as const) {
    lines.push("", GROUP_TITLES[group]);
    const tools = report.tools.filter((t) => t.group === group);
    const width = Math.max(...tools.map((t) => t.name.length));
    for (const tool of tools) {
      lines.push(`  ${tool.path !== null ? "✓" : "–"} ${tool.name.padEnd(width)}  ${tool.path ?? `not found  (${tool.label})`}`);
    }
  }
  const missing = report.tools.filter((t) => t.path === null).length;
  lines.push("", missing === 0 ? "Everything Ruah can use is installed." : `${missing} optional tool${missing === 1 ? "" : "s"} not found — Ruah hides what needs them.`);
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(argv: readonly string[], version: string, packageRoot?: string): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { json: { type: "boolean", default: false }, "no-login-shell": { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(`ruah app doctor: ${(err as Error).message}\n`);
    return 2;
  }
  const report = await runDoctorReport({
    version,
    loginShell: values["no-login-shell"] !== true,
    ...(packageRoot !== undefined ? { packageRoot } : {}),
  });
  process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  return 0;
}
