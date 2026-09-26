// Contract types shared with the ruah daemon (ruah/docs/CONTRACTS.md §1.1 and §2.1).
// Copied from the Lovable prompt L1. Where the prompt text and the daemon's zod schemas
// (ruah/src/contracts/ws.ts) disagree, the zod schemas win: ToolCallView.kind is an
// open string there, so it is an open union here too.

import type { PreviewStatus } from "./preview-types";

// architecture.json (CONTRACTS.md §1.1)
export type NodeType =
  | "service"
  | "module"
  | "datastore"
  | "external"
  | "step" // from the brief
  | "frontend"
  | "gateway"
  | "queue"
  | "file" // added: the viewer already styles these kinds
  | (string & {}); // open; unknown types render as "module"

export interface ArchNode {
  id: string;
  type: NodeType;
  name: string;
  description?: string; // 1–2 sentences, <= 400 chars. Copied verbatim into the context pack.
  notes?: string; // user-authored, markdown allowed, any length. Context pack takes the first 600 chars.
  tech?: string[]; // e.g. ["Node 22", "Express", "Postgres"]
  path?: string; // directory or file. The node's address in the repo.
  files?: string[]; // <= 20 entries, most relevant first. Context pack lists the first 12.
  layer?: string; // must appear in Architecture.layers
  parent?: string; // id of the containing node. Absent = top level. Enables drill-down.
  x?: number; // canvas units (px at zoom 1). Daemon fills both when missing; viewer never lays out.
  y?: number;
  repo?: string; // multi-repo systems: id of the owning repo in ruah.system.json
  origin?: "scan" | "user" | "agent" | (string & {}); // §1.7: "agent" = drawn by a coding agent (marked until kept)
  infra?: InfraDetails; // §11: infrastructure-as-code details (round-tripped untouched)
}

// CONTRACTS §11: what an infrastructure-as-code element is and where it is declared.
export interface InfraDetails {
  tool: "terraform" | "kubernetes" | "kustomize" | "helm" | "ansible" | "compose" | "docker" | "ci" | (string & {});
  kind: string; // aws_db_instance | Deployment | hosts | workflow | Dockerfile | provider | environment …
  address?: string; // aws_db_instance.main | prod/Deployment/api
  source?: string[]; // "path:line"
  settings?: Record<string, string>; // replicas, image, instance_class, …
  details?: string[]; // folded resources / objects
  hints?: string[]; // names live cloud resources may carry
}

export interface ArchEdge {
  from: string; // node id
  to: string; // node id
  label?: string; // <= 40 chars, rendered on the edge
  kind?: "sync" | "async" | "event" | "data" | (string & {});
  source?: "scan" | "suggested" | "manual" | "agent" | (string & {}); // provenance; absent = manual
  evidence?: string[]; // "path:line" strings backing a scanned or suggested edge
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: string[]; // node ids in order, >= 2 entries. Consecutive steps are drawn as arrows.
  source?: "scan" | (string & {}); // §11: "scan" = derived by the scanner ("how it ships"), replaced on re-scan
}

export interface Architecture {
  version: 1;
  name: string; // display name, usually the repo directory name
  generatedBy?: string; // e.g. "ruah app scan 0.1.0"
  generatedAt?: string;
  layers?: string[]; // drawn as labelled groups; order = drawing order
  nodes: ArchNode[];
  edges: ArchEdge[];
  workflows: Workflow[];
}

// viewer <-> daemon WebSocket messages (CONTRACTS.md §2.1)
// ---------- viewer -> daemon ----------
export type ClientMessage =
  | { type: "hello"; protocol: 1; client: string } // first frame. client = "architects-canvas/<version>"
  | { type: "architecture.get" } // re-request current file
  | { type: "focus.set"; nodeId: string | null } // selection changed (daemon logs it; MCP exposes it)
  | {
      type: "prompt";
      turnId: string;
      nodeId?: string; // omitted = plain chat on the project, no element context
      text: string;
      attachments?: AttachmentRef[]; // ≤ 8 images uploaded via POST /api/attachments (§5.6)
    } // turnId: viewer-generated UUID
  | { type: "permission.response"; requestId: string; optionId: string } // optionId must be one of the offered options
  | { type: "permission.response"; requestId: string; cancelled: true } // user dismissed
  | { type: "cancel"; turnId: string }
  | { type: "session.reset" } // Phase 3: new ACP session (drops agent memory)
  | { type: "mode.set"; modeId: string } // Phase 3: session/set_mode
  | { type: "model.set"; modelId: string } // switch the agent's model (one of agent.status.models.available)
  | { type: "agent.set"; agentId: string } // switch coding agent (one of agent.status.agents.available); instant when warm
  | { type: "agent.prewarm"; agentIds?: string[] } // start agents in the background (default: all installed but the current) (§5.7)
  | {
      type: "defaults.set";
      agentId?: string;
      models?: Record<string, string | null>;
      modes?: Record<string, string | null>;
    } // Settings → Agents: saved defaults (§5.7); null clears
  | { type: "architecture.save"; architecture: Architecture } // Phase 3: daemon validates + writes the file
  // §5.2 chats (turns always belong to the active chat; new/open cancel a running turn first)
  | { type: "chat.new" }
  | { type: "chat.open"; chatId: string }
  | { type: "chat.rename"; chatId: string; title: string }
  | { type: "chat.delete"; chatId: string }
  // §1.7: undo the map changes an agent made in a turn
  | { type: "arch.undo"; turnId: string }
  // §9: on the Cloud page / "Show on map" on → the daemon keeps cloud status fresh while any viewer watches
  | { type: "cloud.watch"; on: boolean }
  // §13: clear unread markers (a chat, or the whole project); save the view state; feature flags
  | { type: "activity.read"; projectId: string; chatId?: string }
  | { type: "view.save"; projectId: string; view: ViewState }
  | { type: "settings.set"; backgroundAgents?: boolean; notifications?: NotificationMode };

// ---------- daemon -> viewer ----------
export type ServerMessage =
  | {
      type: "architecture";
      reason: "initial" | "changed" | "saved";
      revision: number;
      root: string;
      path: string;
      architecture: Architecture;
      by?: MapActor; // §1.7: who saved it (reason "saved")
      changes?: MapChange[]; // §1.7: what an agent op / undo changed
    } // root = absolute repo dir on the daemon host
  | { type: "architecture.error"; path: string; message: string } // file invalid; previous revision stays live
  | {
      type: "agent.status";
      state: AgentState;
      agent?: { name: string; version: string };
      sessionId?: string;
      modes?: ModeState;
      models?: ModelState; // absent when the agent does not offer a model choice
      agents?: AgentChoiceState; // absent when the daemon cannot switch agents
      error?: string;
      defaults?: AgentDefaults; // saved defaults (§5.7)
    }
  | {
      type: "turn.started";
      turnId: string;
      nodeId?: string;
      contextPack: string;
      text: string;
      attachments?: AttachmentMeta[];
      queued?: true; // the agent is still starting; sent (and re-announced without it) once idle
    }
  | { type: "stream"; turnId: string; event: StreamEvent }
  | {
      type: "permission.request";
      turnId: string;
      requestId: string;
      toolCall: ToolCallView;
      options: PermissionOption[];
    }
  | {
      type: "permission.resolved";
      turnId: string;
      requestId: string;
      optionId?: string;
      cancelled?: true;
    }
  | { type: "turn.finished"; turnId: string; stopReason: StopReason; error?: string }
  | {
      type: "error";
      code: ErrorCode;
      message: string;
      turnId?: string;
      requestId?: string;
      fatal?: boolean;
    }
  // §5.2 projects + chats
  | { type: "project"; project: ProjectInfo | null } // null = launcher state (no architecture follows)
  | { type: "chats"; projectId: string; chats: ChatInfo[]; activeChatId: string | null }
  | { type: "chat.history"; chatId: string; turns: TurnRecord[] }
  // §9: after every cloud sync / link change; resources absent = nothing visible changed
  | {
      type: "cloud.updated";
      root: string;
      syncedAt: string | null;
      providers: string[];
      failed: string[];
      errors: { provider: string; message: string }[];
      resources?: CloudResource[];
      scope?: CloudScopeSummary; // §14
    }
  // §13 activity feed: every viewer, whatever project is open
  | { type: "activity"; event: ActivityEvent; project: ProjectActivity }
  | { type: "activity.project"; project: ProjectActivity }
  | {
      type: "activity.snapshot";
      projects: ProjectActivity[];
      recent: ActivityEvent[];
      settings: AppFeatures;
      maxBackgroundTurns: number;
    }
  // §18: the live preview of a project's dev server changed (every viewer; filter by projectId)
  | { type: "preview"; status: PreviewStatus }
  // §20: the recent list changed without a switch (pin, unpin, reorder, tags, forget) — every viewer
  | { type: "projects.changed"; recent: ProjectInfo[] };

export type AgentState = "starting" | "idle" | "busy" | "error" | "stopped";
export type StopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";

export interface ModeState {
  currentModeId: string; // Claude adapter: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions"
  available: { id: string; name: string; description?: string }[];
}

/** Same shape as ModeState: the models the agent offers and the active one. */
export interface ModelState {
  currentModelId: string;
  available: { id: string; name: string; description?: string }[];
}

/** The coding agents the daemon can run (Claude Code, Cursor Agent, …) and the active one. */
export interface AgentChoiceState {
  currentAgentId: string;
  available: {
    id: string;
    name: string;
    installed: boolean;
    description?: string;
    installHint?: string; // shown when installed is false
    images?: boolean; // takes images in prompts (§5.6); absent = not known yet
    warm?: WarmState; // installed agents, open project (§5.7)
    warmError?: string; // why the last pre-warm failed
    models?: ModelState; // last reported by that agent (non-current agents)
    modes?: ModeState;
  }[];
}

/** Pre-warm state of an agent: ready = switching is instant, starting = on its way, cold = not running. */
export type WarmState = "ready" | "starting" | "cold";

/** Saved defaults (daemon settings.json, §5.7); modes include the built-in edit-without-asking modes. */
export interface AgentDefaults {
  agentId: string;
  models: Record<string, string>;
  modes: Record<string, string>;
}

// Image attachments (CONTRACTS.md §5.6)
/** POST /api/attachments answer. id = "<sha256>.<png|jpg|gif|webp>". */
export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}
/** What a prompt references. */
export interface AttachmentRef {
  id: string;
  name: string;
}
/** What turn.started / TurnRecord carry. */
export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
}

export type StreamEvent =
  | { kind: "text"; text: string } // ACP agent_message_chunk with text content, forwarded per chunk
  | { kind: "thought"; text: string } // ACP agent_thought_chunk
  | { kind: "tool_call"; toolCall: ToolCallView } // ACP tool_call, or tool_call_update while status is pending/in_progress
  | { kind: "tool_result"; toolCall: ToolCallView } // ACP tool_call_update whose merged status is completed/failed
  | { kind: "diff"; toolCallId: string; path: string; oldText: string | null; newText: string } // ACP ToolCallContent type "diff"
  | { kind: "plan"; entries: PlanEntry[] }; // ACP plan; replaces the whole plan

export interface ToolCallView {
  toolCallId: string;
  title: string;
  // zod (ws.ts) keeps this open: z.string(). Unknown kinds render like "other".
  kind:
    | "read"
    | "edit"
    | "delete"
    | "move"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "switch_mode"
    | "other"
    | (string & {});
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: { path: string; line?: number }[]; // repo-relative when inside root, else absolute
  command?: string; // rawInput.command when kind === "execute"
  output?: string; // concatenated text content, capped at 4096 chars, suffix " …[truncated]"
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionOption {
  optionId: string; // opaque, relay verbatim
  name: string; // button label
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type ErrorCode =
  | "bad_message" // frame failed validation
  | "save_rejected" // architecture.save failed validation or could not be written
  | "unknown_node" // prompt.nodeId not in current architecture
  | "busy" // a turn is active; prompt rejected
  | "no_turn" // cancel/permission.response for an unknown turn or request
  | "agent_spawn_failed" // fatal
  | "agent_exited" // fatal until the daemon respawns (it retries once)
  | "agent_protocol" // malformed ACP traffic
  | "agent_request_failed" // ACP JSON-RPC error on initialize/session/prompt
  | "internal";

// Projects, launcher and chats (CONTRACTS.md §5)
export interface ProjectInfo {
  id: string; // stable: sha1(realpath(root)).slice(0, 12)
  name: string; // architecture name, else folder name
  root: string; // absolute path (repo dir, or the folder holding ruah.system.json)
  kind: "repo" | "system"; // "system" = multi-repo (docs/MULTI-REPO.md)
  lastOpenedAt: string; // ISO
  pinned?: boolean;
  pinOrder?: number; // §20: the pinned projects' explicit order (0 = ⌘1)
  pinnedAt?: string; // §20: ISO, when it was pinned
  tags?: string[]; // §20: free-form groups (a client, "Job"); the first is the project's group
}

export interface ChatInfo {
  id: string; // uuid
  projectId: string;
  title: string; // first prompt, trimmed to 80 chars, renameable
  agentId: string; // agent used when the chat was created
  model?: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  lastNodeId?: string;
}

/** What the viewer needs to redraw a past turn. */
export interface TurnRecord {
  turnId: string;
  nodeId?: string; // absent = asked without an element as context
  text: string;
  contextPack: string;
  attachments?: AttachmentMeta[];
  events: StreamEvent[];
  mapChanges?: MapChange[]; // §1.7: map edits the agent made in this turn
  stopReason?: StopReason;
  startedAt: string;
  finishedAt?: string;
  /** §13: only in chat.history — the turn is still running (a background turn re-attached, or a reload). */
  running?: true;
}

// §13 background agents, activity feed, resume, view state (CONTRACTS.md §13)
export type ActivityKind =
  | "turn.started"
  | "turn.finished"
  | "permission.requested"
  | "permission.answered"
  | "agent.error"
  | "map.changed"
  | (string & {});

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  projectId: string;
  projectName: string;
  projectRoot?: string;
  chatId: string | null;
  turnId?: string;
  agentId?: string;
  summary: string; // one line
  at: string; // ISO
  /** Happened while its project / chat was not in front (or no viewer was connected). */
  background: boolean;
  stopReason?: StopReason;
  error?: string;
  requestId?: string;
  files?: string[];
  mapChanges?: number;
}

export interface ProjectActivity {
  projectId: string;
  projectName: string;
  projectRoot?: string;
  running: number;
  waitingPermission: number;
  unread: number;
  chats: Record<string, number>; // unread per chat id ("none" = no chat)
  lastEventAt?: string;
}

export type NotificationMode = "background" | "always" | "off";
export interface AppFeatures {
  backgroundAgents: boolean;
  notifications: NotificationMode;
}

/** §13.5: viewer-owned, opaque to the daemon (a JSON object, ≤ 16 KB serialized). */
export type ViewState = Record<string, unknown>;

export type GitState =
  | {
      available: true;
      branch: string | null;
      head: string | null;
      upstream: string | null;
      ahead: number | null;
      behind: number | null;
      dirty: number;
      dirtyPaths: string[];
      lastCommit: { hash: string; subject: string; author: string; at: string } | null;
    }
  | { available: false; reason: string };

export interface ResumeInfo {
  project: { id: string; name: string; root: string; kind: "repo" | "system"; lastOpenedAt: string | null };
  lastViewedAt: string | null;
  lastChat: {
    id: string;
    title: string;
    agentId: string;
    updatedAt: string;
    turnCount: number;
    lastPrompt: string | null;
    lastReply: string | null;
  } | null;
  lastFocus: { nodeId: string; name: string; at?: string } | null;
  since: {
    from: string | null;
    turnsFinished: number;
    turnsFailed: number;
    permissionsRequested: number;
    files: string[];
    filesTotal: number;
    mapChanges: number;
    events: ActivityEvent[];
  };
  unread: number;
  live?: { running: number; waitingPermission: number };
  git: GitState;
  ruah:
    | { initialized: false }
    | { initialized: true; tasks: { name: string; status: string; executor?: string; files?: string[] }[]; error?: string };
  view: ViewState | null;
  attention: number;
}

// §1.7 map edits by agents
export interface MapActor {
  kind: "agent" | "user" | "scan" | (string & {});
  agentId?: string;
  turnId?: string;
  undo?: boolean;
}

export interface MapChange {
  action:
    | "add"
    | "update"
    | "remove"
    | "connect"
    | "disconnect"
    | "move"
    | "add_workflow"
    | "update_workflow"
    | "remove_workflow"
    | (string & {});
  target: "element" | "link" | "workflow" | (string & {});
  id: string; // element id, workflow id, or "<from>-><to>"
  name: string; // display text
  level?: string | null; // parent id of the element (links: of `from`); null = top level
  fields?: string[];
  from?: string;
  to?: string;
  label?: string;
}

/** GET /api/projects */
export interface ProjectsResponse {
  current: ProjectInfo | null;
  recent: ProjectInfo[]; // most recent first, pinned on top
}

// §20 new project wizard, pinned order, tags, Home overview

export type GithubVisibility = "private" | "public";

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  files: string[]; // top-level entries it writes (folders end with "/")
  run?: string; // "pnpm install && pnpm dev"
  setupPrompt: string; // the suggested first prompt for the agent
}

/** GET /api/projects/new */
export interface NewProjectDefaults {
  parentDir: string;
  /** Where `parentDir` came from (absent from daemons before the 2026-09-26 review fixes). */
  parentSource?: "remembered" | "projects" | "recent" | "home";
  home: string;
  templates: TemplateInfo[];
  git: { installed: boolean; identity: boolean };
}

/** GET /api/projects/new/github */
export interface GithubToolStatus {
  installed: boolean;
  loggedIn: boolean;
  login?: string;
}

/** POST /api/projects/new/check */
export interface NewProjectCheck {
  path: string;
  ok: boolean;
  name: { ok: boolean; error?: string };
  /** `path`: the resolved location (a relative one is taken from the daemon's home). */
  parent: { path?: string; exists: boolean; isDir: boolean; writable: boolean };
  target: { exists: boolean; empty?: boolean };
  problems: string[];
}

export interface CreateProjectInput {
  parentDir: string;
  name: string;
  git?: boolean;
  template?: string;
  commit?: boolean;
  github?: { visibility: GithubVisibility; name?: string };
  system?: string;
  createParent?: boolean;
}

export interface CreateReport {
  path: string;
  template: string;
  files: number;
  scanned: { nodes: number; edges: number } | null;
  git: { init: boolean; branch: string | null; commit: string | null; warning?: string } | null;
  github: { command: string[]; ran: boolean; url?: string; error?: string } | null;
  system: { root: string; repoId: string | null; error?: string } | null;
  warnings: string[];
}

/** POST /api/projects/create */
export type CreateResult = ProjectInfo & { created?: CreateReport };

export interface OverviewPermission {
  requestId: string;
  turnId: string;
  chatId: string | null;
  title: string;
  options: PermissionOption[];
}

export interface OverviewCloud {
  inScope: number;
  healthy: number;
  degraded: number;
  down: number;
  deploying: number;
  unhealthy: string[];
  syncedAt: string | null;
}

/** One card of GET /api/projects/overview (§20.5). */
export interface ProjectOverview {
  project: ProjectInfo;
  current: boolean;
  exists: boolean;
  lastViewedAt: string | null;
  lastChat: {
    id: string;
    title: string;
    agentId: string;
    updatedAt: string;
    turnCount: number;
    lastPrompt: string | null;
    lastReply: string | null;
  } | null;
  since: {
    from: string | null;
    turnsFinished: number;
    turnsFailed: number;
    permissionsRequested: number;
    filesTotal: number;
    mapChanges: number;
  };
  lastEvent: ActivityEvent | null;
  unread: number;
  live: { running: number; waitingPermission: number };
  permissions: OverviewPermission[];
  git: GitState;
  cloud: OverviewCloud | null;
  preview: { state: "stopped" | "starting" | "running" | "crashed"; url: string | null; exitCode: number | null } | null;
}

export interface ProjectsOverview {
  at: string;
  projects: ProjectOverview[];
}

/** GET /api/chats/recent */
export type RecentChat = ChatInfo & { projectName: string; projectRoot: string };
export interface RecentChatsResponse {
  chats: RecentChat[];
}

/** §5.4 desktop bridge (Electron preload). Absent in a plain browser. */
export interface RuahDesktopBridge {
  version: string;
  pickFolder(opts?: { title?: string }): Promise<string | null>;
  revealInFinder(path: string): void;
  /** §7.5: opens an http(s) URL in the default browser (older desktop builds lack it). */
  openExternal?(url: string): void;
  /** §13.3: OS notification (older desktop builds lack it); resolves false when not shown. */
  notify?(opts: NotificationRequest): Promise<boolean>;
  /** §13.3: a notification was clicked (the window is already focused); returns an unsubscribe function. */
  onNotificationClick?(callback: (target: NotificationTarget) => void): () => void;
  /** ⌥Space anywhere focuses Ruah and opens the launcher (Settings; off by default). Resolves
   * whether the shortcut is registered (false: off, or another app owns it). Older builds lack it. */
  setLauncherShortcut?(on: boolean): Promise<boolean>;
  /** The global launcher shortcut was pressed (the window is already focused). */
  onLauncherShortcut?(callback: () => void): () => void;
  /** §18.6: the window allows <webview> for the live preview (pages that refuse iframes). */
  previewWebview?: boolean;
  /** §19.4: application-menu commands ("settings"); subscribing replaces the preload's default (routing to /settings). Returns an unsubscribe function. */
  onMenuCommand?(callback: (command: string) => void): () => void;
}

export interface NotificationTarget {
  projectId: string;
  chatId: string | null;
  projectRoot: string | null;
}

export interface NotificationRequest {
  title: string;
  body: string;
  projectId: string;
  chatId?: string | null;
  projectRoot?: string;
  silent?: boolean;
}

declare global {
  interface Window {
    ruah?: RuahDesktopBridge;
  }
}

// Integrations (CONTRACTS.md §6.1): cloud, work items, ruah orchestration.
export interface IntegrationInfo {
  id: "digitalocean" | "aws" | "jira" | "github" | "ruah" | (string & {});
  family: "cloud" | "work" | "orchestration";
  name: string;
  status: "connected" | "not_connected" | "cli_missing" | "error";
  detail?: string; // e.g. "doctl context: default", "AWS CLI not installed"
  setupHint?: string; // what the user runs / enters to connect
  accounts?: { id: string; label: string }[]; // aws profiles, doctl contexts, jira sites
  /** §10: exact Homebrew install command of the provider CLI (gcp, azure, cloudflare, railway, fly). */
  installCommand?: string;
  /** §10: exact CLI login command ("gcloud auth login", "az login", …). */
  loginCommand?: string;
}

export type CloudResourceType =
  | "compute"
  | "container"
  | "function"
  | "app"
  | "database"
  | "cache"
  | "queue"
  | "storage"
  | "loadbalancer"
  | "gateway"
  | "cdn"
  | "dns"
  | "kubernetes"
  | "other";

export interface CloudResource {
  id: string; // provider-native id (ARN, DO URN)
  provider: "digitalocean" | "aws" | "gcp" | "azure" | "cloudflare" | "vercel" | "supabase" | "kubernetes" | "railway" | "fly" | "netlify" | "hetzner" | (string & {});
  type: CloudResourceType;
  service: string; // "droplet", "apps", "ec2", "lambda", "rds", …
  name: string;
  region?: string;
  status?: string;
  tags?: Record<string, string>;
  consoleUrl?: string;
  url?: string; // §9/§10: public URL it serves (Cloud Run, Pages, Fly app, Vercel/Netlify production, ingress, …)
  linkedNodeId?: string; // architecture element it runs (tag ruah:node, name match, or manual)
  /** Viewer extension (optional, not in §6.1 yet): how linkedNodeId was set. Absent = automatic. */
  linkSource?: "tag" | "name" | "manual";
  // §9 live status (optional; absent = the provider has no health notion for this resource)
  health?: CloudHealth;
  healthDetail?: string; // "2/3 ready · 1 crash-looping", "latest production deployment failed"
  observedAt?: string; // ISO time of the sync that read it
  replicas?: { ready: number; desired: number };
  pods?: { running: number; pending: number; crashLoop: number; restarts: number };
  hosts?: string[]; // ingress hosts, custom domains, load balancer addresses
  createdAt?: string; // ISO (deployments)
  account?: string; // §14: the account (team / context / profile) it was synced from, when one was named
  scope?: ResourceScope; // §14: membership in the open project; absent = an older daemon (treat as in scope)
}

export type CloudHealth = "healthy" | "degraded" | "down" | "deploying" | "unknown";

/** §14: how sure Ruah is that a resource belongs to the open project (strongest first). */
export type ScopeConfidence = "manual" | "proof" | "likely" | "weak";

export interface ResourceScope {
  in: boolean;
  confidence?: ScopeConfidence; // absent = no evidence; "weak" + in:false = a suggestion
  reasons: string[]; // "from .do/app.yaml (app shop)", "tag project=acme", "added by you"
  excluded?: boolean; // removed by the user
}

export interface ScopeAccount {
  provider: string;
  account?: string; // absent = the provider's selected / default account
  whole?: boolean; // everything in the account is the project's
}

export interface CloudScopeSummary {
  configured: boolean;
  accounts: (ScopeAccount & { repo?: string })[];
  files: { repo?: string; path: string; exists: boolean; error?: string }[];
  writable: boolean;
}

/** POST /api/cloud/sync and GET /api/cloud/resources. */
export interface CloudSyncResult {
  resources: CloudResource[];
  syncedAt: string | null;
  errors: { provider: string; message: string }[];
  scope?: CloudScopeSummary; // §14
}

export interface WorkItem {
  id: string; // "PLAT-123", "owner/repo#42"
  provider: "jira" | "github" | (string & {});
  title: string;
  status: string;
  url: string;
  assignee?: string;
  updatedAt: string;
  linkedNodeIds: string[]; // stored links (elements ↔ issues)
}
