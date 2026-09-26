import { z } from "zod";
import { PreviewStatusSchema } from "./preview.js";
import type { Architecture } from "./architecture.js";
import { ArchitectureSchema } from "./architecture.js";
import { CloudResourceSchema, CloudScopeSummarySchema, ProviderErrorSchema } from "./integrations.js";
import { MapActorSchema, MapChangeSchema } from "./map.js";

// CONTRACTS.md §2.1 — field for field. Open unions use z.string() with the
// known literals documented; receivers ignore unknown type/kind values.
export const AgentStateSchema = z.enum(["starting", "idle", "busy", "error", "stopped"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const StopReasonSchema = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "error"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const ModeStateSchema = z.object({
  currentModeId: z.string(),
  available: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })),
});
export type ModeState = z.infer<typeof ModeStateSchema>;

// Same shape as ModeState: the models the agent offers and the active one.
export const ModelStateSchema = z.object({
  currentModelId: z.string(),
  available: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })),
});
export type ModelState = z.infer<typeof ModelStateSchema>;

// Which coding agent drives the session. `installed` is false when the CLI
// was not found on PATH (the viewer shows it disabled with an install hint).
export const AgentChoiceStateSchema = z.object({
  currentAgentId: z.string(), // "claude" | "cursor" | "grok" | "kiro" (open)
  available: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      installed: z.boolean(),
      description: z.string().optional(),
      installHint: z.string().optional(),
      /** Whether the agent accepts images in prompts (Claude SDK: true; ACP: promptCapabilities.image). Absent = not known yet. */
      images: z.boolean().optional(),
      /**
       * Pre-warm state of this agent for the open project (installed agents only):
       * "ready" = a live bridge is idle (agent.set is instant), "starting" = one is
       * starting (agent.set attaches to it), "cold" = nothing running.
       */
      warm: z.enum(["ready", "starting", "cold"]).optional(),
      /** Why the last pre-warm of this agent failed (it stays "cold"; the current agent is unaffected). */
      warmError: z.string().optional(),
      /** Models / modes last reported by this agent (non-current agents; the current one's are top-level). */
      models: ModelStateSchema.optional(),
      modes: ModeStateSchema.optional(),
    }),
  ),
});
export type AgentChoiceState = z.infer<typeof AgentChoiceStateSchema>;
export type WarmState = "ready" | "starting" | "cold";

// Saved per-agent defaults (settings.json): the agent used at startup, and the
// model / permission mode each agent starts with.
export const AgentDefaultsSchema = z.object({
  agentId: z.string(),
  models: z.record(z.string(), z.string()),
  modes: z.record(z.string(), z.string()),
});
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

export const ToolCallViewSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string(), // known: read | edit | delete | move | search | execute | think | fetch | switch_mode | other
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  locations: z.array(z.object({ path: z.string(), line: z.number().optional() })),
  command: z.string().optional(),
  output: z.string().optional(), // capped at 4096 chars, suffix " …[truncated]"
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;

export const PlanEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const PermissionOptionSchema = z.object({
  optionId: z.string(), // opaque, relay verbatim
  name: z.string(),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

export const StreamEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("thought"), text: z.string() }),
  z.object({ kind: z.literal("tool_call"), toolCall: ToolCallViewSchema }),
  z.object({ kind: z.literal("tool_result"), toolCall: ToolCallViewSchema }),
  z.object({
    kind: z.literal("diff"),
    toolCallId: z.string(),
    path: z.string(),
    oldText: z.string().nullable(),
    newText: z.string(),
  }),
  z.object({ kind: z.literal("plan"), entries: z.array(PlanEntrySchema) }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ErrorCodeSchema = z.enum([
  "bad_message",
  "save_rejected", // architecture.save failed validation or could not be written
  "unknown_node",
  "busy",
  "no_turn",
  "agent_spawn_failed",
  "agent_exited",
  "agent_protocol",
  "agent_request_failed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ---------- CONTRACTS.md §5.6: image attachments ----------
/** `<sha256 hex>.<ext>` as returned by POST /api/attachments. */
export const AttachmentIdSchema = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/, "invalid attachment id");
export const MAX_PROMPT_ATTACHMENTS = 8;

/** What a prompt references (the image itself was uploaded over HTTP). */
export const AttachmentRefSchema = z.object({ id: AttachmentIdSchema, name: z.string().max(200) });
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** What turn.started and TurnRecord carry so the viewer can show the images. */
export const AttachmentMetaSchema = z.object({ id: AttachmentIdSchema, name: z.string(), mimeType: z.string() });
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

// ---------- CONTRACTS.md §5.1: projects, chats, stored turns ----------
export const ProjectKindSchema = z.enum(["repo", "system"]);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

export const ProjectInfoSchema = z.object({
  id: z.string(), // stable: sha1(realpath(root)).slice(0, 12)
  name: z.string(), // architecture name, else folder name
  root: z.string(), // absolute path (repo dir, or the folder holding ruah.system.json)
  kind: ProjectKindSchema, // "system" = multi-repo (docs/MULTI-REPO.md)
  lastOpenedAt: z.string(), // ISO
  pinned: z.boolean().optional(),
  // §20: the pinned projects' explicit order (0 = ⌘1), set on pin and by POST /api/projects/reorder
  pinOrder: z.number().int().nonnegative().optional(),
  pinnedAt: z.string().optional(), // ISO, when it was pinned
  // §20: free-form groups (a client's name, "Job", "Freelance"); the first one is the project's group
  tags: z.array(z.string()).optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ChatInfoSchema = z.object({
  id: z.string(), // uuid
  projectId: z.string(),
  title: z.string(), // first prompt, trimmed to 80 chars, renameable
  agentId: z.string(), // agent used when the chat was created
  model: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turnCount: z.number(),
  lastNodeId: z.string().optional(),
});
export type ChatInfo = z.infer<typeof ChatInfoSchema>;

export const TurnRecordSchema = z.object({
  turnId: z.string(),
  nodeId: z.string().optional(), // absent = asked without an element as context
  text: z.string(),
  contextPack: z.string(),
  attachments: z.array(AttachmentMetaSchema).optional(),
  events: z.array(StreamEventSchema),
  mapChanges: z.array(MapChangeSchema).optional(), // §1.7: architecture edits the agent made in this turn
  stopReason: StopReasonSchema.optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** §13: only in chat.history — the turn is still running (events so far; stream frames continue it). Never stored. */
  running: z.literal(true).optional(),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

// ---------- CONTRACTS.md §13: activity feed, view state, feature settings ----------
/** Known kinds: turn.started | turn.finished | permission.requested | permission.answered | agent.error | map.changed (open). */
export type ActivityKind = "turn.started" | "turn.finished" | "permission.requested" | "permission.answered" | "agent.error" | "map.changed";

export const ActivityEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  projectRoot: z.string().optional(),
  chatId: z.string().nullable(),
  turnId: z.string().optional(),
  agentId: z.string().optional(),
  /** One line, at most 200 chars. */
  summary: z.string(),
  at: z.string(), // ISO
  /** Happened while its project (or chat) was not in front, or no viewer was connected. */
  background: z.boolean(),
  stopReason: StopReasonSchema.optional(),
  error: z.string().optional(),
  requestId: z.string().optional(),
  /** turn.finished: repo-relative files the agent edited (at most 20). */
  files: z.array(z.string()).optional(),
  /** turn.finished / map.changed: number of map changes. */
  mapChanges: z.number().optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ProjectActivitySchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  projectRoot: z.string().optional(),
  /** Turns running or queued (the open project's included). */
  running: z.number(),
  /** Permission requests waiting for an answer. */
  waitingPermission: z.number(),
  /** Unread turns / requests, summed over the project's chats (persisted in state.json). */
  unread: z.number(),
  /** Unread per chat id ("none" = a turn without a chat). */
  chats: z.record(z.string(), z.number()),
  lastEventAt: z.string().optional(),
});
export type ProjectActivity = z.infer<typeof ProjectActivitySchema>;

export const NotificationModeSchema = z.enum(["background", "always", "off"]);
export type NotificationMode = z.infer<typeof NotificationModeSchema>;
/**
 * §21.1: whether Ruah reads an agent app's saved login to show plan usage
 * (`usage.readAppLogins` in settings.json, default off); `source` says what
 * decided it — RUAH_USAGE_READ_LOGINS ("env") wins over the saved value.
 */
export const UsageSettingsViewSchema = z.object({
  readAppLogins: z.boolean(),
  source: z.enum(["settings", "env", "default"]),
});
export type UsageSettingsView = z.infer<typeof UsageSettingsViewSchema>;
/** Feature flags in $RUAH_HOME/settings.json (§13.6, §21.1). */
export const AppFeaturesSchema = z.object({
  backgroundAgents: z.boolean(),
  notifications: NotificationModeSchema,
  usage: UsageSettingsViewSchema,
});
export type AppFeatures = z.infer<typeof AppFeaturesSchema>;

// ---------- viewer -> daemon ----------
export const ClientMessageSchema = z.union([
  z.object({ type: z.literal("hello"), protocol: z.literal(1), client: z.string() }),
  z.object({ type: z.literal("architecture.get") }),
  z.object({ type: z.literal("focus.set"), nodeId: z.string().nullable() }),
  z.object({
    type: z.literal("prompt"),
    turnId: z.string(),
    /** Element the question is about; omitted = plain chat on the project, no context pack. */
    nodeId: z.string().optional(),
    text: z.string(),
    attachments: z.array(AttachmentRefSchema).max(MAX_PROMPT_ATTACHMENTS, `at most ${MAX_PROMPT_ATTACHMENTS} images per prompt`).optional(),
  }),
  z.union([
    z.object({ type: z.literal("permission.response"), requestId: z.string(), optionId: z.string() }),
    z.object({ type: z.literal("permission.response"), requestId: z.string(), cancelled: z.literal(true) }),
  ]),
  z.object({ type: z.literal("cancel"), turnId: z.string() }),
  z.object({ type: z.literal("session.reset") }),
  z.object({ type: z.literal("mode.set"), modeId: z.string() }),
  z.object({ type: z.literal("model.set"), modelId: z.string() }),
  z.object({ type: z.literal("agent.set"), agentId: z.string() }),
  // Start agents in the background (default: every installed agent but the current one) so agent.set is instant.
  z.object({ type: z.literal("agent.prewarm"), agentIds: z.array(z.string()).max(16).optional() }),
  // Settings → Agents: saved defaults (null clears an entry). Applies to agents started or bound later.
  z.object({
    type: z.literal("defaults.set"),
    agentId: z.string().optional(),
    models: z.record(z.string(), z.string().nullable()).optional(),
    modes: z.record(z.string(), z.string().nullable()).optional(),
  }),
  z.object({ type: z.literal("architecture.save"), architecture: ArchitectureSchema }),
  // §5.2 chats
  z.object({ type: z.literal("chat.new") }),
  z.object({ type: z.literal("chat.open"), chatId: z.string() }),
  z.object({ type: z.literal("chat.rename"), chatId: z.string(), title: z.string() }),
  z.object({ type: z.literal("chat.delete"), chatId: z.string() }),
  // §1.7: restore the elements an agent's turn changed (in-memory snapshot, this daemon's life)
  z.object({ type: z.literal("arch.undo"), turnId: z.string() }),
  // §9: this viewer is on the Cloud page or has "Show on map" on (the daemon re-syncs cloud providers while any viewer watches)
  z.object({ type: z.literal("cloud.watch"), on: z.boolean() }),
  // §13.2: clear unread markers (one chat, or the whole project)
  z.object({ type: z.literal("activity.read"), projectId: z.string().max(64), chatId: z.string().max(64).optional() }),
  // §13.5: the viewer's opaque per-project view state (a JSON object, ≤ 16 KB)
  z.object({ type: z.literal("view.save"), projectId: z.string().max(64), view: z.unknown() }),
  // §13.6: feature flags (settings.json)
  z.object({
    type: z.literal("settings.set"),
    backgroundAgents: z.boolean().optional(),
    notifications: NotificationModeSchema.optional(),
    /** §21.1 */
    usage: z.object({ readAppLogins: z.boolean().optional() }).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- daemon -> viewer ----------
export const ServerMessageSchema = z.union([
  z.object({
    type: z.literal("architecture"),
    reason: z.enum(["initial", "changed", "saved"]),
    revision: z.number(),
    root: z.string(),
    path: z.string(),
    architecture: ArchitectureSchema,
    by: MapActorSchema.optional(), // §1.7: who saved it (reason "saved"); absent = unknown / file edit
    changes: z.array(MapChangeSchema).optional(), // §1.7: what an agent op or an undo changed
  }),
  z.object({ type: z.literal("architecture.error"), path: z.string(), message: z.string() }),
  z.object({
    type: z.literal("agent.status"),
    state: AgentStateSchema,
    agent: z.object({ name: z.string(), version: z.string() }).optional(),
    sessionId: z.string().optional(),
    modes: ModeStateSchema.optional(),
    models: ModelStateSchema.optional(),
    agents: AgentChoiceStateSchema.optional(),
    error: z.string().optional(),
    /** Saved defaults (~/.ruah/settings.json) merged with the built-in edit-without-asking modes. */
    defaults: AgentDefaultsSchema.optional(),
  }),
  z.object({
    type: z.literal("turn.started"),
    turnId: z.string(),
    nodeId: z.string().optional(),
    contextPack: z.string(),
    text: z.string(),
    attachments: z.array(AttachmentMetaSchema).optional(),
    /** The agent is still starting: the prompt waits and is sent once it is idle (a second turn.started follows without it). */
    queued: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("stream"), turnId: z.string(), event: StreamEventSchema }),
  z.object({
    type: z.literal("permission.request"),
    turnId: z.string(),
    requestId: z.string(),
    toolCall: ToolCallViewSchema,
    options: z.array(PermissionOptionSchema),
  }),
  z.object({
    type: z.literal("permission.resolved"),
    turnId: z.string(),
    requestId: z.string(),
    optionId: z.string().optional(),
    cancelled: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("turn.finished"), turnId: z.string(), stopReason: StopReasonSchema, error: z.string().optional() }),
  z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    turnId: z.string().optional(),
    requestId: z.string().optional(),
    fatal: z.boolean().optional(),
  }),
  // §5.2: null = launcher state (no architecture message follows)
  z.object({ type: z.literal("project"), project: ProjectInfoSchema.nullable() }),
  z.object({ type: z.literal("chats"), projectId: z.string(), chats: z.array(ChatInfoSchema), activeChatId: z.string().nullable() }),
  z.object({ type: z.literal("chat.history"), chatId: z.string(), turns: z.array(TurnRecordSchema) }),
  // §9: after every cloud sync (watch loop or Sync button) and link change; resources absent = nothing visible changed
  z.object({
    type: z.literal("cloud.updated"),
    root: z.string(),
    syncedAt: z.string().nullable(),
    providers: z.array(z.string()),
    failed: z.array(z.string()),
    errors: z.array(ProviderErrorSchema),
    resources: z.array(CloudResourceSchema).optional(),
    scope: CloudScopeSummarySchema.optional(), // §14: the project's accounts and scope files
  }),
  // §13.2: sent to every viewer, whatever project is open
  z.object({ type: z.literal("activity"), event: ActivityEventSchema, project: ProjectActivitySchema }),
  // §13.2: a project's counts changed without an event (unread markers cleared)
  z.object({ type: z.literal("activity.project"), project: ProjectActivitySchema }),
  z.object({
    type: z.literal("activity.snapshot"),
    projects: z.array(ProjectActivitySchema),
    recent: z.array(ActivityEventSchema),
    settings: AppFeaturesSchema,
    maxBackgroundTurns: z.number(),
  }),
  // §18: the live preview of a project's dev server changed (every viewer; filter by status.projectId)
  z.object({ type: z.literal("preview"), status: PreviewStatusSchema }),
  // §20: the recent list changed without a switch (pin, unpin, reorder, tags, forget) — every viewer
  z.object({ type: z.literal("projects.changed"), recent: z.array(ProjectInfoSchema) }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type ArchInput = Architecture;
export const ArchSchema = ArchitectureSchema;
