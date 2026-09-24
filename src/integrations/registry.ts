// src/integrations/registry.ts — the plugin surface. Every provider is an
// adapter implementing `Integration` (info/connect/disconnect); cloud and
// work providers add their read (and, for work items, create) operations.
// The registry is the only place that knows which providers exist.
import type {
  CloudResource,
  ConnectBody,
  IntegrationFamily,
  IntegrationInfo,
  WorkItem,
} from "../contracts/integrations.js";
import { AzureIntegration } from "./cloud/azure.js";
import type { CliCloudDeps } from "./cloud/cli-kit.js";
import { CloudflareIntegration } from "./cloud/cloudflare.js";
import { FlyIntegration } from "./cloud/fly.js";
import { GcpIntegration } from "./cloud/gcp.js";
import { RailwayIntegration } from "./cloud/railway.js";

export interface ProjectContext {
  root: string;
}

export interface Integration {
  readonly id: string;
  readonly family: IntegrationFamily;
  readonly name: string;
  /** Current status; cheap enough to call on every GET /api/integrations. */
  info(project: ProjectContext | null): Promise<IntegrationInfo>;
  /** Picks an account / stores credentials; validates before storing anything. */
  connect(body: ConnectBody, project: ProjectContext | null): Promise<IntegrationInfo>;
  /** Removes the stored token/selection (never logs out of a provider CLI). */
  disconnect(project: ProjectContext | null): Promise<IntegrationInfo>;
}

export interface CloudSyncOutcome {
  resources: CloudResource[];
  /** Per-service failures; a partial result is still a result. */
  errors: string[];
}

export interface CloudIntegration extends Integration {
  readonly family: "cloud";
  /** Read-only listing of everything the account can see. `project` (optional) lets a provider read repo config (§10: Cloudflare Workers, Railway link). */
  sync(options: { account?: string; project?: ProjectContext | null }): Promise<CloudSyncOutcome>;
  /** False when the user disconnected it in Ruah (sync skips it unless named). */
  enabled(): boolean;
}

export interface WorkCreateInput {
  title: string;
  body: string;
  projectKey?: string;
  repo?: string;
  issueType?: string;
}

/** Work items without linkedNodeIds; the service fills those from links.json. */
export type WorkItemData = Omit<WorkItem, "linkedNodeIds">;

export interface WorkIntegration extends Integration {
  readonly family: "work";
  enabled(project: ProjectContext | null): Promise<boolean>;
  search(query: string, project: ProjectContext | null): Promise<WorkItemData[]>;
  /** Fetch specific items by id (for linked items); missing ones are omitted. */
  get(ids: readonly string[], project: ProjectContext | null): Promise<WorkItemData[]>;
  /** The only state-changing call; reached only from POST /api/work/create. */
  create(input: WorkCreateInput, project: ProjectContext | null): Promise<WorkItemData>;
  /** Best-effort URL for an id when the item cannot be fetched. */
  urlFor(id: string, project: ProjectContext | null): string;
}

export function isCloud(integration: Integration): integration is CloudIntegration {
  return integration.family === "cloud";
}
export function isWork(integration: Integration): integration is WorkIntegration {
  return integration.family === "work";
}

export class IntegrationRegistry {
  private readonly byId = new Map<string, Integration>();

  register(integration: Integration): this {
    if (this.byId.has(integration.id)) throw new Error(`integration already registered: ${integration.id}`);
    this.byId.set(integration.id, integration);
    return this;
  }

  get(id: string): Integration | undefined {
    return this.byId.get(id);
  }

  all(): Integration[] {
    return [...this.byId.values()];
  }

  cloud(): CloudIntegration[] {
    return this.all().filter(isCloud);
  }

  work(): WorkIntegration[] {
    return this.all().filter(isWork);
  }
}

// ---- cloud providers batch B (CONTRACTS.md §10) ------------------------------
// Standalone CLI adapters: each needs only a Runner + SettingsStore, so the
// same set works inside the daemon and from a CLI command with no project.

/** Google Cloud, Azure, Cloudflare, Railway and Fly.io, in display order. */
export function cloudBatchB(deps: CliCloudDeps): CloudIntegration[] {
  return [
    new GcpIntegration(deps),
    new AzureIntegration(deps),
    new CloudflareIntegration(deps),
    new RailwayIntegration(deps),
    new FlyIntegration(deps),
  ];
}

export function registerCloudBatchB(registry: IntegrationRegistry, deps: CliCloudDeps): IntegrationRegistry {
  for (const integration of cloudBatchB(deps)) registry.register(integration);
  return registry;
}
