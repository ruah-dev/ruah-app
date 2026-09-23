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
  const named = matchNodeByName(resource.name, nodes);
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
