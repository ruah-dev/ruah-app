// src/integrations/cloud/digitalocean.ts — DigitalOcean via `doctl` and its
// own login (auth contexts). Read-only: only `list`/`get` subcommands, JSON
// output, 20 s timeout each. Pure mappers turn doctl JSON into CloudResource.
import type { CloudHealth, CloudResource, CloudResourceType, ConnectBody, IntegrationInfo } from "../../contracts/integrations.js";
import { arr, cliMessage, CliError, IntegrationError, mapLimit, obj, parseJson, resolveBin, str, type Runner } from "../exec.js";
import { DO_HEALTH, healthFrom, withHealth } from "../health.js";
import type { CloudIntegration, CloudSyncOutcome } from "../registry.js";
import type { SettingsStore } from "../store.js";

const PROVIDER = "digitalocean";
const CONSOLE = "https://cloud.digitalocean.com";
const SETUP_HINT = "brew install doctl && doctl auth init";
const CONTEXT_RE = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,99}$/;

type Mapper = (json: unknown) => CloudResource[];

/** doctl tags are plain strings; "k=v" becomes {k: v}, anything else {tag: ""}. */
export function doTags(value: unknown, extra?: unknown): Record<string, string> | undefined {
  const list = [...arr(value), ...(typeof extra === "string" && extra.length > 0 ? [extra] : [])];
  const tags: Record<string, string> = {};
  for (const tag of list) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    const eq = tag.indexOf("=");
    if (eq > 0) tags[tag.slice(0, eq)] = tag.slice(eq + 1);
    else tags[tag] = "";
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function resource(fields: {
  id: string;
  type: CloudResourceType;
  service: string;
  name: string | undefined;
  region?: string | undefined;
  status?: string | undefined;
  tags?: Record<string, string> | undefined;
  consoleUrl?: string | undefined;
}): CloudResource {
  const out: CloudResource = { id: fields.id, provider: PROVIDER, type: fields.type, service: fields.service, name: fields.name ?? fields.id };
  if (fields.region !== undefined) out.region = fields.region;
  if (fields.status !== undefined) out.status = fields.status;
  if (fields.tags !== undefined) out.tags = fields.tags;
  if (fields.consoleUrl !== undefined) out.consoleUrl = fields.consoleUrl;
  return out;
}

function each(json: unknown, fn: (item: Record<string, unknown>) => CloudResource | undefined): CloudResource[] {
  const out: CloudResource[] = [];
  for (const raw of arr(json)) {
    const item = obj(raw);
    if (item === undefined) continue;
    const mapped = fn(item);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

const regionSlug = (value: unknown): string | undefined => str(obj(value)?.slug) ?? str(value);

const APP_PHASE: Record<string, CloudHealth> = {
  active: "healthy", superseded: "healthy", error: "down", canceled: "unknown", unknown: "unknown",
  pending_build: "deploying", building: "deploying", pending_deploy: "deploying", deploying: "deploying",
};

/** App Platform: a deployment in progress wins ("deploying"); else the active deployment's phase. */
export function appHealth(active: string | undefined, progress: string | undefined): { health: CloudHealth; detail?: string } | undefined {
  if (progress !== undefined && APP_PHASE[progress.toLowerCase()] === "deploying") {
    return { health: "deploying", detail: active !== undefined ? `${progress.toLowerCase()} · previous version live` : progress.toLowerCase() };
  }
  if (active === undefined) return progress?.toUpperCase() === "ERROR" ? { health: "down", detail: "first deployment failed" } : undefined;
  return { health: APP_PHASE[active.toLowerCase()] ?? "unknown" };
}

export const mapDroplets: Mapper = (json) =>
  each(json, (d) => {
    const id = str(d.id);
    if (id === undefined) return undefined;
    const status = str(d.status);
    return withHealth(resource({
      id: `do:droplet:${id}`, type: "compute", service: "droplet", name: str(d.name),
      region: regionSlug(d.region), status, tags: doTags(d.tags), consoleUrl: `${CONSOLE}/droplets/${id}`,
    }), healthFrom(status, DO_HEALTH.droplet));
  });

export const mapApps: Mapper = (json) =>
  each(json, (a) => {
    const id = str(a.id);
    if (id === undefined) return undefined;
    const spec = obj(a.spec);
    const active = str(obj(a.active_deployment)?.phase);
    const progress = str(obj(a.in_progress_deployment)?.phase);
    const out = resource({
      id: `do:app:${id}`, type: "app", service: "apps", name: str(spec?.name),
      region: regionSlug(a.region) ?? str(spec?.region), status: (active ?? progress)?.toLowerCase(), consoleUrl: `${CONSOLE}/apps/${id}`,
    });
    const live = str(a.live_url);
    if (live !== undefined) out.url = live;
    const health = appHealth(active, progress);
    return withHealth(out, health?.health, health?.detail);
  });

function databaseType(engine: string | undefined): CloudResourceType {
  if (engine === "redis" || engine === "valkey") return "cache";
  if (engine === "kafka") return "queue";
  return "database";
}

export const mapDatabases: Mapper = (json) =>
  each(json, (d) => {
    const id = str(d.id);
    if (id === undefined) return undefined;
    const engine = str(d.engine);
    const status = str(d.status);
    return withHealth(resource({
      id: `do:dbaas:${id}`, type: databaseType(engine), service: engine !== undefined ? `databases/${engine}` : "databases",
      name: str(d.name), region: str(d.region), status, tags: doTags(d.tags), consoleUrl: `${CONSOLE}/databases/${id}`,
    }), healthFrom(status, DO_HEALTH.database));
  });

export const mapKubernetes: Mapper = (json) =>
  each(json, (k) => {
    const id = str(k.id);
    if (id === undefined) return undefined;
    const status = str(obj(k.status)?.state);
    return withHealth(resource({
      id: `do:kubernetes:${id}`, type: "kubernetes", service: "kubernetes", name: str(k.name),
      region: str(k.region) ?? str(k.region_slug), status, tags: doTags(k.tags),
      consoleUrl: `${CONSOLE}/kubernetes/clusters/${id}`,
    }), healthFrom(status, DO_HEALTH.kubernetes), str(obj(k.status)?.message));
  });

export const mapLoadBalancers: Mapper = (json) =>
  each(json, (l) => {
    const id = str(l.id);
    if (id === undefined) return undefined;
    const status = str(l.status);
    return withHealth(resource({
      id: `do:loadbalancer:${id}`, type: "loadbalancer", service: "load-balancer", name: str(l.name),
      region: regionSlug(l.region), status, tags: doTags(l.tags, l.tag),
      consoleUrl: `${CONSOLE}/networking/load_balancers/${id}`,
    }), healthFrom(status, DO_HEALTH.loadbalancer));
  });

export const mapDomains: Mapper = (json) =>
  each(json, (d) => {
    const name = str(d.name);
    if (name === undefined) return undefined;
    return resource({ id: `do:domain:${name}`, type: "dns", service: "domains", name, consoleUrl: `${CONSOLE}/networking/domains/${name}` });
  });

export const mapVolumes: Mapper = (json) =>
  each(json, (v) => {
    const id = str(v.id);
    if (id === undefined) return undefined;
    return resource({
      id: `do:volume:${id}`, type: "storage", service: "volumes", name: str(v.name),
      region: regionSlug(v.region), tags: doTags(v.tags), consoleUrl: `${CONSOLE}/volumes`,
    });
  });

export const mapCdns: Mapper = (json) =>
  each(json, (c) => {
    const id = str(c.id);
    if (id === undefined) return undefined;
    return resource({ id: `do:cdn:${id}`, type: "cdn", service: "cdn", name: str(c.origin), consoleUrl: `${CONSOLE}/spaces` });
  });

/**
 * doctl cannot list Spaces buckets (they use the S3 API with separate keys),
 * but CDN endpoints name their origin bucket: "<bucket>.<region>.digitaloceanspaces.com".
 */
export const spacesFromCdns: Mapper = (json) => {
  const seen = new Set<string>();
  return each(json, (c) => {
    const match = /^([a-z0-9][a-z0-9.-]*)\.([a-z]{3}\d)\.digitaloceanspaces\.com$/.exec(str(c.origin) ?? "");
    if (match === null) return undefined;
    const [, bucket, region] = match as unknown as [string, string, string];
    if (seen.has(`${region}/${bucket}`)) return undefined;
    seen.add(`${region}/${bucket}`);
    return resource({
      id: `do:space:${region}:${bucket}`, type: "storage", service: "spaces", name: bucket, region,
      consoleUrl: `${CONSOLE}/spaces/${bucket}?region=${region}`,
    });
  });
};

export const mapFunctions: Mapper = (json) =>
  // Only id/label/region are read; the namespace's access key is never copied.
  each(json, (f) => {
    const id = str(f.uuid) ?? str(f.namespace) ?? str(f.id);
    if (id === undefined) return undefined;
    return resource({
      id: `do:functions:${id}`, type: "function", service: "functions", name: str(f.label) ?? id,
      region: str(f.region), consoleUrl: `${CONSOLE}/functions/${id}`,
    });
  });

export const mapRegistry: Mapper = (json) => {
  const r = obj(json) ?? obj(arr(json)[0]);
  const name = str(r?.name);
  if (name === undefined) return [];
  return [resource({ id: `do:registry:${name}`, type: "storage", service: "registry", name, region: str(r?.region), consoleUrl: `${CONSOLE}/registry` })];
};

interface Listing {
  service: string;
  args: string[];
  map: Mapper;
  /** Treat this failure text as "none exist" instead of an error. */
  empty?: RegExp;
}

const LISTINGS: Listing[] = [
  { service: "droplets", args: ["compute", "droplet", "list"], map: mapDroplets },
  { service: "apps", args: ["apps", "list"], map: mapApps },
  { service: "databases", args: ["databases", "list"], map: mapDatabases },
  { service: "kubernetes", args: ["kubernetes", "cluster", "list"], map: mapKubernetes },
  { service: "load balancers", args: ["compute", "load-balancer", "list"], map: mapLoadBalancers },
  { service: "domains", args: ["compute", "domain", "list"], map: mapDomains },
  { service: "volumes", args: ["compute", "volume", "list"], map: mapVolumes },
  { service: "cdn", args: ["compute", "cdn", "list"], map: (json) => [...mapCdns(json), ...spacesFromCdns(json)] },
  { service: "functions", args: ["serverless", "namespaces", "list"], map: mapFunctions },
  { service: "registry", args: ["registry", "get"], map: mapRegistry, empty: /registry does not exist|404/i },
];

export interface DigitalOceanDeps {
  runner: Runner;
  settings: SettingsStore;
  /** Absolute doctl path; default: resolved from PATH + Homebrew. */
  bin?: () => string | undefined;
}

export class DigitalOceanIntegration implements CloudIntegration {
  readonly id = PROVIDER;
  readonly family = "cloud" as const;
  readonly name = "DigitalOcean";

  constructor(private readonly deps: DigitalOceanDeps) {}

  private bin(): string | undefined {
    return this.deps.bin !== undefined ? this.deps.bin() : resolveBin("doctl");
  }

  enabled(): boolean {
    return this.deps.settings.get(this.id).disabled !== true;
  }

  available(): boolean {
    return this.bin() !== undefined;
  }

  private base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...extra };
  }

  /** doctl auth contexts; the current one first. */
  async contexts(bin: string): Promise<{ name: string; current: boolean }[]> {
    const result = await this.deps.runner(bin, ["auth", "list", "-o", "json"]);
    const parsed = parseJson(result.stdout);
    if (Array.isArray(parsed)) {
      return parsed
        .map((c) => ({ name: str(obj(c)?.name) ?? "", current: obj(c)?.current === true }))
        .filter((c) => c.name.length > 0);
    }
    // Older doctl: text lines "name" / "name (current)".
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ name: line.replace(/\s*\(current\)$/, ""), current: line.endsWith("(current)") }));
  }

  private contextArgs(context: string | undefined): string[] {
    if (context === undefined) return [];
    if (!CONTEXT_RE.test(context)) throw new IntegrationError(400, "invalid doctl context name");
    return ["--context", context];
  }

  async info(): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.base({ status: "cli_missing", detail: "doctl not installed", setupHint: SETUP_HINT });
    try {
      const contexts = await this.contexts(bin);
      const accounts = contexts.map((c) => ({ id: c.name, label: c.current ? `${c.name} (current)` : c.name }));
      const settings = this.deps.settings.get(this.id);
      const context = settings.account ?? contexts.find((c) => c.current)?.name;
      if (settings.disabled === true) {
        return this.base({ status: "not_connected", detail: "disconnected in Ruah (doctl login unchanged)", setupHint: "Connect to use your doctl login", accounts });
      }
      const check = await this.deps.runner(bin, ["account", "get", "-o", "json", ...this.contextArgs(context)]);
      if (check.code !== 0) {
        const message = cliMessage(check);
        const unauthenticated = /access token|auth init|unauthori[sz]ed|401/i.test(message);
        return this.base({
          status: unauthenticated ? "not_connected" : "error",
          detail: context !== undefined ? `doctl context ${context}: ${message}` : message,
          setupHint: context !== undefined ? `doctl auth init --context ${context}` : "doctl auth init",
          accounts,
        });
      }
      const account = obj(parseJson(check.stdout));
      const team = str(obj(account?.team)?.name);
      return this.base({
        status: "connected",
        detail: `doctl context: ${context ?? "default"}${team !== undefined ? ` · team ${team}` : ""}`,
        accounts,
      });
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      return this.base({ status: "error", detail: err instanceof CliError ? err.message : "doctl failed", setupHint: SETUP_HINT });
    }
  }

  async connect(body: ConnectBody): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.info();
    const current = this.deps.settings.get(this.id);
    if (body.account !== undefined) {
      this.contextArgs(body.account);
      const contexts = await this.contexts(bin);
      if (!contexts.some((c) => c.name === body.account)) throw new IntegrationError(400, `unknown doctl context "${body.account}" — run: doctl auth init --context ${body.account}`);
    }
    const { disabled: _disabled, ...rest } = current;
    this.deps.settings.set(this.id, body.account !== undefined ? { ...rest, account: body.account } : rest);
    return this.info();
  }

  async disconnect(): Promise<IntegrationInfo> {
    this.deps.settings.set(this.id, { disabled: true });
    return this.info();
  }

  async sync(options: { account?: string }): Promise<CloudSyncOutcome> {
    const bin = this.bin();
    if (bin === undefined) throw new IntegrationError(424, "doctl not installed — " + SETUP_HINT);
    const context = options.account ?? this.deps.settings.get(this.id).account;
    const contextArgs = this.contextArgs(context);
    const errors: string[] = [];
    const lists = await mapLimit(LISTINGS, 4, async (listing) => {
      try {
        const result = await this.deps.runner(bin, [...listing.args, "-o", "json", ...contextArgs]);
        if (result.code !== 0) {
          const message = cliMessage(result);
          if (listing.empty?.test(message) === true) return [];
          errors.push(`${listing.service}: ${message}`);
          return [];
        }
        const json = parseJson(result.stdout);
        if (json === undefined && result.stdout.trim().length > 0) {
          errors.push(`${listing.service}: unexpected (non-JSON) doctl output`);
          return [];
        }
        return listing.map(json ?? []);
      } catch (err) {
        errors.push(`${listing.service}: ${err instanceof CliError ? err.message : "doctl failed"}`);
        return [];
      }
    });
    return { resources: lists.flat(), errors };
  }
}
