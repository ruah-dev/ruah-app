// src/contracts/integrations.ts — CONTRACTS.md §6: integration, cloud and
// work-item shapes plus the request bodies of the §6.2 endpoints. Open unions
// use z.string() (receivers ignore unknown values); known literals are listed
// in comments.
import { z } from "zod";

export const INTEGRATION_FAMILIES = ["cloud", "work", "orchestration"] as const;
export const INTEGRATION_STATUSES = ["connected", "not_connected", "cli_missing", "error"] as const;
export const CLOUD_RESOURCE_TYPES = [
  "compute", "container", "function", "app", "database", "cache", "queue",
  "storage", "loadbalancer", "gateway", "cdn", "dns", "kubernetes", "other",
] as const;
/** §9: every provider's native states normalized for "is it up right now?". */
export const CLOUD_HEALTH = ["healthy", "degraded", "down", "deploying", "unknown"] as const;

export const IntegrationAccountSchema = z.object({ id: z.string(), label: z.string() });

export const IntegrationInfoSchema = z.object({
  id: z.string(), // known: digitalocean | aws | vercel | supabase | kubernetes | netlify | hetzner | jira | github | ruah
  family: z.enum(INTEGRATION_FAMILIES),
  name: z.string(),
  status: z.enum(INTEGRATION_STATUSES),
  detail: z.string().optional(),
  setupHint: z.string().optional(),
  accounts: z.array(IntegrationAccountSchema).optional(),
});

export const CloudResourceTypeSchema = z.enum(CLOUD_RESOURCE_TYPES);

export const CloudResourceSchema = z.object({
  id: z.string(), // provider-native id (ARN, DO URN)
  provider: z.string(), // known: digitalocean | aws | vercel | supabase | kubernetes | netlify | hetzner
  type: CloudResourceTypeSchema,
  service: z.string(), // "droplet", "apps", "ec2", "lambda", "rds", …
  name: z.string(),
  region: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.string()).optional(),
  consoleUrl: z.string().optional(),
  linkedNodeId: z.string().optional(),
  linkSource: z.enum(["tag", "name", "manual"]).optional(), // how linkedNodeId was decided
  // §9 live status (all optional; absent = the provider has no health notion for it)
  health: z.enum(CLOUD_HEALTH).optional(),
  healthDetail: z.string().optional(), // "2/3 ready · 1 CrashLoopBackOff", "latest production deploy failed"
  observedAt: z.string().optional(), // ISO time of the sync that read this state
  replicas: z.object({ ready: z.number(), desired: z.number() }).optional(), // workloads
  pods: z.object({ running: z.number(), pending: z.number(), crashLoop: z.number(), restarts: z.number() }).optional(), // kubernetes workloads
  url: z.string().optional(), // where it is served (Vercel/Netlify production URL, deployment URL)
  hosts: z.array(z.string()).optional(), // ingress hosts, custom domains, load balancer addresses
  createdAt: z.string().optional(), // ISO (deployments)
});

export const WorkItemSchema = z.object({
  id: z.string(), // "PLAT-123", "owner/repo#42"
  provider: z.string(), // known: jira | github
  title: z.string(),
  status: z.string(),
  url: z.string(),
  assignee: z.string().optional(),
  updatedAt: z.string(),
  linkedNodeIds: z.array(z.string()),
});

export const ProviderErrorSchema = z.object({ provider: z.string(), message: z.string() });

export const CloudSyncResultSchema = z.object({
  resources: z.array(CloudResourceSchema),
  syncedAt: z.string().nullable(), // null = never synced for this project
  errors: z.array(ProviderErrorSchema),
});

export type IntegrationFamily = (typeof INTEGRATION_FAMILIES)[number];
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export type IntegrationInfo = z.infer<typeof IntegrationInfoSchema>;
export type CloudResourceType = (typeof CLOUD_RESOURCE_TYPES)[number];
export type CloudHealth = (typeof CLOUD_HEALTH)[number];
export type CloudResource = z.infer<typeof CloudResourceSchema>;
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type ProviderError = z.infer<typeof ProviderErrorSchema>;
export type CloudSyncResult = z.infer<typeof CloudSyncResultSchema>;

// ---- request bodies (§6.2) -------------------------------------------------

const NodeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "invalid node id");

/** Jira: { site, email, token }; cloud: { account?, regions? }; github/ruah: {}. */
export const ConnectBodySchema = z.object({
  account: z.string().min(1).max(200).optional(),
  regions: z.array(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "invalid region")).max(30).optional(), // aws only
  site: z.string().min(1).max(300).optional(),
  email: z.string().min(3).max(300).optional(),
  token: z.string().min(1).max(4096).optional(),
});

export const CloudSyncBodySchema = z.object({
  providers: z.array(z.string()).max(10).optional(),
  accounts: z.record(z.string().min(1).max(200)).optional(),
});

export const CloudLinkBodySchema = z.object({
  resourceId: z.string().min(1).max(2048),
  nodeId: NodeId.nullable(),
});

export const WorkLinkBodySchema = z.object({
  provider: z.string().min(1).max(40),
  itemId: z.string().min(1).max(300),
  nodeId: NodeId,
  linked: z.boolean(),
});

export const WorkCreateBodySchema = z.object({
  provider: z.string().min(1).max(40),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/, "invalid Jira project key").optional(),
  repo: z.string().regex(/^([A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must be owner/name").optional(),
  issueType: z.string().min(1).max(60).optional(), // jira only, default "Task"
  title: z.string().trim().min(1).max(250),
  body: z.string().max(60_000),
  nodeId: NodeId,
});

export const RUAH_EXECUTORS = ["claude-code", "codex", "open-code", "aider"] as const;
export const RUAH_TASK_ACTIONS = ["start", "done", "merge", "cancel"] as const;
export const RuahTaskNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,63}$/, "task name must match ^[a-z0-9][a-z0-9-_]{0,63}$");

export const RuahTaskBodySchema = z.object({
  name: RuahTaskNameSchema,
  prompt: z.string().trim().min(1).max(20_000).refine((p) => !p.startsWith("-"), "prompt must not start with '-'"),
  files: z.array(z.string().min(1).max(500)).max(50).optional(),
  executor: z.enum(RUAH_EXECUTORS).optional(),
  nodeId: NodeId.optional(),
  start: z.boolean().optional(),
});

export type ConnectBody = z.infer<typeof ConnectBodySchema>;
export type CloudSyncBody = z.infer<typeof CloudSyncBodySchema>;
export type CloudLinkBody = z.infer<typeof CloudLinkBodySchema>;
export type WorkLinkBody = z.infer<typeof WorkLinkBodySchema>;
export type WorkCreateBody = z.infer<typeof WorkCreateBodySchema>;
export type RuahExecutor = (typeof RUAH_EXECUTORS)[number];
export type RuahTaskAction = (typeof RUAH_TASK_ACTIONS)[number];
export type RuahTaskBody = z.infer<typeof RuahTaskBodySchema>;

// ---- files ------------------------------------------------------------------

/** `<projectRoot>/.ruah/links.json` — committable, sorted, stable formatting. */
export const WorkLinkSchema = z.object({ nodeId: z.string(), provider: z.string(), itemId: z.string() });
export const LinksFileSchema = z.object({ version: z.literal(1), links: z.array(WorkLinkSchema) });
export type WorkLink = z.infer<typeof WorkLinkSchema>;
export type LinksFile = z.infer<typeof LinksFileSchema>;

/** `~/.ruah/projects/<projectId>/cloud.json` — last sync + manual links (null = explicitly unlinked). */
export const CloudCacheSchema = z.object({
  version: z.literal(1),
  syncedAt: z.string().nullable(),
  resources: z.array(CloudResourceSchema),
  errors: z.array(ProviderErrorSchema),
  manualLinks: z.record(z.string().nullable()),
});
export type CloudCache = z.infer<typeof CloudCacheSchema>;
