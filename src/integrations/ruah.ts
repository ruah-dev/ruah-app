// src/integrations/ruah.ts — ruah orchestration via the `ruah` CLI in the
// project repo. Reads: `ruah status --json`, `ruah workflow list --json`,
// `ruah task list --json`. Writes only on explicit request: task create /
// done / merge / cancel (awaited, bounded) and task start / workflow run
// (long-running executors: launched detached, output to a log file under
// ~/.ruah/projects/<id>/ruah/). Ruah never runs `ruah init` for the user.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchNode } from "../contracts/architecture.js";
import type { ConnectBody, IntegrationInfo, RuahTaskAction, RuahTaskBody } from "../contracts/integrations.js";
import { RuahTaskNameSchema } from "../contracts/integrations.js";
import type { RuahResume, RuahTaskSummary } from "../contracts/resume.js";
import { arr, cliMessage, CliError, defaultRunner, IntegrationError, obj, parseJson, resolveBin, searchPath, str, stripAnsi, type Runner } from "./exec.js";
import type { Integration, ProjectContext } from "./registry.js";
import { withoutDaemonPlumbing } from "../desktop/child-env.js";
import { projectIdOf } from "./store.js";

const SETUP_HINT = "npm i -g @ruah-dev/cli";
const INIT_HINT = "ruah init";
const NOT_GIT_HINT = "ruah runs tasks on git worktrees, so it needs a git repository: run `git init` in the project folder, or open a repository.";

/** The git work tree `dir` is in (walks up to a `.git` folder or file); undefined outside one. No spawn. */
export function gitRootOf(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * A ruah CLI failure as one readable line: colours, the "✗" mark, Node stack
 * frames and internals dropped; "not a git repository" said plainly.
 */
export function ruahFailureMessage(raw: string): string {
  const all = stripAnsi(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // An uncaught Node error prints the source excerpt first, then "Error: message", then frames.
  const thrown = all.find((l) => /^(?:[A-Z]\w*)?Error(?: \[[\w-]+\])?: /.test(l));
  const lines = thrown !== undefined
    ? [thrown.replace(/^(?:[A-Z]\w*)?Error(?: \[[\w-]+\])?: /, "")]
    : all.filter((l) => !/^at\s/.test(l) && !/node:internal|^\^+$|^Node\.js v\d/.test(l) && !/^(?:file:\/\/)?[\w/.@-]+\.(?:m?js|c?js|ts):\d+$/.test(l));
  const text = lines.join(" ").replace(/^[✗✖×]\s*/u, "").replace(/\s+/g, " ").trim();
  if (/not a git repository/i.test(text)) return "this folder is not a git repository (ruah needs one: `git init`)";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
const MUTATION_TIMEOUT_MS = 120_000;

/** Starts a long-running command detached from the daemon; returns the log file. */
export type Launcher = (bin: string, args: readonly string[], cwd: string, logFile: string) => { pid: number | undefined };

export const detachedLauncher: Launcher = (bin, args, cwd, logFile) => {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a", 0o600);
  try {
    const child = spawn(bin, [...args], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...withoutDaemonPlumbing(process.env), PATH: searchPath(), NO_COLOR: "1" },
    });
    child.on("error", () => {});
    child.unref();
    return { pid: child.pid };
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Lock globs for a task from an element: its `path` (a directory becomes
 * "<dir>/**") plus its `files`. Rejects anything that could escape the repo or
 * break ruah's comma-separated --files list.
 */
export function validateGlobs(globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of globs) {
    const glob = raw.trim().replace(/^\.\//, "");
    if (glob.length === 0) continue;
    if (glob.startsWith("/") || glob.startsWith("-") || /[,\0\n\r]/.test(glob) || glob.split("/").includes("..")) {
      throw new IntegrationError(400, `invalid file glob: ${JSON.stringify(raw)}`);
    }
    if (!out.includes(glob)) out.push(glob);
  }
  return out;
}

export function globsForNode(node: ArchNode, root: string): string[] {
  const globs: string[] = [];
  if (node.path !== undefined && node.path.length > 0) {
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(root, node.path)).isDirectory();
    } catch {
      isDir = !path.extname(node.path);
    }
    globs.push(isDir ? `${node.path.replace(/\/+$/, "")}/**` : node.path);
  }
  const covered = (file: string): boolean => globs.some((g) => g.endsWith("/**") && file.startsWith(g.slice(0, -2)));
  for (const file of node.files ?? []) if (!covered(file)) globs.push(file);
  return globs;
}

export function isInitialized(root: string): boolean {
  return fs.existsSync(path.join(root, ".ruah", "state.json"));
}

/** Task states that are over (left out of "running tasks"). */
const FINISHED_TASK_STATES = new Set(["done", "merged", "cancelled"]);

/**
 * CONTRACTS §13.4: the unfinished `ruah` tasks of a repo that has `.ruah/`
 * (`ruah task list --json`, bounded by a short timeout). Never throws: a
 * missing CLI or a failed call is reported in `error`.
 */
export async function activeRuahTasks(
  root: string,
  deps: { runner?: Runner; bin?: string | undefined; timeoutMs?: number } = {},
): Promise<RuahResume> {
  if (!fs.existsSync(path.join(root, ".ruah"))) return { initialized: false };
  // ruah needs git; outside a work tree it only prints an error.
  if (gitRootOf(root) === undefined) return { initialized: false };
  const bin = deps.bin ?? resolveBin("ruah");
  if (bin === undefined) return { initialized: true, tasks: [], error: `ruah CLI not installed — ${SETUP_HINT}` };
  const runner = deps.runner ?? defaultRunner;
  try {
    const result = await runner(bin, ["task", "list", "--json"], { cwd: root, timeoutMs: deps.timeoutMs ?? 5000 });
    if (result.code !== 0) return { initialized: true, tasks: [], error: `ruah task list: ${ruahFailureMessage(`${result.stderr}\n${result.stdout}`) || cliMessage(result)}` };
    const json = parseJson(stripAnsi(result.stdout));
    const entries = Array.isArray(json) ? json : Object.values(obj(json) ?? {});
    const tasks: RuahTaskSummary[] = [];
    for (const entry of entries) {
      const task = obj(entry);
      const name = str(task?.name);
      const status = str(task?.status) ?? "unknown";
      if (name === undefined || FINISHED_TASK_STATES.has(status)) continue;
      const executor = str(task?.executor);
      const files = arr(task?.files).filter((f): f is string => typeof f === "string");
      tasks.push({ name, status, ...(executor !== undefined ? { executor } : {}), ...(files.length > 0 ? { files } : {}) });
    }
    return { initialized: true, tasks };
  } catch (err) {
    return { initialized: true, tasks: [], error: err instanceof CliError ? err.message : "ruah failed" };
  }
}

export interface RuahDeps {
  runner: Runner;
  home: string;
  bin?: () => string | undefined;
  launch?: Launcher;
}

export class RuahIntegration implements Integration {
  readonly id = "ruah";
  readonly family = "orchestration" as const;
  readonly name = "ruah";

  constructor(private readonly deps: RuahDeps) {}

  private bin(): string | undefined {
    return this.deps.bin !== undefined ? this.deps.bin() : resolveBin("ruah");
  }

  private base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...extra };
  }

  private async version(bin: string): Promise<string | undefined> {
    try {
      const result = await this.deps.runner(bin, ["--version"], { timeoutMs: 10_000 });
      return /(\d+\.\d+\.\d+)/.exec(stripAnsi(result.stdout))?.[1];
    } catch {
      return undefined;
    }
  }

  async info(project: ProjectContext | null): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.base({ status: "cli_missing", detail: "ruah CLI not installed", setupHint: SETUP_HINT });
    const version = await this.version(bin);
    const v = version !== undefined ? `ruah v${version}` : "ruah";
    if (project === null) return this.base({ detail: `${v} · no project open` });
    if (gitRootOf(project.root) === undefined) return this.base({ detail: `${v} · this folder is not a git repository`, setupHint: "git init" });
    if (!isInitialized(project.root)) return this.base({ detail: `${v} · this repo is not initialized for ruah`, setupHint: INIT_HINT });
    return this.base({ status: "connected", detail: `${v} · initialized` });
  }

  /** Nothing to store: ruah works on the repo itself. Returns the status. */
  connect(_body: ConnectBody, project: ProjectContext | null): Promise<IntegrationInfo> {
    return this.info(project);
  }

  disconnect(project: ProjectContext | null): Promise<IntegrationInfo> {
    return this.info(project);
  }

  private require(project: ProjectContext | null): { bin: string; root: string } {
    const bin = this.bin();
    if (bin === undefined) throw new IntegrationError(424, `ruah CLI not installed — ${SETUP_HINT}`);
    if (project === null) throw new IntegrationError(409, "no project open");
    if (gitRootOf(project.root) === undefined) throw new IntegrationError(409, NOT_GIT_HINT);
    if (!isInitialized(project.root)) throw new IntegrationError(409, `ruah is not initialized in this repo — run: ${INIT_HINT}`);
    return { bin, root: project.root };
  }

  private async ruah(bin: string, root: string, args: string[], timeoutMs?: number): Promise<string> {
    let result;
    try {
      result = await this.deps.runner(bin, args, { cwd: root, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    } catch (err) {
      throw new IntegrationError(504, err instanceof CliError ? err.message : "ruah failed");
    }
    if (result.code !== 0) {
      const why = ruahFailureMessage(`${result.stderr}\n${result.stdout}`) || cliMessage(result);
      throw new IntegrationError(422, `ruah ${args[0] ?? ""} ${args[1] ?? ""}: ${why}`.replace(/\s+:/, ":"));
    }
    return stripAnsi(result.stdout);
  }

  /**
   * `ruah status --json`, or why there is nothing to show (`reason`: the CLI
   * is missing, no project, not a git repository, ruah not initialized) —
   * never the CLI's raw output.
   */
  async status(project: ProjectContext | null): Promise<unknown> {
    const bin = this.bin();
    if (bin === undefined) return { initialized: false, reason: "cli_missing", hint: SETUP_HINT };
    if (project === null) return { initialized: false, reason: "no_project", hint: "open a project first" };
    if (gitRootOf(project.root) === undefined) return { initialized: false, reason: "not_git", hint: NOT_GIT_HINT };
    if (!isInitialized(project.root)) return { initialized: false, reason: "not_initialized", hint: INIT_HINT };
    const json = obj(parseJson(await this.ruah(bin, project.root, ["status", "--json"])));
    if (json === undefined) throw new IntegrationError(502, "ruah status: unexpected (non-JSON) output");
    return { initialized: true, ...json };
  }

  private logFile(root: string, name: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(this.deps.home, "projects", projectIdOf(root), "ruah", `${name}-${stamp}.log`);
  }

  private async taskJson(bin: string, root: string, name: string): Promise<unknown> {
    try {
      const tasks = obj(parseJson(await this.ruah(bin, root, ["task", "list", "--json"])));
      return tasks?.[name] ?? null;
    } catch {
      return null;
    }
  }

  async createTask(body: RuahTaskBody, node: ArchNode | undefined, project: ProjectContext | null): Promise<unknown> {
    const { bin, root } = this.require(project);
    const globs = validateGlobs(body.files ?? (node !== undefined ? globsForNode(node, root) : []));
    if (globs.length === 0) throw new IntegrationError(400, "no files to lock: pass files, or a nodeId whose element has a path or files");
    const executor = body.executor ?? "claude-code";
    const output = await this.ruah(
      bin, root,
      ["task", "create", body.name, "--files", globs.join(","), "--executor", executor, "--prompt", body.prompt],
      MUTATION_TIMEOUT_MS,
    );
    const result: Record<string, unknown> = { name: body.name, files: globs, executor, output: output.trim().slice(-2000) };
    if (body.start === true) Object.assign(result, this.launch(bin, root, ["task", "start", body.name], body.name));
    result.task = await this.taskJson(bin, root, body.name);
    return result;
  }

  private launch(bin: string, root: string, args: string[], label: string): { started: true; pid: number | undefined; log: string } {
    const log = this.logFile(root, label);
    const { pid } = (this.deps.launch ?? detachedLauncher)(bin, args, root, log);
    return { started: true, pid, log };
  }

  async taskAction(name: string, action: RuahTaskAction, project: ProjectContext | null): Promise<unknown> {
    if (!RuahTaskNameSchema.safeParse(name).success) throw new IntegrationError(400, "invalid task name");
    const { bin, root } = this.require(project);
    if (action === "start") return { name, action, ...this.launch(bin, root, ["task", "start", name], name) };
    const output = await this.ruah(bin, root, ["task", action, name], MUTATION_TIMEOUT_MS);
    return { name, action, ok: true, output: output.trim().slice(-2000), task: await this.taskJson(bin, root, name) };
  }

  async workflows(project: ProjectContext | null): Promise<{ workflows: { name: string; path: string }[] }> {
    const bin = this.bin();
    if (bin === undefined || project === null || gitRootOf(project.root) === undefined || !isInitialized(project.root)) return { workflows: [] };
    const json = parseJson(await this.ruah(bin, project.root, ["workflow", "list", "--json"]));
    const workflows = arr(json)
      .map((w) => ({ name: str(obj(w)?.name), path: str(obj(w)?.path) }))
      .filter((w): w is { name: string; path: string } => w.name !== undefined && w.path !== undefined)
      .map((w) => ({ name: w.name, path: path.isAbsolute(w.path) ? path.relative(project.root, w.path) : w.path }));
    return { workflows };
  }

  async runWorkflow(name: string, project: ProjectContext | null): Promise<unknown> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new IntegrationError(400, "invalid workflow name");
    const { bin, root } = this.require(project);
    // Only a workflow ruah itself lists can run; the client never passes a path.
    const found = (await this.workflows(project)).workflows.find((w) => w.name === name);
    if (found === undefined) throw new IntegrationError(404, `unknown workflow: ${name}`);
    return { name, ...this.launch(bin, root, ["workflow", "run", found.path], `workflow-${name}`) };
  }
}
