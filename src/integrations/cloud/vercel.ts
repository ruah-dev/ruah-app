// src/integrations/cloud/vercel.ts — Vercel via the `vercel` CLI and its own
// login; teams are the accounts (`--scope <slug>`). Read-only: `whoami`,
// `teams list`, `projects list`, `list` (deployments) and `domains list`, all
// with `--format json`, run from a neutral cwd with stdin closed so no
// command can pick up a linked project or wait on a prompt. A project's
// health comes from its latest production deployment (CONTRACTS.md §9).
import { tmpdir } from "node:os";
import type { CloudHealth, CloudResource } from "../../contracts/integrations.js";
import { arr, mapLimit, obj, str, type Json } from "../exec.js";
import { CliCloudAdapter, cloudResource, guarded, isoTime, type CheckResult, type CliAccount } from "./cli-adapter.js";

const PROVIDER = "vercel";
const DASHBOARD = "https://vercel.com";
/** Projects whose deployments are not in the cross-project listing get their own `vercel list <name>` (bounded). */
const MAX_PROJECT_LISTINGS = 25;
const MAX_PROJECT_PAGES = 5;
const PROJECT_NAME_RE = /^[a-z0-9._-]{1,100}$/i;

export interface VercelDeployment {
  url: string;
  project: string;
  state: string; // READY | ERROR | BUILDING | INITIALIZING | QUEUED | CANCELED
  target: "production" | "preview";
  createdAt: number;
  branch?: string | undefined;
}

const DEPLOYING = new Set(["BUILDING", "INITIALIZING", "QUEUED"]);

export function parseDeployments(json: unknown): VercelDeployment[] {
  const out: VercelDeployment[] = [];
  for (const raw of arr(obj(json)?.deployments)) {
    const d = obj(raw);
    const url = str(d?.url);
    const project = str(d?.name);
    const state = str(d?.state) ?? str(d?.readyState);
    if (d === undefined || url === undefined || project === undefined || state === undefined) continue;
    const created = typeof d.createdAt === "number" ? d.createdAt : typeof d.created === "number" ? d.created : 0;
    out.push({
      url, project, state: state.toUpperCase(), target: str(d.target) === "production" ? "production" : "preview", createdAt: created,
      branch: str(obj(d.meta)?.githubCommitRef) ?? str(obj(d.meta)?.gitlabCommitRef) ?? str(obj(d.meta)?.bitbucketCommitRef),
    });
  }
  return out;
}

/**
 * Health of a project from its deployments: the newest production deployment
 * decides; a failed or building one with an older READY production deployment
 * behind it means the site is still served (degraded / deploying, not down).
 */
export function vercelProjectHealth(deployments: readonly VercelDeployment[]): { health: CloudHealth; detail?: string; state?: string } | undefined {
  const prod = deployments
    .filter((d) => d.target === "production" && d.state !== "CANCELED")
    .sort((a, b) => b.createdAt - a.createdAt);
  const latest = prod[0];
  if (latest === undefined) return undefined;
  const olderReady = prod.slice(1).some((d) => d.state === "READY");
  const state = latest.state.toLowerCase();
  if (latest.state === "READY") return { health: "healthy", state };
  if (DEPLOYING.has(latest.state)) return { health: "deploying", detail: olderReady ? `${state} · previous production deployment still live` : state, state };
  if (latest.state === "ERROR") {
    return olderReady
      ? { health: "degraded", detail: "latest production deployment failed · previous one still live", state }
      : { health: "down", detail: "production deployment failed", state };
  }
  return { health: "unknown", detail: state, state };
}

export function mapProjects(json: unknown, deployments: readonly VercelDeployment[], team: string | undefined): CloudResource[] {
  const out: CloudResource[] = [];
  for (const raw of arr(obj(json)?.projects)) {
    const p = obj(raw);
    const id = str(p?.id);
    const name = str(p?.name);
    if (p === undefined || id === undefined || name === undefined) continue;
    const own = deployments.filter((d) => d.project === name);
    const health = vercelProjectHealth(own);
    const productionUrl = str(p.latestProductionUrl);
    out.push(cloudResource(PROVIDER, {
      id: `vercel:project:${id}`, type: "app", service: "project", name, status: health?.state,
      tags: team !== undefined ? { team } : undefined,
      consoleUrl: team !== undefined ? `${DASHBOARD}/${team}/${name}` : `${DASHBOARD}/dashboard`,
      url: productionUrl !== undefined ? (productionUrl.startsWith("http") ? productionUrl : `https://${productionUrl}`) : undefined,
      health: health?.health ?? (productionUrl !== undefined ? "unknown" : undefined),
      healthDetail: health?.detail ?? (health === undefined && productionUrl !== undefined ? "no recent production deployment listed" : undefined),
    }));
  }
  return out;
}

/**
 * The newest production and preview deployment of each project, as their own
 * rows (status + URL + created; no health — the project carries it, so the
 * summary counts each site once).
 */
export function mapDeployments(deployments: readonly VercelDeployment[], team: string | undefined): CloudResource[] {
  const newest = new Map<string, VercelDeployment>();
  for (const d of deployments) {
    const key = `${d.project}\u0000${d.target}`;
    const seen = newest.get(key);
    if (seen === undefined || d.createdAt > seen.createdAt) newest.set(key, d);
  }
  return [...newest.values()].map((d) =>
    cloudResource(PROVIDER, {
      id: `vercel:deployment:${d.url}`, type: "app", service: "deployment", name: `${d.project} (${d.target})`,
      status: d.state.toLowerCase(),
      tags: { project: d.project, target: d.target, ...(d.branch !== undefined ? { branch: d.branch } : {}) },
      consoleUrl: team !== undefined ? `${DASHBOARD}/${team}/${d.project}/deployments` : undefined,
      url: `https://${d.url}`, createdAt: isoTime(d.createdAt),
    }),
  );
}

export function mapDomains(json: unknown, team: string | undefined): CloudResource[] {
  const out: CloudResource[] = [];
  for (const raw of arr(obj(json)?.domains)) {
    const d = obj(raw);
    const name = str(d?.name);
    if (d === undefined || name === undefined) continue;
    out.push(cloudResource(PROVIDER, {
      id: `vercel:domain:${name}`, type: "dns", service: "domain", name,
      tags: { registrar: str(d.registrar) ?? "", ...(team !== undefined ? { team } : {}) },
      consoleUrl: team !== undefined ? `${DASHBOARD}/${team}/~/domains/${name}` : `${DASHBOARD}/dashboard/domains`,
      createdAt: isoTime(d.createdAt),
    }));
  }
  return out;
}

export class VercelIntegration extends CliCloudAdapter {
  readonly id = PROVIDER;
  readonly name = "Vercel";
  protected readonly binName = "vercel";
  protected readonly setupHint = "brew install vercel-cli && vercel login";
  protected readonly accountPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
  protected readonly accountNoun = "team";
  // A linked `.vercel/` in the daemon's cwd must not change the scope; an empty stdin answers any prompt with EOF.
  protected override runOptions = { cwd: tmpdir(), input: "" };

  private scope(account: string | undefined): string[] {
    return account !== undefined ? ["--scope", account] : [];
  }

  protected async accounts(bin: string): Promise<CliAccount[]> {
    const json = await this.json(bin, ["teams", "list", "--format", "json"]);
    return arr(obj(json)?.teams).flatMap((raw) => {
      const t = obj(raw);
      const slug = str(t?.slug);
      if (slug === undefined) return [];
      return [{ id: slug, label: str(t?.name) ?? slug, current: t?.current === true }];
    });
  }

  protected async check(bin: string, account: string | undefined): Promise<CheckResult> {
    try {
      const who = obj(await this.json(bin, ["whoami", "--format", "json", ...this.scope(account)]));
      const user = str(who?.username) ?? "?";
      const team = account ?? str(obj(who?.team)?.slug);
      return { ok: true, detail: `vercel: ${user}${team !== undefined ? ` · team ${team}` : ""}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "vercel failed";
      const loggedOut = /credentials|not logged in|log ?in|no existing|token/i.test(message);
      return { ok: false, status: loggedOut ? "not_connected" : "error", detail: message, setupHint: loggedOut ? "vercel login" : this.setupHint };
    }
  }

  protected async list(bin: string, account: string | undefined, errors: string[]): Promise<CloudResource[]> {
    const scope = this.scope(account);
    let team = account;
    const projectsJson = await guarded("projects", errors, async () => {
      const pages: Json[] = [];
      let next: string | undefined;
      for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
        const json = obj(await this.json(bin, ["projects", "list", "--format", "json", ...scope, ...(next !== undefined ? ["--next", next] : [])]));
        if (json === undefined) break;
        pages.push(json);
        team ??= str(json.contextName);
        next = str(obj(json.pagination)?.next);
        if (next === undefined || !/^\d+$/.test(next)) break;
      }
      return pages;
    });
    const projects = { projects: projectsJson.flatMap((p) => arr(p.projects)) };

    // One cross-project listing (newest deployments), then per-project listings for projects it missed.
    const deployments: VercelDeployment[] = await guarded("deployments", errors, async () => {
      const json = obj(await this.json(bin, ["list", "--all", "--format", "json", ...scope]));
      team ??= str(json?.contextName);
      return parseDeployments(json);
    }, /unknown or unexpected option|unknown option/i);
    const covered = new Set(deployments.map((d) => d.project));
    const missing = projects.projects
      .map((p) => str(obj(p)?.name))
      .filter((n): n is string => n !== undefined && !covered.has(n) && PROJECT_NAME_RE.test(n))
      .slice(0, MAX_PROJECT_LISTINGS);
    const perProject = await mapLimit(missing, 4, (name) =>
      guarded(`deployments ${name}`, errors, async () => parseDeployments(await this.json(bin, ["list", name, "--format", "json", ...scope]))),
    );
    deployments.push(...perProject.flat());

    const domains = await guarded("domains", errors, async () => mapDomains(await this.json(bin, ["domains", "list", "--format", "json", ...scope]), team));
    return [...mapProjects(projects, deployments, team), ...mapDeployments(deployments, team), ...domains];
  }
}
