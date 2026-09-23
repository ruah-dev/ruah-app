// Contract types shared with the archmap daemon (archmap/docs/CONTRACTS.md §1.1 and §2.1).
// Copied from the Lovable prompt L1. Where the prompt text and the daemon's zod schemas
// (archmap/src/contracts/ws.ts) disagree, the zod schemas win: ToolCallView.kind is an
// open string there, so it is an open union here too.

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
}

export interface ArchEdge {
  from: string; // node id
  to: string; // node id
  label?: string; // <= 40 chars, rendered on the edge
  kind?: "sync" | "async" | "event" | "data" | (string & {});
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: string[]; // node ids in order, >= 2 entries. Consecutive steps are drawn as arrows.
}

export interface Architecture {
  version: 1;
  name: string; // display name, usually the repo directory name
  generatedBy?: string; // e.g. "archmap scan 0.1.0"
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
  | { type: "prompt"; turnId: string; nodeId: string; text: string } // turnId: viewer-generated UUID
  | { type: "permission.response"; requestId: string; optionId: string } // optionId must be one of the offered options
  | { type: "permission.response"; requestId: string; cancelled: true } // user dismissed
  | { type: "cancel"; turnId: string }
  | { type: "session.reset" } // Phase 3: new ACP session (drops agent memory)
  | { type: "mode.set"; modeId: string } // Phase 3: session/set_mode
  | { type: "model.set"; modelId: string } // switch the agent's model (one of agent.status.models.available)
  | { type: "agent.set"; agentId: string } // switch coding agent (one of agent.status.agents.available); new session
  | { type: "architecture.save"; architecture: Architecture } // Phase 3: daemon validates + writes the file
  // §5.2 chats (turns always belong to the active chat; new/open cancel a running turn first)
  | { type: "chat.new" }
  | { type: "chat.open"; chatId: string }
  | { type: "chat.rename"; chatId: string; title: string }
  | { type: "chat.delete"; chatId: string };

// ---------- daemon -> viewer ----------
export type ServerMessage =
  | {
      type: "architecture";
      reason: "initial" | "changed" | "saved";
      revision: number;
      root: string;
      path: string;
      architecture: Architecture;
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
    }
  | { type: "turn.started"; turnId: string; nodeId: string; contextPack: string; text: string }
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
  | { type: "chat.history"; chatId: string; turns: TurnRecord[] };

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
  }[];
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
  nodeId: string;
  text: string;
  contextPack: string;
  events: StreamEvent[];
  stopReason?: StopReason;
  startedAt: string;
  finishedAt?: string;
}

/** GET /api/projects */
export interface ProjectsResponse {
  current: ProjectInfo | null;
  recent: ProjectInfo[]; // most recent first, pinned on top
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
}

declare global {
  interface Window {
    ruah?: RuahDesktopBridge;
  }
}
