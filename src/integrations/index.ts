// src/integrations/index.ts — IntegrationsService: the §6 API behind the HTTP
// handler. Owns the registry (DigitalOcean, AWS, Jira, GitHub, ruah, and the
// §9 providers Vercel, Supabase, Kubernetes, Netlify, Hetzner), the
// per-project cloud cache and the committable links file, and applies the
// cloud→element linking on every read. The current project comes from a
// callback so project switching (§5) needs no rewiring. Every cloud change is
// announced to onCloudUpdated listeners (the daemon's `cloud.updated`, §9).
import type { Architecture } from "../contracts/architecture.js";
import type {
  CloudLinkBody,
  CloudResource,
  CloudScopeSummary,
  CloudSyncBody,
  CloudSyncResult,
  ConnectBody,
  ResourceScope,
  ScopeAccountsBody,
  ScopeResourceBody,
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
import { HetznerIntegration } from "./cloud/hetzner.js";
import { KubernetesIntegration } from "./cloud/kubernetes.js";
import { NetlifyIntegration } from "./cloud/netlify.js";
import { SupabaseIntegration } from "./cloud/supabase.js";
import { VercelIntegration } from "./cloud/vercel.js";
import { cloudFingerprint, syncProviders } from "./cloud-sync.js";
import { defaultRunner, IntegrationError, redact, type Runner } from "./exec.js";
import { Keychain, type SecretStore } from "./keychain.js";
import { linkResources } from "./linking.js";
import { IntegrationRegistry, isCloud, isWork, registerCloudBatchB, syncable, type CloudIntegration, type CloudSyncOutcome, type ProjectContext, type WorkIntegration, type WorkItemData } from "./registry.js";
import { RuahIntegration, type Launcher } from "./ruah.js";
import {
  applyResourceAction,
  applyScope,
  loadScopeUnits,
  ownUnit,
  ScopeFileError,
  scopeSummary,
  SignalsCache,
  syncAccountPlan,
  updateScopeFile,
  withoutScope,
  type LoadedUnit,
} from "./scope/index.js";
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
  /** §14: the open project's scope — accounts, files, what the repo says, members and suggestions. */
  cloudScope(): Promise<CloudScopeInfo>;
  cloudScopeAccounts(body: ScopeAccountsBody): Promise<CloudScopeSummary>;
  cloudScopeResource(body: ScopeResourceBody): Promise<{ ok: true; scope: ResourceScope }>;
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

/** §9 `cloud.updated` payload (minus the message type). */
export interface CloudUpdate {
  /** Project the snapshot belongs to. */
  root: string;
  syncedAt: string | null;
  /** Providers synced in this update ([] = a link change). */
  providers: string[];
  /** Providers whose sync failed outright (the watch loop backs off). */
  failed: string[];
  errors: ProviderError[];
  /** The whole snapshot; absent when nothing a viewer shows changed since the last update. */
  resources?: CloudResource[];
  /** §14: the project's accounts and scope files. */
  scope?: CloudScopeSummary;
}

/** §14 GET /api/cloud/scope. */
export interface CloudScopeInfo {
  root: string;
  scope: CloudScopeSummary;
  /** What each folder of the project says about where it runs (files read, host names, names). */
  evidence: { repo?: string; root: string; files: string[]; hosts: string[]; names: string[]; accountHints: { provider: string; account: string; file: string }[]; truncated: boolean }[];
  /** In-scope resources, suggestions (weak) and excluded ones, from the last sync. */
  resources: Pick<CloudResource, "id" | "provider" | "type" | "service" | "name" | "account" | "scope">[];
  counts: { in: number; suggestions: number; excluded: number; total: number };
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
  private readonly inflight = new Map<string, Promise<CloudSyncOutcome>>();
  private readonly cloudListeners = new Set<(update: CloudUpdate) => void>();
  private readonly cloudFingerprints = new Map<string, string>();
  /** §14: repo signals, re-read at most every 15 s (scope is evaluated on every read and push). */
  private readonly signals = new SignalsCache();

  constructor(private readonly options: IntegrationsOptions) {
    const runner = options.runner ?? defaultRunner;
    const settings = new SettingsStore(options.home);
    this.ruah = options.ruah ?? new RuahIntegration({ runner, home: options.home, ...(options.launch !== undefined ? { launch: options.launch } : {}) });
    this.registry =
      options.registry ??
      new IntegrationRegistry()
        .register(new DigitalOceanIntegration({ runner, settings }))
        .register(new AwsIntegration({ runner, settings }))
        .register(new VercelIntegration({ runner, settings }))
        .register(new SupabaseIntegration({ runner, settings }))
        .register(new KubernetesIntegration({ runner, settings }))
        .register(new NetlifyIntegration({ runner, settings }))
        .register(new HetznerIntegration({ runner, settings }))
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
    // §14: a project whose scope lists accounts syncs only those providers and accounts (sync-all and the
    // watch loop); naming a provider still syncs it (its scope accounts, else its selected account).
    const units = this.scopeUnits(project.root);
    const plan = syncAccountPlan(units);
    const providers = wanted !== undefined
      ? wanted.map((id) => {
          const integration = this.integration(id);
          if (!isCloud(integration)) throw new IntegrationError(400, `${id} is not a cloud integration`);
          return integration;
        })
      : this.registry.cloud().filter((c) => syncable(c) && (plan === null || plan.has(c.id)));
    const { resources: fresh, errors, failed } = await syncProviders(providers, {
      accounts: body.accounts,
      accountLists: plan,
      now: this.now(),
      project: { root: project.root },
      syncOne: (provider, account, ctx) => this.syncOnce(provider, account, ctx),
    });
    const synced = new Set(providers.map((p) => p.id));
    // Sync-all and the watch loop skip providers without their CLI (or disconnected in Ruah); an old
    // "not installed" error of theirs goes too, unless this call synced them explicitly.
    const skipped = new Set(this.registry.cloud().filter((c) => (!syncable(c) || (plan !== null && !plan.has(c.id))) && !synced.has(c.id)).map((c) => c.id));
    const cache = this.cloudCache.read(project.root);
    // A sync-all under account scope also drops what other providers left in this project's cache.
    // A provider whose sync failed outright (timeout, cluster unreachable) keeps its last resources
    // (with their old observedAt) instead of vanishing from the Cloud page and the map until it recovers.
    const failedNow = new Set(failed);
    const kept = cache.resources.filter(
      (r) => (!synced.has(r.provider) || failedNow.has(r.provider)) && (wanted !== undefined || plan === null || plan.has(r.provider)),
    );
    const resources = linkResources(withoutScope([...kept, ...fresh]), this.nodes(project), cache.manualLinks).sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    );
    const syncedAt = this.now().toISOString();
    const keptErrors = cache.errors.filter((e) => !synced.has(e.provider) && !skipped.has(e.provider));
    this.cloudCache.write(project.root, { ...cache, syncedAt, resources, errors: [...keptErrors, ...errors] });
    const result = this.scoped(project, units, { resources, syncedAt, errors: [...keptErrors, ...errors] }, cache.manualLinks);
    this.emitCloud(project.root, result, [...synced], failed);
    return result;
  }

  // ---- §14 per-project scope ----------------------------------------------------

  private scopeUnits(root: string): LoadedUnit[] {
    return loadScopeUnits(root, { signals: (r, names) => this.signals.get(r, names) });
  }

  /** A snapshot with every resource's `scope` and the project's scope summary. */
  private scoped(project: CurrentProject, units: LoadedUnit[], result: CloudSyncResult, manualLinks: Record<string, string | null>): CloudSyncResult {
    return {
      ...result,
      resources: applyScope({ units, resources: result.resources, nodes: this.nodes(project), manualLinks }),
      scope: scopeSummary(units),
    };
  }

  /** Cloud providers the watch loop keeps fresh: syncable ones, only the scope's when it lists accounts. */
  watchProviders(): string[] {
    const project = this.options.project();
    if (project === null) return [];
    const plan = syncAccountPlan(this.scopeUnits(project.root));
    return this.registry.cloud().filter((c) => syncable(c) && (plan === null || plan.has(c.id))).map((c) => c.id);
  }

  async cloudScope(): Promise<CloudScopeInfo> {
    const project = this.requireProject();
    const units = this.scopeUnits(project.root);
    const snapshot = await this.cloudResources();
    const members = snapshot.resources.filter((r) => r.scope !== undefined && (r.scope.in || r.scope.confidence !== undefined));
    return {
      root: project.root,
      scope: scopeSummary(units),
      evidence: units.map((u) => ({
        ...(u.repo !== undefined ? { repo: u.repo } : {}),
        root: u.root, files: u.signals.files, hosts: u.signals.hosts.map((h) => h.host), names: u.signals.names,
        accountHints: u.signals.accountHints, truncated: u.signals.truncated,
      })),
      resources: members.map((r) => ({
        id: r.id, provider: r.provider, type: r.type, service: r.service, name: r.name,
        ...(r.account !== undefined ? { account: r.account } : {}), ...(r.scope !== undefined ? { scope: r.scope } : {}),
      })),
      counts: {
        in: snapshot.resources.filter((r) => r.scope?.in === true).length,
        suggestions: snapshot.resources.filter((r) => r.scope?.in === false && r.scope.confidence === "weak").length,
        excluded: snapshot.resources.filter((r) => r.scope?.excluded === true).length,
        total: snapshot.resources.length,
      },
    };
  }

  private writeScope<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ScopeFileError) throw new IntegrationError(err.status, err.message);
      throw err;
    }
  }

  async cloudScopeAccounts(body: ScopeAccountsBody): Promise<CloudScopeSummary> {
    const project = this.requireProject();
    const cloudIds = new Set(this.registry.cloud().map((c) => c.id));
    for (const a of body.accounts) if (!cloudIds.has(a.provider)) throw new IntegrationError(400, `unknown cloud provider: ${a.provider}`);
    const own = ownUnit(this.scopeUnits(project.root));
    if (own === undefined) throw new IntegrationError(409, "no project open");
    this.writeScope(() => updateScopeFile(own.root, (c) => ({ ...c, accounts: body.accounts.map((a) => ({ ...a })) })));
    return this.emitScopeChange(project);
  }

  async cloudScopeResource(body: ScopeResourceBody): Promise<{ ok: true; scope: ResourceScope }> {
    const project = this.requireProject();
    const cache = this.cloudCache.read(project.root);
    const resource = cache.resources.find((r) => r.id === body.resourceId);
    if (resource === undefined) throw new IntegrationError(404, "unknown resource (sync first)");
    const own = ownUnit(this.scopeUnits(project.root));
    if (own === undefined) throw new IntegrationError(409, "no project open");
    this.writeScope(() => updateScopeFile(own.root, (c) => applyResourceAction(c, { id: resource.id, provider: resource.provider, name: resource.name }, body.action)));
    this.emitScopeChange(project);
    const after = (await this.cloudResources()).resources.find((r) => r.id === resource.id);
    return { ok: true, scope: after?.scope ?? { in: false, reasons: [] } };
  }

  /** Re-scopes the cached snapshot after a scope edit and pushes it (like a link change). */
  private emitScopeChange(project: CurrentProject): CloudScopeSummary {
    const cache = this.cloudCache.read(project.root);
    const units = this.scopeUnits(project.root);
    const result = this.scoped(project, units, {
      resources: linkResources(cache.resources, this.nodes(project), cache.manualLinks), syncedAt: cache.syncedAt, errors: cache.errors,
    }, cache.manualLinks);
    this.emitCloud(project.root, result, [], []);
    return result.scope ?? scopeSummary(units);
  }

  /** Concurrent syncs of the same provider + account (watch loop, Sync button, second tab) share one run. */
  private syncOnce(provider: CloudIntegration, account: string | undefined, project: ProjectContext | null): Promise<CloudSyncOutcome> {
    const key = `${provider.id}\u0000${account ?? ""}\u0000${project?.root ?? ""}`;
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const started = provider.sync({ ...(account !== undefined ? { account } : {}), project }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, started);
    return started;
  }

  /** §9: called after every sync / link change; the daemon pushes it to viewers as `cloud.updated`. */
  onCloudUpdated(listener: (update: CloudUpdate) => void): () => void {
    this.cloudListeners.add(listener);
    return () => this.cloudListeners.delete(listener);
  }

  private emitCloud(root: string, result: CloudSyncResult, providers: string[], failed: string[]): void {
    if (this.cloudListeners.size === 0) return;
    const fingerprint = cloudFingerprint(result.resources);
    const changed = this.cloudFingerprints.get(root) !== fingerprint;
    this.cloudFingerprints.set(root, fingerprint);
    const update: CloudUpdate = {
      root, syncedAt: result.syncedAt, providers, failed, errors: result.errors, ...(changed ? { resources: result.resources } : {}),
      ...(result.scope !== undefined ? { scope: result.scope } : {}),
    };
    for (const listener of this.cloudListeners) {
      try {
        listener(update);
      } catch {
        // a broken listener must not fail the sync
      }
    }
  }

  async cloudResources(): Promise<CloudSyncResult> {
    const project = this.options.project();
    if (project === null) return { resources: [], syncedAt: null, errors: [] };
    const cache = this.cloudCache.read(project.root);
    return this.scoped(project, this.scopeUnits(project.root), {
      resources: linkResources(cache.resources, this.nodes(project), cache.manualLinks),
      syncedAt: cache.syncedAt,
      errors: cache.errors,
    }, cache.manualLinks);
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
    this.emitCloud(project.root, this.scoped(project, this.scopeUnits(project.root), { resources: cache.resources, syncedAt: cache.syncedAt, errors: cache.errors }, cache.manualLinks), [], []);
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
