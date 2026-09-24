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
/** Cloud provider ids the daemon registers (§6, §9, §10); a sync body may name all of them. */
export const KNOWN_CLOUD_PROVIDERS = [
  "digitalocean", "aws", "vercel", "supabase", "kubernetes", "netlify", "hetzner",
  "gcp", "azure", "cloudflare", "railway", "fly",
] as const;
/** §9: every provider's native states normalized for "is it up right now?". */
export const CLOUD_HEALTH = ["healthy", "degraded", "down", "deploying", "unknown"] as const;
/** §14: how sure Ruah is that a resource belongs to the open project (strongest first). */
export const SCOPE_CONFIDENCE = ["manual", "proof", "likely", "weak"] as const;

export const IntegrationAccountSchema = z.object({ id: z.string(), label: z.string() });

export const IntegrationInfoSchema = z.object({
  id: z.string(), // known: digitalocean | aws | vercel | supabase | kubernetes | netlify | hetzner | jira | github | ruah
  family: z.enum(INTEGRATION_FAMILIES),
  name: z.string(),
  status: z.enum(INTEGRATION_STATUSES),
  detail: z.string().optional(),
  setupHint: z.string().optional(),
  accounts: z.array(IntegrationAccountSchema).optional(),
  installCommand: z.string().optional(), // §10: exact Homebrew install command of the provider CLI
  loginCommand: z.string().optional(), // §10: exact CLI login command
});

export const CloudResourceTypeSchema = z.enum(CLOUD_RESOURCE_TYPES);

/** §14: membership of a resource in the open project's cloud scope (attached on every read). */
export const ResourceScopeSchema = z.object({
  in: z.boolean(), // counted as this project's (proof, likely, manual include or a whole account; never when excluded)
  confidence: z.enum(SCOPE_CONFIDENCE).optional(), // strongest evidence; absent = none. "weak" + in:false = a suggestion
  reasons: z.array(z.string()), // "from .do/app.yaml", "tag project=acme", "in Terraform (digitalocean_app.web)", "added by you"
  excluded: z.boolean().optional(), // removed by the user (wins over any evidence)
});

export const CloudResourceSchema = z.object({
  id: z.string(), // provider-native id (ARN, DO URN)
  provider: z.string(), // known: KNOWN_CLOUD_PROVIDERS
  type: CloudResourceTypeSchema,
  service: z.string(), // "droplet", "apps", "ec2", "lambda", "rds", …
  name: z.string(),
  region: z.string().optional(),
  status: z.string().optional(),
  tags: z.record(z.string()).optional(),
  consoleUrl: z.string().optional(),
  url: z.string().optional(), // §9/§10: public URL it serves (Cloud Run, Pages, Fly app, Vercel/Netlify production, ingress, …)
  linkedNodeId: z.string().optional(),
  linkSource: z.enum(["tag", "name", "manual"]).optional(), // how linkedNodeId was decided
  // §9 live status (all optional; absent = the provider has no health notion for it)
  health: z.enum(CLOUD_HEALTH).optional(),
  healthDetail: z.string().optional(), // "2/3 ready · 1 CrashLoopBackOff", "latest production deploy failed"
  observedAt: z.string().optional(), // ISO time of the sync that read this state
  replicas: z.object({ ready: z.number(), desired: z.number() }).optional(), // workloads
  pods: z.object({ running: z.number(), pending: z.number(), crashLoop: z.number(), restarts: z.number() }).optional(), // kubernetes workloads
  hosts: z.array(z.string()).optional(), // ingress hosts, custom domains, load balancer addresses
  createdAt: z.string().optional(), // ISO (deployments)
  account: z.string().optional(), // §14: the account (team / context / profile …) it was synced from, when one was named
  scope: ResourceScopeSchema.optional(), // §14: set on reads for an open project; never stored in the cache
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

// ---- §14 per-project cloud scope ----------------------------------------------

/** One provider account that belongs to the project (`.ruah/cloud.json` `accounts[]`). */
export const ScopeAccountSchema = z.object({
  provider: z.string().min(1).max(40),
  account: z.string().min(1).max(200).optional(), // absent = the provider's selected / default account
  whole: z.boolean().optional(), // true = everything in this account is the project's; default: only what matches the repo
});

/** A resource the user added to / removed from the project; the name only helps humans reading diffs. */
export const ScopeResourceRefSchema = z.union([
  z.string().min(1).max(2048),
  z.object({ id: z.string().min(1).max(2048), provider: z.string().max(40).optional(), name: z.string().max(300).optional() }),
]);

/** `<repo>/.ruah/cloud.json` — committable, no secrets, stable formatting. */
export const ScopeFileSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(200).optional(), // project name for `project=<name>` tags (default: repo / package names)
  accounts: z.array(ScopeAccountSchema).max(200).optional(),
  include: z.array(ScopeResourceRefSchema).max(5000).optional(),
  exclude: z.array(ScopeResourceRefSchema).max(5000).optional(),
});

export const ScopeFileStatusSchema = z.object({
  repo: z.string().optional(), // system repo id; absent = the project (or system) folder itself
  path: z.string(), // absolute path of the .ruah/cloud.json
  exists: z.boolean(),
  error: z.string().optional(), // invalid file: reported, treated as empty, never overwritten
});

export const ScopeAccountEntrySchema = ScopeAccountSchema.extend({ repo: z.string().optional() });

/** What the viewer needs besides the per-resource `scope`: accounts and the files they came from. */
export const CloudScopeSummarySchema = z.object({
  configured: z.boolean(), // some scope file lists accounts, includes or excludes
  accounts: z.array(ScopeAccountEntrySchema), // union over the project's files (repo = which system repo listed it)
  files: z.array(ScopeFileStatusSchema),
  writable: z.boolean(), // false while the file edits go to is invalid
});

export const CloudSyncResultSchema = z.object({
  resources: z.array(CloudResourceSchema),
  syncedAt: z.string().nullable(), // null = never synced for this project
  errors: z.array(ProviderErrorSchema),
  scope: CloudScopeSummarySchema.optional(), // §14: present when a project is open
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
export type ScopeConfidence = (typeof SCOPE_CONFIDENCE)[number];
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export type ScopeAccount = z.infer<typeof ScopeAccountSchema>;
export type ScopeAccountEntry = z.infer<typeof ScopeAccountEntrySchema>;
export type ScopeResourceRef = z.infer<typeof ScopeResourceRefSchema>;
export type ScopeFile = z.infer<typeof ScopeFileSchema>;
export type ScopeFileStatus = z.infer<typeof ScopeFileStatusSchema>;
export type CloudScopeSummary = z.infer<typeof CloudScopeSummarySchema>;

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
  providers: z.array(z.string()).max(KNOWN_CLOUD_PROVIDERS.length).optional(),
  accounts: z.record(z.string().min(1).max(200)).optional(),
});

export const CloudLinkBodySchema = z.object({
  resourceId: z.string().min(1).max(2048),
  nodeId: NodeId.nullable(),
});

/** §14 POST /api/cloud/scope/accounts: replaces the project's account list. */
export const ScopeAccountsBodySchema = z.object({ accounts: z.array(ScopeAccountSchema).max(200) });
export const SCOPE_RESOURCE_ACTIONS = ["include", "exclude", "reset"] as const;
/** §14 POST /api/cloud/scope/resource: include (add / accept a suggestion), exclude (remove / reject), reset (back to the evidence). */
export const ScopeResourceBodySchema = z.object({ resourceId: z.string().min(1).max(2048), action: z.enum(SCOPE_RESOURCE_ACTIONS) });

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
export type ScopeAccountsBody = z.infer<typeof ScopeAccountsBodySchema>;
export type ScopeResourceAction = (typeof SCOPE_RESOURCE_ACTIONS)[number];
export type ScopeResourceBody = z.infer<typeof ScopeResourceBodySchema>;
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
