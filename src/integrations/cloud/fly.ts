// src/integrations/cloud/fly.ts — Fly.io via `flyctl` (or `fly`) and its own
// login (`fly auth login`). Organizations are the accounts (none selected =
// every org the login can see). Read-only list commands only, `--json`,
// 20 s timeout each: apps, then per app (bounded) machines — summarized as
// started/stopped counts and regions, never listed one by one — and volumes;
// Postgres apps (`postgres list`) and Managed Postgres clusters (`mpg list`,
// newer flyctl only) are databases. `healthOf` maps app / machine / volume
// states for the live-status work (CONTRACTS.md §10).
import type { CloudResource } from "../../contracts/integrations.js";
import { mapLimit, obj, str, type Json } from "../exec.js";
import {
  CliCloudIntegration,
  cloudResource,
  errorText,
  lowerState,
  nativeState,
  objects,
  pick,
  type CliCloudDeps,
  type CollectContext,
  type HealthState,
  type Session,
} from "./cli-kit.js";

const PROVIDER = "fly";
const CONSOLE = "https://fly.io";
export const FLY_INSTALL = "brew install flyctl";
export const FLY_LOGIN = "fly auth login";
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AUTH_RE = /auth login|no access token|not logged in|unauthori[sz]ed|token.*expired|expired.*token/i;
const MAX_APPS = 50;

const resource = (fields: Parameters<typeof cloudResource>[1]): CloudResource => cloudResource(PROVIDER, fields);

/** `orgs list --json`: `{ slug: name }` (older flyctl) or `[{ Slug, Name }]`. */
export function parseOrgs(json: unknown): { slug: string; name: string }[] {
  if (Array.isArray(json)) {
    return objects(json).flatMap((o) => {
      const slug = str(pick(o, "Slug", "slug", "RawSlug"));
      return slug !== undefined ? [{ slug, name: str(pick(o, "Name", "name")) ?? slug }] : [];
    });
  }
  return Object.entries(obj(json) ?? {}).flatMap(([slug, name]) => (typeof name === "string" ? [{ slug, name }] : []));
}

export interface MachineSummary {
  total: number;
  started: number;
  stopped: number;
  /** Regions by machine count, most first. */
  regions: string[];
}

/** `machines list --json` → counts and regions (machines are summarized, not listed). */
export function summarizeMachines(json: unknown): MachineSummary {
  const machines = objects(json).filter((m) => (str(m.state) ?? "") !== "destroyed");
  const byRegion = new Map<string, number>();
  let started = 0;
  let stopped = 0;
  for (const m of machines) {
    const state = str(m.state);
    if (state === "started") started++;
    else if (state === "stopped" || state === "suspended") stopped++;
    const region = str(m.region);
    if (region !== undefined) byRegion.set(region, (byRegion.get(region) ?? 0) + 1);
  }
  const regions = [...byRegion].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r);
  return { total: machines.length, started, stopped, regions };
}

/** "deployed · 2/3 machines started · fra, iad" — the word before " · " is the native app state. */
export function appStatus(state: string | undefined, machines: MachineSummary | undefined): string | undefined {
  const parts = [state];
  if (machines !== undefined && machines.total > 0) {
    parts.push(`${machines.started}/${machines.total} ${machines.total === 1 ? "machine" : "machines"} started`);
    if (machines.regions.length > 0) parts.push(machines.regions.join(", "));
  }
  const out = parts.filter((p): p is string => p !== undefined && p.length > 0);
  return out.length > 0 ? out.join(" · ") : undefined;
}

export function appName(app: Json): string | undefined {
  return str(pick(app, "Name", "name", "ID", "id"));
}

export function orgOf(app: Json): string | undefined {
  return str(pick(obj(pick(app, "Organization", "organization")), "Slug", "slug", "RawSlug"));
}

export function mapFlyApp(app: Json, machines: MachineSummary | undefined, postgres: ReadonlySet<string>): CloudResource | undefined {
  const name = appName(app);
  if (name === undefined) return undefined;
  const pg = postgres.has(name) || pick(app, "PostgresAppRole", "postgresAppRole") !== undefined;
  const hostname = str(pick(app, "Hostname", "hostname"));
  const org = orgOf(app);
  return resource({
    id: `fly:app:${name}`, type: pg ? "database" : "app", service: pg ? "fly/postgres" : "fly/app", name,
    region: machines?.regions[0] ?? str(pick(app, "PrimaryRegion", "primaryRegion")),
    status: appStatus(lowerState(pick(app, "Status", "status")), machines),
    url: hostname !== undefined && !pg ? `https://${hostname}` : undefined,
    tags: org !== undefined ? { org } : undefined,
    consoleUrl: `${CONSOLE}/apps/${name}`,
  });
}

export function mapVolumes(json: unknown, app: string): CloudResource[] {
  return objects(json).flatMap((v) => {
    const id = str(pick(v, "id", "ID"));
    if (id === undefined) return [];
    const state = lowerState(pick(v, "state", "State"));
    if (state === "destroyed" || state === "pending destroy") return [];
    const size = pick(v, "size_gb", "SizeGb", "sizeGb");
    return [resource({
      id: `fly:volume:${id}`, type: "storage", service: "fly/volume", name: str(pick(v, "name", "Name")) ?? id,
      region: str(pick(v, "region", "Region")),
      status: typeof size === "number" && state !== undefined ? `${state} · ${size} GB` : state,
      tags: { app }, consoleUrl: `${CONSOLE}/apps/${app}/volumes`,
    })];
  });
}

/** `mpg list --json` (Managed Postgres, newer flyctl). */
export function mapManagedPostgres(json: unknown): CloudResource[] {
  return objects(Array.isArray(json) ? json : pick(obj(json), "data", "clusters")).flatMap((c) => {
    const id = str(pick(c, "id", "ID"));
    if (id === undefined) return [];
    const org = str(pick(obj(pick(c, "organization", "Organization")), "slug", "Slug"));
    return [resource({
      id: `fly:mpg:${id}`, type: "database", service: "fly/managed-postgres", name: str(pick(c, "name", "Name")) ?? id,
      region: str(pick(c, "region", "Region", "primary_region")), status: lowerState(pick(c, "status", "Status")),
      tags: org !== undefined ? { org } : undefined,
      consoleUrl: org !== undefined ? `${CONSOLE}/dashboard/${org}/managed_postgres/${id}` : `${CONSOLE}/dashboard`,
    })];
  });
}

/**
 * Native Fly state → live health. `kind` disambiguates "created" (a volume's
 * normal state, a machine not yet started); default is app/machine.
 */
export function healthOf(state: string | undefined | null, kind: "app" | "machine" | "volume" = "app"): HealthState {
  const s = nativeState(state);
  if (s.length === 0) return "unknown";
  if (kind === "volume") return s === "CREATED" || s === "READY" ? "healthy" : s.includes("DESTROY") || s === "FAILED" ? "down" : s === "RESTORING" || s === "HYDRATING" ? "deploying" : "unknown";
  if (["DEPLOYED", "STARTED", "RUNNING", "PASSING", "READY", "HEALTHY"].includes(s)) return "healthy";
  if (["PENDING", "CREATED", "STARTING", "REPLACING", "LAUNCHING", "UPDATING", "RESTARTING", "PROVISIONING"].includes(s)) return "deploying";
  if (["WARNING", "DEGRADED"].includes(s)) return "degraded";
  if (["SUSPENDED", "STOPPED", "STOPPING", "DEAD", "FAILED", "DESTROYED", "CRITICAL", "ERROR"].includes(s)) return "down";
  return "unknown";
}

export class FlyIntegration extends CliCloudIntegration {
  constructor(deps: CliCloudDeps) {
    super(
      { id: PROVIDER, name: "Fly.io", bins: ["flyctl", "fly"], install: FLY_INSTALL, login: FLY_LOGIN, accountNoun: "org", accountRe: ORG_RE, authError: AUTH_RE },
      deps,
    );
  }

  protected async session(bin: string): Promise<Session> {
    const me = obj(await this.runJson(bin, ["auth", "whoami", "--json"], {}, {}));
    const who = str(pick(me, "email", "Email"));
    if (who === undefined) return { loggedIn: false, reason: "no fly login" };
    const orgs = parseOrgs(await this.runJson(bin, ["orgs", "list", "--json"], {}, {}).catch(() => ({})));
    return { loggedIn: true, who, accounts: orgs.filter((o) => ORG_RE.test(o.slug)).map((o) => ({ id: o.slug, label: o.name !== o.slug ? `${o.name} (${o.slug})` : o.slug })) };
  }

  protected describe(session: Extract<Session, { loggedIn: true }>, account: string | undefined): string {
    return [session.who, account !== undefined ? `org ${account}` : "all orgs"].filter(Boolean).join(" · ");
  }

  protected async collect({ bin, account, errors }: CollectContext): Promise<CloudResource[]> {
    const org = account !== undefined ? ["--org", account] : [];
    let apps: Json[];
    try {
      apps = objects(await this.runJson(bin, ["apps", "list", "--json", ...org]));
    } catch (err) {
      errors.push(`apps: ${errorText(err, "flyctl failed")}`);
      return [];
    }
    if (account !== undefined) apps = apps.filter((a) => orgOf(a) === undefined || orgOf(a) === account);
    const postgres = new Set(
      objects(await this.runJson(bin, ["postgres", "list", "--json", ...org]).catch(() => [])).map(appName).filter((n): n is string => n !== undefined),
    );
    const named = apps.filter((a) => APP_RE.test(appName(a) ?? "")).slice(0, MAX_APPS);
    if (apps.length > MAX_APPS) errors.push(`apps: showing machines/volumes for the first ${MAX_APPS} of ${apps.length} apps`);
    const perApp = await mapLimit(named, 4, async (app): Promise<CloudResource[]> => {
      const name = appName(app)!;
      let machines: MachineSummary | undefined;
      const out: CloudResource[] = [];
      try {
        machines = summarizeMachines(await this.runJson(bin, ["machines", "list", "--app", name, "--json"]));
      } catch (err) {
        errors.push(`machines ${name}: ${errorText(err, "flyctl failed")}`);
      }
      try {
        out.push(...mapVolumes(await this.runJson(bin, ["volumes", "list", "--app", name, "--json"]), name));
      } catch (err) {
        errors.push(`volumes ${name}: ${errorText(err, "flyctl failed")}`);
      }
      const mapped = mapFlyApp(app, machines, postgres);
      return mapped !== undefined ? [mapped, ...out] : out;
    });
    // Managed Postgres needs a recent flyctl; an unknown command is not an error.
    const mpg = await this.runJson(bin, ["mpg", "list", "--json", ...org])
      .then(mapManagedPostgres)
      .catch(() => []);
    return [...perApp.flat(), ...mpg];
  }
}
