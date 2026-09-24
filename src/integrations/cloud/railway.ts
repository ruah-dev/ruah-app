// src/integrations/cloud/railway.ts — Railway via the `railway` CLI and its own
// login (`railway login`). Workspaces are the accounts (from the projects
// `railway list --json` returns). Read-only: `whoami`, `list --json` and — in
// the open project's folder only, when that folder is linked with
// `railway link` — `status --json`, which adds each service's latest
// deployment per environment and its domains. 20 s timeout each.
// `healthOf` maps Railway deployment states for the live-status work
// (CONTRACTS.md §10).
import type { CloudResource, CloudResourceType } from "../../contracts/integrations.js";
import { obj, str, type Json } from "../exec.js";
import {
  CliCloudIntegration,
  cloudResource,
  errorText,
  lowerState,
  nativeState,
  nodes,
  objects,
  type CliCloudDeps,
  type CollectContext,
  type HealthState,
  type Session,
} from "./cli-kit.js";

const PROVIDER = "railway";
const CONSOLE = "https://railway.com";
export const RAILWAY_INSTALL = "brew install railway";
export const RAILWAY_LOGIN = "railway login";
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,100}$/;
const AUTH_RE = /railway login|unauthori[sz]ed|not logged in|login required|invalid (auth|token)|token.*expired/i;
const PERSONAL = "personal";

const resource = (fields: Parameters<typeof cloudResource>[1]): CloudResource => cloudResource(PROVIDER, fields);

/** Projects from `railway list --json`: a bare array, `{ projects }`, or GraphQL edges. */
export function railwayProjects(json: unknown): Json[] {
  if (Array.isArray(json)) return objects(json);
  const o = obj(json);
  if (o === undefined) return [];
  if (o.projects !== undefined) return nodes(o.projects);
  if (o.id !== undefined && o.name !== undefined) return [o];
  return nodes(o);
}

/** The workspace (formerly team) a project belongs to; personal projects have none. */
export function workspaceOf(project: Json): { id: string; name: string } {
  const w = obj(project.workspace) ?? obj(project.team);
  const id = str(w?.id);
  return id !== undefined ? { id, name: str(w?.name) ?? id } : { id: PERSONAL, name: "Personal" };
}

const DB_IMAGE_RE = /(postgres|postgis|timescale|mysql|mariadb|mongo|redis|valkey|clickhouse)/i;

function serviceKind(name: string, image: string | undefined): { type: CloudResourceType; engine?: string } {
  const m = DB_IMAGE_RE.exec(image ?? "") ?? /^(postgres(ql)?|mysql|mariadb|mongo(db)?|redis|valkey|clickhouse)(\b|-|$)/i.exec(name);
  if (m === null) return { type: "app" };
  const engine = m[1]!.toLowerCase().replace(/^postgresql$/, "postgres").replace(/^mongodb$/, "mongo");
  return { type: engine === "redis" || engine === "valkey" ? "cache" : "database", engine };
}

function firstDomain(instance: Json | undefined): string | undefined {
  const domains = obj(instance?.domains);
  const all = [...objects(domains?.customDomains), ...objects(domains?.serviceDomains)];
  const d = all.map((x) => str(x.domain)).find((x) => x !== undefined);
  return d !== undefined ? `https://${d}` : str(obj(instance?.latestDeployment)?.staticUrl)?.replace(/^(?!https?:\/\/)/, "https://");
}

/**
 * One resource per service × environment when the JSON carries service
 * instances (status --json, newer list --json); one per service otherwise.
 * Legacy plugins (pre-2024 databases) map to database resources.
 */
export function mapRailwayProject(project: Json): CloudResource[] {
  const projectId = str(project.id);
  const projectName = str(project.name);
  if (projectId === undefined) return [];
  const envNames = new Map<string, string>();
  for (const e of nodes(project.environments)) {
    const id = str(e.id);
    if (id !== undefined) envNames.set(id, str(e.name) ?? id);
  }
  const base = projectName !== undefined ? { project: projectName } : {};
  const out: CloudResource[] = [];
  for (const s of nodes(project.services)) {
    const serviceId = str(s.id);
    const name = str(s.name);
    if (serviceId === undefined || name === undefined) continue;
    const instances = nodes(s.serviceInstances);
    const image = str(obj(s.source)?.image) ?? instances.map((i) => str(obj(i.source)?.image)).find((x) => x !== undefined);
    const kind = serviceKind(name, image);
    const service = kind.engine !== undefined ? `railway/${kind.engine}` : "railway/service";
    const consoleBase = `${CONSOLE}/project/${projectId}/service/${serviceId}`;
    if (instances.length === 0) {
      const envs = [...envNames.values()];
      out.push(resource({
        id: `railway:service:${serviceId}`, type: kind.type, service, name,
        tags: { ...base, ...(envs.length > 0 ? { environments: envs.join(", ") } : {}) }, consoleUrl: consoleBase,
      }));
      continue;
    }
    for (const inst of instances) {
      const envId = str(inst.environmentId) ?? "-";
      const env = envNames.get(envId) ?? str(obj(inst.environment)?.name) ?? envId;
      out.push(resource({
        id: `railway:service:${serviceId}:${envId}`, type: kind.type, service, name,
        region: str(inst.region) ?? str(obj(obj(inst.latestDeployment)?.meta)?.region),
        status: lowerState(obj(inst.latestDeployment)?.status), url: firstDomain(inst),
        tags: { ...base, environment: env },
        consoleUrl: envId !== "-" ? `${consoleBase}?environmentId=${envId}` : consoleBase,
      }));
    }
  }
  for (const p of nodes(project.plugins)) {
    const id = str(p.id);
    const name = str(p.friendlyName) ?? str(p.name);
    if (id === undefined || name === undefined) continue;
    const engine = (str(p.name) ?? "db").toLowerCase();
    out.push(resource({
      id: `railway:plugin:${id}`, type: engine === "redis" ? "cache" : "database", service: `railway/${engine}`, name,
      status: lowerState(p.status), tags: base, consoleUrl: `${CONSOLE}/project/${projectId}`,
    }));
  }
  return out;
}

/** Railway deployment status (SUCCESS, FAILED, CRASHED, BUILDING, …) → live health. */
export function healthOf(state: string | undefined | null): HealthState {
  const s = nativeState(state);
  if (s.length === 0) return "unknown";
  // SLEEPING is app sleeping (serverless): it wakes on the next request.
  if (["SUCCESS", "SLEEPING", "ACTIVE", "RUNNING"].includes(s)) return "healthy";
  if (["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL"].includes(s)) return "deploying";
  if (["FAILED", "CRASHED", "REMOVED", "REMOVING"].includes(s)) return "down";
  if (["SKIPPED"].includes(s)) return "degraded";
  return "unknown";
}

export class RailwayIntegration extends CliCloudIntegration {
  constructor(deps: CliCloudDeps) {
    super(
      { id: PROVIDER, name: "Railway", bins: ["railway"], install: RAILWAY_INSTALL, login: RAILWAY_LOGIN, accountNoun: "workspace", accountRe: ACCOUNT_RE, authError: AUTH_RE, healthOf: (state) => healthOf(state) },
      deps,
    );
  }

  protected async session(bin: string): Promise<Session> {
    const text = await this.run(bin, ["whoami"]);
    // "Logged in as Jane Doe (jane@example.com) 👋"
    const who = /\(([^()\s]+@[^()\s]+)\)/.exec(text)?.[1] ?? /logged in as\s+(.+?)\s*(👋)?\s*$/im.exec(text)?.[1];
    if (who === undefined && !/logged in/i.test(text)) return { loggedIn: false, reason: "no railway login" };
    const projects = railwayProjects(await this.runJson(bin, ["list", "--json"]).catch(() => []));
    const accounts = new Map<string, string>();
    for (const p of projects) {
      const w = workspaceOf(p);
      if (ACCOUNT_RE.test(w.id)) accounts.set(w.id, w.name);
    }
    return { loggedIn: true, who, accounts: [...accounts].map(([id, label]) => ({ id, label })) };
  }

  protected describe(session: Extract<Session, { loggedIn: true }>, account: string | undefined): string {
    const label = session.accounts.find((a) => a.id === account)?.label;
    return [session.who, label !== undefined ? `workspace ${label}` : "all workspaces"].filter(Boolean).join(" · ");
  }

  protected async collect({ bin, account, project, errors }: CollectContext): Promise<CloudResource[]> {
    let projects: Json[];
    try {
      projects = railwayProjects(await this.runJson(bin, ["list", "--json"]));
    } catch (err) {
      errors.push(`projects: ${errorText(err, "railway failed")}`);
      return [];
    }
    if (account !== undefined) projects = projects.filter((p) => workspaceOf(p).id === account);
    // The open repo's linked project (railway link) has deployment status + domains per environment.
    if (project !== null) {
      const linked = obj(await this.runJson(bin, ["status", "--json"], { cwd: project.root }, {}).catch(() => undefined));
      const id = str(linked?.id);
      if (linked !== undefined && id !== undefined) {
        const i = projects.findIndex((p) => str(p.id) === id);
        if (i >= 0) projects[i] = { ...projects[i], ...linked };
        else if (account === undefined || workspaceOf(linked).id === account) projects.push(linked);
      }
    }
    return projects.flatMap(mapRailwayProject);
  }
}

