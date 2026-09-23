// src/integrations/work/github.ts — GitHub issues via `gh` and its own login.
// The repository comes from the project's git remote (origin first). Reads:
// `gh issue list --search` / `gh issue view`. The only write is
// `gh issue create`, reached from POST /api/work/create. Flag values are
// passed as `--flag=value` so user text can never be parsed as a flag.
import type { ConnectBody, IntegrationInfo } from "../../contracts/integrations.js";
import { arr, cliMessage, CliError, IntegrationError, mapLimit, obj, parseJson, resolveBin, str, type Runner } from "../exec.js";
import type { ProjectContext, WorkCreateInput, WorkIntegration, WorkItemData } from "../registry.js";
import type { SettingsStore } from "../store.js";

const PROVIDER = "github";
const SETUP_HINT = "brew install gh && gh auth login";
const ISSUE_FIELDS = "number,title,state,url,assignees,updatedAt";
export const REPO_SPEC_RE = /^(?:([A-Za-z0-9.-]+)\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const ITEM_ID_RE = /^((?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/;

export interface GitRemote {
  host: string;
  owner: string;
  repo: string;
}

/** git@github.com:o/r.git, https://github.com/o/r(.git), ssh://git@host/o/r.git → {host, owner, repo}. */
export function parseGitRemote(url: string): GitRemote | undefined {
  const text = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (scp !== null) return { host: scp[1] ?? "", owner: scp[2] ?? "", repo: scp[3] ?? "" };
  try {
    const u = new URL(text);
    if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol)) return undefined;
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
    if (parts.length !== 2 || parts.some((p) => !/^[\w.-]+$/.test(p))) return undefined;
    return { host: u.hostname, owner: parts[0] ?? "", repo: parts[1] ?? "" };
  } catch {
    return undefined;
  }
}

export function repoSpec(remote: GitRemote): string {
  return remote.host === "github.com" ? `${remote.owner}/${remote.repo}` : `${remote.host}/${remote.owner}/${remote.repo}`;
}

export function mapGhIssue(json: unknown, repo: string): WorkItemData | undefined {
  const issue = obj(json);
  const number = str(issue?.number);
  if (issue === undefined || number === undefined) return undefined;
  const item: WorkItemData = {
    id: `${repo}#${number}`,
    provider: PROVIDER,
    title: str(issue.title) ?? `#${number}`,
    status: (str(issue.state) ?? "unknown").toLowerCase(),
    url: str(issue.url) ?? "",
    updatedAt: str(issue.updatedAt) ?? new Date(0).toISOString(),
  };
  const assignee = str(obj(arr(issue.assignees)[0])?.login);
  if (assignee !== undefined) item.assignee = assignee;
  return item;
}

export interface GitHubDeps {
  runner: Runner;
  settings: SettingsStore;
  bin?: () => string | undefined;
  gitBin?: () => string | undefined;
}

export class GitHubIntegration implements WorkIntegration {
  readonly id = PROVIDER;
  readonly family = "work" as const;
  readonly name = "GitHub Issues";

  constructor(private readonly deps: GitHubDeps) {}

  private bin(): string | undefined {
    return this.deps.bin !== undefined ? this.deps.bin() : resolveBin("gh");
  }

  private base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...extra };
  }

  /** The project's GitHub repo from `git remote get-url origin` (or the first remote). */
  async detectRepo(project: ProjectContext | null): Promise<string | undefined> {
    if (project === null) return undefined;
    const git = this.deps.gitBin !== undefined ? this.deps.gitBin() : resolveBin("git");
    if (git === undefined) return undefined;
    try {
      const origin = await this.deps.runner(git, ["-C", project.root, "remote", "get-url", "origin"]);
      let url = origin.code === 0 ? origin.stdout.trim() : "";
      if (url.length === 0) {
        const all = await this.deps.runner(git, ["-C", project.root, "remote", "-v"]);
        url = all.code === 0 ? (all.stdout.split("\n")[0]?.split(/\s+/)[1] ?? "") : "";
      }
      const remote = parseGitRemote(url);
      return remote !== undefined ? repoSpec(remote) : undefined;
    } catch {
      return undefined;
    }
  }

  enabled(): Promise<boolean> {
    return Promise.resolve(this.deps.settings.get(this.id).disabled !== true && this.bin() !== undefined);
  }

  async info(project: ProjectContext | null): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.base({ status: "cli_missing", detail: "GitHub CLI (gh) not installed", setupHint: SETUP_HINT });
    const repo = await this.detectRepo(project);
    const repoDetail = repo !== undefined ? ` · repo ${repo}` : project !== null ? " · no GitHub remote in this project" : "";
    if (this.deps.settings.get(this.id).disabled === true) {
      return this.base({ detail: `disconnected in Ruah (gh login unchanged)${repoDetail}`, setupHint: "Connect to use your gh login" });
    }
    try {
      const result = await this.deps.runner(bin, ["auth", "status", "--json", "hosts"]);
      const hosts = obj(obj(parseJson(result.stdout))?.hosts);
      if (hosts === undefined) {
        // gh without `auth status --json`: fall back to the exit code.
        return result.code === 0
          ? this.base({ status: "connected", detail: `gh logged in${repoDetail}` })
          : this.base({ detail: cliMessage(result), setupHint: "gh auth login" });
      }
      const accounts: { id: string; label: string }[] = [];
      let active: string | undefined;
      for (const [host, entries] of Object.entries(hosts)) {
        for (const raw of arr(entries)) {
          const entry = obj(raw);
          if (entry === undefined || str(entry.state) !== "success") continue;
          const login = str(entry.login) ?? "?";
          accounts.push({ id: host, label: `${login}@${host}` });
          if (entry.active === true && (active === undefined || host === "github.com")) active = `${host} as ${login}`;
        }
      }
      if (accounts.length === 0) return this.base({ detail: "gh is not logged in", setupHint: "gh auth login" });
      return this.base({ status: "connected", detail: `${active ?? accounts[0]?.label ?? "gh"}${repoDetail}`, accounts });
    } catch (err) {
      return this.base({ status: "error", detail: err instanceof CliError ? err.message : "gh failed", setupHint: SETUP_HINT });
    }
  }

  connect(_body: ConnectBody, project: ProjectContext | null): Promise<IntegrationInfo> {
    this.deps.settings.set(this.id, undefined);
    return this.info(project);
  }

  disconnect(project: ProjectContext | null): Promise<IntegrationInfo> {
    this.deps.settings.set(this.id, { disabled: true });
    return this.info(project);
  }

  private requireBin(): string {
    const bin = this.bin();
    if (bin === undefined) throw new IntegrationError(424, "gh not installed — " + SETUP_HINT);
    return bin;
  }

  private async requireRepo(project: ProjectContext | null, explicit?: string): Promise<string> {
    if (explicit !== undefined) {
      if (!REPO_SPEC_RE.test(explicit)) throw new IntegrationError(400, "repo must be owner/name");
      return explicit;
    }
    const repo = await this.detectRepo(project);
    if (repo === undefined) throw new IntegrationError(409, "this project has no GitHub remote (git remote get-url origin)");
    return repo;
  }

  private async gh(args: string[]): Promise<unknown> {
    const result = await this.deps.runner(this.requireBin(), args);
    if (result.code !== 0) throw new IntegrationError(502, `gh: ${cliMessage(result)}`);
    return parseJson(result.stdout);
  }

  async search(query: string, project: ProjectContext | null): Promise<WorkItemData[]> {
    const repo = await this.requireRepo(project);
    const json = await this.gh(["issue", "list", `--repo=${repo}`, "--state=all", `--search=${query.slice(0, 256)}`, `--json=${ISSUE_FIELDS}`, "--limit=50"]);
    return arr(json).map((i) => mapGhIssue(i, repo)).filter((i): i is WorkItemData => i !== undefined);
  }

  async get(ids: readonly string[]): Promise<WorkItemData[]> {
    const parsed = ids.map((id) => ITEM_ID_RE.exec(id)).filter((m): m is RegExpExecArray => m !== null);
    if (parsed.length === 0) return [];
    const bin = this.requireBin();
    const items = await mapLimit(parsed, 4, async (match) => {
      const repo = match[1] ?? "";
      const result = await this.deps.runner(bin, ["issue", "view", match[2] ?? "", `--repo=${repo}`, `--json=${ISSUE_FIELDS}`]);
      return result.code === 0 ? mapGhIssue(parseJson(result.stdout), repo) : undefined;
    });
    return items.filter((i): i is WorkItemData => i !== undefined);
  }

  async create(input: WorkCreateInput, project: ProjectContext | null): Promise<WorkItemData> {
    const repo = await this.requireRepo(project, input.repo);
    const bin = this.requireBin();
    const result = await this.deps.runner(bin, ["issue", "create", `--repo=${repo}`, `--title=${input.title}`, `--body=${input.body}`]);
    if (result.code !== 0) throw new IntegrationError(502, `gh: ${cliMessage(result)}`);
    const url = result.stdout.trim().split("\n").reverse().find((line) => /\/issues\/\d+/.test(line));
    const number = url !== undefined ? /\/issues\/(\d+)/.exec(url)?.[1] : undefined;
    if (url === undefined || number === undefined) throw new IntegrationError(502, "gh: issue created but no URL returned");
    const [fetched] = await this.get([`${repo}#${number}`]).catch(() => []);
    return fetched ?? { id: `${repo}#${number}`, provider: PROVIDER, title: input.title, status: "open", url: url.trim(), updatedAt: new Date().toISOString() };
  }

  urlFor(id: string): string {
    const match = ITEM_ID_RE.exec(id);
    if (match === null) return "";
    const spec = REPO_SPEC_RE.exec(match[1] ?? "");
    const host = spec?.[1] ?? "github.com";
    return `https://${host}/${spec?.[2] ?? ""}/${spec?.[3] ?? ""}/issues/${match[2] ?? ""}`;
  }
}
