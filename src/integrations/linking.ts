// src/integrations/linking.ts — which architecture element a cloud resource
// runs. Precedence: manual link (cloud.json, null = explicitly unlinked) >
// tag (`ruah:node=<id>` / `ruah-node=<id>`, or DO-style string tags
// `ruah:node:<id>` / `ruah-node:<id>`) > unique exact name match against node
// ids/names > unique normalized name match. Pure; re-applied on every read so
// architecture edits show up without a re-sync.
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

export function linkResource(
  resource: CloudResource,
  nodes: readonly ArchNode[],
  manualLinks: Readonly<Record<string, string | null>>,
): string | undefined {
  const ids = new Set(nodes.map((n) => n.id));
  if (Object.prototype.hasOwnProperty.call(manualLinks, resource.id)) {
    const manual = manualLinks[resource.id];
    return manual !== null && manual !== undefined && ids.has(manual) ? manual : undefined;
  }
  const tagged = nodeIdFromTags(resource.tags);
  if (tagged !== undefined && ids.has(tagged)) return tagged;
  return matchNodeByName(resource.name, nodes);
}

/** Returns copies with `linkedNodeId` set (or removed) for the given architecture. */
export function linkResources(
  resources: readonly CloudResource[],
  nodes: readonly ArchNode[],
  manualLinks: Readonly<Record<string, string | null>>,
): CloudResource[] {
  return resources.map((resource) => {
    const { linkedNodeId: _previous, ...rest } = resource;
    const linked = linkResource(rest, nodes, manualLinks);
    return linked !== undefined ? { ...rest, linkedNodeId: linked } : rest;
  });
}
