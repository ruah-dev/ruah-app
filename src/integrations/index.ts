// src/integrations/index.ts — IntegrationsService: the §6 API behind the HTTP
// handler. Owns the registry (DigitalOcean, AWS, Jira, GitHub, ruah), the
// per-project cloud cache and the committable links file, and applies the
// cloud→element linking on every read. The current project comes from a
// callback so project switching (§5) needs no rewiring.
import type { Architecture } from "../contracts/architecture.js";
import type {
  CloudLinkBody,
  CloudResource,
  CloudSyncBody,
  CloudSyncResult,
  ConnectBody,
  IntegrationInfo,
  ProviderError,
  RuahTaskAction,
  RuahTaskBody,
  WorkCreateBody,
  WorkItem,
  WorkLinkBody,
} from "../contracts/integrations.js";
import { AwsIntegration } from "./cloud/aws.js";
import { DigitalOceanIntegration } from "./cloud/digitalocean.js";
import { defaultRunner, IntegrationError, redact, type Runner } from "./exec.js";
import { Keychain, type SecretStore } from "./keychain.js";
import { linkResources } from "./linking.js";
import { IntegrationRegistry, isCloud, isWork, registerCloudBatchB, type ProjectContext, type WorkIntegration, type WorkItemData } from "./registry.js";
import { RuahIntegration, type Launcher } from "./ruah.js";
import { CloudCacheStore, readLinks, SettingsStore, updateLink } from "./store.js";
import { GitHubIntegration } from "./work/github.js";
import { JiraIntegration } from "./work/jira.js";

export { IntegrationError } from "./exec.js";
export { IntegrationRegistry } from "./registry.js";

export interface CurrentProject {
  root: string;
  architecture: Architecture | null;
}

export interface IntegrationsApi {
  list(): Promise<{ integrations: IntegrationInfo[] }>;
  connect(id: string, body: ConnectBody): Promise<IntegrationInfo>;
  disconnect(id: string): Promise<IntegrationInfo>;
  cloudSync(body: CloudSyncBody): Promise<CloudSyncResult>;
  cloudResources(): Promise<CloudSyncResult>;
  cloudLink(body: CloudLinkBody): Promise<{ ok: true }>;
  workItems(query: { nodeId?: string; q?: string; provider?: string }): Promise<{ items: WorkItem[]; errors?: ProviderError[] }>;
  workLink(body: WorkLinkBody): Promise<{ ok: true }>;
  workCreate(body: WorkCreateBody): Promise<WorkItem>;
  ruahStatus(): Promise<unknown>;
  ruahTask(body: RuahTaskBody): Promise<unknown>;
  ruahTaskAction(name: string, action: RuahTaskAction): Promise<unknown>;
  ruahWorkflows(): Promise<unknown>;
  ruahWorkflowRun(name: string): Promise<unknown>;
}

export interface IntegrationsOptions {
  /** $RUAH_HOME (~/.ruah). */
  home: string;
  project: () => CurrentProject | null;
  runner?: Runner;
  secrets?: SecretStore;
  fetch?: typeof fetch;
  launch?: Launcher;
  now?: () => Date;
  /** Override the provider set (tests). */
  registry?: IntegrationRegistry;
  ruah?: RuahIntegration;
}

const ITEM_ID_RE = /^[A-Za-z0-9._/#-]{1,300}$/;
const MAX_LINKED_ITEMS = 100;
const LIST_CACHE_MS = 15_000;

function message(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

export class IntegrationsService implements IntegrationsApi {
  readonly registry: IntegrationRegistry;
  readonly ruah: RuahIntegration;
  private readonly cloudCache: CloudCacheStore;
  private readonly now: () => Date;
  private listCache: { at: number; root: string | null; value: { integrations: IntegrationInfo[] } } | undefined;

  constructor(private readonly options: IntegrationsOptions) {
    const runner = options.runner ?? defaultRunner;
    const settings = new SettingsStore(options.home);
    this.ruah = options.ruah ?? new RuahIntegration({ runner, home: options.home, ...(options.launch !== undefined ? { launch: options.launch } : {}) });
    this.registry =
      options.registry ??
      new IntegrationRegistry()
        .register(new DigitalOceanIntegration({ runner, settings }))
        .register(new AwsIntegration({ runner, settings }))
        .register(new JiraIntegration({ settings, secrets: options.secrets ?? new Keychain({ runner }), ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) }))
        .register(new GitHubIntegration({ runner, settings }));
    if (options.registry === undefined) registerCloudBatchB(this.registry, { runner, settings });
    if (this.registry.get(this.ruah.id) === undefined) this.registry.register(this.ruah);
    this.cloudCache = new CloudCacheStore(options.home);
    this.now = options.now ?? (() => new Date());
  }

  private context(): ProjectContext | null {
    const project = this.options.project();
    return project !== null ? { root: project.root } : null;
  }

  private requireProject(): CurrentProject {
    const project = this.options.project();
    if (project === null) throw new IntegrationError(409, "no project open");
    return project;
  }

  private nodes(project: CurrentProject | null): Architecture["nodes"] {
    return project?.architecture?.nodes ?? [];
  }

  private integration(id: string): NonNullable<ReturnType<IntegrationRegistry["get"]>> {
    const integration = this.registry.get(id);
    if (integration === undefined) throw new IntegrationError(404, `unknown integration: ${id}`);
    return integration;
  }

  private workProvider(id: string): WorkIntegration {
    const integration = this.integration(id);
    if (!isWork(integration)) throw new IntegrationError(400, `${id} is not a work-item integration`);
    return integration;
  }

  // ---- integrations ------------------------------------------------------------

  async list(): Promise<{ integrations: IntegrationInfo[] }> {
    // Each info() spawns CLIs (some hit the network); a short cache keeps a polling viewer cheap.
    const root = this.options.project()?.root ?? null;
    const cached = this.listCache;
    if (cached !== undefined && cached.root === root && this.now().getTime() - cached.at < LIST_CACHE_MS) return cached.value;
    const value = await this.listFresh();
    this.listCache = { at: this.now().getTime(), root, value };
    return value;
  }

  private async listFresh(): Promise<{ integrations: IntegrationInfo[] }> {
    const ctx = this.context();
    const integrations = await Promise.all(
      this.registry.all().map((i) =>
        i.info(ctx).catch((err: unknown): IntegrationInfo => ({ id: i.id, family: i.family, name: i.name, status: "error", detail: message(err) })),
      ),
    );
    return { integrations };
  }

  async connect(id: string, body: ConnectBody): Promise<IntegrationInfo> {
    this.listCache = undefined;
    return this.integration(id).connect(body, this.context());
  }

  async disconnect(id: string): Promise<IntegrationInfo> {
    this.listCache = undefined;
    return this.integration(id).disconnect(this.context());
  }

  // ---- cloud --------------------------------------------------------------------

  async cloudSync(body: CloudSyncBody): Promise<CloudSyncResult> {
    const project = this.requireProject();
    const wanted = body.providers;
    const providers = wanted !== undefined
      ? wanted.map((id) => {
          const integration = this.integration(id);
          if (!isCloud(integration)) throw new IntegrationError(400, `${id} is not a cloud integration`);
          return integration;
        })
      : this.registry.cloud().filter((c) => c.enabled());
    const errors: ProviderError[] = [];
    const fresh: CloudResource[] = [];
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const account = body.accounts?.[provider.id];
          const outcome = await provider.sync({ ...(account !== undefined ? { account } : {}), project: { root: project.root } });
          fresh.push(...outcome.resources);
          for (const e of outcome.errors) errors.push({ provider: provider.id, message: redact(e) });
        } catch (err) {
          errors.push({ provider: provider.id, message: message(err) });
        }
      }),
    );
    const synced = new Set(providers.map((p) => p.id));
    const cache = this.cloudCache.read(project.root);
    const kept = cache.resources.filter((r) => !synced.has(r.provider));
    const resources = linkResources([...kept, ...fresh], this.nodes(project), cache.manualLinks).sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    );
    const syncedAt = this.now().toISOString();
    const keptErrors = cache.errors.filter((e) => !synced.has(e.provider));
    this.cloudCache.write(project.root, { ...cache, syncedAt, resources, errors: [...keptErrors, ...errors] });
    return { resources, syncedAt, errors: [...keptErrors, ...errors] };
  }

  async cloudResources(): Promise<CloudSyncResult> {
    const project = this.options.project();
    if (project === null) return { resources: [], syncedAt: null, errors: [] };
    const cache = this.cloudCache.read(project.root);
    return {
      resources: linkResources(cache.resources, this.nodes(project), cache.manualLinks),
      syncedAt: cache.syncedAt,
      errors: cache.errors,
    };
  }

  async cloudLink(body: CloudLinkBody): Promise<{ ok: true }> {
    const project = this.requireProject();
    if (body.nodeId !== null && !this.nodes(project).some((n) => n.id === body.nodeId)) {
      throw new IntegrationError(400, `unknown element: ${body.nodeId}`);
    }
    const cache = this.cloudCache.read(project.root);
    if (!cache.resources.some((r) => r.id === body.resourceId)) throw new IntegrationError(404, "unknown resource (sync first)");
    cache.manualLinks[body.resourceId] = body.nodeId;
    cache.resources = linkResources(cache.resources, this.nodes(project), cache.manualLinks);
    this.cloudCache.write(project.root, cache);
    return { ok: true };
  }

  // ---- work items ----------------------------------------------------------------

  private withLinks(items: readonly WorkItemData[], root: string | undefined): WorkItem[] {
    const links = root !== undefined ? readLinks(root) : [];
    return items.map((item) => ({
      ...item,
      linkedNodeIds: [...new Set(links.filter((l) => l.provider === item.provider && l.itemId === item.id).map((l) => l.nodeId))].sort(),
    }));
  }

  async workItems(query: { nodeId?: string; q?: string; provider?: string }): Promise<{ items: WorkItem[]; errors?: ProviderError[] }> {
    const project = this.options.project();
    const ctx = this.context();
    const errors: ProviderError[] = [];
    const items: WorkItemData[] = [];
    const q = query.q?.trim();

    if (q !== undefined && q.length > 0) {
      const providers = query.provider !== undefined ? [this.workProvider(query.provider)] : this.registry.work();
      await Promise.all(
        providers.map(async (p) => {
          if (query.provider === undefined && !(await p.enabled(ctx))) return;
          try {
            items.push(...(await p.search(q, ctx)));
          } catch (err) {
            errors.push({ provider: p.id, message: message(err) });
          }
        }),
      );
    } else if (project !== null) {
      const links = readLinks(project.root).filter(
        (l) => (query.nodeId === undefined || l.nodeId === query.nodeId) && (query.provider === undefined || l.provider === query.provider),
      );
      const byProvider = new Map<string, string[]>();
      for (const l of links.slice(0, MAX_LINKED_ITEMS)) {
        const ids = byProvider.get(l.provider) ?? [];
        if (!ids.includes(l.itemId)) ids.push(l.itemId);
        byProvider.set(l.provider, ids);
      }
      await Promise.all(
        [...byProvider].map(async ([providerId, ids]) => {
          const provider = this.registry.get(providerId);
          let fetched: WorkItemData[] = [];
          if (provider !== undefined && isWork(provider)) {
            try {
              fetched = await provider.get(ids, ctx);
            } catch (err) {
              errors.push({ provider: providerId, message: message(err) });
            }
          }
          // Links whose item could not be fetched still show (as stubs) so they can be unlinked.
          for (const id of ids) {
            const found = fetched.find((f) => f.id === id);
            items.push(
              found ?? {
                id, provider: providerId, title: id, status: "unknown",
                url: provider !== undefined && isWork(provider) ? provider.urlFor(id, ctx) : "",
                updatedAt: new Date(0).toISOString(),
              },
            );
          }
        }),
      );
    }
    const result: { items: WorkItem[]; errors?: ProviderError[] } = { items: this.withLinks(items, project?.root) };
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  async workLink(body: WorkLinkBody): Promise<{ ok: true }> {
    const project = this.requireProject();
    this.workProvider(body.provider);
    if (!ITEM_ID_RE.test(body.itemId)) throw new IntegrationError(400, "invalid item id");
    if (body.linked && !this.nodes(project).some((n) => n.id === body.nodeId)) throw new IntegrationError(400, `unknown element: ${body.nodeId}`);
    updateLink(project.root, { nodeId: body.nodeId, provider: body.provider, itemId: body.itemId }, body.linked);
    return { ok: true };
  }

  async workCreate(body: WorkCreateBody): Promise<WorkItem> {
    const project = this.requireProject();
    const provider = this.workProvider(body.provider);
    if (!this.nodes(project).some((n) => n.id === body.nodeId)) throw new IntegrationError(400, `unknown element: ${body.nodeId}`);
    const created = await provider.create(
      {
        title: body.title,
        body: body.body,
        ...(body.projectKey !== undefined ? { projectKey: body.projectKey } : {}),
        ...(body.repo !== undefined ? { repo: body.repo } : {}),
        ...(body.issueType !== undefined ? { issueType: body.issueType } : {}),
      },
      this.context(),
    );
    updateLink(project.root, { nodeId: body.nodeId, provider: created.provider, itemId: created.id }, true);
    const [item] = this.withLinks([created], project.root);
    return item as WorkItem;
  }

  // ---- ruah ------------------------------------------------------------------------

  ruahStatus(): Promise<unknown> {
    return this.ruah.status(this.context());
  }

  async ruahTask(body: RuahTaskBody): Promise<unknown> {
    const project = this.options.project();
    let node;
    if (body.nodeId !== undefined) {
      node = this.nodes(project).find((n) => n.id === body.nodeId);
      if (node === undefined) throw new IntegrationError(400, `unknown element: ${body.nodeId}`);
    }
    return this.ruah.createTask(body, node, this.context());
  }

  ruahTaskAction(name: string, action: RuahTaskAction): Promise<unknown> {
    return this.ruah.taskAction(name, action, this.context());
  }

  ruahWorkflows(): Promise<unknown> {
    return this.ruah.workflows(this.context());
  }

  ruahWorkflowRun(name: string): Promise<unknown> {
    return this.ruah.runWorkflow(name, this.context());
  }
}
