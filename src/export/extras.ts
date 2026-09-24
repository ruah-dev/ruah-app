// src/export/extras.ts — the integration data a draw.io export carries
// (CONTRACTS.md §6): cloud resources linked to elements and work items linked
// to elements. Read-only. Two sources:
//   - the running daemon's IntegrationsApi (live issue titles/status), with a timeout
//   - local files only (CLI): ~/.ruah/projects/<id>/cloud.json + <root>/.ruah/links.json
// Failures never fail the export; they become notes on the Specifications page.
import type { Architecture } from "../contracts/architecture.js";
import type { CloudResource, WorkItem } from "../contracts/integrations.js";
import type { IntegrationsApi } from "../integrations/index.js";
import { IntegrationsService } from "../integrations/index.js";
import { isWork } from "../integrations/registry.js";
import { linkResources } from "../integrations/linking.js";
import { applyScope, loadScopeUnits } from "../integrations/scope/index.js";
import { CloudCacheStore, readLinks } from "../integrations/store.js";
import type { DrawioOptions } from "./drawio.js";

export type ExportExtras = Pick<DrawioOptions, "cloud" | "issues" | "notes">;

const DEFAULT_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** From the daemon's integrations service (GET /api/export/drawio). */
export async function extrasFromService(api: IntegrationsApi | undefined, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExportExtras> {
  if (api === undefined) return { notes: ["integrations are not available in this daemon; cloud resources and issues are not included"] };
  const notes: string[] = [];
  const [cloud, work] = await Promise.allSettled([
    withTimeout(api.cloudResources(), timeoutMs, "cloud resources"),
    withTimeout(api.workItems({}), timeoutMs, "linked issues"),
  ]);
  let resources: CloudResource[] = [];
  if (cloud.status === "fulfilled") {
    // §14: in-scope resources only (resources without a scope come from an older daemon).
    resources = cloud.value.resources.filter((r) => r.scope === undefined || r.scope.in);
    if (cloud.value.syncedAt !== null) notes.push(`cloud resources as of the last sync (${cloud.value.syncedAt})`);
    for (const e of cloud.value.errors) notes.push(`cloud sync error (${e.provider}): ${e.message}`);
  } else {
    notes.push(`cloud resources unavailable: ${msg(cloud.reason)}`);
  }
  let items: WorkItem[] = [];
  if (work.status === "fulfilled") {
    items = work.value.items;
    for (const e of work.value.errors ?? []) notes.push(`issues from ${e.provider} unavailable (links kept, status unknown): ${e.message}`);
  } else {
    notes.push(`linked issues unavailable: ${msg(work.reason)}`);
  }
  return { cloud: resources, issues: items, notes };
}

/** From local files only (CLI export): no network, no provider CLIs. */
export function extrasFromDisk(root: string, arch: Architecture, home: string): ExportExtras {
  const notes: string[] = [];
  let cloud: CloudResource[] = [];
  try {
    const cache = new CloudCacheStore(home).read(root);
    // §14: only the project's resources (its cloud scope), like the Cloud page and the map.
    const linked = linkResources(cache.resources, arch.nodes, cache.manualLinks);
    cloud = applyScope({ units: loadScopeUnits(root), resources: linked, nodes: arch.nodes, manualLinks: cache.manualLinks }).filter((r) => r.scope?.in === true);
    if (cache.syncedAt !== null) notes.push(`cloud resources from the cached sync of ${cache.syncedAt}`);
  } catch (err) {
    notes.push(`cloud cache unreadable: ${msg(err)}`);
  }
  let issues: WorkItem[] = [];
  try {
    const links = readLinks(root);
    if (links.length > 0) {
      // URLs from the providers' own rules (Jira site from ~/.ruah/integrations.json, GitHub owner/repo#n); no fetch.
      const registry = new IntegrationsService({ home, project: () => ({ root, architecture: arch }) }).registry;
      const byItem = new Map<string, WorkItem>();
      for (const l of links) {
        const key = `${l.provider}\u0000${l.itemId}`;
        let item = byItem.get(key);
        if (item === undefined) {
          const provider = registry.get(l.provider);
          let url = "";
          try {
            url = provider !== undefined && isWork(provider) ? provider.urlFor(l.itemId, { root }) : "";
          } catch {
            url = "";
          }
          item = { id: l.itemId, provider: l.provider, title: l.itemId, status: "not fetched", url, updatedAt: new Date(0).toISOString(), linkedNodeIds: [] };
          byItem.set(key, item);
        }
        if (!item.linkedNodeIds.includes(l.nodeId)) item.linkedNodeIds.push(l.nodeId);
      }
      issues = [...byItem.values()];
      notes.push("issue titles and status are not fetched by the CLI export (links from .ruah/links.json); export from the app for live status");
    }
  } catch (err) {
    notes.push(`links file unreadable: ${msg(err)}`);
  }
  return { cloud, issues, notes };
}
