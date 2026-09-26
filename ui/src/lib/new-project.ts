// The new project wizard (§20.1) as pure functions: the name rule the daemon applies (instant
// feedback before the debounced check), the final path, the exact `gh repo create` command the
// GitHub option would run, which step can advance, and what is sent. No React; unit-tested in
// ui/test/new-project.test.ts.
import type { CreateProjectInput, GithubVisibility, NewProjectCheck, NewProjectDefaults, TemplateInfo } from "./contracts";

export type WizardStep = 0 | 1 | 2;
export const WIZARD_STEPS = ["Name & location", "Starting point", "Options"] as const;

export interface WizardState {
  name: string;
  parentDir: string;
  createParent: boolean;
  template: string;
  git: boolean;
  commit: boolean;
  github: boolean;
  visibility: GithubVisibility;
  repoName: string; // "" = derived from the name
  system: string | null; // a system folder (ruah.system.json) to add the repo to
  askAgent: boolean;
  prompt: string;
}

export function initialWizard(parentDir: string): WizardState {
  return {
    name: "",
    parentDir,
    createParent: false,
    template: "empty",
    git: true,
    commit: true,
    github: false,
    visibility: "private",
    repoName: "",
    system: null,
    askAgent: false,
    prompt: "",
  };
}

/** Mirrors the daemon (plainNameProblem): a plain folder name that works in Finder, git, npm and GitHub. */
export function nameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null; // empty: nothing to say yet
  if (name.length > 255) return "Use at most 255 characters.";
  if (name === "." || name === "..") return "Pick a real name.";
  if (/[/\\]/.test(name)) return "No slashes — this is one folder's name.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "No control characters.";
  if (name.startsWith(".")) return "A name starting with a dot makes a hidden folder.";
  if (/[:*?"<>|]/.test(name)) return 'Use letters, digits, spaces, "-", "_" or ".".';
  return null;
}

/** "Payments API" → "payments-api" (the daemon's slugify: npm package and GitHub repo names). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-.]+$/, "")
    .slice(0, 100);
  return slug === "" ? "app" : slug;
}

/** The daemon's rule: a GitHub name that is one plain argument (a leading "-" would be a `gh` flag). */
export const GITHUB_REPO_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** The folder the project will be created in, as typed ("~/Projects" + "shop" → "~/Projects/shop"). */
export function joinPath(parentDir: string, name: string): string {
  const parent = parentDir.trim().replace(/[\\/]+$/, "");
  const n = name.trim();
  if (!n) return parent;
  return parent ? `${parent}/${n}` : n;
}

/** The GitHub repo name the option uses. */
export function repoNameFor(state: Pick<WizardState, "name" | "repoName">): string {
  return state.repoName.trim() || slugify(state.name.trim());
}

/**
 * The exact command the GitHub option runs in the new folder (the daemon's githubCreateArgs).
 * `--push` only when there will be a first commit to push: the commit is on and git has an
 * identity (without one the daemon skips the commit, so it runs the command without `--push`).
 */
export function ghCommand(state: Pick<WizardState, "name" | "repoName" | "visibility" | "commit">, gitIdentity = true): string {
  const repo = repoNameFor(state);
  const push = state.commit && gitIdentity;
  const args = ["gh", "repo", "create", repo, state.visibility === "public" ? "--public" : "--private", "--source", ".", "--remote", "origin", ...(push ? ["--push"] : [])];
  return args.map((a) => (/^[A-Za-z0-9._/:=@+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** Which typed input a check answers: a check for an older input never counts (the debounce). */
export function checkKey(state: Pick<WizardState, "parentDir" | "name">): string {
  return `${state.parentDir.trim()}\u0000${state.name.trim()}`;
}

/** The stored check when it is for what is typed now, else null ("Checking…", Next disabled). */
export function currentCheck(stored: { key: string; check: NewProjectCheck } | null, state: Pick<WizardState, "parentDir" | "name">): NewProjectCheck | null {
  return stored && stored.key === checkKey(state) ? stored.check : null;
}

/** "/Users/me/Projects" → "~/Projects" when it is under the daemon's home. */
export function prettyHome(dir: string, home: string): string {
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}

/**
 * The "Creates" line: the folder the daemon will make — resolved (a relative location is taken
 * from home) once the check for this input is back, else as typed.
 */
export function createsPath(check: NewProjectCheck | null, state: Pick<WizardState, "parentDir" | "name">, home: string | undefined): string {
  if (check && check.name.ok && check.path) return home ? prettyHome(check.path, home) : check.path;
  return joinPath(state.parentDir, state.name);
}

/** A location that is neither absolute nor `~/…` (the daemon takes it from home). */
export function isRelativeLocation(parentDir: string): boolean {
  const p = parentDir.trim();
  return p !== "" && !p.startsWith("/") && p !== "~" && !p.startsWith("~/");
}

/** The small line under Location: where the proposed folder came from, or how a relative one reads. */
export function locationNote(defaults: Pick<NewProjectDefaults, "parentDir" | "home" | "parentSource"> | null, parentDir: string): string | null {
  if (isRelativeLocation(parentDir)) return "A relative location is taken from your home folder.";
  if (!defaults || parentDir.trim() !== prettyHome(defaults.parentDir, defaults.home)) return null;
  switch (defaults.parentSource) {
    case "remembered":
      return "Remembered from your last new project.";
    case "projects":
      return "Your Projects folder. Ruah remembers the folder you create in.";
    case "recent":
      return "Next to your most recent project. Ruah remembers the folder you create in.";
    case "home":
      return "Your home folder. Ruah remembers the folder you create in.";
    default:
      return null;
  }
}

/** Whether a step lets you go on (Enter / Next). */
export function canAdvance(step: WizardStep, state: WizardState, check: NewProjectCheck | null): boolean {
  if (step === 0) {
    if (!state.name.trim() || nameProblem(state.name) !== null || !state.parentDir.trim()) return false;
    if (!check) return false;
    if (check.name.ok === false || check.target.exists) return false;
    if (!check.parent.exists) return state.createParent && check.parent.writable;
    return check.parent.isDir && check.parent.writable;
  }
  if (step === 1) return !!state.template;
  if (state.github && (!state.git || !GITHUB_REPO_NAME.test(repoNameFor(state)))) return false;
  return true;
}

/** The first prompt suggested for the agent after creation. */
export function defaultPrompt(template: TemplateInfo | undefined, name: string): string {
  const base = template?.setupPrompt ?? "Set up the project: look around and propose the first steps.";
  return name.trim() ? `${base} The project is called “${name.trim()}”.` : base;
}

/** What the wizard sends to POST /api/projects/create. */
export function createInput(state: WizardState): CreateProjectInput {
  return {
    parentDir: state.parentDir.trim(),
    name: state.name.trim(),
    template: state.template,
    git: state.git,
    commit: state.git && state.commit,
    ...(state.github && state.git ? { github: { visibility: state.visibility, ...(state.repoName.trim() ? { name: state.repoName.trim() } : {}) } } : {}),
    ...(state.system ? { system: state.system } : {}),
    ...(state.createParent ? { createParent: true } : {}),
  };
}

/** The line under the path: what is wrong, or that it is fine. */
export function pathMessage(check: NewProjectCheck | null, state: Pick<WizardState, "createParent">): { tone: "ok" | "warn" | "bad" | "muted"; text: string } {
  if (!check) return { tone: "muted", text: "Checking…" };
  if (check.name.ok === false) return { tone: "bad", text: check.name.error ?? "Invalid name" };
  if (check.target.exists) {
    return {
      tone: "bad",
      text: check.target.empty ? "A folder with this name already exists (it is empty). Ruah never writes into an existing folder." : "A folder with this name already exists. Ruah never writes into an existing folder.",
    };
  }
  if (!check.parent.exists) {
    if (!check.parent.writable) return { tone: "bad", text: "That location doesn't exist and can't be created here." };
    return state.createParent ? { tone: "ok", text: "The location will be created too." } : { tone: "warn", text: "That location doesn't exist yet." };
  }
  if (!check.parent.isDir) return { tone: "bad", text: "That location is a file, not a folder." };
  if (!check.parent.writable) return { tone: "bad", text: "No permission to create folders there." };
  return { tone: "ok", text: "Available — a new folder will be created." };
}

export type SetupStatus = "none" | "waiting" | "blocked" | "lost" | "working" | "error";

/**
 * What the first-run hints may say about "Ask the agent to set it up": the prompt waits for the
 * agent (starting), can't go out (the agent is in error / stopped), was lost (a reload before it
 * was sent — it lives in memory), or went out (working / an error since).
 */
export function setupStatus(s: { askedAgent: boolean; promptSent: boolean; pending: boolean; agentState: string | undefined }): SetupStatus {
  if (!s.askedAgent) return "none";
  const broken = s.agentState === "error" || s.agentState === "stopped";
  if (!s.promptSent) {
    if (!s.pending) return "lost";
    return broken ? "blocked" : "waiting";
  }
  return broken ? "error" : "working";
}
