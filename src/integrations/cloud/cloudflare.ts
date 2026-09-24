// src/integrations/cloud/cloudflare.ts — Cloudflare via `wrangler` and its own
// login (`wrangler login`). Accounts come from `wrangler whoami`; the chosen
// one is passed as CLOUDFLARE_ACCOUNT_ID (wrangler has no --account flag).
// Read-only list commands only, 20 s timeout each, run from a neutral cwd so a
// stray wrangler.toml cannot change the account.
//
// JSON support in wrangler is uneven (documented in CONTRACTS.md §10):
//   d1 list --json ............ JSON
//   kv namespace list ......... JSON (always)
//   pages project list --json . JSON rows of the table; table parsed as fallback
//   pages deployment list ..... same (--json, table fallback)
//   deployments list --json ... JSON (per Worker)
//   r2 bucket list ............ text only ("name: …" blocks), parsed
//   queues list ............... table only, parsed
//   whoami .................... text (table of accounts), parsed
// Wrangler cannot list an account's Workers, so Workers are the ones the open
// project's wrangler.toml / wrangler.json(c) files declare (+ their routes),
// confirmed and dated with `wrangler deployments list --name <worker> --json`.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { CloudResource } from "../../contracts/integrations.js";
import { arr, mapLimit, obj, parseJson, str } from "../exec.js";
import {
  CliCloudIntegration,
  cloudResource,
  errorText,
  looseJson,
  nativeState,
  objects,
  parseTextTable,
  pick,
  type CliCloudDeps,
  type CollectContext,
  type HealthState,
  type Session,
} from "./cli-kit.js";

const PROVIDER = "cloudflare";
const DASH = "https://dash.cloudflare.com";
export const CLOUDFLARE_INSTALL = "brew install cloudflare-wrangler";
export const CLOUDFLARE_LOGIN = "wrangler login";
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const WORKER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const PAGES_RE = /^[a-z0-9][a-z0-9-]{0,57}$/;
const AUTH_RE = /wrangler login|not authenticated|not logged in|authentication error|\[code: (10000|9109|9106)\]|invalid access token|token.*expired/i;
const MISSING_WORKER_RE = /does not exist|not found|\[code: 10007\]|script_not_found/i;
const UNKNOWN_FLAG_RE = /unknown argument|unknown option|unrecognized/i;
const MAX_WORKERS = 20;
const MAX_PAGES = 20;

export interface CloudflareContext {
  account: string | undefined;
}

const resource = (fields: Parameters<typeof cloudResource>[1]): CloudResource => cloudResource(PROVIDER, fields);

/** Dashboard link; without a known account, Cloudflare's `?to=/:account/…` redirect picks one. */
export const dashUrl = (account: string | undefined, rest: string): string =>
  account !== undefined ? `${DASH}/${account}/${rest}` : `${DASH}/?to=/:account/${rest}`;

// ---- whoami ------------------------------------------------------------------------

export interface Whoami {
  loggedIn: boolean;
  email?: string;
  accounts: { id: string; name: string }[];
}

/** `wrangler whoami` text (or a future JSON form) → login state and accounts. */
export function parseWhoami(text: string): Whoami {
  const json = obj(looseJson(text));
  if (json !== undefined && (json.loggedIn !== undefined || json.accounts !== undefined)) {
    const accounts = objects(json.accounts).flatMap((a) => {
      const id = str(a.id);
      return id !== undefined && ACCOUNT_RE.test(id) ? [{ id, name: str(a.name) ?? id }] : [];
    });
    const out: Whoami = { loggedIn: json.loggedIn !== false && accounts.length > 0, accounts };
    const email = str(json.email);
    if (email !== undefined) out.email = email;
    return out;
  }
  const accounts: { id: string; name: string }[] = [];
  for (const row of parseTextTable(text)) {
    const id = row["Account ID"]?.trim();
    if (id !== undefined && ACCOUNT_RE.test(id)) accounts.push({ id, name: row["Account Name"]?.trim() || id });
  }
  const out: Whoami = { loggedIn: accounts.length > 0 && !/not authenticated|not logged in/i.test(text), accounts };
  const email = /associated with the email\s+(\S+?)\.?\s*$/im.exec(text)?.[1];
  if (email !== undefined) out.email = email;
  return out;
}

// ---- mappers --------------------------------------------------------------------------

/** Rows from `--json` output, else the printed table. */
function rows(text: string): Record<string, unknown>[] {
  const json = looseJson(text);
  if (json !== undefined) return objects(Array.isArray(json) ? json : pick(obj(json), "result", "items", "deployments"));
  return parseTextTable(text);
}

/** Pages deployment "Status" cell ("Failure", "3 hours ago", "Building", …) → a state word. */
export function pagesDeploymentState(value: string | undefined): string | undefined {
  const s = (value ?? "").trim();
  if (s.length === 0) return undefined;
  if (/fail|error/i.test(s)) return "failed";
  if (/cancel|skip/i.test(s)) return "canceled";
  if (/build|progress|queued|initiali|deploying|pending|active_?build/i.test(s)) return "deploying";
  return "deployed";
}

export interface PagesDeployment {
  status?: string | undefined;
  url?: string | undefined;
  environment?: string | undefined;
}

/** Newest production deployment (rows are newest first), else the newest of any kind. */
export function latestPagesDeployment(text: string): PagesDeployment | undefined {
  const list = rows(text);
  const prod = list.find((r) => /production/i.test(str(pick(r, "Environment", "environment")) ?? "")) ?? list[0];
  if (prod === undefined) return undefined;
  const stage = obj(prod.latest_stage);
  return {
    status: pagesDeploymentState(str(pick(prod, "Status", "status")) ?? str(stage?.status)),
    url: str(pick(prod, "Deployment", "url")),
    environment: str(pick(prod, "Environment", "environment"))?.toLowerCase(),
  };
}

/** `pages project list` rows → Pages projects (latest deployment merged in by the caller). */
export function mapPagesProjects(text: string, { account }: CloudflareContext, deployments: ReadonlyMap<string, PagesDeployment> = new Map()): CloudResource[] {
  return rows(text).flatMap((p) => {
    const name = str(pick(p, "Project Name", "name"));
    if (name === undefined) return [];
    const domains = (str(pick(p, "Project Domains", "domains")) ?? arr(p.domains).map(str).filter(Boolean).join(", "))
      .split(/[,\s]+/)
      .filter((d) => d.length > 0);
    const custom = domains.find((d) => !d.endsWith(".pages.dev"));
    const latest = deployments.get(name);
    const host = custom ?? domains[0];
    return [resource({
      id: `cf:pages:${account ?? "-"}:${name}`, type: "app", service: "pages", name,
      status: latest?.status, url: host !== undefined ? `https://${host}` : latest?.url,
      consoleUrl: dashUrl(account, `pages/view/${name}`),
    })];
  });
}

export function mapD1(json: unknown, { account }: CloudflareContext): CloudResource[] {
  return objects(json).flatMap((d) => {
    const uuid = str(d.uuid);
    const name = str(d.name);
    if (uuid === undefined || name === undefined) return [];
    return [resource({ id: `cf:d1:${uuid}`, type: "database", service: "d1", name, consoleUrl: dashUrl(account, `workers/d1/databases/${uuid}`) })];
  });
}

export function mapKv(json: unknown, { account }: CloudflareContext): CloudResource[] {
  return objects(json).flatMap((n) => {
    const id = str(n.id);
    if (id === undefined) return [];
    return [resource({ id: `cf:kv:${id}`, type: "storage", service: "kv", name: str(n.title) ?? id, consoleUrl: dashUrl(account, `workers/kv/namespaces/${id}`) })];
  });
}

/** `r2 bucket list`: "name: x" blocks (wrangler 3/4) or a JSON array (older). */
export function mapR2(text: string, { account }: CloudflareContext): CloudResource[] {
  const json = looseJson(text);
  const names = Array.isArray(json)
    ? objects(json).map((b) => str(b.name)).filter((n): n is string => n !== undefined)
    : [...text.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
  return [...new Set(names)].map((name) =>
    resource({ id: `cf:r2:${account ?? "-"}:${name}`, type: "storage", service: "r2", name, consoleUrl: dashUrl(account, `r2/default/buckets/${name}`) }),
  );
}

/** `queues list` table (Id, Name, Created On, Modified On, Producers, Consumers) or JSON. */
export function mapQueues(text: string, { account }: CloudflareContext): CloudResource[] {
  return rows(text).flatMap((q) => {
    const id = str(pick(q, "Id", "queue_id", "id"));
    const name = str(pick(q, "Name", "queue_name", "name"));
    if (id === undefined || name === undefined) return [];
    const consumers = Number(str(pick(q, "Consumers", "consumers_total_count")) ?? NaN);
    return [resource({
      id: `cf:queue:${id}`, type: "queue", service: "queues", name,
      status: Number.isFinite(consumers) ? (consumers > 0 ? "active" : "no consumers") : undefined,
      consoleUrl: dashUrl(account, `workers/queues/view/${id}`),
    })];
  });
}

// ---- Workers from the project's wrangler config ---------------------------------------

export interface WorkerDecl {
  name: string;
  routes: string[];
  environment?: string;
}

const CONFIG_NAMES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "build", ".next", ".output", ".turbo", "vendor", "target", "coverage", ".ruah"]);

/** wrangler config files at the root and up to three levels down (bounded). */
export function findWranglerConfigs(root: string, maxDepth = 3, maxFiles = 20): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (found.length >= maxFiles || visited++ > 400) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isFile() && CONFIG_NAMES.includes(e.name)) found.push(path.join(dir, e.name));
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.slice(0, maxFiles);
}

/** Removes // and /* *\/ comments outside strings, then trailing commas. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** A route value: "host/*", { pattern: "host/*" }, or an array of those. */
function routePatterns(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  return list.map((r) => str(r) ?? str(obj(r)?.pattern)).filter((r): r is string => r !== undefined);
}

function tomlString(raw: string): string | undefined {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(raw);
  return m === null ? undefined : (m[1] ?? m[2]);
}

/** Patterns in a TOML route/routes value: inline tables' `pattern`, then bare strings. */
function tomlRoutes(raw: string): string[] {
  const patterns = [...raw.matchAll(/pattern\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2] ?? "");
  const bare = raw.replace(/\{[^}]*\}/g, "");
  for (const m of bare.matchAll(/"([^"]*)"|'([^']*)'/g)) patterns.push(m[1] ?? m[2] ?? "");
  return patterns.filter((p) => p.length > 0);
}

function pushString(list: string[], raw: string): void {
  const value = tomlString(raw);
  if (value !== undefined && value.length > 0) list.push(value);
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

interface RawConfig {
  name?: string;
  routes: string[];
  envs: Map<string, { name?: string; routes: string[] }>;
}

/** The subset of wrangler.toml Ruah needs: name, route(s) and [env.*] overrides. */
export function parseWranglerToml(text: string): RawConfig {
  const cfg: RawConfig = { routes: [], envs: new Map() };
  const env = (name: string): { name?: string; routes: string[] } => {
    let e = cfg.envs.get(name);
    if (e === undefined) cfg.envs.set(name, (e = { routes: [] }));
    return e;
  };
  let section = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = stripTomlComment(lines[i]!).trim();
    if (line.length === 0) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header !== null) {
      section = header[1]!.replace(/["']/g, "");
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1]!;
    let value = kv[2]!;
    // Multi-line arrays / inline tables: read until the brackets balance.
    const depth = (s: string): number => (s.match(/[[{]/g)?.length ?? 0) - (s.match(/[\]}]/g)?.length ?? 0);
    while (depth(value) > 0 && i + 1 < lines.length) {
      line = stripTomlComment(lines[++i]!).trim();
      value += ` ${line}`;
    }
    const envMatch = /^env\.([^.]+)(\.routes)?$/.exec(section);
    if (section === "" || section === "routes") {
      if (section === "" && key === "name") {
        const n = tomlString(value);
        if (n !== undefined) cfg.name = n;
      } else if (section === "routes" && key === "pattern") pushString(cfg.routes, value);
      else if (section === "" && (key === "route" || key === "routes")) cfg.routes.push(...tomlRoutes(value));
    } else if (envMatch !== null) {
      const e = env(envMatch[1]!);
      if (envMatch[2] !== undefined && key === "pattern") pushString(e.routes, value);
      else if (envMatch[2] === undefined && key === "name") {
        const n = tomlString(value);
        if (n !== undefined) e.name = n;
      } else if (envMatch[2] === undefined && (key === "route" || key === "routes")) e.routes.push(...tomlRoutes(value));
    }
  }
  return cfg;
}

export function parseWranglerJson(text: string): RawConfig {
  const json = obj(parseJson(stripJsonc(text)));
  const cfg: RawConfig = { routes: [], envs: new Map() };
  if (json === undefined) return cfg;
  const name = str(json.name);
  if (name !== undefined) cfg.name = name;
  cfg.routes = [...routePatterns(json.route), ...routePatterns(json.routes)];
  for (const [envName, raw] of Object.entries(obj(json.env) ?? {})) {
    const e = obj(raw);
    if (e === undefined) continue;
    const entry: { name?: string; routes: string[] } = { routes: [...routePatterns(e.route), ...routePatterns(e.routes)] };
    const n = str(e.name);
    if (n !== undefined) entry.name = n;
    cfg.envs.set(envName, entry);
  }
  return cfg;
}

/** Workers a config declares: the top-level one and one per [env.*] (default name "<name>-<env>"). */
export function workersFromConfig(text: string, file: string): WorkerDecl[] {
  const cfg = file.endsWith(".toml") ? parseWranglerToml(text) : parseWranglerJson(text);
  if (cfg.name === undefined) return [];
  const out: WorkerDecl[] = [{ name: cfg.name, routes: cfg.routes }];
  for (const [envName, e] of cfg.envs) out.push({ name: e.name ?? `${cfg.name}-${envName}`, routes: e.routes, environment: envName });
  return out.filter((w) => WORKER_RE.test(w.name));
}

/** "api.example.com/*" → "https://api.example.com"; wildcard hosts have no single URL. */
export function routeUrl(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const host = pattern.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (host.length === 0 || host.includes("*")) return undefined;
  const rest = pattern.replace(/^https?:\/\//, "").slice(host.length).replace(/\/?\*$/, "");
  return `https://${host}${rest}`;
}

/** Newest `created_on` of `wrangler deployments list --json` output. */
export function latestWorkerDeployment(json: unknown): string | undefined {
  const list = objects(Array.isArray(json) ? json : pick(obj(json), "deployments", "items"));
  return list.map((d) => str(pick(d, "created_on", "createdOn"))).filter((d): d is string => d !== undefined).sort().pop();
}

export function mapWorker(decl: WorkerDecl, { account }: CloudflareContext, deployedAt: string | undefined): CloudResource {
  const tags: Record<string, string> = {};
  if (decl.routes.length > 0) tags.routes = decl.routes.join(", ");
  if (decl.environment !== undefined) tags.environment = decl.environment;
  if (deployedAt !== undefined) tags["deployed-at"] = deployedAt;
  return resource({
    id: `cf:worker:${account ?? "-"}:${decl.name}`, type: "function", service: "workers", name: decl.name,
    status: "deployed", url: routeUrl(decl.routes[0]), tags,
    consoleUrl: dashUrl(account, `workers/services/view/${decl.name}/production`),
  });
}

/** Native Cloudflare state (Pages stage status, this adapter's words) → live health. */
export function healthOf(state: string | undefined | null): HealthState {
  const s = nativeState(state);
  if (s.length === 0) return "unknown";
  if (["DEPLOYED", "SUCCESS", "ACTIVE", "HEALTHY"].includes(s)) return "healthy";
  if (["NO_CONSUMERS", "CANCELED", "CANCELLED", "SKIPPED"].includes(s)) return "degraded";
  if (["DEPLOYING", "BUILDING", "QUEUED", "INITIALIZED", "IDLE", "ACTIVE_BUILD", "PENDING"].includes(s)) return "deploying";
  if (["FAILED", "FAILURE", "ERROR"].includes(s)) return "down";
  return "unknown";
}

export class CloudflareIntegration extends CliCloudIntegration {
  constructor(deps: CliCloudDeps) {
    super(
      { id: PROVIDER, name: "Cloudflare", bins: ["wrangler"], install: CLOUDFLARE_INSTALL, login: CLOUDFLARE_LOGIN, accountNoun: "account", accountRe: ACCOUNT_RE, authError: AUTH_RE },
      deps,
    );
  }

  protected accountEnv(account: string | undefined): Record<string, string> {
    return { WRANGLER_SEND_METRICS: "false", ...(account !== undefined ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) };
  }

  private wrangler(bin: string, args: string[], account: string | undefined): Promise<string> {
    return this.run(bin, args, { account, cwd: tmpdir() });
  }

  /** `--json` first; an older wrangler without the flag gets the table form. */
  private async wranglerRows(bin: string, args: string[], account: string | undefined): Promise<string> {
    try {
      return await this.wrangler(bin, [...args, "--json"], account);
    } catch (err) {
      if (UNKNOWN_FLAG_RE.test(errorText(err, ""))) return this.wrangler(bin, args, account);
      throw err;
    }
  }

  protected async session(bin: string): Promise<Session> {
    const who = parseWhoami(await this.wrangler(bin, ["whoami"], undefined));
    if (!who.loggedIn) return { loggedIn: false, reason: "no wrangler login" };
    const fromEnv = this.env().CLOUDFLARE_ACCOUNT_ID;
    const current = fromEnv !== undefined && who.accounts.some((a) => a.id === fromEnv) ? fromEnv : who.accounts[0]?.id;
    return { loggedIn: true, who: who.email, accounts: who.accounts.map((a) => ({ id: a.id, label: a.name })), current };
  }

  protected async collect({ bin, account, project, errors }: CollectContext): Promise<CloudResource[]> {
    const ctx: CloudflareContext = { account };
    const guard = async (service: string, fn: () => Promise<CloudResource[]>): Promise<CloudResource[]> => {
      try {
        return await fn();
      } catch (err) {
        errors.push(`${service}: ${errorText(err, "wrangler failed")}`);
        return [];
      }
    };
    const jobs: Promise<CloudResource[]>[] = [
      guard("d1", async () => mapD1(looseJson(await this.wrangler(bin, ["d1", "list", "--json"], account)), ctx)),
      guard("kv", async () => mapKv(looseJson(await this.wrangler(bin, ["kv", "namespace", "list"], account)), ctx)),
      guard("r2", async () => mapR2(await this.wrangler(bin, ["r2", "bucket", "list"], account), ctx)),
      guard("queues", async () => mapQueues(await this.wrangler(bin, ["queues", "list"], account), ctx)),
      guard("pages", () => this.pages(bin, account, ctx, errors)),
    ];
    if (project !== null) jobs.push(guard("workers", () => this.workers(bin, project.root, account, ctx, errors)));
    return (await Promise.all(jobs)).flat();
  }

  private async pages(bin: string, account: string | undefined, ctx: CloudflareContext, errors: string[]): Promise<CloudResource[]> {
    const listing = await this.wranglerRows(bin, ["pages", "project", "list"], account);
    const names = mapPagesProjects(listing, ctx).map((r) => r.name).filter((n) => PAGES_RE.test(n)).slice(0, MAX_PAGES);
    const deployments = new Map<string, PagesDeployment>();
    await mapLimit(names, 3, async (name) => {
      try {
        const latest = latestPagesDeployment(await this.wranglerRows(bin, ["pages", "deployment", "list", "--project-name", name], account));
        if (latest !== undefined) deployments.set(name, latest);
      } catch (err) {
        errors.push(`pages ${name}: ${errorText(err, "wrangler failed")}`);
      }
    });
    return mapPagesProjects(listing, ctx, deployments);
  }

  private async workers(bin: string, root: string, account: string | undefined, ctx: CloudflareContext, errors: string[]): Promise<CloudResource[]> {
    const decls = new Map<string, WorkerDecl>();
    for (const file of findWranglerConfigs(root)) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const w of workersFromConfig(text, file)) if (!decls.has(w.name)) decls.set(w.name, w);
    }
    const found = await mapLimit([...decls.values()].slice(0, MAX_WORKERS), 3, async (decl): Promise<CloudResource[]> => {
      try {
        const out = await this.wranglerRows(bin, ["deployments", "list", "--name", decl.name], account);
        return [mapWorker(decl, ctx, latestWorkerDeployment(looseJson(out)))];
      } catch (err) {
        const message = errorText(err, "wrangler failed");
        // Declared in the repo but never deployed to this account: not a resource.
        if (MISSING_WORKER_RE.test(message)) return [];
        errors.push(`worker ${decl.name}: ${message}`);
        return [];
      }
    });
    return found.flat();
  }
}
