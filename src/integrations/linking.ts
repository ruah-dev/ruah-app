// src/integrations/linking.ts — which architecture element a cloud resource
// runs. Precedence: manual link (cloud.json, null = explicitly unlinked) >
// tag (`ruah:node=<id>` / `ruah-node=<id>`, or DO-style string tags
// `ruah:node:<id>` / `ruah-node:<id>`) > unique exact name match against node
// ids/names > unique normalized name match > (§11) an ambiguous name match
// narrowed to the one IaC node whose type fits > infrastructure-as-code hints
// (`infra.hints`: terraform address / Name tag, k8s namespace/name, …). Pure;
// re-applied on every read so architecture edits show up without a re-sync.
import type { ArchNode } from "../contracts/architecture.js";
import type { CloudResource } from "../contracts/integrations.js";

const TAG_KEYS = ["ruah:node", "ruah-node", "ruah_node"];

/** Lowercase, non-alphanumerics → "-", trimmed; "Invoices_API" → "invoices-api". */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Node id named by a resource's tags, if any. */
export function nodeIdFromTags(tags: Record<string, string> | undefined): string | undefined {
  if (tags === undefined) return undefined;
  for (const key of TAG_KEYS) {
    const value = tags[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  // String tags (DigitalOcean) arrive as { "<tag>": "" }; accept "ruah:node:<id>" / "ruah-node:<id>".
  for (const key of Object.keys(tags)) {
    for (const prefix of TAG_KEYS) {
      if (key.startsWith(`${prefix}:`) && key.length > prefix.length + 1) return key.slice(prefix.length + 1);
    }
  }
  return undefined;
}

function unique<T>(values: T[]): T | undefined {
  const set = [...new Set(values)];
  return set.length === 1 ? set[0] : undefined;
}

export function matchNodeByName(name: string, nodes: readonly ArchNode[]): string | undefined {
  const exact = unique(nodes.filter((n) => n.id === name || n.name === name).map((n) => n.id));
  if (exact !== undefined) return exact;
  const wanted = normalizeName(name);
  if (wanted.length === 0) return undefined;
  return unique(nodes.filter((n) => normalizeName(n.id) === wanted || normalizeName(n.name) === wanted).map((n) => n.id));
}

// Resource type → node types it can run as (CONTRACTS §11: IaC node types).
const COMPATIBLE: Record<string, readonly string[]> = {
  compute: ["service", "server", "container", "worker", "function", "frontend"],
  container: ["container", "service", "worker"],
  function: ["function", "service"],
  app: ["service", "container", "frontend", "function"],
  database: ["datastore", "database", "search"],
  cache: ["cache", "queue", "datastore"],
  queue: ["queue"],
  storage: ["storage", "datastore"],
  loadbalancer: ["loadbalancer", "gateway"],
  gateway: ["gateway", "loadbalancer"],
  cdn: ["cdn", "gateway"],
  dns: ["dns"],
  kubernetes: ["cluster", "container", "worker", "cloud"],
};

// Tag keys whose value names the workload / resource (AWS `Name`, Kubernetes app labels).
const NAME_TAGS = ["Name", "name", "app", "app.kubernetes.io/name", "app.kubernetes.io/instance", "k8s-app", "service"];

/**
 * CONTRACTS §11: infrastructure-as-code nodes carry `infra.hints` — names a
 * live resource may have (terraform address and `Name` tag, k8s
 * `namespace/name`, Helm release, host names). A resource whose name (or
 * name-like tag) matches the hints of exactly one node links to it; several
 * matches are narrowed to nodes whose type fits the resource type.
 */
export function matchNodeByInfraHints(resource: Pick<CloudResource, "name" | "type" | "tags">, nodes: readonly ArchNode[]): string | undefined {
  const tags = resource.tags ?? {};
  const names = [resource.name, ...NAME_TAGS.map((k) => tags[k]).filter((v): v is string => v !== undefined && v.trim() !== "")];
  const ns = tags.namespace ?? tags["kubernetes.io/namespace"];
  if (ns !== undefined) names.push(`${ns}/${resource.name}`);
  const withHints = nodes.filter((n) => (n.infra?.hints?.length ?? 0) > 0);
  if (withHints.length === 0) return undefined;
  const fits = (n: ArchNode): boolean => (COMPATIBLE[resource.type] ?? []).includes(n.type);
  const pick = (hits: ArchNode[]): string | undefined => {
    const ids = [...new Set(hits.map((n) => n.id))];
    if (ids.length === 1) return ids[0];
    const typed = [...new Set(hits.filter(fits).map((n) => n.id))];
    return typed.length === 1 ? typed[0] : undefined;
  };
  for (const exact of [true, false]) {
    for (const name of names) {
      const wanted = exact ? name : normalizeName(name);
      if (wanted === "") continue;
      const hits = withHints.filter((n) => (n.infra?.hints ?? []).some((h) => (exact ? h === wanted : normalizeName(h) === wanted)));
      if (hits.length === 0) continue;
      const id = pick(hits);
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

/** Exact / normalized name matches that are ambiguous, narrowed to the one IaC node whose type fits the resource. */
function preferInfraNode(resource: CloudResource, nodes: readonly ArchNode[]): string | undefined {
  const wanted = normalizeName(resource.name);
  if (wanted === "") return undefined;
  const hits = nodes.filter((n) => n.infra !== undefined && (n.id === resource.name || n.name === resource.name || normalizeName(n.name) === wanted));
  const typed = [...new Set(hits.filter((n) => (COMPATIBLE[resource.type] ?? []).includes(n.type)).map((n) => n.id))];
  return typed.length === 1 ? typed[0] : undefined;
}

export type LinkSource = "tag" | "name" | "manual";

/** The element a resource runs, and how that was decided (shown as auto/manual in the viewer). */
export function linkResourceWithSource(
  resource: CloudResource,
  nodes: readonly ArchNode[],
  manualLinks: Readonly<Record<string, string | null>>,
): { nodeId: string; source: LinkSource } | undefined {
  const ids = new Set(nodes.map((n) => n.id));
  if (Object.prototype.hasOwnProperty.call(manualLinks, resource.id)) {
    const manual = manualLinks[resource.id];
    return manual !== null && manual !== undefined && ids.has(manual) ? { nodeId: manual, source: "manual" } : undefined;
  }
  const tagged = nodeIdFromTags(resource.tags);
  if (tagged !== undefined && ids.has(tagged)) return { nodeId: tagged, source: "tag" };
  const named = matchNodeByName(resource.name, nodes) ?? preferInfraNode(resource, nodes) ?? matchNodeByInfraHints(resource, nodes);
  return named !== undefined ? { nodeId: named, source: "name" } : undefined;
}

export function linkResource(
  resource: CloudResource,
  nodes: readonly ArchNode[],
  manualLinks: Readonly<Record<string, string | null>>,
): string | undefined {
  return linkResourceWithSource(resource, nodes, manualLinks)?.nodeId;
}

/** Returns copies with `linkedNodeId` set (or removed) for the given architecture. */
export function linkResources(
  resources: readonly CloudResource[],
  nodes: readonly ArchNode[],
  manualLinks: Readonly<Record<string, string | null>>,
): CloudResource[] {
  return resources.map((resource) => {
    const { linkedNodeId: _previous, linkSource: _previousSource, ...rest } = resource;
    const linked = linkResourceWithSource(rest, nodes, manualLinks);
    return linked !== undefined ? { ...rest, linkedNodeId: linked.nodeId, linkSource: linked.source } : rest;
  });
}
