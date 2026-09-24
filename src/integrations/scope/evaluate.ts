// src/integrations/scope/evaluate.ts — decides, per cloud resource, whether it
// belongs to the open project and why (CONTRACTS.md §14). Pure: resources,
// repo signals, the architecture and the scope files in; a ResourceScope per
// resource out. No I/O, no tokens.
//
//   manual  — `.ruah/cloud.json`: include ("added by you"), a whole account,
//             exclude ("removed by you", wins over everything)
//   proof   — provider link files, infrastructure-as-code declarations,
//             `project=` / `ruah-project=` tags and labels, a Kubernetes
//             namespace the repo's manifests declare, `ruah:node` tags and
//             manual element links
//   likely  — host names the repo mentions, looser IaC / link-file matches
//   weak    — the name looks like the project's (a suggestion only)
//
// In scope = manual include / whole account + proof + likely − exclude.
// Children follow their parent (a Vercel deployment its project, a Supabase
// function its project, a Fly volume its app).
import type { ArchNode } from "../../contracts/architecture.js";
import type { CloudResource, ResourceScope, ScopeConfidence } from "../../contracts/integrations.js";
import { linkResourceWithSource, normalizeName } from "../linking.js";
import type { ScopeConfig } from "./file.js";
import { GENERIC_NAMES, squash, type Claim, type RepoSignals } from "./signals.js";

export interface ScopeUnit {
  /** System repo id; absent = the project (or system) folder itself. */
  repo?: string;
  root: string;
  config: ScopeConfig;
  signals: RepoSignals;
  /** The system folder of a multi-repo system: its excludes win over every repo's evidence. */
  system?: boolean;
}

export interface EvaluateInput {
  units: readonly ScopeUnit[];
  resources: readonly CloudResource[];
  nodes: readonly ArchNode[];
  manualLinks?: Readonly<Record<string, string | null>>;
  /** Ruah project ids (`ruah-project=<id>` tags). */
  projectIds?: readonly string[];
}

interface Hit {
  confidence: ScopeConfidence;
  reason: string;
}

const RANK: Record<ScopeConfidence, number> = { manual: 0, proof: 1, likely: 2, weak: 3 };
const IN_SCOPE = (c: ScopeConfidence): boolean => c !== "weak";

/** Providers whose `tags` are user labels (not provider-internal parents like Vercel's `project`). */
const LABEL_PROVIDERS = new Set(["digitalocean", "aws", "gcp", "azure", "hetzner", "kubernetes"]);
const RUAH_PROJECT_KEYS = ["ruah-project", "ruah:project", "ruah_project"];
const PROJECT_KEYS = ["project", "Project", "PROJECT", "app.kubernetes.io/part-of", "part-of"];

/** Terraform resource type prefix → cloud provider id. */
const TF_PROVIDER: [string, string][] = [
  ["aws_", "aws"], ["google_", "gcp"], ["azurerm_", "azure"], ["digitalocean_", "digitalocean"], ["cloudflare_", "cloudflare"],
  ["hcloud_", "hetzner"], ["vercel_", "vercel"], ["supabase_", "supabase"], ["netlify_", "netlify"], ["fly_", "fly"],
  ["railway_", "railway"], ["kubernetes_", "kubernetes"], ["helm_", "kubernetes"],
];
const K8S_TOOLS = new Set(["kubernetes", "kustomize", "helm"]);

function tfProvider(kind: string): string | undefined {
  return TF_PROVIDER.find(([prefix]) => kind.startsWith(prefix))?.[1];
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const bareHost = (h: string): string => h.toLowerCase().replace(/^www\./, "");

/** Host names a resource answers on: its URL, hosts, and (DNS zones) its own name. */
export function resourceHosts(r: CloudResource): string[] {
  const out = new Set<string>();
  const u = hostOf(r.url);
  if (u !== undefined) out.add(u);
  for (const h of r.hosts ?? []) if (/[a-z]/i.test(h)) out.add(h.toLowerCase());
  return [...out];
}

export function claimMatches(claim: Claim, r: CloudResource): boolean {
  if (claim.provider !== undefined && claim.provider !== r.provider) return false;
  switch (claim.kind) {
    case "id":
      return r.id === claim.id;
    case "idPart":
      return r.id.includes(claim.part);
    case "name": {
      const serviceOk = claim.services === undefined || claim.services.some((s) => r.service === s || r.service.startsWith(`${s}/`));
      return serviceOk && (r.name === claim.name || (r.type === "dns" && r.name.toLowerCase() === claim.name.toLowerCase()));
    }
    case "namePrefix":
      return r.name.length > claim.prefix.length && r.name.startsWith(claim.prefix);
    case "tag": {
      const v = r.tags?.[claim.key];
      return v !== undefined && (claim.prefix === true ? v.startsWith(claim.value) : v === claim.value);
    }
  }
}

/** A name that says something (not "api", not 3 letters). */
function meaningful(name: string): boolean {
  const sq = squash(name);
  return sq.length >= 4 && !GENERIC_NAMES.has(name.toLowerCase()) && !GENERIC_NAMES.has(sq);
}

// ---- per-unit evidence ------------------------------------------------------------

interface UnitContext {
  unit: ScopeUnit;
  names: string[]; // squashed, meaningful
  projectIds: Set<string>;
  hosts: Map<string, string>; // bare host → where it was seen
  nodes: readonly ArchNode[];
  hintsExact: Map<string, ArchNode[]>;
  hintsNorm: Map<string, ArchNode[]>;
  namespaces: Map<string, string>; // declared namespace → file
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function unitContext(unit: ScopeUnit, allNodes: readonly ArchNode[], projectIds: readonly string[], multi: boolean): UnitContext {
  // In a system, a unit owns the nodes of its repo; the system folder owns the rest.
  const nodes = multi ? allNodes.filter((n) => (unit.system === true ? n.repo === undefined : n.repo === unit.repo)) : allNodes;
  const names = [...new Set([...unit.signals.names, ...(unit.config.name !== undefined ? [unit.config.name] : [])].filter(meaningful).map(squash))];
  const hosts = new Map<string, string>();
  for (const h of unit.signals.hosts) hosts.set(bareHost(h.host), h.file);
  const hintsExact = new Map<string, ArchNode[]>();
  const hintsNorm = new Map<string, ArchNode[]>();
  const namespaces = new Map<string, string>();
  for (const n of nodes) {
    const infra = n.infra;
    if (infra === undefined) continue;
    const where = infra.source?.[0]?.replace(/:\d+$/, "") ?? n.path ?? infra.tool;
    for (const h of infra.hints ?? []) {
      push(hintsExact, h, n);
      const norm = normalizeName(h);
      if (norm !== "") push(hintsNorm, norm, n);
    }
    for (const h of (infra.settings?.hosts ?? "").split(/[,\s]+/)) {
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !hosts.has(bareHost(h))) hosts.set(bareHost(h), where);
    }
    if (K8S_TOOLS.has(infra.tool)) {
      const ns = infra.settings?.namespace ?? /^([a-z0-9-]+)\/[A-Za-z]+\//.exec(infra.address ?? "")?.[1];
      if (ns !== undefined && ns !== "default" && ns !== "") namespaces.set(ns, where);
    }
  }
  return { unit, names, projectIds: new Set(projectIds), hosts, nodes, hintsExact, hintsNorm, namespaces };
}

function tagHits(r: CloudResource, ctx: UnitContext): Hit[] {
  if (!LABEL_PROVIDERS.has(r.provider) || r.tags === undefined) return [];
  const out: Hit[] = [];
  const matchesProject = (value: string): boolean => ctx.projectIds.has(value) || (meaningful(value) && ctx.names.includes(squash(value)));
  for (const [rawKey, rawValue] of Object.entries(r.tags)) {
    // DigitalOcean string tags arrive as { "<tag>": "" }; "project:acme" is key "project", value "acme".
    let key = rawKey;
    let value = rawValue;
    if (value === "" && rawKey.includes(":")) {
      const i = rawKey.lastIndexOf(":");
      key = rawKey.slice(0, i);
      value = rawKey.slice(i + 1);
    }
    if (value === "") {
      if (meaningful(rawKey) && ctx.names.includes(squash(rawKey))) out.push({ confidence: "likely", reason: `tag ${rawKey}` });
      continue;
    }
    if (RUAH_PROJECT_KEYS.includes(key) && matchesProject(value)) out.push({ confidence: "proof", reason: `tag ${key}=${value}` });
    else if (PROJECT_KEYS.includes(key) && matchesProject(value)) out.push({ confidence: "proof", reason: `${r.provider === "kubernetes" ? "label" : "tag"} ${key}=${value}` });
  }
  return out;
}

function iacHits(r: CloudResource, ctx: UnitContext): Hit[] {
  if (ctx.hintsExact.size === 0) return [];
  const out: Hit[] = [];
  const fits = (n: ArchNode): boolean => {
    const infra = n.infra!;
    if (infra.tool === "terraform") return tfProvider(infra.kind) === r.provider;
    return K8S_TOOLS.has(infra.tool) && r.provider === "kubernetes";
  };
  const label = (n: ArchNode): string => {
    const infra = n.infra!;
    const tool = infra.tool === "terraform" ? "Terraform" : infra.tool === "helm" ? "Helm" : "Kubernetes manifests";
    return `in ${tool}${infra.address !== undefined ? ` (${infra.address})` : ""}`;
  };
  if (r.provider === "kubernetes" && r.region !== undefined) {
    const hit = (ctx.hintsExact.get(`${r.region}/${r.name}`) ?? []).find(fits);
    if (hit !== undefined) return [{ confidence: "proof", reason: label(hit) }];
  }
  const exact = (ctx.hintsExact.get(r.name) ?? []).find(fits);
  if (exact !== undefined) {
    // A bare workload name ("api") is only likely: the same name runs in other clusters too.
    const strong = r.provider !== "kubernetes" && meaningful(r.name);
    out.push({ confidence: strong ? "proof" : "likely", reason: label(exact) });
    return out;
  }
  const norm = normalizeName(r.name);
  const loose = norm !== "" && meaningful(r.name) ? (ctx.hintsNorm.get(norm) ?? []).find(fits) : undefined;
  if (loose !== undefined) out.push({ confidence: "likely", reason: `${label(loose)}, similar name` });
  return out;
}

function hostHits(r: CloudResource, ctx: UnitContext): Hit[] {
  if (ctx.hosts.size === 0) return [];
  for (const h of resourceHosts(r)) {
    const file = ctx.hosts.get(bareHost(h));
    if (file !== undefined) return [{ confidence: "likely", reason: `host ${bareHost(h)} in ${file}` }];
  }
  if (r.type === "dns") {
    const zone = r.name.toLowerCase().replace(/\.$/, "");
    for (const [h, file] of ctx.hosts) if (h === zone || h.endsWith(`.${zone}`)) return [{ confidence: "likely", reason: `domain of ${h} (${file})` }];
  }
  return [];
}

function nameHits(r: CloudResource, ctx: UnitContext): Hit[] {
  if (!meaningful(r.name)) return [];
  const rn = squash(r.name);
  for (const n of ctx.names) {
    if (rn === n || (n.length >= 5 && rn.includes(n)) || (rn.length >= 5 && n.includes(rn))) return [{ confidence: "weak", reason: `name looks like ${n}` }];
  }
  return [];
}

function linkHits(r: CloudResource, ctx: UnitContext, manualLinks: Readonly<Record<string, string | null>>): Hit[] {
  const linked = linkResourceWithSource(r, ctx.nodes, manualLinks);
  if (linked === undefined) return [];
  const node = ctx.nodes.find((n) => n.id === linked.nodeId);
  const name = node?.name ?? linked.nodeId;
  if (linked.source === "manual") return [{ confidence: "proof", reason: `linked to ${name} by you` }];
  if (linked.source === "tag") return [{ confidence: "proof", reason: `tag ruah:node=${linked.nodeId}` }];
  // A name match to a code element ("api" ↔ api) is common across clients: a suggestion only.
  if (node?.infra === undefined && meaningful(r.name)) return [{ confidence: "weak", reason: `same name as element ${name}` }];
  return [];
}

/** The resource a child belongs to (deployment → project, function → project, volume → app). */
function parentKey(r: CloudResource): { id?: string; provider: string; name?: string } | undefined {
  if (r.provider === "supabase") {
    const fn = /^supabase:function:([^:]+):/.exec(r.id);
    if (fn !== null) return { provider: "supabase", id: `supabase:project:${fn[1]}` };
    if (r.service === "branch" && r.tags?.project !== undefined) return { provider: "supabase", name: r.tags.project };
  }
  if (r.provider === "vercel" && r.service === "deployment" && r.tags?.project !== undefined) return { provider: "vercel", name: r.tags.project };
  if (r.provider === "fly" && r.service === "fly/volume" && r.tags?.app !== undefined) return { provider: "fly", id: `fly:app:${r.tags.app}` };
  return undefined;
}

const PARENT_SERVICES: Record<string, string> = { supabase: "project", vercel: "project" };

function evaluateUnit(input: EvaluateInput, ctx: UnitContext): Map<string, { hits: Hit[]; excluded: boolean }> {
  const { unit } = ctx;
  const manualLinks = input.manualLinks ?? {};
  const include = new Set(unit.config.include.map((r) => r.id));
  const exclude = new Set(unit.config.exclude.map((r) => r.id));
  const out = new Map<string, { hits: Hit[]; excluded: boolean }>();

  for (const r of input.resources) {
    const hits: Hit[] = [];
    if (include.has(r.id)) hits.push({ confidence: "manual", reason: "added by you" });
    for (const a of unit.config.accounts) {
      if (a.whole === true && a.provider === r.provider && a.account === r.account) {
        hits.push({ confidence: "manual", reason: `in account ${a.account ?? "(default)"}` });
      }
    }
    for (const e of unit.signals.claims) if (claimMatches(e.claim, r)) hits.push({ confidence: e.confidence, reason: e.reason });
    // The Railway adapter tags the project the (system) folder is `railway link`ed to.
    if (r.provider === "railway" && r.tags?.["railway-link"] !== undefined && (unit.system === true || input.units.length === 1)) {
      hits.push({ confidence: "proof", reason: "from railway link" });
    }
    hits.push(...linkHits(r, ctx, manualLinks), ...tagHits(r, ctx));
    if (r.provider === "kubernetes" && r.region !== undefined && ctx.namespaces.has(r.region)) {
      hits.push({ confidence: "proof", reason: `namespace ${r.region} (${ctx.namespaces.get(r.region)})` });
    }
    hits.push(...iacHits(r, ctx), ...hostHits(r, ctx), ...nameHits(r, ctx));
    out.set(r.id, { hits, excluded: exclude.has(r.id) });
  }

  // Children follow their parent's strongest in-scope evidence.
  const byName = new Map<string, CloudResource>();
  for (const r of input.resources) if (PARENT_SERVICES[r.provider] === r.service) byName.set(`${r.provider}\u0000${r.name}`, r);
  for (const r of input.resources) {
    const key = parentKey(r);
    if (key === undefined) continue;
    const parent = key.id !== undefined ? input.resources.find((p) => p.id === key.id) : byName.get(`${key.provider}\u0000${key.name ?? ""}`);
    if (parent === undefined) continue;
    const p = out.get(parent.id);
    if (p === undefined || p.excluded) continue;
    const best = strongest(p.hits);
    if (best === undefined) continue;
    out.get(r.id)!.hits.push({ confidence: best.confidence === "manual" ? "proof" : best.confidence, reason: `part of ${parent.name}` });
  }
  return out;
}

function strongest(hits: readonly Hit[]): Hit | undefined {
  let best: Hit | undefined;
  for (const h of hits) if (best === undefined || RANK[h.confidence] < RANK[best.confidence]) best = h;
  return best;
}

function orderedReasons(hits: readonly Hit[], prefix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of [...hits].sort((a, b) => RANK[a.confidence] - RANK[b.confidence])) {
    const text = `${prefix}${h.reason}`;
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out.slice(0, 6);
}

/**
 * The project's scope of every resource. A multi-repo system is the union of
 * its repos' scopes (reasons prefixed "<repo>: "); the system folder's own
 * `exclude` wins over every repo.
 */
export function evaluateScope(input: EvaluateInput): Map<string, ResourceScope> {
  const multi = input.units.length > 1;
  const perUnit = input.units.map((unit) => ({ unit, result: evaluateUnit(input, unitContext(unit, input.nodes, input.projectIds ?? [], multi)) }));
  const systemExclude = new Set(input.units.filter((u) => u.system === true).flatMap((u) => u.config.exclude.map((r) => r.id)));
  const scopes = new Map<string, ResourceScope>();
  for (const r of input.resources) {
    if (systemExclude.has(r.id)) {
      scopes.set(r.id, { in: false, confidence: "manual", reasons: ["removed by you"], excluded: true });
      continue;
    }
    const inHits: string[] = [];
    const otherHits: string[] = [];
    let best: ScopeConfidence | undefined;
    let inBest: ScopeConfidence | undefined;
    let excluded = false;
    for (const { unit, result } of perUnit) {
      const entry = result.get(r.id);
      if (entry === undefined) continue;
      const prefix = multi && unit.repo !== undefined ? `${unit.repo}: ` : "";
      if (entry.excluded) {
        excluded = true;
        continue;
      }
      const top = strongest(entry.hits);
      if (top === undefined) continue;
      if (best === undefined || RANK[top.confidence] < RANK[best]) best = top.confidence;
      if (IN_SCOPE(top.confidence)) {
        if (inBest === undefined || RANK[top.confidence] < RANK[inBest]) inBest = top.confidence;
        inHits.push(...orderedReasons(entry.hits.filter((h) => IN_SCOPE(h.confidence)), prefix));
      } else {
        otherHits.push(...orderedReasons(entry.hits, prefix));
      }
    }
    if (inBest !== undefined) {
      scopes.set(r.id, { in: true, confidence: inBest, reasons: [...new Set(inHits)].slice(0, 6) });
    } else if (excluded) {
      scopes.set(r.id, { in: false, confidence: "manual", reasons: ["removed by you"], excluded: true });
    } else {
      scopes.set(r.id, best !== undefined ? { in: false, confidence: best, reasons: [...new Set(otherHits)].slice(0, 6) } : { in: false, reasons: [] });
    }
  }
  return scopes;
}
