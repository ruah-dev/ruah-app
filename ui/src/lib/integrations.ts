// Client for the daemon's integration endpoints (CONTRACTS.md §6.2): integrations, cloud
// resources, work items and ruah orchestration. A small useSyncExternalStore store keeps the
// shared lists (integrations, cloud snapshot, ruah status) so the pages, the sidebar badges,
// the Details panel and the Map's derived Cloud level read one copy. Credentials never pass
// through here except the Jira token on connect, which is sent once and never stored or echoed.
// Live cloud status (§9): while the Cloud page is open or "Show on map" is on, the viewer asks
// the daemon to watch (cloud.watch) and applies its cloud.updated pushes; otherwise nothing polls.
import { useEffect, useSyncExternalStore } from "react";
import type {
  Architecture,
  ArchNode,
  CloudHealth,
  CloudResource,
  CloudResourceType,
  CloudSyncResult,
  IntegrationInfo,
  ServerMessage,
  WorkItem,
} from "./contracts";
import { setCloudWatch, type DaemonState } from "./daemon";
import type { DiagramEdge, DiagramGroup, DiagramNode, Graph, NodeKind } from "@/data/graphs";
import { ORIGIN, NODE_W, NODE_H, kindFor, subtitleFor } from "./architecture";

// ---------------------------------------------------------------------------
// HTTP

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; unavailable?: boolean };

/** The daemon answers unknown /api paths with 404 or the SPA's HTML: both mean "not served yet". */
async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  const origin = store.origin;
  if (!origin) return { ok: false, status: 0, message: "No daemon connected", unavailable: true };
  try {
    const r = await fetch(`${origin}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const type = r.headers.get("content-type") ?? "";
    const json = type.includes("json") ? ((await r.json().catch(() => null)) as unknown) : null;
    if (!r.ok) {
      const b = (json ?? {}) as { error?: string; message?: string };
      return {
        ok: false,
        status: r.status,
        message: b.error ?? b.message ?? `${r.status} ${r.statusText}`,
        ...(r.status === 404 && json === null ? { unavailable: true } : {}),
      };
    }
    if (json === null)
      return { ok: false, status: r.status, message: "Not available on this daemon", unavailable: true };
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// ruah passthrough shapes (`ruah status --json`, `ruah workflow list --json`)

export type RuahTaskStatus = "created" | "in-progress" | "done" | "merged" | "failed" | "cancelled" | (string & {});

export interface RuahTask {
  name: string;
  status: RuahTaskStatus;
  branch?: string;
  worktree?: string;
  baseBranch?: string;
  files?: string[];
  executor?: string | null;
  prompt?: string | null;
  parent?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  mergedAt?: string | null;
  integrationStatus?: string;
  workflow?: { name: string; path: string; stage: number } | null;
}

export interface RuahWorkflowSummary {
  name: string;
  path: string;
  stageCount?: number;
  taskNames?: string[];
  counts?: Record<string, number>;
}

export interface RuahStatus {
  initialized: true;
  baseBranch?: string;
  currentBranch?: string;
  taskCounts?: { total: number; created: number; active: number; done: number; merged: number; failed: number };
  tasks: RuahTask[];
  workflows: RuahWorkflowSummary[];
}

export type RuahStatusResult = RuahStatus | { initialized: false; hint?: string };

export interface RuahWorkflowFile {
  name: string;
  path?: string;
}

export const RUAH_EXECUTORS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "open-code", label: "OpenCode" },
  { id: "aider", label: "Aider" },
] as const;

export const RUAH_TASK_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

function normalizeRuahStatus(raw: unknown): RuahStatusResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r["initialized"] === false) {
    const hint = typeof r["hint"] === "string" ? r["hint"] : undefined;
    return hint !== undefined ? { initialized: false, hint } : { initialized: false };
  }
  const rawTasks = r["tasks"];
  const tasks: RuahTask[] = Array.isArray(rawTasks)
    ? (rawTasks as RuahTask[])
    : rawTasks && typeof rawTasks === "object"
      ? Object.entries(rawTasks as Record<string, RuahTask>).map(([name, t]) => ({ ...t, name: t.name ?? name }))
      : [];
  const workflows = Array.isArray(r["workflows"]) ? (r["workflows"] as RuahWorkflowSummary[]) : [];
  return {
    initialized: true,
    tasks,
    workflows,
    ...(typeof r["baseBranch"] === "string" ? { baseBranch: r["baseBranch"] } : {}),
    ...(typeof r["currentBranch"] === "string" ? { currentBranch: r["currentBranch"] } : {}),
    ...(r["taskCounts"] ? { taskCounts: r["taskCounts"] as NonNullable<RuahStatus["taskCounts"]> } : {}),
  };
}

// ---------------------------------------------------------------------------
// store

export type Remote<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; data: T; at: number };

export interface IntegrationsStore {
  /** Daemon HTTP origin, null in sample mode / before the daemon answered. */
  origin: string | null;
  /** "no-daemon" when the viewer runs on the bundled sample. */
  mode: "pending" | "daemon" | "no-daemon";
  projectKey: string | null;
  integrations: Remote<IntegrationInfo[]>;
  cloud: Remote<CloudSyncResult>;
  /** Key of the sync in flight ("all" or "<provider>:<account>"), else null. */
  syncing: string | null;
  ruah: Remote<RuahStatusResult>;
  workflows: Remote<RuahWorkflowFile[]>;
  /** Resource ids the user linked by hand this session (for the auto/manual badge fallback). */
  manualLinks: Record<string, true>;
  showCloudOnMap: boolean;
  /** §9: epoch ms of the last cloud.updated push for this project (null = none yet). */
  cloudPushedAt: number | null;
}

const ON_MAP_KEY = "ruah.cloud.onMap";

const INITIAL: IntegrationsStore = {
  origin: null,
  mode: "pending",
  projectKey: null,
  integrations: { status: "idle" },
  cloud: { status: "idle" },
  syncing: null,
  ruah: { status: "idle" },
  workflows: { status: "idle" },
  manualLinks: {},
  showCloudOnMap: false,
  cloudPushedAt: null,
};

let store: IntegrationsStore = INITIAL;
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function set(patch: Partial<IntegrationsStore>) {
  store = { ...store, ...patch };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getSnapshot = () => store;
const getServerSnapshot = () => INITIAL;

function failed<T>(res: Extract<ApiResult<T>, { ok: false }>): Remote<never> {
  return res.unavailable
    ? { status: "unavailable", message: res.message }
    : { status: "error", message: res.message };
}

/** Called from a hook with the daemon state: resets the lists when the project changes. */
function bind(daemon: Pick<DaemonState, "source" | "httpOrigin" | "root" | "connection">) {
  const mode = daemon.source === "daemon" ? "daemon" : daemon.source === "sample" ? "no-daemon" : "pending";
  const origin = daemon.source === "daemon" ? daemon.httpOrigin : null;
  const projectKey = daemon.source === "daemon" ? (daemon.root ?? "daemon") : null;
  if (store.origin === origin && store.mode === mode && store.projectKey === projectKey) return;
  const projectChanged = store.projectKey !== projectKey;
  set({
    origin,
    mode,
    projectKey,
    ...(projectChanged
      ? {
          integrations: { status: "idle" },
          cloud: { status: "idle" },
          ruah: { status: "idle" },
          workflows: { status: "idle" },
          manualLinks: {},
          syncing: null,
          cloudPushedAt: null,
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// live cloud status (§9)

type CloudUpdated = Extract<ServerMessage, { type: "cloud.updated" }>;

/** Applies a cloud.updated push: the full snapshot when it changed, else fresh timestamps / errors. */
export function applyCloudUpdate(prev: CloudSyncResult | null, u: CloudUpdated): CloudSyncResult {
  const synced = new Set(u.providers);
  const base = u.resources ?? prev?.resources ?? [];
  const resources =
    u.resources || !u.syncedAt
      ? base
      : base.map((r) => (synced.has(r.provider) && !u.failed.includes(r.provider) ? { ...r, observedAt: u.syncedAt! } : r));
  return { resources, syncedAt: u.syncedAt ?? prev?.syncedAt ?? null, errors: u.errors };
}

if (typeof window !== "undefined") {
  window.addEventListener("ruah:cloud-updated", (ev) => {
    const u = (ev as CustomEvent<CloudUpdated>).detail;
    if (!u || store.mode !== "daemon" || (store.projectKey !== null && store.projectKey !== u.root)) return;
    const prev = store.cloud.status === "ok" ? store.cloud.data : null;
    // Before the first load a push without resources carries nothing to show: load instead.
    if (!prev && !u.resources) return void loadCloud();
    set({ cloud: { status: "ok", data: applyCloudUpdate(prev, u), at: Date.now() }, cloudPushedAt: Date.now() });
  });
}

const watchReasons = new Set<"page" | "map">();
function watchCloud(reason: "page" | "map", on: boolean) {
  if (on) watchReasons.add(reason);
  else watchReasons.delete(reason);
  setCloudWatch(watchReasons.size > 0);
}

/** Keeps cloud status live while the calling component (the Cloud page) is mounted. */
export function useCloudWatch(active = true) {
  useEffect(() => {
    if (!active) return;
    watchCloud("page", true);
    return () => watchCloud("page", false);
  }, [active]);
}

function once(key: string, fn: () => Promise<void>): Promise<void> {
  const running = inflight.get(key);
  if (running) return running;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function noDaemon(): Remote<never> {
  return { status: "unavailable", message: "No daemon connected" };
}

export function loadIntegrations(): Promise<void> {
  return once("integrations", async () => {
    if (!store.origin) {
      if (store.mode === "no-daemon") set({ integrations: noDaemon() });
      return;
    }
    if (store.integrations.status !== "ok") set({ integrations: { status: "loading" } });
    const res = await api<{ integrations: IntegrationInfo[] }>("GET", "/api/integrations");
    set({
      integrations: res.ok
        ? { status: "ok", data: res.data.integrations ?? [], at: Date.now() }
        : failed(res),
    });
  });
}

export function loadCloud(): Promise<void> {
  return once("cloud", async () => {
    if (!store.origin) {
      if (store.mode === "no-daemon") set({ cloud: noDaemon() });
      return;
    }
    if (store.cloud.status !== "ok") set({ cloud: { status: "loading" } });
    const res = await api<CloudSyncResult>("GET", "/api/cloud/resources");
    set({ cloud: res.ok ? { status: "ok", data: normalizeCloud(res.data), at: Date.now() } : failed(res) });
  });
}

function normalizeCloud(d: Partial<CloudSyncResult> | null | undefined): CloudSyncResult {
  return {
    resources: Array.isArray(d?.resources) ? d.resources : [],
    syncedAt: d?.syncedAt ?? null,
    errors: Array.isArray(d?.errors) ? d.errors : [],
  };
}

export function loadRuah(): Promise<void> {
  return once("ruah", async () => {
    if (!store.origin) {
      if (store.mode === "no-daemon") set({ ruah: noDaemon() });
      return;
    }
    if (store.ruah.status !== "ok") set({ ruah: { status: "loading" } });
    const res = await api<unknown>("GET", "/api/ruah/status");
    set({ ruah: res.ok ? { status: "ok", data: normalizeRuahStatus(res.data), at: Date.now() } : failed(res) });
  });
}

export function loadWorkflows(): Promise<void> {
  return once("workflows", async () => {
    if (!store.origin) {
      if (store.mode === "no-daemon") set({ workflows: noDaemon() });
      return;
    }
    if (store.workflows.status !== "ok") set({ workflows: { status: "loading" } });
    const res = await api<unknown>("GET", "/api/ruah/workflows");
    if (!res.ok) return set({ workflows: failed(res) });
    const raw = res.data as { workflows?: RuahWorkflowFile[] } | RuahWorkflowFile[];
    const list = Array.isArray(raw) ? raw : (raw.workflows ?? []);
    set({ workflows: { status: "ok", data: list, at: Date.now() } });
  });
}

// ---------------------------------------------------------------------------
// actions

function upsertIntegration(info: IntegrationInfo) {
  if (store.integrations.status !== "ok") return void loadIntegrations();
  const list = store.integrations.data;
  const next = list.some((i) => i.id === info.id)
    ? list.map((i) => (i.id === info.id ? info : i))
    : [...list, info];
  set({ integrations: { status: "ok", data: next, at: Date.now() } });
}

export type JiraCredentials = { site: string; email: string; token: string };

/** Jira: `{ site, email, token }` (token goes to the Keychain on the daemon side);
 * CLI providers: `{ account? }` picks the AWS profile / doctl context. */
export async function connectIntegration(
  id: string,
  body: JiraCredentials | { account?: string },
): Promise<ApiResult<IntegrationInfo>> {
  const res = await api<IntegrationInfo>("POST", `/api/integrations/${encodeURIComponent(id)}/connect`, body);
  if (res.ok) upsertIntegration(res.data);
  return res;
}

export async function disconnectIntegration(id: string): Promise<ApiResult<IntegrationInfo>> {
  const res = await api<IntegrationInfo>("POST", `/api/integrations/${encodeURIComponent(id)}/disconnect`, {});
  if (res.ok) upsertIntegration(res.data);
  return res;
}

export async function syncCloud(opts: { provider?: string; account?: string } = {}): Promise<ApiResult<CloudSyncResult>> {
  const key = opts.provider ? `${opts.provider}:${opts.account ?? ""}` : "all";
  set({ syncing: key });
  const body: { providers?: string[]; accounts?: Record<string, string> } = {};
  if (opts.provider) body.providers = [opts.provider];
  if (opts.provider && opts.account) body.accounts = { [opts.provider]: opts.account };
  const res = await api<CloudSyncResult>("POST", "/api/cloud/sync", body);
  if (res.ok) {
    const fresh = normalizeCloud(res.data);
    // A per-provider sync returns that provider's resources: keep the others.
    const prev = store.cloud.status === "ok" ? store.cloud.data.resources : [];
    const resources = opts.provider
      ? [...prev.filter((r) => r.provider !== opts.provider), ...fresh.resources]
      : fresh.resources;
    set({ syncing: null, cloud: { status: "ok", data: { ...fresh, resources }, at: Date.now() } });
  } else {
    set({ syncing: null });
  }
  return res;
}

export async function linkCloudResource(resourceId: string, nodeId: string | null): Promise<ApiResult<{ ok: boolean }>> {
  const before = store.cloud;
  if (before.status === "ok") {
    const resources = before.data.resources.map((r): CloudResource => {
      if (r.id !== resourceId) return r;
      const { linkedNodeId: _l, linkSource: _s, ...rest } = r;
      return nodeId ? { ...rest, linkedNodeId: nodeId, linkSource: "manual" } : rest;
    });
    set({
      cloud: { ...before, data: { ...before.data, resources } },
      manualLinks: { ...store.manualLinks, [resourceId]: true },
    });
  }
  const res = await api<{ ok: boolean }>("POST", "/api/cloud/link", { resourceId, nodeId });
  if (!res.ok) set({ cloud: before });
  return res;
}

export function setShowCloudOnMap(on: boolean) {
  try {
    if (on) window.localStorage.setItem(ON_MAP_KEY, "1");
    else window.localStorage.removeItem(ON_MAP_KEY);
  } catch {
    /* storage unavailable */
  }
  set({ showCloudOnMap: on });
  watchCloud("map", on);
  if (on && store.cloud.status === "idle") void loadCloud();
}

export async function fetchWorkItems(query: { nodeId?: string; q?: string }): Promise<ApiResult<WorkItem[]>> {
  const params = new URLSearchParams();
  if (query.nodeId) params.set("nodeId", query.nodeId);
  if (query.q) params.set("q", query.q);
  const res = await api<{ items: WorkItem[] }>("GET", `/api/work/items?${params.toString()}`);
  return res.ok ? { ok: true, data: res.data.items ?? [] } : res;
}

export function linkWorkItem(item: Pick<WorkItem, "provider" | "id">, nodeId: string, linked: boolean) {
  return api<{ ok: boolean }>("POST", "/api/work/link", {
    provider: item.provider,
    itemId: item.id,
    nodeId,
    linked,
  });
}

export type CreateWorkItem = {
  provider: string;
  title: string;
  body: string;
  nodeId: string;
} & ({ projectKey: string } | { repo: string });

/** Creates the issue in Jira / GitHub. The caller must have shown an explicit confirm step. */
export function createWorkItem(input: CreateWorkItem) {
  return api<WorkItem>("POST", "/api/work/create", input);
}

export type CreateRuahTask = {
  name: string;
  prompt: string;
  files?: string[];
  executor?: string;
  nodeId?: string;
  start?: boolean;
};

export async function createRuahTask(input: CreateRuahTask) {
  const res = await api<RuahTask>("POST", "/api/ruah/task", input);
  if (res.ok) void loadRuah();
  return res;
}

export type RuahTaskAction = "start" | "done" | "merge" | "cancel";

export async function ruahTaskAction(name: string, action: RuahTaskAction) {
  const res = await api<unknown>("POST", `/api/ruah/task/${encodeURIComponent(name)}/${action}`, {});
  void loadRuah();
  return res;
}

export async function runRuahWorkflow(name: string) {
  const res = await api<unknown>("POST", `/api/ruah/workflows/${encodeURIComponent(name)}/run`, {});
  void loadRuah();
  return res;
}

// ---------------------------------------------------------------------------
// hooks

export function useIntegrationsStore(): IntegrationsStore {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Binds the store to the daemon. Mount once near the root (WorkspaceProvider). */
export function useIntegrationsBinding(
  daemon: Pick<DaemonState, "source" | "httpOrigin" | "root" | "connection">,
) {
  const { source, httpOrigin, root, connection } = daemon;
  useEffect(() => {
    bind({ source, httpOrigin, root, connection });
  }, [source, httpOrigin, root, connection]);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(ON_MAP_KEY) === "1") {
        set({ showCloudOnMap: true });
        watchCloud("map", true);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);
}

/** Loads a list on mount and whenever the daemon/project changes. */
export function useLoad(which: "integrations" | "cloud" | "ruah" | "workflows", opts: { pollMs?: number } = {}) {
  const s = useIntegrationsStore();
  const { pollMs } = opts;
  useEffect(() => {
    const fn = { integrations: loadIntegrations, cloud: loadCloud, ruah: loadRuah, workflows: loadWorkflows }[which];
    void fn();
    if (!pollMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void fn();
    }, pollMs);
    return () => clearInterval(t);
  }, [which, s.origin, s.mode, s.projectKey, pollMs]);
  return s;
}

/** Loads a list only if nothing was loaded yet for this project (Details panel sections). */
export function useEnsure(which: "integrations" | "cloud" | "ruah" | "workflows") {
  const s = useIntegrationsStore();
  const status = s[which].status;
  useEffect(() => {
    if (status !== "idle" || !s.origin) {
      if (status === "idle" && s.mode === "no-daemon")
        set({ [which]: { status: "unavailable", message: "No daemon connected" } });
      return;
    }
    const fn = { integrations: loadIntegrations, cloud: loadCloud, ruah: loadRuah, workflows: loadWorkflows }[which];
    void fn();
  }, [which, status, s.origin, s.mode]);
  return s;
}

/** The derived Cloud level for the Map, or null when "Show on map" is off. */
export function useCloudDiagram(architecture: Architecture): Graph | null {
  const s = useIntegrationsStore();
  const show = s.showCloudOnMap;
  useEffect(() => {
    if (show && s.cloud.status === "idle" && s.origin) void loadCloud();
  }, [show, s.cloud.status, s.origin]);
  if (!show) return null;
  const resources = s.cloud.status === "ok" ? s.cloud.data.resources : NO_RESOURCES;
  return cloudGraphMemo(architecture, resources);
}

const NO_RESOURCES: CloudResource[] = [];
let memo: { arch: Architecture; resources: CloudResource[]; graph: Graph } | null = null;
function cloudGraphMemo(arch: Architecture, resources: CloudResource[]): Graph {
  if (memo && memo.arch === arch && memo.resources === resources) return memo.graph;
  const graph = cloudGraph(arch, resources);
  memo = { arch, resources, graph };
  return graph;
}

// ---------------------------------------------------------------------------
// derived Cloud diagram (viewer only; no daemon change)

export const CLOUD_DIAGRAM_ID = "cloud:map";
const CLOUD_NODE_PREFIX = "cloud:";

export const isCloudDiagramId = (id: string) => id === CLOUD_DIAGRAM_ID;
export const cloudNodeId = (resourceId: string) => `${CLOUD_NODE_PREFIX}${resourceId}`;
/** Resource node ids never collide with architecture ids (those cannot contain ":"). */
export const isCloudNodeId = (id: string) => id.startsWith(CLOUD_NODE_PREFIX);
export const resourceIdOf = (nodeId: string) => nodeId.slice(CLOUD_NODE_PREFIX.length);

export const CLOUD_TYPE_ORDER: CloudResourceType[] = [
  "app",
  "compute",
  "container",
  "kubernetes",
  "function",
  "gateway",
  "loadbalancer",
  "cdn",
  "dns",
  "database",
  "cache",
  "queue",
  "storage",
  "other",
];

export const CLOUD_TYPE_LABEL: Record<CloudResourceType, string> = {
  app: "Apps",
  compute: "Compute",
  container: "Containers",
  kubernetes: "Kubernetes",
  function: "Functions",
  gateway: "Gateways",
  loadbalancer: "Load balancers",
  cdn: "CDN",
  dns: "DNS",
  database: "Databases",
  cache: "Caches",
  queue: "Queues",
  storage: "Storage",
  other: "Other",
};

/** Cloud resource type -> an existing diagram kind (icon + colour). */
export function cloudKind(type: string): NodeKind {
  switch (type) {
    case "compute":
      return "service";
    case "container":
    case "app":
      return "container";
    case "kubernetes":
      return "cluster";
    case "function":
      return "function";
    case "database":
      return "database";
    case "cache":
      return "cache";
    case "queue":
      return "queue";
    case "storage":
      return "storage";
    case "loadbalancer":
      return "loadbalancer";
    case "gateway":
      return "gateway";
    case "cdn":
      return "cdn";
    case "dns":
      return "dns";
    default:
      return "external";
  }
}

export const PROVIDER_LABEL: Record<string, string> = {
  digitalocean: "DigitalOcean",
  aws: "AWS",
  vercel: "Vercel",
  supabase: "Supabase",
  kubernetes: "Kubernetes",
  netlify: "Netlify",
  hetzner: "Hetzner Cloud",
  gcp: "Google Cloud",
  azure: "Azure",
  cloudflare: "Cloudflare",
  railway: "Railway",
  fly: "Fly.io",
  jira: "Jira",
  github: "GitHub",
  ruah: "ruah",
};
export const providerLabel = (id: string) => PROVIDER_LABEL[id] ?? id;

export type StatusTone = "ok" | "warn" | "bad" | "idle";

/** Onboarding state of a provider: which of install / log in / connect is missing. */
export type ProviderSetupState = "connected" | "not_installed" | "not_logged_in" | "disconnected" | "error";

export function providerSetupState(info: IntegrationInfo): ProviderSetupState {
  if (info.status === "connected") return "connected";
  if (info.status === "cli_missing") return "not_installed";
  if (info.status === "error") return "error";
  // Every provider words a Ruah-side disconnect as "disconnected in Ruah (… unchanged)".
  return /disconnected in ruah/i.test(info.detail ?? "") ? "disconnected" : "not_logged_in";
}

export const PROVIDER_SETUP_LABEL: Record<ProviderSetupState, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "ok" },
  not_installed: { label: "Not installed", tone: "idle" },
  not_logged_in: { label: "Not logged in", tone: "warn" },
  disconnected: { label: "Disconnected", tone: "idle" },
  error: { label: "Error", tone: "bad" },
};

/**
 * The commands that fix a provider's state, in order: install (CLI missing), then log in.
 * A logged-in CLI with an unusable default (gcloud without a project) puts that fix in
 * setupHint. Providers without the §10 fields fall back to setupHint.
 */
export function setupCommands(info: IntegrationInfo): { label: string; command: string }[] {
  const state = providerSetupState(info);
  if (state === "connected" || state === "disconnected") return [];
  const out: { label: string; command: string }[] = [];
  if (state === "not_installed" && info.installCommand) out.push({ label: "Install", command: info.installCommand });
  if (info.loginCommand) {
    const other = state === "not_logged_in" && !!info.setupHint && info.setupHint !== info.loginCommand;
    out.push(other ? { label: "Set up", command: info.setupHint! } : { label: "Log in", command: info.loginCommand });
  }
  if (out.length === 0 && info.setupHint && state !== "error") out.push({ label: "Run", command: info.setupHint });
  return out;
}

/** Provider status strings ("active", "running", "online", "stopped", "error", …) -> a tone. */
export function resourceTone(status: string | undefined): StatusTone {
  const s = (status ?? "").toLowerCase();
  if (!s) return "idle";
  if (/(error|fail|degraded|unhealthy|deleted)/.test(s)) return "bad";
  if (/(pending|creating|deploying|updating|progress|starting|provisioning|building|stopping|migrating|off$|stopped)/.test(s))
    return "warn";
  if (/(active|running|online|available|healthy|ready|deployed|success|in_?service|^ok$|^up$)/.test(s)) return "ok";
  return "idle";
}

export const HEALTH_LABEL: Record<CloudHealth, string> = {
  healthy: "Running",
  degraded: "Degraded",
  down: "Down",
  deploying: "Deploying",
  unknown: "Unknown",
};

const HEALTH_TONE: Record<CloudHealth, StatusTone> = {
  healthy: "ok",
  degraded: "warn",
  down: "bad",
  deploying: "idle",
  unknown: "idle",
};

/** §9 health when the provider reports one, else the older status-string heuristic. */
export function healthTone(r: Pick<CloudResource, "health" | "status">): StatusTone {
  return r.health ? HEALTH_TONE[r.health] : resourceTone(r.status);
}

export const isUnhealthy = (r: Pick<CloudResource, "health">) => r.health === "down" || r.health === "degraded";

export type HealthCounts = Record<CloudHealth, number> & { total: number };

export function healthCounts(resources: readonly Pick<CloudResource, "health">[]): HealthCounts {
  const out: HealthCounts = { healthy: 0, degraded: 0, down: 0, deploying: 0, unknown: 0, total: 0 };
  for (const r of resources) {
    if (!r.health) continue;
    out[r.health] += 1;
    out.total += 1;
  }
  return out;
}

const INNER_GAP = 24; // between columns inside a type group
const ROW_H = NODE_H + 24;
const MAX_ROWS = 5;
const GROUP_PAD = 24;
const GROUP_GAP = 36;
const WRAP_AT = 1120; // canvas px before type groups wrap to a new row

/** Resources grouped by type (wrapping grid of labelled groups), linked architecture elements in
 * a column on the right, `runs` edges from each resource to the element it runs. */
export function cloudGraph(arch: Architecture, resources: CloudResource[]): Graph {
  const byType = new Map<string, CloudResource[]>();
  for (const r of resources) {
    const t = CLOUD_TYPE_ORDER.includes(r.type) ? r.type : "other";
    const list = byType.get(t) ?? [];
    list.push(r);
    byType.set(t, list);
  }
  const nodes: DiagramNode[] = [];
  const groups: DiagramGroup[] = [];
  const edges: DiagramEdge[] = [];
  const archById = new Map(arch.nodes.map((n) => [n.id, n]));
  const yOf = new Map<string, number[]>();
  let cx = ORIGIN;
  let cy = ORIGIN;
  let rowH = 0;
  let maxRight = ORIGIN;

  for (const type of CLOUD_TYPE_ORDER) {
    const list = byType.get(type);
    if (!list?.length) continue;
    list.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    const cols = Math.ceil(list.length / MAX_ROWS);
    const rows = Math.min(list.length, MAX_ROWS);
    const innerW = cols * NODE_W + (cols - 1) * INNER_GAP;
    const innerH = (rows - 1) * ROW_H + NODE_H;
    if (cx > ORIGIN && cx + innerW > ORIGIN + WRAP_AT) {
      cx = ORIGIN;
      cy += rowH + GROUP_PAD * 2 + GROUP_GAP;
      rowH = 0;
    }
    list.forEach((r, i) => {
      const nx = cx + Math.floor(i / MAX_ROWS) * (NODE_W + INNER_GAP);
      const ny = cy + (i % MAX_ROWS) * ROW_H;
      const status = r.health ? HEALTH_LABEL[r.health].toLowerCase() : r.status ? r.status.toLowerCase() : "";
      nodes.push({
        id: cloudNodeId(r.id),
        label: r.name,
        subtitle: [r.service, r.region, status].filter(Boolean).join(" · "),
        kind: cloudKind(r.type),
        type: r.type,
        x: nx,
        y: ny,
        description: `${providerLabel(r.provider)} ${r.service}${r.region ? ` in ${r.region}` : ""}.`,
        ...(r.health || r.status
          ? {
              health: [
                {
                  label: r.health ? `${HEALTH_LABEL[r.health]}${r.healthDetail ? ` · ${r.healthDetail}` : ""}` : r.status!,
                  tone: toneForHealth(healthTone(r)),
                },
              ],
            }
          : {}),
      });
      if (r.linkedNodeId && archById.has(r.linkedNodeId)) {
        edges.push({ from: cloudNodeId(r.id), to: r.linkedNodeId, label: "runs", kind: "runs" });
        const ys = yOf.get(r.linkedNodeId) ?? [];
        ys.push(ny);
        yOf.set(r.linkedNodeId, ys);
      }
    });
    groups.push({
      id: `cloud-type:${type}`,
      label: `${CLOUD_TYPE_LABEL[type]} · ${list.length}`,
      x: cx - GROUP_PAD,
      y: cy - GROUP_PAD,
      w: innerW + GROUP_PAD * 2,
      h: innerH + GROUP_PAD * 2,
    });
    rowH = Math.max(rowH, innerH);
    maxRight = Math.max(maxRight, cx + innerW);
    cx += innerW + GROUP_PAD * 2 + GROUP_GAP;
  }

  // Linked elements on the right, each as close as possible to the resources that run it.
  const linked = [...yOf.entries()]
    .map(([id, ys]) => ({ node: archById.get(id)!, y: ys.reduce((a, b) => a + b, 0) / ys.length }))
    .sort((a, b) => a.y - b.y);
  if (linked.length) {
    const ex = maxRight + GROUP_PAD * 2 + 140;
    let next = ORIGIN;
    let top = Infinity;
    let bottom = 0;
    for (const { node, y } of linked) {
      const ny = Math.max(next, Math.round(y / 8) * 8);
      nodes.push(elementNode(node, ex, ny));
      next = ny + ROW_H;
      top = Math.min(top, ny);
      bottom = ny + NODE_H;
    }
    groups.push({
      id: "cloud-type:elements",
      label: "Architecture",
      x: ex - GROUP_PAD,
      y: top - GROUP_PAD,
      w: NODE_W + GROUP_PAD * 2,
      h: bottom - top + GROUP_PAD * 2,
    });
  }

  const providers = [...new Set(resources.map((r) => providerLabel(r.provider)))];
  return {
    id: CLOUD_DIAGRAM_ID,
    title: "Cloud",
    subtitle: resources.length
      ? `${resources.length} resources · ${providers.join(", ")} · ${linked.length} linked elements`
      : "No resources synced yet — open Cloud and press Sync",
    nodes,
    edges,
    groups,
  };
}

function toneForHealth(t: StatusTone): "ok" | "warn" | "bad" {
  return t === "idle" ? "warn" : t;
}

function elementNode(n: ArchNode, x: number, y: number): DiagramNode {
  return {
    id: n.id,
    label: n.name,
    subtitle: subtitleFor(n),
    kind: kindFor(n.type),
    type: n.type,
    x,
    y,
    ...(n.description !== undefined ? { description: n.description } : {}),
    ...(n.path !== undefined ? { path: n.path } : {}),
    ...(n.tech !== undefined ? { tech: n.tech } : {}),
    ...(n.layer !== undefined ? { layer: n.layer } : {}),
    ...(n.parent !== undefined ? { parent: n.parent } : {}),
    ...(n.files !== undefined ? { filePaths: n.files } : {}),
  };
}

// ---------------------------------------------------------------------------
// element context (issue bodies, ruah prompts)

type ElementLike = Pick<DiagramNode, "id" | "label" | "kind"> &
  Partial<Pick<DiagramNode, "type" | "path" | "description" | "tech" | "filePaths" | "notes">>;

/** Markdown summary of an element for an issue body. Deterministic, no daemon round-trip. */
export function elementSummary(node: ElementLike, arch: Architecture): string {
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const out = arch.edges.filter((e) => e.from === node.id).map((e) => byId.get(e.to)?.name ?? e.to);
  const inc = arch.edges.filter((e) => e.to === node.id).map((e) => byId.get(e.from)?.name ?? e.from);
  const lines: string[] = [];
  lines.push(
    `**Element:** ${node.label} (${node.type ?? node.kind})${node.path ? ` — \`${node.path}\`` : ""}`,
  );
  if (node.description) lines.push("", node.description);
  if (node.tech?.length) lines.push("", `**Stack:** ${node.tech.join(", ")}`);
  const files = node.filePaths ?? [];
  if (files.length) {
    lines.push("", "**Files:**");
    for (const f of files.slice(0, 8)) lines.push(`- \`${f}\``);
    if (files.length > 8) lines.push(`- +${files.length - 8} more`);
  }
  if (out.length) lines.push("", `**Talks to:** ${[...new Set(out)].slice(0, 8).join(", ")}`);
  if (inc.length) lines.push(`**Used by:** ${[...new Set(inc)].slice(0, 8).join(", ")}`);
  lines.push("", `_Linked from Ruah (element \`${node.id}\`)._`);
  return lines.join("\n");
}

/** Plain-text prompt for a ruah task scoped to an element. */
export function elementTaskPrompt(node: ElementLike): string {
  const lines = [`Work on ${node.label} (${node.type ?? node.kind})${node.path ? ` at ${node.path}` : ""}.`];
  if (node.description) lines.push(node.description);
  const files = node.filePaths ?? [];
  if (files.length) lines.push(`Start with: ${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""}.`);
  lines.push("Keep changes inside this element's files; say so if you must touch anything else.", "", "Task: ");
  return lines.join("\n");
}

const looksLikeFile = (p: string) => /\.[A-Za-z0-9]+$/.test(p.split("/").pop() ?? "");

/** File globs a ruah task should lock for an element: its files, else `<path>/**`. */
export function elementFileGlobs(node: Pick<DiagramNode, "path" | "filePaths">): string[] {
  if (node.filePaths?.length) return node.filePaths.slice(0, 20);
  if (node.path) return [looksLikeFile(node.path) ? node.path : `${node.path.replace(/\/+$/, "")}/**`];
  return [];
}

/** A task name slug from an element label: "Invoices API" -> "invoices-api". */
export function slugTaskName(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 48);
  return s || "task";
}

// ---------------------------------------------------------------------------
// formatting

export function timeAgo(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}

/** Short age for dense tables: "4m", "3h", "2d". */
export function shortAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
