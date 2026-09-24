// src/integrations/cloud/supabase.ts — Supabase via the `supabase` CLI and
// its own login (`supabase login`); organizations are the accounts (a filter
// on the project list). Read-only Management API listings only — `orgs
// list`, `projects list`, and per active project `functions list` / `branches
// list --project-ref <ref>` — never anything that needs the database
// password. Project status → health per CONTRACTS.md §9.
import type { CloudResource } from "../../contracts/integrations.js";
import { arr, mapLimit, obj, str } from "../exec.js";
import { healthFrom, type HealthTable } from "../health.js";
import { CliCloudAdapter, cloudResource, guarded, isoTime, type CheckResult, type CliAccount } from "./cli-adapter.js";

const PROVIDER = "supabase";
const DASHBOARD = "https://supabase.com/dashboard";
const REF_RE = /^[a-z0-9]{8,40}$/;
const MAX_PROJECT_DETAILS = 25;

export const SUPABASE_HEALTH = {
  project: {
    active_healthy: "healthy", active_unhealthy: "degraded",
    coming_up: "deploying", restoring: "deploying", upgrading: "deploying", resizing: "deploying", init_ready: "deploying",
    inactive: "down", pausing: "down", going_down: "down", paused: "down", removed: "down",
    init_failed: "down", restore_failed: "down", pause_failed: "down", unknown: "unknown",
  },
  function: { active: "healthy", throttled: "degraded", removed: "down" },
  branch: {
    migrations_passed: "healthy", functions_deployed: "healthy",
    creating_project: "deploying", running_migrations: "deploying",
    migrations_failed: "down", functions_failed: "down",
  },
} satisfies Record<string, HealthTable>;

const PROJECT_DETAIL: Record<string, string> = {
  active_unhealthy: "some services are unhealthy",
  inactive: "paused",
  init_failed: "project failed to start",
  restore_failed: "restore failed",
  pause_failed: "pause failed",
};

export interface SupabaseProject {
  ref: string;
  name: string;
  region: string | undefined;
  status: string | undefined;
  org: string | undefined;
  orgId: string | undefined;
}

export function parseProjects(json: unknown): { projects: SupabaseProject[]; resources: CloudResource[] } {
  const projects: SupabaseProject[] = [];
  const resources: CloudResource[] = [];
  for (const raw of arr(json)) {
    const p = obj(raw);
    const ref = str(p?.ref) ?? str(p?.id);
    if (p === undefined || ref === undefined) continue;
    // Only these fields are read; the database host and any keys are never copied.
    const status = str(p.status)?.toLowerCase();
    const project: SupabaseProject = {
      ref, name: str(p.name) ?? ref, region: str(p.region), status, org: str(p.organization_slug), orgId: str(p.organization_id),
    };
    projects.push(project);
    resources.push(cloudResource(PROVIDER, {
      id: `supabase:project:${ref}`, type: "database", service: "project", name: project.name, region: project.region, status,
      tags: project.org !== undefined ? { org: project.org } : undefined,
      consoleUrl: `${DASHBOARD}/project/${ref}`, url: `https://${ref}.supabase.co`, createdAt: isoTime(p.created_at),
      health: healthFrom(status, SUPABASE_HEALTH.project), healthDetail: status !== undefined ? PROJECT_DETAIL[status] : undefined,
    }));
  }
  return { projects, resources };
}

export function mapFunctions(json: unknown, project: SupabaseProject): CloudResource[] {
  return arr(json).flatMap((raw) => {
    const f = obj(raw);
    const slug = str(f?.slug) ?? str(f?.name);
    if (f === undefined || slug === undefined) return [];
    const status = str(f.status)?.toLowerCase();
    const version = str(f.version);
    return [cloudResource(PROVIDER, {
      id: `supabase:function:${project.ref}:${slug}`, type: "function", service: "edge-function", name: slug, region: project.region, status,
      tags: { project: project.name }, consoleUrl: `${DASHBOARD}/project/${project.ref}/functions/${encodeURIComponent(slug)}/details`,
      url: `https://${project.ref}.supabase.co/functions/v1/${slug}`, createdAt: isoTime(f.created_at),
      health: healthFrom(status, SUPABASE_HEALTH.function), healthDetail: version !== undefined ? `version ${version}` : undefined,
    })];
  });
}

export function mapBranches(json: unknown, project: SupabaseProject): CloudResource[] {
  return arr(json).flatMap((raw) => {
    const b = obj(raw);
    const id = str(b?.id);
    const name = str(b?.name);
    // The default branch is the project itself.
    if (b === undefined || id === undefined || name === undefined || b.is_default === true) return [];
    const status = str(b.status)?.toLowerCase();
    const git = str(b.git_branch);
    return [cloudResource(PROVIDER, {
      id: `supabase:branch:${id}`, type: "database", service: "branch", name: `${project.name}:${name}`, region: project.region, status,
      tags: { project: project.name, ...(git !== undefined ? { branch: git } : {}) },
      consoleUrl: `${DASHBOARD}/project/${project.ref}/branches`, createdAt: isoTime(b.created_at),
      health: healthFrom(status, SUPABASE_HEALTH.branch),
    })];
  });
}

export class SupabaseIntegration extends CliCloudAdapter {
  readonly id = PROVIDER;
  readonly name = "Supabase";
  protected readonly binName = "supabase";
  protected readonly setupHint = "brew install supabase/tap/supabase && supabase login";
  protected readonly accountPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
  protected readonly accountNoun = "organization";
  // The CLI's update notice goes to stderr; stdin closed so nothing can prompt.
  protected override runOptions = { input: "", env: { SUPABASE_TELEMETRY_DISABLED: "1" } };

  protected async accounts(bin: string): Promise<CliAccount[]> {
    const json = await this.json(bin, ["orgs", "list", "-o", "json"]);
    return arr(json).flatMap((raw) => {
      const o = obj(raw);
      const id = str(o?.slug) ?? str(o?.id);
      if (id === undefined) return [];
      return [{ id, label: str(o?.name) ?? id }];
    });
  }

  protected async check(bin: string, account: string | undefined): Promise<CheckResult> {
    try {
      const orgs = await this.accounts(bin);
      return { ok: true, detail: account !== undefined ? `supabase: organization ${account}` : `supabase: ${orgs.length} organization${orgs.length === 1 ? "" : "s"}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "supabase failed";
      const loggedOut = /access token|log ?in|unauthori[sz]ed|401/i.test(message);
      return { ok: false, status: loggedOut ? "not_connected" : "error", detail: message, setupHint: loggedOut ? "supabase login" : this.setupHint };
    }
  }

  protected async list(bin: string, account: string | undefined, errors: string[]): Promise<CloudResource[]> {
    const parsed = parseProjects(await this.json(bin, ["projects", "list", "-o", "json"]));
    const inAccount = (p: SupabaseProject): boolean => account === undefined || p.org === account || p.orgId === account;
    const projects = parsed.projects.filter(inAccount);
    const resources = parsed.resources.filter((r) => projects.some((p) => r.id === `supabase:project:${p.ref}`));
    // Functions and branches of running projects only (a paused project answers errors).
    const active = projects.filter((p) => p.status?.startsWith("active") === true && REF_RE.test(p.ref)).slice(0, MAX_PROJECT_DETAILS);
    const details = await mapLimit(active, 3, async (p) => [
      ...(await guarded(`functions ${p.name}`, errors, async () => mapFunctions(await this.json(bin, ["functions", "list", "--project-ref", p.ref, "-o", "json"]), p))),
      // Older CLIs lack --project-ref on branches; projects without branching answer an error: both mean "none".
      ...(await guarded(`branches ${p.name}`, errors, async () => mapBranches(await this.json(bin, ["branches", "list", "--project-ref", p.ref, "-o", "json"]), p),
        /unknown flag|branching|not enabled|not found|404/i)),
    ]);
    return [...resources, ...details.flat()];
  }
}
