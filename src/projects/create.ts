// src/projects/create.ts — creating a project folder (CONTRACTS §20.1), as a
// library with no daemon: the app's POST /api/projects/create and
// `ruah app new` both use it.
//
//   checkNewProject()      validation while the user types (no side effects)
//   createProjectFolder()  mkdir (exclusive) → template files → scan →
//                          git init + initial commit → add to a system →
//                          `gh repo create` (only when asked)
//
// Never overwrites: the target folder must not exist and is claimed with an
// exclusive mkdir; files are written with the "wx" flag. A failure before the
// project is usable (files, scan, git init) removes everything it created, so
// nothing half-made stays behind. Later steps (initial commit, system, GitHub)
// only warn: the project is kept and the report says what to do. git and gh
// run through execFile with an args array (no shell), with a timeout, never
// prompting; `gh repo create` runs only when `github` is given.
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { CreateReport, GithubVisibility, NewProjectCheck, ParentSource, ToolStatus } from "../contracts/projects.js";
import { validateArchitecture } from "../contracts/validate.js";
import { cliMessage, CliError, defaultRunner, parseJson, redact, resolveBin, type Runner } from "../integrations/exec.js";
import { scanRepo } from "../scan/index.js";
import { addRepos } from "../system/manage.js";
import { SYSTEM_FILE } from "../system/config.js";
import { atomicWriteFileSync, expandHome } from "./fs-util.js";
import { emptyArchitecture, plainNameProblem, ProjectError, validateProjectName } from "./project-names.js";
import { DEFAULT_TEMPLATE, findTemplate, renderTemplate, slugify, TEMPLATES } from "./templates/index.js";

export const ARCHITECTURE_FILE = "architecture.json";
const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 120_000;

export interface CreateProjectInput {
  parentDir: string;
  name: string;
  /** Template id (default "empty"). */
  template?: string | undefined;
  /** git init (default false). */
  git?: boolean | undefined;
  /** Initial commit after git init (default = git). */
  commit?: boolean | undefined;
  /** Runs `gh repo create` — only when given. */
  github?: { visibility: GithubVisibility; name?: string | undefined } | undefined;
  /** A system folder (holding ruah.system.json) to add the new repo to. */
  system?: string | undefined;
  /** mkdir -p the parent when it is missing (default: 404). */
  createParent?: boolean | undefined;
}

export interface CreateDeps {
  /** Ruah version, stamped into the scanned architecture.json. */
  version: string;
  /** git / gh runner (tests); default: execFile without a shell. */
  runner?: Runner;
  /** Extra environment for git / gh (tests pin GIT_CONFIG_GLOBAL). */
  env?: Record<string, string>;
  /** Executable lookup (tests); default: PATH + Homebrew dirs. */
  resolveBin?: (name: string) => string | undefined;
  now?: () => Date;
  home?: string;
  /**
   * What a relative `parentDir` / `system` is taken against: the CLI keeps the
   * current folder (the default); the daemon passes home — its own cwd means
   * nothing to the person typing "Projects" in the wizard.
   */
  cwd?: string;
}

// ---------------------------------------------------------------- paths + checks

/** `~/…` expanded, anything else relative resolved against `cwd` (not realpath'd: the path the user sees). */
export function resolveDir(input: string, home: string = process.env.HOME ?? homedir(), cwd: string = process.cwd()): string {
  return path.resolve(cwd, expandHome(input.trim(), home));
}

function statOf(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The nearest existing ancestor of `dir` (for "can the missing parent be created?"). */
function existingAncestor(dir: string): string {
  let cur = dir;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** §20.1 POST /api/projects/new/check: everything the wizard shows while you type. No side effects. */
export function checkNewProject(input: { parentDir: string; name: string }, opts: { home?: string; cwd?: string } = {}): NewProjectCheck {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const trimmedName = input.name.trim();
  const nameError = trimmedName.length === 0 ? "enter a name" : plainNameProblem(trimmedName);
  const parentInput = input.parentDir.trim();
  const parent = parentInput.length > 0 ? resolveDir(parentInput, home, opts.cwd) : "";
  const parentStat = parent !== "" ? statOf(parent) : undefined;
  const parentIsDir = parentStat?.isDirectory() === true;
  const parentWritable = parentIsDir ? writable(parent) : parent !== "" && writable(existingAncestor(parent));
  const target = parent !== "" && trimmedName.length > 0 && nameError === null ? path.join(parent, trimmedName) : parent;
  const targetStat = target !== parent ? statOf(target) : undefined;
  let empty: boolean | undefined;
  if (targetStat?.isDirectory() === true) {
    try {
      empty = fs.readdirSync(target).length === 0;
    } catch {
      empty = undefined;
    }
  }

  const problems: string[] = [];
  if (nameError !== null) problems.push(`Name: ${nameError}`);
  if (parent === "") problems.push("Choose a location");
  else if (parentStat === undefined) problems.push(`${parent} doesn't exist yet`);
  else if (!parentIsDir) problems.push(`${parent} is a file, not a folder`);
  else if (!parentWritable) problems.push(`No permission to create folders in ${parent}`);
  if (targetStat !== undefined) {
    problems.push(
      targetStat.isDirectory()
        ? `${target} already exists${empty === true ? " (an empty folder)" : " and has files"} — Ruah never writes into an existing folder; pick another name or open it with Open folder`
        : `${target} already exists (a file)`,
    );
  }
  return {
    path: target,
    ok: problems.length === 0,
    name: nameError === null ? { ok: true } : { ok: false, error: nameError },
    parent: { path: parent, exists: parentStat !== undefined, isDir: parentIsDir, writable: parentWritable },
    target: { exists: targetStat !== undefined, ...(empty !== undefined ? { empty } : {}) },
    problems,
  };
}

/**
 * Where the wizard proposes to create projects: the remembered folder, else
 * ~/Projects, else the parent of the most recent project, else home — the first
 * that exists — and which of those it is (the wizard says "remembered" only
 * when it is).
 */
export function suggestParentDir(opts: { remembered?: string | undefined; recentRoots?: readonly string[]; home?: string }): { dir: string; source: ParentSource } {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const candidates: [string | undefined, ParentSource][] = [
    [opts.remembered, "remembered"],
    [path.join(home, "Projects"), "projects"],
    ...(opts.recentRoots ?? []).slice(0, 3).map((r): [string, ParentSource] => [path.dirname(r), "recent"]),
  ];
  for (const [c, source] of candidates) {
    if (c !== undefined && c.length > 0 && statOf(c)?.isDirectory() === true) return { dir: c, source };
  }
  return { dir: home, source: "home" };
}

// ---------------------------------------------------------------- GitHub

/**
 * A GitHub repo name that is also one plain argument: never starting with "-",
 * which `gh` would read as a flag (`--public`, `-h`), whatever the wizard or
 * `--gh-name` sends.
 */
const GITHUB_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** The repo name for GitHub: `name` when valid, else the folder name as a slug. */
export function githubRepoName(folderName: string, wanted?: string): string {
  const w = wanted?.trim();
  if (w !== undefined && w.length > 0) {
    if (!GITHUB_NAME.test(w) || w === "." || w === "..") {
      throw new ProjectError(400, `invalid GitHub repo name: ${w} (letters, digits, ".", "-", "_"; not starting with "-")`);
    }
    return w;
  }
  return slugify(folderName);
}

/** The `gh` arguments (run in the new folder). `push` = there is a commit to push. */
export function githubCreateArgs(repoName: string, visibility: GithubVisibility, push: boolean): string[] {
  return ["repo", "create", repoName, visibility === "public" ? "--public" : "--private", "--source", ".", "--remote", "origin", ...(push ? ["--push"] : [])];
}

/** How the command reads in the wizard and the CLI (every argument is shell-safe by construction). */
export function commandLine(bin: string, args: readonly string[]): string {
  return [bin, ...args].map((a) => (/^[A-Za-z0-9._/:=@+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

// ---------------------------------------------------------------- tools

/** git installed + an identity to commit with (user.name and user.email). */
export async function gitToolStatus(deps: Pick<CreateDeps, "runner" | "env" | "resolveBin"> = {}): Promise<ToolStatus["git"]> {
  const bin = (deps.resolveBin ?? resolveBin)("git");
  if (bin === undefined) return { installed: false, identity: false };
  const run = deps.runner ?? defaultRunner;
  const get = async (key: string): Promise<string> => {
    try {
      const r = await run(bin, ["config", "--get", key], { timeoutMs: 5000, env: { GIT_TERMINAL_PROMPT: "0", ...deps.env } });
      return r.code === 0 ? r.stdout.trim() : "";
    } catch {
      return "";
    }
  };
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { installed: true, identity: name.length > 0 && email.length > 0 };
}

/** gh installed + logged in (`gh auth status --json hosts`; read-only, never prints a token). */
export async function ghToolStatus(deps: Pick<CreateDeps, "runner" | "env" | "resolveBin"> = {}): Promise<NonNullable<ToolStatus["gh"]>> {
  const bin = (deps.resolveBin ?? resolveBin)("gh");
  if (bin === undefined) return { installed: false, loggedIn: false };
  try {
    const r = await (deps.runner ?? defaultRunner)(bin, ["auth", "status", "--json", "hosts"], { timeoutMs: 15_000, env: { ...deps.env } });
    const hosts = (parseJson(r.stdout) as { hosts?: Record<string, unknown> } | undefined)?.hosts;
    if (hosts === undefined || typeof hosts !== "object" || hosts === null) return { installed: true, loggedIn: r.code === 0 };
    for (const entries of Object.values(hosts)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Record<string, unknown>[]) {
        if (entry.state === "success" && (entry.active === true || entries.length === 1)) {
          return { installed: true, loggedIn: true, ...(typeof entry.login === "string" ? { login: entry.login } : {}) };
        }
      }
    }
    return { installed: true, loggedIn: false };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

// ---------------------------------------------------------------- create

function firstLine(text: string): string {
  return redact(text.trim().split("\n").find((l) => l.trim().length > 0) ?? "").slice(0, 300);
}

/**
 * Creates `<parentDir>/<name>` from a template (see file header) and returns
 * what it did. Throws ProjectError: 400 bad input / git missing, 404 parent
 * missing, 409 target exists, 500 a write, scan or git init failed (after
 * removing what it created).
 */
export async function createProjectFolder(input: CreateProjectInput, deps: CreateDeps): Promise<CreateReport> {
  const home = deps.home ?? process.env.HOME ?? homedir();
  const name = validateProjectName(input.name);
  const problem = plainNameProblem(name);
  if (problem !== null) throw new ProjectError(400, `invalid name: ${problem}`);
  const templateId = input.template ?? DEFAULT_TEMPLATE;
  const template = findTemplate(templateId);
  if (template === undefined) throw new ProjectError(400, `unknown template: ${templateId} (expected ${TEMPLATES.map((t) => t.id).join(", ")})`);
  const wantGit = input.git === true;
  const wantCommit = wantGit && input.commit !== false;
  const which = deps.resolveBin ?? resolveBin;
  const run = deps.runner ?? defaultRunner;
  const gitBin = wantGit ? which("git") : undefined;
  if (wantGit && gitBin === undefined) throw new ProjectError(400, "git is not installed — turn off “Initialize git” or install git");
  if (input.github !== undefined && !wantGit) throw new ProjectError(400, "creating a GitHub repo needs git (turn on “Initialize git”)");
  const repoName = input.github !== undefined ? githubRepoName(name, input.github.name) : undefined;
  let systemRoot: string | undefined;
  if (input.system !== undefined) {
    systemRoot = resolveDir(input.system, home, deps.cwd);
    if (!fs.existsSync(path.join(systemRoot, SYSTEM_FILE))) throw new ProjectError(400, `not a system folder (no ${SYSTEM_FILE}): ${systemRoot}`);
  }

  // The parent: must exist (or be created on request) and be a folder.
  const parent = resolveDir(input.parentDir, home, deps.cwd);
  let createdParent: string | undefined;
  if (!fs.existsSync(parent)) {
    if (input.createParent !== true) throw new ProjectError(404, `folder not found: ${parent}`);
    try {
      createdParent = fs.mkdirSync(parent, { recursive: true });
    } catch (err) {
      throw new ProjectError(500, `cannot create ${parent}: ${(err as Error).message}`);
    }
  }
  let parentReal: string;
  try {
    parentReal = fs.realpathSync(parent);
  } catch {
    throw new ProjectError(404, `folder not found: ${parent}`);
  }
  if (statOf(parentReal)?.isDirectory() !== true) throw new ProjectError(400, `not a folder: ${parent}`);

  // Claim the target: an exclusive mkdir (never an existing folder, not even an empty one).
  const target = path.join(parentReal, name);
  try {
    fs.mkdirSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (createdParent !== undefined) removeCreatedParents(parent, createdParent);
    if (code === "EEXIST") throw new ProjectError(409, `already exists: ${target}`);
    if (code === "EACCES" || code === "EPERM") throw new ProjectError(403, `no permission to create ${target}`);
    throw new ProjectError(500, `cannot create ${target}: ${(err as Error).message}`);
  }

  const rollback = (): void => {
    removeQuietly(target);
    if (createdParent !== undefined) removeCreatedParents(parent, createdParent);
  };
  const env = { GIT_TERMINAL_PROMPT: "0", ...deps.env };
  const git = async (args: string[], timeoutMs = GIT_TIMEOUT_MS) => run(gitBin ?? "git", args, { cwd: target, timeoutMs, env });
  const warnings: string[] = [];
  const now = deps.now?.() ?? new Date();
  let files = 0;
  let scanned: CreateReport["scanned"] = null;
  let gitReport: CreateReport["git"] = null;

  try {
    // 1. Files (never overwriting: "wx").
    for (const [rel, content] of renderTemplate(template, name, now)) {
      const file = path.join(target, ...rel.split("/"));
      if (!file.startsWith(target + path.sep)) throw new Error(`template path escapes the folder: ${rel}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { flag: "wx" });
      files += 1;
    }
    // 2. The map: scanned from the files, or empty for the "Empty" template (you draw it).
    const archPath = path.join(target, ARCHITECTURE_FILE);
    if (template.scan) {
      const arch = scanRepo(target, { version: deps.version, now, infra: true });
      const result = validateArchitecture({ ...arch, name }, target);
      if (!result.ok) throw new Error(`scan result failed validation: ${result.errors[0] ?? "unknown"}`);
      atomicWriteFileSync(archPath, `${JSON.stringify(result.value, null, 2)}\n`);
      scanned = { nodes: result.value.nodes.length, edges: result.value.edges.length };
    } else {
      atomicWriteFileSync(archPath, `${JSON.stringify(emptyArchitecture(name), null, 2)}\n`);
    }
    files += 1;
    // 3. git init (the user's init.defaultBranch, else main).
    if (wantGit) {
      const configured = await git(["config", "--get", "init.defaultBranch"], 5000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const init = await git(configured.code === 0 && configured.stdout.trim() !== "" ? ["init", "-q"] : ["init", "-q", "-b", "main"]);
      if (init.code !== 0) throw new Error(`git init failed: ${firstLine(init.stderr || init.stdout)}`);
      gitReport = { init: true, branch: null, commit: null };
    }
  } catch (err) {
    rollback();
    if (err instanceof ProjectError) throw err;
    const message = err instanceof CliError ? err.message : (err as Error).message;
    throw new ProjectError(500, `${message} — nothing was created`);
  }

  // 4. Initial commit: warn (and keep the project) when it cannot be made.
  if (gitReport !== null) {
    if (wantCommit) {
      try {
        const add = await git(["add", "-A"]);
        if (add.code !== 0) throw new Error(firstLine(add.stderr || add.stdout));
        const commit = await git(["commit", "-q", "-m", `Initial commit (Ruah: ${template.name})`]);
        if (commit.code !== 0) {
          const why = firstLine(commit.stderr || commit.stdout);
          throw new Error(/user\.(name|email)|identity|tell me who you are/i.test(why) ? "git has no user.name / user.email — set them with `git config --global user.name …` and commit by hand" : why);
        }
        const head = await git(["rev-parse", "--short", "HEAD"], 5000);
        gitReport.commit = head.code === 0 ? head.stdout.trim() : null;
      } catch (err) {
        gitReport.warning = `Initial commit skipped: ${err instanceof CliError ? err.message : (err as Error).message}`;
        warnings.push(gitReport.warning);
      }
    }
    const branch = await git(["symbolic-ref", "--short", "HEAD"], 5000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    gitReport.branch = branch.code === 0 ? branch.stdout.trim() || null : null;
  }

  // 5. Add to a multi-repo system.
  let systemReport: CreateReport["system"] = null;
  if (systemRoot !== undefined) {
    try {
      const { added } = addRepos(systemRoot, [{ path: target }]);
      systemReport = { root: systemRoot, repoId: added[0]?.id ?? null };
    } catch (err) {
      systemReport = { root: systemRoot, repoId: null, error: (err as Error).message };
      warnings.push(`Not added to the system: ${(err as Error).message}`);
    }
  }

  // 6. GitHub — only when asked (the wizard's explicit toggle, `--gh`).
  let githubReport: CreateReport["github"] = null;
  if (input.github !== undefined && repoName !== undefined) {
    const args = githubCreateArgs(repoName, input.github.visibility, gitReport?.commit != null);
    const ghBin = which("gh");
    if (ghBin === undefined) {
      githubReport = { command: ["gh", ...args], ran: false, error: "GitHub CLI (gh) is not installed" };
    } else {
      try {
        const r = await run(ghBin, args, { cwd: target, timeoutMs: GH_TIMEOUT_MS, env: { ...deps.env } });
        const url = /https:\/\/github\.com\/[^\s]+/.exec(`${r.stdout}\n${r.stderr}`)?.[0]?.replace(/\.git$/, "");
        githubReport = r.code === 0
          ? { command: ["gh", ...args], ran: true, ...(url !== undefined ? { url } : {}) }
          : { command: ["gh", ...args], ran: true, error: cliMessage(r) };
        // gh said nothing about a repository: nothing confirms one exists.
        if (r.code === 0 && url === undefined) warnings.push("GitHub repo not confirmed: gh printed no repository URL — check with `gh repo view` in the new folder");
      } catch (err) {
        githubReport = { command: ["gh", ...args], ran: false, error: err instanceof CliError ? err.message : "gh failed to run" };
      }
    }
    if (githubReport.error !== undefined) warnings.push(`GitHub repo not created: ${githubReport.error}`);
  }

  return { path: target, template: template.id, files, scanned, git: gitReport, github: githubReport, system: systemReport, warnings };
}

/**
 * Undoes `mkdir -p`: removes the folders it made, deepest first, each only while
 * it is empty — a parent that meanwhile got someone else's project (the app and
 * `ruah app new` creating side by side) stays with it.
 */
function removeCreatedParents(parent: string, topCreated: string): void {
  let cur = parent;
  while (cur === topCreated || cur.startsWith(topCreated + path.sep)) {
    try {
      fs.rmdirSync(cur);
    } catch {
      return; // not empty (or already gone): leave it and everything above it
    }
    if (cur === topCreated) return;
    cur = path.dirname(cur);
  }
}

function removeQuietly(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort: the error that caused the rollback is what the caller reports
  }
}
