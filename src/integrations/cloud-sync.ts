// src/integrations/cloud-sync.ts — the project-independent half of a cloud
// sync (CONTRACTS.md §9): run providers' read-only listings side by side,
// stamp `observedAt`, redact errors, and say which providers failed outright
// (the watch loop backs those off). Also the change detection used for
// `cloud.updated` pushes and `ruah app cloud watch`. No daemon, no project,
// no files: the daemon (IntegrationsService) and the CLI both build on it.
import type { CloudResource, ProviderError } from "../contracts/integrations.js";
import { redact } from "./exec.js";
import type { CloudIntegration, CloudSyncOutcome, ProjectContext } from "./registry.js";

export interface ProvidersSyncResult {
  resources: CloudResource[];
  errors: ProviderError[];
  /** Providers that produced nothing but errors (thrown, or every listing failed). */
  failed: string[];
}

export type SyncOne = (provider: CloudIntegration, account: string | undefined, project: ProjectContext | null) => Promise<CloudSyncOutcome>;

const defaultSyncOne: SyncOne = (provider, account, project) => provider.sync({ ...(account !== undefined ? { account } : {}), project });

function message(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

export async function syncProviders(
  providers: readonly CloudIntegration[],
  /**
   * `project`: the repo a provider may read config from (§10: Cloudflare Workers, Railway link); null = none.
   * `accounts`: one named account per provider. `accountLists` (§14, a project's scope): several accounts
   * of a provider, each synced on its own (`undefined` = the selected / default account); `accounts` wins.
   */
  options: {
    accounts?: Readonly<Record<string, string>> | undefined;
    accountLists?: ReadonlyMap<string, readonly (string | undefined)[]> | null | undefined;
    now: Date;
    project?: ProjectContext | null;
    syncOne?: SyncOne;
  },
): Promise<ProvidersSyncResult> {
  const observedAt = options.now.toISOString();
  const syncOne = options.syncOne ?? defaultSyncOne;
  const resources: CloudResource[] = [];
  const errors: ProviderError[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  await Promise.all(
    providers.map(async (provider) => {
      const named = options.accounts?.[provider.id];
      const accounts = named !== undefined ? [named] : (options.accountLists?.get(provider.id) ?? [undefined]);
      const several = accounts.length > 1;
      let got = 0;
      let bad = 0;
      await Promise.all(
        accounts.map(async (account) => {
          const label = several ? `${account ?? "default"}: ` : "";
          try {
            const outcome = await syncOne(provider, account, options.project ?? null);
            for (const r of outcome.resources) {
              // The same resource seen from two accounts (shared team, same cluster) is listed once.
              if (seen.has(r.id)) continue;
              seen.add(r.id);
              resources.push({ ...r, observedAt, ...(account !== undefined ? { account } : {}) });
            }
            for (const e of outcome.errors) errors.push({ provider: provider.id, message: `${label}${redact(e)}` });
            got += outcome.resources.length;
            if (outcome.resources.length === 0 && outcome.errors.length > 0) bad += 1;
          } catch (err) {
            errors.push({ provider: provider.id, message: `${label}${message(err)}` });
            bad += 1;
          }
        }),
      );
      if (got === 0 && bad > 0) failed.push(provider.id);
    }),
  );
  return { resources, errors, failed };
}

/** What a viewer shows for a resource, minus the per-sync timestamp. */
function visible(r: CloudResource): unknown[] {
  return [r.id, r.name, r.status, r.health, r.healthDetail, r.replicas?.ready, r.replicas?.desired, r.pods?.running, r.pods?.pending,
    r.pods?.crashLoop, r.pods?.restarts, r.url, r.hosts, r.linkedNodeId, r.linkSource, r.region, r.tags, r.account, r.scope];
}

/** Stable fingerprint of a resource list (order-independent, ignores observedAt). */
export function cloudFingerprint(resources: readonly CloudResource[]): string {
  return resources.map((r) => JSON.stringify(visible(r))).sort().join("\n");
}

export interface ResourceChange {
  kind: "added" | "removed" | "changed";
  resource: CloudResource;
  /** Previous health/status for "changed". */
  before?: { health?: CloudResource["health"]; status?: string | undefined; healthDetail?: string | undefined };
}

/** Health/status transitions between two snapshots (for `ruah app cloud watch`). */
export function diffResources(before: readonly CloudResource[], after: readonly CloudResource[]): ResourceChange[] {
  const old = new Map(before.map((r) => [r.id, r]));
  const changes: ResourceChange[] = [];
  for (const r of after) {
    const prev = old.get(r.id);
    old.delete(r.id);
    if (prev === undefined) changes.push({ kind: "added", resource: r });
    else if (prev.health !== r.health || prev.status !== r.status || prev.healthDetail !== r.healthDetail) {
      changes.push({
        kind: "changed", resource: r,
        before: {
          ...(prev.health !== undefined ? { health: prev.health } : {}),
          ...(prev.status !== undefined ? { status: prev.status } : {}),
          ...(prev.healthDetail !== undefined ? { healthDetail: prev.healthDetail } : {}),
        },
      });
    }
  }
  for (const r of old.values()) changes.push({ kind: "removed", resource: r });
  return changes;
}
