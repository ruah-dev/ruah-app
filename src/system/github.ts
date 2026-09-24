// GitHub for multi-repo systems (CONTRACTS §12.3): browse an owner's repos
// with `gh repo list <owner> --json …` and clone one with `gh repo clone`.
// The user's own `gh auth` is used; Ruah stores no token. Everything runs
// through execFile with an args array (never a shell); owner and repo names
// are validated before they reach an argument, and a clone only happens on
// an explicit call (the "Clone" button, `system add gh:owner/name`).
import * as fs from "node:fs";
import * as path from "node:path";
import { cliMessage, CliError, defaultRunner, parseJson, type Runner } from "../integrations/exec.js";
import { SystemManageError } from "./manage.js";

export interface GithubRepo {
  nameWithOwner: string;
  name: string;
  description: string | null;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  updatedAt: string | null;
  defaultBranch: string | null;
}

export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

const LIST_FIELDS = "name,nameWithOwner,description,url,isPrivate,isArchived,updatedAt,defaultBranchRef";

function ghError(err: unknown): SystemManageError {
  if (err instanceof CliError && err.kind === "missing") {
    return new SystemManageError("invalid", "GitHub CLI (gh) is not installed — install it and run `gh auth login`");
  }
  return new SystemManageError("invalid", err instanceof Error ? err.message : String(err));
}

/** Repos of `owner` (a user or org; empty = the logged-in user), newest first. */
export async function listGithubRepos(owner: string | undefined, opts: { runner?: Runner; limit?: number } = {}): Promise<GithubRepo[]> {
  const who = (owner ?? "").trim();
  if (who !== "" && !GITHUB_OWNER.test(who)) throw new SystemManageError("invalid", `invalid GitHub owner: ${who}`);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const args = ["repo", "list", ...(who !== "" ? [who] : []), "--json", LIST_FIELDS, "--limit", String(limit)];
  let r;
  try {
    r = await (opts.runner ?? defaultRunner)("gh", args, { timeoutMs: 30_000 });
  } catch (err) {
    throw ghError(err);
  }
  if (r.code !== 0) throw new SystemManageError("invalid", `gh repo list failed: ${cliMessage(r)}`);
  const json = parseJson(r.stdout);
  if (!Array.isArray(json)) throw new SystemManageError("invalid", "gh repo list returned no JSON array");
  const out: GithubRepo[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const nameWithOwner = typeof o.nameWithOwner === "string" ? o.nameWithOwner : undefined;
    if (nameWithOwner === undefined || !GITHUB_REPO.test(nameWithOwner)) continue;
    const branch = o.defaultBranchRef as { name?: unknown } | null | undefined;
    out.push({
      nameWithOwner,
      name: typeof o.name === "string" ? o.name : nameWithOwner.split("/")[1] ?? nameWithOwner,
      description: typeof o.description === "string" && o.description !== "" ? o.description : null,
      url: typeof o.url === "string" ? o.url : `https://github.com/${nameWithOwner}`,
      isPrivate: o.isPrivate === true,
      isArchived: o.isArchived === true,
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
      defaultBranch: typeof branch?.name === "string" ? branch.name : null,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/**
 * `gh repo clone owner/name <parentDir>/<name>`; the target must not exist.
 * Returns the absolute clone folder.
 */
export async function cloneGithubRepo(repo: string, parentDir: string, opts: { runner?: Runner; name?: string } = {}): Promise<string> {
  const spec = repo.trim().replace(/^gh:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!GITHUB_REPO.test(spec)) throw new SystemManageError("invalid", `invalid GitHub repo: ${repo} (expected owner/name)`);
  const parent = path.resolve(parentDir.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  let parentReal: string;
  try {
    parentReal = fs.realpathSync(parent);
  } catch {
    throw new SystemManageError("not_found", `folder not found: ${parent}`);
  }
  if (!fs.statSync(parentReal).isDirectory()) throw new SystemManageError("invalid", `not a folder: ${parent}`);
  const folder = opts.name ?? spec.split("/")[1] ?? "";
  if (folder === "" || folder === "." || folder === ".." || /[/\\]/.test(folder) || folder.startsWith("-")) {
    throw new SystemManageError("invalid", `invalid folder name: ${folder}`);
  }
  const target = path.join(parentReal, folder);
  if (fs.existsSync(target)) throw new SystemManageError("conflict", `already exists: ${target}`);
  let r;
  try {
    r = await (opts.runner ?? defaultRunner)("gh", ["repo", "clone", spec, target], { timeoutMs: 10 * 60_000 });
  } catch (err) {
    throw ghError(err);
  }
  if (r.code !== 0) throw new SystemManageError("invalid", `gh repo clone failed: ${cliMessage(r)}`);
  if (!fs.existsSync(target)) throw new SystemManageError("invalid", `gh repo clone did not create ${target}`);
  return target;
}
