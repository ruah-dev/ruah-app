// src/integrations/scope/signals.ts — what a repo says about where it runs
// (CONTRACTS.md §14), read deterministically from small files and without
// tokens: provider link files (`.do/app.yaml`, `supabase/config.toml` and
// `supabase/.temp/project-ref`, `fly.toml`, `.vercel/project.json`,
// `wrangler.toml|json|jsonc`, `.netlify/state.json`, `.firebaserc`,
// `serverless.yml`, `samconfig.toml`, …), host names in example env files,
// compose files and config, and the names the project goes by.
//
// Bounded: directories up to 3 levels below the root (dependency, build and
// hidden folders skipped, except the provider link folders), ≤ 1,500
// directories, ≤ 150 files read, ≤ 256 KiB each. Never read: `.env` and
// every other real env file, Terraform state / tfvars, anything under `.git`
// but its `config` (the remote's repo name).
import * as fs from "node:fs";
import * as path from "node:path";
import { isTable, parseToml, tomlGet, tomlString, type TomlValue } from "../../scan/mini-toml.js";
import { parseYaml, yamlGet, yamlList, yamlPath, yamlString } from "../../scan/mini-yaml.js";
import { IGNORED_DIRS } from "../../scan/walk.js";
import { stripJsonc, workersFromConfig } from "../cloud/cloudflare.js";

/** What a link file says a resource looks like. */
export type Claim =
  | { kind: "id"; provider: string; id: string }
  | { kind: "idPart"; provider: string; part: string }
  | { kind: "name"; provider: string; name: string; services?: readonly string[] }
  | { kind: "namePrefix"; provider: string; prefix: string }
  | { kind: "tag"; provider?: string; key: string; value: string; prefix?: boolean };

export interface Evidence {
  claim: Claim;
  confidence: "proof" | "likely";
  /** Badge text: "from .do/app.yaml". */
  reason: string;
  /** Repo-relative file it came from. */
  file: string;
}

export interface HostRef {
  host: string;
  file: string;
}

export interface RepoSignals {
  root: string;
  /** Provider link / config files that were read (repo-relative, sorted). */
  files: string[];
  claims: Evidence[];
  hosts: HostRef[];
  /** Names the project goes by (repo folder, package, git remote, scope file `name`). */
  names: string[];
  /** Accounts a link file names (Cloudflare account_id, Firebase / GCP project). */
  accountHints: { provider: string; account: string; file: string }[];
  /** A bound was hit (more directories or files than read). */
  truncated: boolean;
}

const MAX_DEPTH = 3;
const MAX_DIRS = 1500;
const MAX_FILES = 150;
const MAX_BYTES = 256 * 1024;
const MAX_HOSTS = 500;

const SKIP_DIRS = new Set([...IGNORED_DIRS, ".git", ".next", ".turbo", ".wrangler", ".terraform", ".output", ".ruah", ".pnpm-store"]);

const ENV_EXAMPLE = [
  /^\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|sample|template|dist)$/,
  /^\.env\.(?:example|sample|template|dist)(?:\.[A-Za-z0-9_-]+)?$/,
  /^(?:example|sample)\.env$/,
];
const COMPOSE = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/;
const WRANGLER = new Set(["wrangler.toml", "wrangler.json", "wrangler.jsonc"]);

/** Generic words that never identify a project by themselves. */
export const GENERIC_NAMES = new Set([
  "app", "apps", "web", "www", "api", "site", "website", "frontend", "backend", "server", "service", "services", "main",
  "prod", "production", "staging", "stage", "dev", "development", "test", "default", "demo", "docs", "admin", "cms",
  "worker", "workers", "db", "database", "postgres", "redis", "cache", "monorepo", "project", "repo", "src", "code",
  "my-app", "myapp", "hello-world", "starter", "template", "root", "workspace", "platform", "infra", "core", "shared",
]);

/** "Harbor_Pay-Store" → "harborpaystore": case and separators never matter for names. */
export function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ---- hosts ------------------------------------------------------------------------

const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/g;
const BARE_HOST = /^[A-Za-z0-9_]+\s*[=:]\s*["']?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)["']?\s*$/;
const NOT_A_HOST = /(^|\.)(localhost|local|test|internal|invalid|example|lan|home|corp|cluster\.local|svc)$/;

/** A host name worth matching: has a letter TLD, not localhost / an IP / example.*. */
export function usableHost(raw: string): string | undefined {
  const host = raw.toLowerCase().replace(/\.$/, "");
  if (!/\.[a-z]{2,}$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return undefined;
  if (NOT_A_HOST.test(host) || /(^|\.)example\.(com|org|net)$/.test(host)) return undefined;
  return host;
}

/** Host names in free text: URLs anywhere, bare `KEY=host.tld` values in env-style lines. */
export function hostsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) {
    const h = usableHost(m[1] ?? "");
    if (h !== undefined) out.add(h);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = BARE_HOST.exec(line.trim());
    const h = m !== null ? usableHost(m[1] ?? "") : undefined;
    if (h !== undefined) out.add(h);
  }
  return [...out];
}

// ---- per-file parsers (pure: text in, evidence out) ---------------------------------

export interface FileFindings {
  claims: Evidence[];
  hosts: string[];
  accountHints: { provider: string; account: string }[];
  names?: string[];
}

const none = (): FileFindings => ({ claims: [], hosts: [], accountHints: [] });

function ev(file: string, claim: Claim, confidence: "proof" | "likely" = "proof", reason = `from ${file}`): Evidence {
  return { claim, confidence, reason, file };
}

/** DigitalOcean App Platform spec (`.do/app.yaml`, `.do/deploy.template.yaml` with `spec:`). */
export function parseDoAppSpec(text: string, file: string): FileFindings {
  const out = none();
  const doc = parseYaml(text);
  const spec = yamlGet(doc, "spec") ?? doc;
  const name = yamlString(yamlGet(spec, "name"));
  if (name !== undefined && name !== "") out.claims.push(ev(file, { kind: "name", provider: "digitalocean", name, services: ["apps"] }, "proof", `from ${file} (app ${name})`));
  // The names it deploys under are names the project goes by (weak suggestions look for them).
  if (name !== undefined && name !== "") out.names = [name];
  for (const d of yamlList(yamlGet(spec, "domains"))) {
    const host = usableHost(yamlString(yamlGet(d, "domain")) ?? "");
    if (host !== undefined) out.hosts.push(host);
    const zone = yamlString(yamlGet(d, "zone"));
    if (zone !== undefined && zone !== "") out.claims.push(ev(file, { kind: "name", provider: "digitalocean", name: zone.toLowerCase(), services: ["domains"] }, "proof", `from ${file} (domain ${zone})`));
  }
  for (const db of yamlList(yamlGet(spec, "databases"))) {
    const cluster = yamlString(yamlGet(db, "cluster_name"));
    if (cluster !== undefined && cluster !== "") {
      out.claims.push(ev(file, { kind: "name", provider: "digitalocean", name: cluster }, "proof", `from ${file} (database ${cluster})`));
    }
  }
  // Component env values are often URLs of the app itself (APP_URL=https://…).
  for (const key of ["services", "static_sites", "workers", "jobs", "functions"]) {
    for (const c of yamlList(yamlGet(spec, key))) {
      for (const e of yamlList(yamlGet(c, "envs"))) {
        if (yamlString(yamlGet(e, "type"))?.toUpperCase() === "SECRET") continue;
        for (const h of hostsInText(yamlString(yamlGet(e, "value")) ?? "")) out.hosts.push(h);
      }
    }
  }
  return out;
}

/** `supabase/config.toml`: `project_id` is the ref once linked, else the local folder name. */
export function parseSupabaseConfig(text: string, file: string): FileFindings {
  const out = none();
  const id = tomlString(tomlGet(parseToml(text), "project_id"));
  if (id !== undefined && id !== "") {
    out.claims.push(ev(file, { kind: "id", provider: "supabase", id: `supabase:project:${id}` }, "proof", `from ${file} (project ${id})`));
    out.claims.push(ev(file, { kind: "name", provider: "supabase", name: id, services: ["project"] }, "likely", `named like ${file} project_id`));
  }
  return out;
}

/** `supabase/.temp/project-ref` (written by `supabase link`). */
export function parseSupabaseRef(text: string, file: string): FileFindings {
  const out = none();
  const ref = text.trim();
  if (/^[a-z0-9]{10,40}$/.test(ref)) out.claims.push(ev(file, { kind: "id", provider: "supabase", id: `supabase:project:${ref}` }, "proof", `from supabase link (${ref})`));
  return out;
}

/** `fly.toml`: `app = "<name>"`. */
export function parseFlyToml(text: string, file: string): FileFindings {
  const out = none();
  const app = tomlString(tomlGet(parseToml(text), "app"));
  if (app !== undefined && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(app)) {
    out.claims.push(ev(file, { kind: "id", provider: "fly", id: `fly:app:${app}` }, "proof", `from ${file} (app ${app})`));
    out.hosts.push(`${app.toLowerCase()}.fly.dev`);
    out.names = [app];
  }
  return out;
}

function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stripJsonc(text)) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** `.vercel/project.json` (`vercel link`): projectId (+ projectName in newer CLIs). */
export function parseVercelProject(text: string, file: string): FileFindings {
  const out = none();
  const json = jsonOf(text);
  const id = s(json?.projectId);
  if (id !== undefined) out.claims.push(ev(file, { kind: "id", provider: "vercel", id: `vercel:project:${id}` }, "proof", `from ${file}`));
  const name = s(json?.projectName);
  if (name !== undefined) out.claims.push(ev(file, { kind: "name", provider: "vercel", name, services: ["project"] }, "proof", `from ${file} (${name})`));
  if (name !== undefined) out.names = [name];
  return out;
}

/** `.vercel/repo.json` (monorepo `vercel link --repo`): every linked project. */
export function parseVercelRepo(text: string, file: string): FileFindings {
  const out = none();
  const projects = jsonOf(text)?.projects;
  for (const p of Array.isArray(projects) ? projects : []) {
    const id = s((p as Record<string, unknown>)?.id);
    const name = s((p as Record<string, unknown>)?.name);
    if (id !== undefined) out.claims.push(ev(file, { kind: "id", provider: "vercel", id: `vercel:project:${id}` }, "proof", `from ${file}${name !== undefined ? ` (${name})` : ""}`));
  }
  return out;
}

/** `vercel.json`: alias hosts; the legacy `name` only suggests. */
export function parseVercelJson(text: string, file: string): FileFindings {
  const out = none();
  const json = jsonOf(text);
  const alias = json?.alias;
  for (const a of Array.isArray(alias) ? alias : [alias]) {
    const h = usableHost(s(a) ?? "");
    if (h !== undefined) out.hosts.push(h);
  }
  const name = s(json?.name);
  if (name !== undefined) out.claims.push(ev(file, { kind: "name", provider: "vercel", name, services: ["project"] }, "likely", `named in ${file}`));
  return out;
}

/** `.netlify/state.json` (`netlify link`): siteId. */
export function parseNetlifyState(text: string, file: string): FileFindings {
  const out = none();
  const id = s(jsonOf(text)?.siteId);
  if (id !== undefined) out.claims.push(ev(file, { kind: "id", provider: "netlify", id: `netlify:site:${id}` }, "proof", `from ${file}`));
  return out;
}

/** `wrangler.toml|json|jsonc`: Worker / Pages names, routes, D1 / KV / R2 bindings, account_id. */
export function parseWrangler(text: string, file: string): FileFindings {
  const out = none();
  const base = path.basename(file);
  for (const w of workersFromConfig(text, base)) {
    out.claims.push(ev(file, { kind: "name", provider: "cloudflare", name: w.name, services: ["workers", "pages"] }, "proof", `from ${file} (${w.name})`));
    for (const r of w.routes) {
      const h = usableHost(r.replace(/^https?:\/\//, "").split("/")[0]?.replace(/^\*\./, "") ?? "");
      if (h !== undefined) out.hosts.push(h);
    }
  }
  const cfg: Record<string, unknown> | TomlValue | undefined = base.endsWith(".toml") ? parseToml(text) : jsonOf(text);
  const get = (o: unknown, key: string): unknown => (typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>)[key] : undefined);
  const list = (key: string): unknown[] => {
    const v = get(cfg, key);
    return Array.isArray(v) ? v : [];
  };
  for (const d of list("d1_databases")) {
    const id = s(get(d, "database_id"));
    const name = s(get(d, "database_name"));
    if (id !== undefined) out.claims.push(ev(file, { kind: "id", provider: "cloudflare", id: `cf:d1:${id}` }, "proof", `from ${file} (D1 ${name ?? id})`));
    else if (name !== undefined) out.claims.push(ev(file, { kind: "name", provider: "cloudflare", name, services: ["d1"] }, "proof", `from ${file} (D1 ${name})`));
  }
  for (const k of list("kv_namespaces")) {
    const id = s(get(k, "id"));
    if (id !== undefined) out.claims.push(ev(file, { kind: "id", provider: "cloudflare", id: `cf:kv:${id}` }, "proof", `from ${file} (KV ${s(get(k, "binding")) ?? id})`));
  }
  for (const b of list("r2_buckets")) {
    const name = s(get(b, "bucket_name"));
    if (name !== undefined) out.claims.push(ev(file, { kind: "name", provider: "cloudflare", name, services: ["r2"] }, "proof", `from ${file} (R2 ${name})`));
  }
  const account = s(get(cfg, "account_id"));
  if (account !== undefined && /^[a-f0-9]{32}$/i.test(account)) out.accountHints.push({ provider: "cloudflare", account });
  return out;
}

/** `.firebaserc`: the Firebase (= Google Cloud) projects the repo deploys to. */
export function parseFirebaserc(text: string, file: string): FileFindings {
  const out = none();
  const projects = jsonOf(text)?.projects;
  const ids = new Set<string>();
  if (typeof projects === "object" && projects !== null) for (const v of Object.values(projects)) if (typeof v === "string" && /^[a-z][a-z0-9-]{4,62}$/.test(v)) ids.add(v);
  for (const id of ids) {
    out.claims.push(ev(file, { kind: "idPart", provider: "gcp", part: `/projects/${id}/` }, "proof", `from ${file} (project ${id})`));
    out.accountHints.push({ provider: "gcp", account: id });
    out.hosts.push(`${id}.web.app`, `${id}.firebaseapp.com`);
  }
  return out;
}

/** `serverless.yml`: `service` names the CloudFormation stack `<service>-<stage>` and functions `<service>-<stage>-<fn>`. */
export function parseServerless(text: string, file: string): FileFindings {
  const out = none();
  const doc = parseYaml(text);
  const svc = yamlString(yamlGet(doc, "service")) ?? yamlString(yamlPath(doc, "service", "name"));
  if (svc !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]{2,}$/.test(svc) && !svc.includes("${")) {
    out.claims.push(ev(file, { kind: "namePrefix", provider: "aws", prefix: `${svc}-` }, "proof", `from ${file} (service ${svc})`));
    out.names = [svc];
    out.claims.push(ev(file, { kind: "tag", provider: "aws", key: "aws:cloudformation:stack-name", value: `${svc}-`, prefix: true }, "proof", `from ${file} (stack ${svc}-*)`));
  }
  return out;
}

/** `samconfig.toml`: `stack_name` of every environment. */
export function parseSamconfig(text: string, file: string): FileFindings {
  const out = none();
  const stacks = new Set<string>();
  const walk = (v: TomlValue | undefined, depth: number): void => {
    if (!isTable(v) || depth > 4) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "stack_name" && typeof x === "string" && /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(x)) stacks.add(x);
      else walk(x, depth + 1);
    }
  };
  walk(parseToml(text), 0);
  for (const stack of stacks) {
    out.claims.push(ev(file, { kind: "tag", provider: "aws", key: "aws:cloudformation:stack-name", value: stack }, "proof", `from ${file} (stack ${stack})`));
    out.claims.push(ev(file, { kind: "namePrefix", provider: "aws", prefix: `${stack}-` }, "likely", `named after ${file} stack ${stack}`));
  }
  return out;
}

/** Root `package.json`: the package name and its homepage. */
export function parsePackageJson(text: string): FileFindings {
  const out = none();
  const json = jsonOf(text);
  const name = s(json?.name)?.replace(/^@[^/]+\//, "");
  if (name !== undefined) out.names = [name];
  const home = usableHost((s(json?.homepage) ?? "").replace(/^https?:\/\//, "").split("/")[0] ?? "");
  if (home !== undefined) out.hosts.push(home);
  return out;
}

/** The repo name of the `origin` (else first) remote in `.git/config`. */
export function remoteRepoName(configText: string): string | undefined {
  const urls = [...configText.matchAll(/\[remote "([^"]+)"\][^[]*?url\s*=\s*(\S+)/g)].map((m) => ({ remote: m[1] ?? "", url: m[2] ?? "" }));
  const url = (urls.find((u) => u.remote === "origin") ?? urls[0])?.url;
  const name = url?.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
  return name !== undefined && name !== "" ? name : undefined;
}

// ---- walking the repo -------------------------------------------------------------

interface Reader {
  read(rel: string): string | null;
  files: Set<string>;
  truncated: boolean;
}

function reader(root: string): Reader {
  const r: Reader = {
    files: new Set(),
    truncated: false,
    read(rel) {
      if (r.files.size >= MAX_FILES) {
        r.truncated = true;
        return null;
      }
      try {
        const abs = path.join(root, rel);
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > MAX_BYTES) return null;
        const text = fs.readFileSync(abs, "utf8");
        r.files.add(rel);
        return text;
      } catch {
        return null;
      }
    },
  };
  return r;
}

function readGitConfig(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    const st = fs.statSync(dotGit);
    let gitDir = dotGit;
    if (st.isFile()) {
      // Worktree: "gitdir: <main>/.git/worktrees/<name>"; the config is in the common dir.
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8").slice(0, 4096));
      if (m === null) return null;
      gitDir = path.resolve(root, (m[1] ?? "").trim());
      try {
        gitDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // not a linked worktree
      }
    }
    const config = path.join(gitDir, "config");
    return fs.statSync(config).size <= MAX_BYTES ? fs.readFileSync(config, "utf8") : null;
  } catch {
    return null;
  }
}

/** Every signal a repo carries; never throws, reads only the files listed in the header. */
export function collectRepoSignals(root: string, opts: { extraNames?: readonly string[] } = {}): RepoSignals {
  const abs = path.resolve(root);
  const rd = reader(abs);
  const claims: Evidence[] = [];
  const hosts = new Map<string, string>();
  const accountHints: RepoSignals["accountHints"] = [];
  const names = new Set<string>([path.basename(abs), ...(opts.extraNames ?? [])]);

  const take = (found: FileFindings, file: string): void => {
    claims.push(...found.claims);
    for (const h of found.hosts) if (hosts.size < MAX_HOSTS && !hosts.has(h)) hosts.set(h, file);
    for (const a of found.accountHints) accountHints.push({ ...a, file });
    for (const n of found.names ?? []) names.add(n);
  };
  const parse = (rel: string, fn: (text: string, file: string) => FileFindings): void => {
    const text = rd.read(rel);
    if (text !== null) {
      try {
        take(fn(text, rel), rel);
      } catch {
        // a malformed file is no evidence
      }
    }
  };
  const textHosts = (text: string): FileFindings => ({ ...none(), hosts: hostsInText(text) });

  const pkg = rd.read("package.json");
  if (pkg !== null) take(parsePackageJson(pkg), "package.json");
  const git = readGitConfig(abs);
  const remote = git !== null ? remoteRepoName(git) : undefined;
  if (remote !== undefined) names.add(remote);

  let dirs = 0;
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    if (++dirs > MAX_DIRS) {
      rd.truncated = true;
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(abs, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const join = (name: string): string => (rel === "" ? name : `${rel}/${name}`);
    for (const e of entries) {
      const f = join(e.name);
      if (e.isFile()) {
        if (WRANGLER.has(e.name)) parse(f, parseWrangler);
        else if (e.name === "fly.toml" || /^fly\.[A-Za-z0-9_-]+\.toml$/.test(e.name)) parse(f, parseFlyToml);
        else if (e.name === ".firebaserc") parse(f, parseFirebaserc);
        else if (e.name === "serverless.yml" || e.name === "serverless.yaml") parse(f, parseServerless);
        else if (e.name === "samconfig.toml") parse(f, parseSamconfig);
        else if (e.name === "vercel.json") parse(f, parseVercelJson);
        else if (e.name === "netlify.toml" || e.name === "CNAME" || COMPOSE.test(e.name) || ENV_EXAMPLE.some((re) => re.test(e.name))) parse(f, textHosts);
        else if (e.name === "railway.json" || e.name === "railway.toml") parse(f, () => none()); // noted: linked with `railway link` (the adapter tags it)
      } else if (e.isDirectory()) {
        if (e.name === ".do") {
          for (const spec of safeList(path.join(abs, f)).filter((n) => /\.ya?ml$/.test(n)).slice(0, 10)) parse(`${f}/${spec}`, parseDoAppSpec);
        } else if (e.name === ".vercel") {
          parse(`${f}/project.json`, parseVercelProject);
          parse(`${f}/repo.json`, parseVercelRepo);
        } else if (e.name === ".netlify") {
          parse(`${f}/state.json`, parseNetlifyState);
        } else if (e.name === "supabase") {
          parse(`${f}/config.toml`, parseSupabaseConfig);
          parse(`${f}/.temp/project-ref`, parseSupabaseRef);
        }
        // Link folders were read above; every other dot-folder (and dependency / build output) is skipped.
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
          queue.push({ rel: f, depth: depth + 1 });
        }
      }
    }
  }

  return {
    root: abs,
    files: [...rd.files].sort(),
    claims,
    hosts: [...hosts].map(([host, file]) => ({ host, file })),
    names: [...names].filter((n) => n.trim() !== ""),
    accountHints,
    truncated: rd.truncated,
  };
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}
