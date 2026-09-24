// WebSocket client for the ruah daemon (CONTRACTS.md §2) exposed as a
// useSyncExternalStore store. Nothing here runs at module load: the socket is
// opened by the first component that calls useDaemon() (in an effect), so the
// SPA prerender never touches window/location.
import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentDefaults,
  AgentState,
  Architecture,
  AttachmentInfo,
  AttachmentMeta,
  ClientMessage,
  ModeState,
  AgentChoiceState,
  ChatInfo,
  ModelState,
  PermissionOption,
  ProjectInfo,
  ProjectsResponse,
  RecentChat,
  RecentChatsResponse,
  ServerMessage,
  StopReason,
  StreamEvent,
  ToolCallView,
  TurnRecord,
} from "./contracts";
import type { MapChange } from "./contracts";
import { noteArchitectureUpdate } from "./map-activity";
import sampleArchitectureJson from "@/data/sample-architecture.json";
import { sampleFiles } from "@/data/sample-files";
import { lruSet } from "./switching";
import { markSwitchCached, markSwitchStart } from "./switch-timing";
import { clearUnreadLocally, handleActivityMessage } from "./activity";
import type { AppFeatures, NotificationTarget, ResumeInfo, ViewState } from "./contracts";

export const CLIENT_ID = "architects-canvas/0.1.0";
const FIRST_ATTEMPT_TIMEOUT_MS = 2500;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;
const SAVE_DEBOUNCE_MS = 500;

export const sampleArchitecture = sampleArchitectureJson as unknown as Architecture;

export type Connection = "connecting" | "open" | "closed";

export interface AgentStatus {
  state: AgentState;
  agent?: { name: string; version: string };
  sessionId?: string;
  modes?: ModeState;
  models?: ModelState;
  agents?: AgentChoiceState;
  error?: string;
  /** Saved defaults (§5.7). */
  defaults?: AgentDefaults;
}

/** Set by setAgent until agent.status reports the new agent idle (or failing). */
export interface AgentSwitch {
  agentId: string;
  name: string;
}

export interface PermissionRequest {
  requestId: string;
  toolCall: ToolCallView;
  options: PermissionOption[];
  answering?: boolean;
}

export interface PermissionRecord {
  requestId: string;
  toolCall: ToolCallView;
  optionId?: string;
  optionName?: string;
  optionKind?: PermissionOption["kind"];
  cancelled?: boolean;
  /** events.length when resolved, so the record renders in stream order. */
  atEvent: number;
}

export interface Turn {
  id: string;
  /** Element the question was about; null = asked without context. */
  nodeId: string | null;
  text: string;
  contextPack: string;
  /** Images sent with the prompt (§5.6). */
  attachments?: AttachmentMeta[];
  events: StreamEvent[];
  /** §1.7: map edits the agent made in this turn (ruah_* tools). */
  mapChanges?: MapChange[];
  /** The user undid this turn's map changes. */
  mapUndone?: boolean;
  permission: PermissionRequest | null;
  resolved: PermissionRecord[];
  stopReason?: StopReason;
  error?: string;
  /** The prompt waits for this agent to finish starting (queued by the daemon, §2.2 rule 3). */
  waitingFor?: string;
  /** Epoch ms, viewer clock. */
  startedAt: number;
  finishedAt?: number;
}

export type SaveState = "idle" | "pending" | "saving" | "error";

/** Optimistic project switch (§5): the shell stays, the content shows a skeleton until the
 * daemon has sent the new project's architecture. */
export interface ProjectSwitch {
  root: string;
  name: string;
  /** Open this chat once the new project's chat list arrives (Chats page, cross-project). */
  chatId?: string;
  /** Target project id, when known up front (recent projects, chats). */
  projectId?: string;
  /** The target is painted from the viewer cache while the daemon swaps (no skeleton);
   * editing and prompts wait until the daemon confirms. */
  preview?: boolean;
}

export interface DaemonState {
  connection: Connection;
  /** Where `architecture` came from: the daemon, or the bundled sample when none is reachable. */
  source: "daemon" | "sample" | null;
  /** What the UI renders: the local edit draft when there is one, else the daemon's revision. */
  architecture: Architecture | null;
  revision: number;
  root: string | null;
  path: string | null;
  archError: string | null;
  agent: AgentStatus | null;
  daemonVersion: string | null;
  turns: Turn[];
  lastError: { code: string; message: string } | null;
  save: SaveState;
  /** Epoch ms of the last architecture.json write confirmed by the daemon (this session). */
  lastSavedAt: number | null;
  agentSwitch: AgentSwitch | null;
  wsUrl: string | null;
  httpOrigin: string | null;

  // §5 projects + chats
  /** True once the daemon has sent a `project` frame (older daemons serve one fixed repo). */
  projectsSupported: boolean;
  /** Current project; null = launcher state (only meaningful when projectsSupported). */
  project: ProjectInfo | null;
  /** Recent projects (GET /api/projects), most recent first, pinned on top. */
  recentProjects: ProjectInfo[];
  projectSwitch: ProjectSwitch | null;
  chats: ChatInfo[];
  activeChatId: string | null;
  /** chat.open sent, waiting for chat.history. */
  chatLoading: boolean;
  /** Last model list seen per agent (agent.status only carries the current agent's). */
  modelsByAgent: Record<string, ModelState>;
  /** Last permission-mode list seen per agent. */
  modesByAgent: Record<string, ModeState>;
}

const INITIAL: DaemonState = {
  connection: "connecting",
  source: null,
  architecture: null,
  revision: 0,
  root: null,
  path: null,
  archError: null,
  agent: null,
  daemonVersion: null,
  turns: [],
  lastError: null,
  save: "idle",
  lastSavedAt: null,
  agentSwitch: null,
  wsUrl: null,
  httpOrigin: null,
  projectsSupported: false,
  project: null,
  recentProjects: [],
  projectSwitch: null,
  chats: [],
  activeChatId: null,
  chatLoading: false,
  modelsByAgent: {},
  modesByAgent: {},
};

let state: DaemonState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<DaemonState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

// ---------------------------------------------------------------------------
// URL resolution

export function resolveDaemonUrls(): { wsUrl: string; httpOrigin: string } | null {
  if (typeof window === "undefined") return null;
  const param = new URLSearchParams(window.location.search).get("daemon");
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = param || `${scheme}//${window.location.host}/ws`;
  try {
    const u = new URL(wsUrl);
    const httpProto = u.protocol === "wss:" ? "https:" : "http:";
    return { wsUrl: u.toString(), httpOrigin: `${httpProto}//${u.host}` };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// connection

let socket: WebSocket | null = null;
let started = false;
let attempt = 0;
let everOpened = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let firstAttemptTimer: ReturnType<typeof setTimeout> | undefined;
let focusedNodeId: string | null = null;

// Edit/save bookkeeping (L7).
let serverArchitecture: Architecture | null = null;
let draft: Architecture | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savesInFlight = 0;
let needsResend = false;

function send(message: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function fallBackToSample() {
  if (state.source === "daemon") return;
  serverArchitecture = null;
  draft = null;
  set({
    source: "sample",
    architecture: sampleArchitecture,
    root: null,
    path: null,
    connection: "closed",
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== undefined) return;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function connect() {
  const urls = resolveDaemonUrls();
  if (!urls) return;
  attempt += 1;
  if (state.wsUrl !== urls.wsUrl) set({ wsUrl: urls.wsUrl, httpOrigin: urls.httpOrigin });
  let ws: WebSocket;
  try {
    ws = new WebSocket(urls.wsUrl);
  } catch {
    if (!everOpened) fallBackToSample();
    scheduleReconnect();
    return;
  }
  socket = ws;
  if (!everOpened && firstAttemptTimer === undefined) {
    firstAttemptTimer = setTimeout(() => {
      if (!everOpened) fallBackToSample();
    }, FIRST_ATTEMPT_TIMEOUT_MS);
  }
  ws.onopen = () => {
    if (socket !== ws) return;
    everOpened = true;
    attempt = 0;
    ws.send(
      JSON.stringify({ type: "hello", protocol: 1, client: CLIENT_ID } satisfies ClientMessage),
    );
    set({ connection: "open", lastError: null });
    if (focusedNodeId !== null) send({ type: "focus.set", nodeId: focusedNodeId });
    void fetch(`${urls.httpOrigin}/api/health`)
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
      .then((h) => {
        if (h?.version) set({ daemonVersion: h.version });
      })
      .catch(() => {});
    void refreshProjects();
  };
  ws.onmessage = (ev) => {
    if (socket !== ws || typeof ev.data !== "string") return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    handle(msg);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (draft) {
      // In-flight saves may or may not have landed; resend the draft after reconnecting.
      needsResend = true;
      savesInFlight = 0;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    // §2.2 rule 6: the daemon cancels an active turn when the viewer goes away.
    const turns = state.turns.map((t) =>
      t.stopReason
        ? t
        : {
            ...t,
            permission: null,
            stopReason: "error" as const,
            error: "connection to the daemon was lost",
          },
    );
    set({
      connection: everOpened ? "closed" : state.connection,
      agentSwitch: null,
      projectSwitch: null,
      turns,
      agent: everOpened ? null : state.agent,
    });
    if (!everOpened) fallBackToSample();
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

export function startDaemon() {
  if (started || typeof window === "undefined") return;
  started = true;
  loadModelCache();
  // §13.3: a click on a desktop notification (the window is already focused) opens its project + chat.
  window.ruah?.onNotificationClick?.((target) => void openActivityTarget(target));
  connect();
}

// ---------------------------------------------------------------------------
// projects + chats (§5): incoming frames

const MODEL_CACHE_KEY = "ruah.models.v1";
const MODE_CACHE_KEY = "ruah.modes.v1";
const SWITCH_TIMEOUT_MS = 30_000;

/** Model choice for an agent that is not running yet: applied once it reports idle. */
let pendingModel: { agentId: string; modelId: string } | null = null;
/** Chat to open once the (new) project's chat list arrives. */
let pendingChatOpen: string | null = null;
/** Last known turns per chat, so switching back to a chat is instant (history replaces it).
 * Chat ids are uuids, so one map serves every project (LRU-capped). */
const turnCache = new Map<string, Turn[]>();
const TURN_CACHE_MAX = 60;
let switchTimer: ReturnType<typeof setTimeout> | undefined;

/** What the viewer needs to paint a project before the daemon has switched to it. */
export interface ProjectSnapshot {
  project: ProjectInfo;
  architecture: Architecture | null;
  revision: number;
  path: string | null;
  chats: ChatInfo[];
  activeChatId: string | null;
  /** Epoch ms the snapshot was taken (prefetches refresh older ones). */
  at: number;
}

/** The last few projects (current one excluded), newest last. */
const projectCache = new Map<string, ProjectSnapshot>();
export const PROJECT_CACHE_MAX = 4;
const PREFETCH_FRESH_MS = 15_000;
const inflight = new Map<string, Promise<unknown>>();

function cacheTurns(chatId: string, turns: Turn[]) {
  lruSet(turnCache, chatId, turns, TURN_CACHE_MAX);
}

/** Keeps what is on screen for the current project, so coming back to it paints at once. */
function snapshotCurrent() {
  const project = state.project;
  if (!project || state.projectSwitch?.preview) return;
  if (state.activeChatId) cacheTurns(state.activeChatId, state.turns.filter((t) => t.stopReason));
  lruSet(
    projectCache,
    project.id,
    {
      project,
      architecture: serverArchitecture ?? state.architecture,
      revision: state.revision,
      path: state.path,
      chats: state.chats,
      activeChatId: state.activeChatId,
      at: Date.now(),
    },
    PROJECT_CACHE_MAX,
  );
}

/** The project `chats` / `activeChatId` belong to: the previewed target during a cached switch
 * (state.project still names the project being left), else the current project. */
export function chatsProjectId(s: DaemonState = state): string | null {
  if (s.projectSwitch?.preview && s.projectSwitch.projectId) return s.projectSwitch.projectId;
  return s.project?.id ?? null;
}

export function cachedProject(idOrRoot: string): ProjectSnapshot | undefined {
  const byId = projectCache.get(idOrRoot);
  if (byId) return byId;
  for (const snap of projectCache.values()) if (sameRoot(snap.project.root, idOrRoot)) return snap;
  return undefined;
}

export function hasCachedTurns(chatId: string): boolean {
  return turnCache.has(chatId);
}

function loadModelCache() {
  try {
    const raw = window.localStorage.getItem(MODEL_CACHE_KEY);
    if (raw) set({ modelsByAgent: JSON.parse(raw) as Record<string, ModelState> });
    const modes = window.localStorage.getItem(MODE_CACHE_KEY);
    if (modes) set({ modesByAgent: JSON.parse(modes) as Record<string, ModeState> });
  } catch {
    /* ignore */
  }
}

function persistModelCache() {
  try {
    window.localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(state.modelsByAgent));
    window.localStorage.setItem(MODE_CACHE_KEY, JSON.stringify(state.modesByAgent));
  } catch {
    /* ignore */
  }
}

/** Model / mode lists of every agent this status describes (the current one's are top-level). */
function knownLists(msg: Extract<ServerMessage, { type: "agent.status" }>) {
  const current = msg.agents?.currentAgentId ?? state.agent?.agents?.currentAgentId ?? "default";
  const models: Record<string, ModelState> = {};
  const modes: Record<string, ModeState> = {};
  for (const a of msg.agents?.available ?? []) {
    if (a.models?.available.length) models[a.id] = a.models;
    if (a.modes?.available.length) modes[a.id] = a.modes;
  }
  if (msg.models) models[current] = msg.models;
  if (msg.modes) modes[current] = msg.modes;
  return { models, modes };
}

export function sameRoot(a: string, b: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  return norm(a) === norm(b);
}

export function basename(path: string) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function sortProjects(list: ProjectInfo[]): ProjectInfo[] {
  return [...list].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt),
  );
}

function recordToTurn(r: TurnRecord, idle: boolean): Turn {
  const startedAt = Date.parse(r.startedAt) || Date.now();
  const finishedAt = r.finishedAt ? Date.parse(r.finishedAt) : undefined;
  // A record without a stop reason is either still running (the stream continues) or was
  // interrupted before the daemon could record the end. §13: `running` says so explicitly (a
  // background turn re-attached, or a reload mid-turn).
  const stopReason: StopReason | undefined = r.running ? undefined : (r.stopReason ?? (idle ? "cancelled" : undefined));
  return {
    id: r.turnId,
    nodeId: r.nodeId ?? null,
    text: r.text,
    contextPack: r.contextPack,
    ...(r.attachments?.length ? { attachments: r.attachments } : {}),
    events: r.events,
    ...(r.mapChanges?.length ? { mapChanges: r.mapChanges } : {}),
    permission: null,
    resolved: [],
    startedAt,
    ...(finishedAt !== undefined && !Number.isNaN(finishedAt) ? { finishedAt } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function clearSwitchTimer() {
  if (switchTimer !== undefined) clearTimeout(switchTimer);
  switchTimer = undefined;
}

function handleProject(project: ProjectInfo | null) {
  const prevId = state.project?.id ?? null;
  const nextId = project?.id ?? null;
  const patch: Partial<DaemonState> = { projectsSupported: true, project, source: "daemon" };
  const previewing =
    !!state.projectSwitch?.preview && !!nextId && state.projectSwitch.projectId === nextId;
  if (nextId !== prevId && prevId !== null && !state.projectSwitch?.preview) snapshotCurrent();
  if (nextId !== prevId && previewing) {
    // The target is already on screen from the cache: keep it until the daemon's frames land.
    serverArchitecture = null;
    draft = null;
    needsResend = false;
    savesInFlight = 0;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    Object.assign(patch, { lastError: null, save: "idle", root: project?.root ?? state.root } satisfies Partial<DaemonState>);
  } else if (nextId !== prevId) {
    // Another project: drop everything that belonged to the previous one.
    serverArchitecture = null;
    draft = null;
    needsResend = false;
    savesInFlight = 0;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    Object.assign(patch, {
      architecture: null,
      revision: 0,
      root: project?.root ?? null,
      path: null,
      archError: null,
      lastError: null,
      save: "idle",
      turns: [],
      chats: [],
      activeChatId: null,
      chatLoading: false,
    } satisfies Partial<DaemonState>);
  }
  if (nextId !== prevId && project) {
    patch.recentProjects = sortProjects([
      project,
      ...state.recentProjects.filter((p) => p.id !== project.id),
    ]);
  }
  if (project === null) {
    patch.projectSwitch = null;
    clearSwitchTimer();
  } else if (state.projectSwitch && nextId !== prevId) {
    // Adopt the daemon's canonical root (realpath) for the pending switch; a preview of another
    // project (a newer click won the race) no longer applies.
    const { preview: _preview, projectId: _projectId, ...rest } = state.projectSwitch;
    patch.projectSwitch = previewing
      ? { ...state.projectSwitch, root: project.root, name: project.name }
      : { ...rest, root: project.root, name: project.name };
  }
  set(patch);
  void refreshProjects();
}

function handleChats(projectId: string, chats: ChatInfo[], activeChatId: string | null) {
  // While a previewed switch runs, only the target's frames count (the old project may still talk).
  const target = state.projectSwitch?.preview ? state.projectSwitch.projectId : undefined;
  if (target !== undefined ? projectId !== target : state.project && projectId !== state.project.id) return; // stale frame
  const sorted = [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const prev = state.activeChatId;
  const patch: Partial<DaemonState> = { chats: sorted, activeChatId };
  if (activeChatId !== prev) {
    if (activeChatId === null) {
      patch.turns = [];
      patch.chatLoading = false;
    } else if (prev !== null) {
      // Switched elsewhere (another tab): show what we know until chat.history arrives.
      cacheTurns(prev, state.turns.filter((t) => t.stopReason));
      patch.turns = turnCache.get(activeChatId) ?? [];
    }
    // prev === null: the first prompt of a new chat created it; keep the live turns.
  }
  set(patch);
  if (pendingChatOpen) {
    const target = pendingChatOpen;
    if (sorted.some((c) => c.id === target)) {
      pendingChatOpen = null;
      if (target !== activeChatId) openChat(target);
    }
  }
}

function handleHistory(chatId: string, records: TurnRecord[]) {
  const idle = state.agent?.state !== "busy";
  const hist = records.map((r) => recordToTurn(r, idle));
  cacheTurns(chatId, hist);
  if (chatId !== state.activeChatId) return;
  const byId = new Map(state.turns.map((t) => [t.id, t]));
  // Prefer the live copy of a turn that is still streaming.
  const merged = hist.map((h) => {
    const live = byId.get(h.id);
    return live && !live.stopReason ? live : h;
  });
  const recorded = new Set(hist.map((h) => h.id));
  const liveOnly = state.turns.filter((t) => !recorded.has(t.id) && !t.stopReason);
  set({ turns: [...merged, ...liveOnly], chatLoading: false });
}

// ---------------------------------------------------------------------------
// incoming frames

function updateTurn(turnId: string, fn: (t: Turn) => Turn) {
  if (!state.turns.some((t) => t.id === turnId)) return;
  set({ turns: state.turns.map((t) => (t.id === turnId ? fn(t) : t)) });
}

function editsPending() {
  return saveTimer !== undefined || savesInFlight > 0;
}

function handle(msg: ServerMessage) {
  if (handleActivityMessage(msg, { currentProjectId: state.project?.id ?? null, activeChatId: state.activeChatId })) return;
  switch (msg.type) {
    case "architecture": {
      // A previewed switch shows the target already: frames of the project being left are stale.
      if (state.projectSwitch?.preview && !sameRoot(state.projectSwitch.root, msg.root)) return;
      // §1.7: animate agent edits / undos (before the new revision renders), and attach the
      // changes to their chat turn.
      noteArchitectureUpdate(serverArchitecture, msg.architecture, msg.by, msg.changes);
      noteTurnMapChanges(msg.by, msg.changes);
      serverArchitecture = msg.architecture;
      if (needsResend && draft) {
        needsResend = false;
        set({
          source: "daemon",
          revision: msg.revision,
          root: msg.root,
          path: msg.path,
          architecture: draft,
        });
        flushSave();
        return;
      }
      if (msg.reason === "saved" && savesInFlight > 0) savesInFlight -= 1;
      // Keep showing the local draft while newer edits are still on their way.
      if (draft && !editsPending()) draft = null;
      set({
        source: "daemon",
        projectSwitch:
          state.projectSwitch && sameRoot(state.projectSwitch.root, msg.root)
            ? null
            : state.projectSwitch,
        architecture: draft ?? msg.architecture,
        revision: msg.revision,
        root: msg.root,
        path: msg.path,
        archError: null,
        save: editsPending() ? state.save : "idle",
        ...(msg.reason === "saved" ? { lastSavedAt: Date.now() } : {}),
      });
      return;
    }
    case "architecture.error":
      set({ archError: msg.message });
      return;
    case "agent.status": {
      const prev = state.agent;
      const switching = state.agentSwitch;
      // A switch is over once the new agent reports idle (or gives up). Its model list comes
      // with that status; the previous agent's list must not linger meanwhile.
      const switchDone =
        !!switching &&
        (msg.state === "error" ||
          msg.state === "stopped" ||
          (msg.state === "idle" && (msg.agents?.currentAgentId ?? switching.agentId) === switching.agentId));
      const keepModels = !switching || msg.models !== undefined;
      const known = knownLists(msg);
      set({
        agentSwitch: switchDone ? null : switching,
        agent: {
          state: msg.state,
          ...((msg.agent ?? prev?.agent) ? { agent: (msg.agent ?? prev?.agent)! } : {}),
          ...((msg.sessionId ?? prev?.sessionId)
            ? { sessionId: (msg.sessionId ?? prev?.sessionId)! }
            : {}),
          ...((msg.modes ?? prev?.modes) ? { modes: (msg.modes ?? prev?.modes)! } : {}),
          ...((msg.models ?? (keepModels ? prev?.models : undefined))
            ? { models: (msg.models ?? prev?.models)! }
            : {}),
          ...((msg.agents ?? prev?.agents) ? { agents: (msg.agents ?? prev?.agents)! } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          ...((msg.defaults ?? prev?.defaults) ? { defaults: (msg.defaults ?? prev?.defaults)! } : {}),
        },
        modelsByAgent: { ...state.modelsByAgent, ...known.models },
        modesByAgent: { ...state.modesByAgent, ...known.modes },
      });
      if (Object.keys(known.models).length || Object.keys(known.modes).length) persistModelCache();
      // A model picked for another agent is applied once that agent is up.
      if (pendingModel && msg.state === "idle" && msg.models) {
        const { agentId, modelId } = pendingModel;
        if ((msg.agents?.currentAgentId ?? state.agent?.agents?.currentAgentId) === agentId) {
          pendingModel = null;
          if (
            msg.models.currentModelId !== modelId &&
            msg.models.available.some((m) => m.id === modelId)
          )
            sendModel(modelId);
        }
      } else if (pendingModel && (msg.state === "error" || msg.state === "stopped")) {
        pendingModel = null;
      }
      return;
    }
    case "project":
      handleProject(msg.project);
      return;
    case "chats":
      handleChats(msg.projectId, msg.chats, msg.activeChatId);
      return;
    case "chat.history":
      handleHistory(msg.chatId, msg.turns);
      return;
    case "turn.started": {
      const waitingFor = msg.queued ? currentAgentName() : undefined;
      if (state.turns.some((t) => t.id === msg.turnId)) {
        updateTurn(msg.turnId, (t) => {
          const { waitingFor: _was, ...rest } = t;
          return {
            ...rest,
            contextPack: msg.contextPack,
            nodeId: msg.nodeId ?? null,
            ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
            ...(waitingFor ? { waitingFor } : {}),
          };
        });
      } else {
        // Started from another viewer tab: show it here too.
        set({
          turns: [
            ...state.turns,
            {
              id: msg.turnId,
              nodeId: msg.nodeId ?? null,
              text: msg.text,
              contextPack: msg.contextPack,
              ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
              ...(waitingFor ? { waitingFor } : {}),
              events: [],
              permission: null,
              resolved: [],
              startedAt: Date.now(),
            },
          ],
        });
      }
      return;
    }
    case "stream":
      updateTurn(msg.turnId, (t) => {
        const { waitingFor: _was, ...rest } = t;
        return { ...rest, events: [...t.events, msg.event] };
      });
      return;
    case "permission.request":
      updateTurn(msg.turnId, (t) => ({
        ...t,
        permission: { requestId: msg.requestId, toolCall: msg.toolCall, options: msg.options },
      }));
      return;
    case "permission.resolved":
      updateTurn(msg.turnId, (t) => {
        const pending = t.permission?.requestId === msg.requestId ? t.permission : null;
        const option = pending?.options.find((o) => o.optionId === msg.optionId);
        const record: PermissionRecord = {
          requestId: msg.requestId,
          toolCall: pending?.toolCall ?? {
            toolCallId: "",
            title: "tool call",
            kind: "other",
            status: "pending",
            locations: [],
          },
          atEvent: t.events.length,
          ...(msg.optionId !== undefined ? { optionId: msg.optionId } : {}),
          ...(option ? { optionName: option.name, optionKind: option.kind } : {}),
          ...(msg.cancelled ? { cancelled: true } : {}),
        };
        return {
          ...t,
          permission: pending ? null : t.permission,
          resolved: [...t.resolved, record],
        };
      });
      return;
    case "turn.finished":
      updateTurn(msg.turnId, ({ waitingFor: _was, ...t }) => ({
        ...t,
        permission: null,
        stopReason: msg.stopReason,
        finishedAt: Date.now(),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      }));
      try {
        window.dispatchEvent(new CustomEvent("ruah:turn-finished", { detail: { turnId: msg.turnId } }));
      } catch {
        // ignore (non-browser)
      }
      return;
    case "error": {
      if (msg.turnId && state.turns.some((t) => t.id === msg.turnId && !t.stopReason)) {
        updateTurn(msg.turnId, (t) => ({
          ...t,
          permission: null,
          stopReason: "error",
          error: `${msg.code}: ${msg.message}`,
        }));
        return;
      }
      if (msg.code === "save_rejected" || msg.message.startsWith("save failed")) {
        // Daemon rejected the edit (validation): drop the draft, show why.
        savesInFlight = Math.max(0, savesInFlight - 1);
        if (!editsPending()) draft = null;
        set({
          archError: msg.message,
          save: "error",
          architecture: draft ?? serverArchitecture ?? state.architecture,
        });
        return;
      }
      set({ lastError: { code: msg.code, message: msg.message } });
      return;
    }
  }
}

function noteTurnMapChanges(by: Extract<ServerMessage, { type: "architecture" }>["by"], changes: MapChange[] | undefined) {
  const turnId = by?.turnId;
  if (!turnId) return;
  if (by.undo) {
    updateTurn(turnId, (t) => ({ ...t, mapUndone: true }));
    return;
  }
  if (by.kind === "agent" && changes?.length)
    updateTurn(turnId, (t) => ({ ...t, mapChanges: [...(t.mapChanges ?? []), ...changes] }));
}

// ---------------------------------------------------------------------------
// actions

const newId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Display name of the current agent. */
function currentAgentName(): string {
  const agents = state.agent?.agents;
  return (
    state.agentSwitch?.name ??
    agents?.available.find((a) => a.id === agents.currentAgentId)?.name ??
    state.agent?.agent?.name ??
    "the agent"
  );
}

/** nodeId null = a plain question on the project, sent without an element's context. */
export function sendPrompt(nodeId: string | null, text: string, attachments: AttachmentMeta[] = []): string {
  // Sent while the agent starts: the daemon queues it (§2.2 rule 3); say so right away.
  const starting = !!state.agentSwitch || state.agent?.state === "starting";
  const turn: Turn = {
    id: newId(),
    nodeId,
    text,
    contextPack: "",
    ...(attachments.length ? { attachments } : {}),
    ...(starting ? { waitingFor: currentAgentName() } : {}),
    events: [],
    permission: null,
    resolved: [],
    startedAt: Date.now(),
  };
  const ok =
    state.source === "daemon" &&
    !state.projectSwitch &&
    send({
      type: "prompt",
      turnId: turn.id,
      ...(nodeId !== null ? { nodeId } : {}),
      text,
      ...(attachments.length
        ? { attachments: attachments.map(({ id, name }) => ({ id, name })) }
        : {}),
    });
  if (!ok) {
    delete turn.waitingFor;
    turn.stopReason = "error";
    turn.error = state.projectSwitch
      ? `Still opening ${state.projectSwitch.name} — send it again in a moment.`
      : "No ruah daemon connected. Start one with `ruah app serve <repo>` to talk to the agent.";
  }
  set({ turns: [...state.turns, turn] });
  return turn.id;
}

export function cancel(turnId: string) {
  if (!send({ type: "cancel", turnId })) {
    updateTurn(turnId, (t) =>
      t.stopReason ? t : { ...t, permission: null, stopReason: "cancelled" },
    );
  }
}

export function answerPermission(requestId: string, answer: string | "cancel") {
  // The card can be on screen twice (inspector + agent pane); answer once.
  if (state.turns.some((t) => t.permission?.requestId === requestId && t.permission.answering))
    return;
  const msg: ClientMessage =
    answer === "cancel"
      ? { type: "permission.response", requestId, cancelled: true }
      : { type: "permission.response", requestId, optionId: answer };
  if (!send(msg)) return;
  set({
    turns: state.turns.map((t) =>
      t.permission?.requestId === requestId
        ? { ...t, permission: { ...t.permission, answering: true } }
        : t,
    ),
  });
}

/** §1.7: put back what the agent changed on the map in this turn (daemon keeps a snapshot). */
export function undoMapChanges(turnId: string): boolean {
  return send({ type: "arch.undo", turnId });
}

export function setFocus(nodeId: string | null) {
  if (nodeId === focusedNodeId) return;
  focusedNodeId = nodeId;
  send({ type: "focus.set", nodeId });
}

export function setAgentMode(modeId: string) {
  send({ type: "mode.set", modeId });
}

/** Ask the daemon to switch models. Optimistic: the picker shows the choice right away; the
 * next agent.status (with models) is authoritative. */
export function sendModel(modelId: string): boolean {
  if (!send({ type: "model.set", modelId })) return false;
  const models = state.agent?.models;
  if (state.agent && models && models.currentModelId !== modelId) {
    set({ agent: { ...state.agent, models: { ...models, currentModelId: modelId } } });
  }
  return true;
}

export const setModel = sendModel;

/** Switch coding agent. The daemon stops any running turn; a pre-warmed agent (warm "ready") is
 * swapped in at once, any other one starts — until it reports idle the UI shows a quiet
 * "Starting …" state (state.agentSwitch) and the composer keeps working (prompts are queued). */
export function setAgent(agentId: string): boolean {
  const agents = state.agent?.agents;
  const choice = agents?.available.find((a) => a.id === agentId);
  if (!state.agent || !agents || !choice || !choice.installed) return false;
  if (agents.currentAgentId === agentId) return true;
  if (!send({ type: "agent.set", agentId })) return false;
  const { models: _dropped, modes: _modes, ...rest } = state.agent;
  const ready = choice.warm === "ready";
  const models = choice.models ?? state.modelsByAgent[agentId];
  const modes = choice.modes ?? state.modesByAgent[agentId];
  set({
    agentSwitch: ready ? null : { agentId, name: choice.name },
    agent: {
      ...rest,
      state: ready ? "idle" : "starting",
      ...(ready && models ? { models } : {}),
      ...(ready && modes ? { modes } : {}),
      agents: { ...agents, currentAgentId: agentId },
    },
  });
  return true;
}

let lastPrewarm: { key: string; at: number } | null = null;

/** Ask the daemon to start agents in the background (default: every installed agent but the
 * current one) so switching to them is instant. Repeats within a few seconds are dropped. */
export function prewarmAgents(agentIds?: string[]): void {
  const agents = state.agent?.agents;
  if (!agents || state.source !== "daemon" || !state.project) return;
  const ids = agentIds?.filter((id) => {
    const a = agents.available.find((x) => x.id === id);
    return !!a && a.installed && a.id !== agents.currentAgentId && a.warm !== "ready" && a.warm !== "starting";
  });
  if (ids && ids.length === 0) return;
  const key = ids ? ids.join(",") : "*";
  const now = Date.now();
  if (lastPrewarm && lastPrewarm.key === key && now - lastPrewarm.at < 5000) return;
  lastPrewarm = { key, at: now };
  send({ type: "agent.prewarm", ...(ids ? { agentIds: ids } : {}) });
}

/** Settings → Agents: save defaults on the daemon (null clears one). */
export function setDefaults(patch: {
  agentId?: string;
  models?: Record<string, string | null>;
  modes?: Record<string, string | null>;
}): boolean {
  if (!send({ type: "defaults.set", ...patch })) return false;
  const d = state.agent?.defaults;
  if (state.agent && d) {
    const apply = (base: Record<string, string>, p?: Record<string, string | null>) => {
      const next = { ...base };
      for (const [k, v] of Object.entries(p ?? {})) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next;
    };
    set({
      agent: {
        ...state.agent,
        defaults: {
          agentId: patch.agentId ?? d.agentId,
          models: apply(d.models, patch.models),
          modes: apply(d.modes, patch.modes),
        },
      },
    });
  }
  return true;
}

/** One-step agent + model choice (the ⌘. picker). A model of another agent is applied after
 * that agent has started (its models are known from an earlier agent.status). */
export function setAgentModel(agentId: string, modelId: string | null): boolean {
  const current = state.agent?.agents?.currentAgentId;
  if (!current || current === agentId) {
    pendingModel = null;
    return modelId ? sendModel(modelId) : true;
  }
  if (!setAgent(agentId)) return false;
  pendingModel = modelId ? { agentId, modelId } : null;
  return true;
}

/** Legacy daemons: drop the agent session. With chats (§5) this starts a new chat instead. */
export function resetSession() {
  if (state.projectsSupported) {
    newChat();
    return;
  }
  if (send({ type: "session.reset" })) set({ turns: state.turns.filter((t) => !t.stopReason) });
}

// ---------------------------------------------------------------------------
// chats (§5.2)

function stashActiveTurns() {
  if (state.activeChatId)
    cacheTurns(
      state.activeChatId,
      state.turns.filter((t) => t.stopReason),
    );
}

export function newChat(): boolean {
  if (!send({ type: "chat.new" })) return false;
  stashActiveTurns();
  set({ activeChatId: null, turns: [], chatLoading: false });
  return true;
}

export function openChat(chatId: string): boolean {
  if (chatId === state.activeChatId) return true;
  if (state.projectSwitch) {
    // The daemon is still swapping projects: open it once the new chat list is in.
    pendingChatOpen = chatId;
    stashActiveTurns();
    set({ activeChatId: chatId, turns: turnCache.get(chatId) ?? [], chatLoading: !turnCache.has(chatId) });
    return true;
  }
  if (!send({ type: "chat.open", chatId })) return false;
  markSwitchStart("chat", chatId, turnCache.has(chatId));
  stashActiveTurns();
  const cached = turnCache.get(chatId);
  set({ activeChatId: chatId, turns: cached ?? [], chatLoading: true });
  return true;
}

export function renameChat(chatId: string, title: string): boolean {
  const t = title.trim().slice(0, 80);
  if (!t || !send({ type: "chat.rename", chatId, title: t })) return false;
  set({ chats: state.chats.map((c) => (c.id === chatId ? { ...c, title: t } : c)) });
  return true;
}

export function deleteChat(chatId: string): boolean {
  if (!send({ type: "chat.delete", chatId })) return false;
  turnCache.delete(chatId);
  for (const snap of projectCache.values()) snap.chats = snap.chats.filter((c) => c.id !== chatId);
  const active = state.activeChatId === chatId;
  set({
    chats: state.chats.filter((c) => c.id !== chatId),
    ...(active ? { activeChatId: null, turns: [], chatLoading: false } : {}),
  });
  return true;
}

// ---------------------------------------------------------------------------
// projects (§5.3)

async function api<T>(path: string, body?: unknown): Promise<T> {
  if (!state.httpOrigin) throw new Error("No daemon connected");
  const r = await fetch(`${state.httpOrigin}${path}`, {
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!r.ok) throw new Error(data.error ?? data.message ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export async function refreshProjects(): Promise<void> {
  if (!state.httpOrigin || state.source === "sample") return;
  try {
    const res = await api<ProjectsResponse>("/api/projects");
    set({ recentProjects: sortProjects(res.recent ?? []) });
  } catch {
    /* older daemon without §5 */
  }
}

function beginSwitch(root: string, name: string, extra: Partial<ProjectSwitch> = {}, patch: Partial<DaemonState> = {}) {
  clearSwitchTimer();
  set({ ...patch, projectSwitch: { root, name, ...extra } });
  switchTimer = setTimeout(() => {
    switchTimer = undefined;
    if (state.projectSwitch) set({ projectSwitch: null });
  }, SWITCH_TIMEOUT_MS);
}

function failSwitch() {
  clearSwitchTimer();
  pendingChatOpen = null;
  set({ projectSwitch: null });
}

/** Open a folder as the current project. Optimistic: the shell keeps rendering, the content
 * shows a skeleton (state.projectSwitch) until the daemon sends the new architecture. */
export async function openProject(
  path: string,
  opts: { name?: string; chatId?: string; projectId?: string } = {},
): Promise<ProjectInfo> {
  const target = path.trim();
  if (!target) throw new Error("Choose a folder first");
  if (state.project && sameRoot(state.project.root, target)) {
    if (opts.chatId) openChat(opts.chatId);
    return state.project;
  }
  pendingChatOpen = opts.chatId ?? null;
  const snap = cachedProject(opts.projectId ?? target) ?? cachedProject(target);
  markSwitchStart("project", snap?.project.id ?? opts.projectId ?? target, false);
  // Pending edits of the project being left go out first (the daemon still has it open).
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    flushSave();
  }
  if (snap?.architecture) {
    // Paint the target from the cache now; the daemon's frames replace it in a few ms.
    snapshotCurrent();
    serverArchitecture = null;
    draft = null;
    const chatId = opts.chatId ?? snap.activeChatId;
    stashActiveTurns();
    markSwitchCached();
    beginSwitch(
      snap.project.root,
      snap.project.name,
      { projectId: snap.project.id, preview: true, ...(opts.chatId ? { chatId: opts.chatId } : {}) },
      {
        architecture: snap.architecture,
        revision: snap.revision,
        root: snap.project.root,
        path: snap.path,
        archError: null,
        lastError: null,
        chats: snap.chats,
        activeChatId: chatId,
        turns: chatId ? (turnCache.get(chatId) ?? []) : [],
        chatLoading: !!chatId && !turnCache.has(chatId),
      },
    );
  } else {
    beginSwitch(target, opts.name ?? snap?.project.name ?? basename(target), opts.projectId ? { projectId: opts.projectId } : {});
  }
  try {
    const info = await api<ProjectInfo>("/api/projects/open", {
      path: target,
      ...(opts.chatId ? { chatId: opts.chatId } : {}),
    });
    if (state.projectSwitch && state.project?.id !== info.id)
      set({ projectSwitch: { ...state.projectSwitch, root: info.root, name: info.name } });
    return info;
  } catch (err) {
    failSwitch();
    throw err;
  }
}

export async function createProject(input: {
  parentDir: string;
  name: string;
  git?: boolean;
}): Promise<ProjectInfo> {
  const parent = input.parentDir.trim().replace(/[\\/]+$/, "");
  const name = input.name.trim();
  beginSwitch(`${parent}/${name}`, name);
  try {
    const info = await api<ProjectInfo>("/api/projects/create", {
      parentDir: parent,
      name,
      ...(input.git !== undefined ? { git: input.git } : {}),
    });
    if (state.projectSwitch && state.project?.id !== info.id)
      set({ projectSwitch: { ...state.projectSwitch, root: info.root, name: info.name } });
    return info;
  } catch (err) {
    failSwitch();
    throw err;
  }
}

export async function pinProject(id: string, pinned: boolean): Promise<void> {
  const before = state.recentProjects;
  set({
    recentProjects: sortProjects(before.map((p) => (p.id === id ? { ...p, pinned } : p))),
    ...(state.project?.id === id ? { project: { ...state.project, pinned } } : {}),
  });
  try {
    await api("/api/projects/pin", { id, pinned });
  } catch (err) {
    set({ recentProjects: before });
    throw err;
  }
}

export async function forgetProject(id: string): Promise<void> {
  const before = state.recentProjects;
  set({ recentProjects: before.filter((p) => p.id !== id) });
  try {
    await api("/api/projects/forget", { id });
  } catch (err) {
    set({ recentProjects: before });
    throw err;
  }
}

export async function fetchRecentChats(limit = 200, projectId?: string): Promise<RecentChat[]> {
  const q = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
  const res = await api<RecentChatsResponse>(`/api/chats/recent?limit=${limit}${q}`);
  return res.chats ?? [];
}

/** Open a chat from any project: switches project first when needed (one request). */
export async function openChatAnywhere(
  chat: Pick<RecentChat, "id" | "projectId" | "projectRoot" | "projectName">,
): Promise<void> {
  if (state.project?.id === chat.projectId) {
    openChat(chat.id);
    return;
  }
  await openProject(chat.projectRoot, { name: chat.projectName, chatId: chat.id, projectId: chat.projectId });
}

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

interface PreviewResponse {
  project: ProjectInfo;
  architecture: Architecture | null;
  chats: ChatInfo[];
  activeChatId: string | null;
  activeTurns: TurnRecord[];
}

/** Hover prefetch: another project's map + chats (+ its active chat) into the viewer cache,
 * so switching to it paints at once. Cheap to call repeatedly (deduped, 15 s fresh). */
export function prefetchProject(projectId: string): Promise<void> {
  if (!state.httpOrigin || state.source !== "daemon" || state.project?.id === projectId) return Promise.resolve();
  const have = projectCache.get(projectId);
  if (have && Date.now() - have.at < PREFETCH_FRESH_MS) return Promise.resolve();
  return once(`p:${projectId}`, async () => {
    try {
      const res = await api<PreviewResponse>(`/api/projects/preview?id=${encodeURIComponent(projectId)}`);
      if (state.project?.id === projectId) return;
      if (res.activeChatId && !turnCache.has(res.activeChatId))
        cacheTurns(res.activeChatId, res.activeTurns.map((r) => recordToTurn(r, true)));
      lruSet(
        projectCache,
        projectId,
        {
          project: res.project,
          // A prefetch without a map keeps the one seen last (systems are only mapped while open).
          architecture: res.architecture ?? have?.architecture ?? null,
          revision: have?.revision ?? 0,
          path: have?.path ?? null,
          chats: [...res.chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
          activeChatId: res.activeChatId,
          at: Date.now(),
        },
        PROJECT_CACHE_MAX,
      );
    } catch {
      /* older daemon or unknown project: the switch just shows the skeleton */
    }
  });
}

/** Hover prefetch of one chat's turns (any project). */
export function prefetchChat(projectId: string, chatId: string): Promise<void> {
  if (!state.httpOrigin || state.source !== "daemon" || turnCache.has(chatId) || chatId === state.activeChatId)
    return Promise.resolve();
  return once(`c:${chatId}`, async () => {
    try {
      const res = await api<{ turns: TurnRecord[] }>(
        `/api/chats/history?projectId=${encodeURIComponent(projectId)}&chatId=${encodeURIComponent(chatId)}`,
      );
      if (!turnCache.has(chatId)) cacheTurns(chatId, res.turns.map((r) => recordToTurn(r, true)));
    } catch {
      /* older daemon: chat.open still works */
    }
  });
}

/** Rescan the served repo (§2.3). */
export async function rescan(): Promise<{ nodes: number; edges: number; ms: number }> {
  return api("/api/rescan", {});
}

export function dismissError() {
  set({
    lastError: null,
    archError: state.save === "error" ? null : state.archError,
    save: state.save === "error" ? "idle" : state.save,
  });
}

// ---------------------------------------------------------------------------
// editing (L7): optimistic local draft + debounced architecture.save

export function canEdit(s: DaemonState = state) {
  return s.source === "daemon" && s.connection === "open" && s.architecture !== null && !s.projectSwitch;
}

function flushSave() {
  saveTimer = undefined;
  if (!draft) return;
  if (send({ type: "architecture.save", architecture: draft })) {
    savesInFlight += 1;
    set({ save: "saving" });
  } else {
    needsResend = true;
    set({ save: "pending" }); // resent after reconnect
  }
}

export function editArchitecture(fn: (arch: Architecture) => Architecture | null) {
  if (!canEdit()) return;
  const base = draft ?? state.architecture;
  if (!base) return;
  const next = fn(base);
  if (!next || next === base) return;
  draft = next;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  set({
    architecture: next,
    save: "pending",
    archError: state.save === "error" ? null : state.archError,
  });
}

export function reportLocalError(message: string) {
  set({ lastError: { code: "edit", message } });
}

// ---------------------------------------------------------------------------
// HTTP companions (§2.3)

export type FileResult =
  | { ok: true; path: string; lang: string; content: string }
  | { ok: false; status: number; message: string };

export async function fetchFile(path: string): Promise<FileResult> {
  if (state.source !== "daemon" || !state.httpOrigin) {
    const code = sampleFiles[path];
    return code !== undefined
      ? { ok: true, path, lang: /\.tsx?$/.test(path) ? "typescript" : "text", content: code }
      : {
          ok: false,
          status: 404,
          message: "No daemon connected; this sample has no source for that file.",
        };
  }
  try {
    const r = await fetch(`${state.httpOrigin}/api/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      return { ok: false, status: r.status, message: body.error ?? r.statusText };
    }
    const body = (await r.json()) as { path: string; lang: string; content: string };
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message };
  }
}

export async function fetchContext(nodeId: string): Promise<string> {
  if (state.source !== "daemon" || !state.httpOrigin) throw new Error("No daemon connected");
  const r = await fetch(`${state.httpOrigin}/api/context/${encodeURIComponent(nodeId)}`);
  if (!r.ok) throw new Error(`context request failed (${r.status})`);
  return r.text();
}

// ---------------------------------------------------------------------------
// image attachments (§5.6)

/** Types the daemon accepts (it sniffs the bytes; this only filters obvious misses early). */
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

/** URL of a stored image of the open project (thumbnails, lightbox). */
export function attachmentUrl(id: string, s: DaemonState = state): string | null {
  return s.httpOrigin ? `${s.httpOrigin}/api/attachments/${encodeURIComponent(id)}` : null;
}

/** Whether the current agent takes images; `null` = not known yet (ACP agent not initialized). */
export function agentTakesImages(s: DaemonState = state): boolean | null {
  const agents = s.agent?.agents;
  const current = agents?.available.find((a) => a.id === agents.currentAgentId);
  return current?.images ?? null;
}

export interface UploadHandle {
  done: Promise<AttachmentInfo>;
  abort: () => void;
}

/** Uploads one image (raw body). XHR rather than fetch for upload progress. */
export function uploadAttachment(
  file: Blob,
  name: string,
  onProgress?: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const done = new Promise<AttachmentInfo>((resolve, reject) => {
    if (!state.httpOrigin || state.source !== "daemon") {
      reject(new Error("No daemon connected"));
      return;
    }
    xhr.open("POST", `${state.httpOrigin}/api/attachments?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: (AttachmentInfo & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText) as AttachmentInfo & { error?: string };
      } catch {
        body = null;
      }
      if (xhr.status === 200 && body?.id) resolve(body);
      else reject(new Error(body?.error ?? `upload failed (${xhr.status || "network"})`));
    };
    xhr.onerror = () => reject(new Error("upload failed (network)"));
    xhr.onabort = () => reject(new Error("upload cancelled"));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

// ---------------------------------------------------------------------------
// React

/** A slice of the daemon state: re-renders only when the (primitive) slice changes. */
export function useDaemonSelector<T>(select: (s: DaemonState) => T): T {
  useEffect(() => {
    startDaemon();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(INITIAL),
  );
}

/** The element the running turn works on, and whether it waits on a permission ("nodeId|state"). */
export function workingNodeOf(s: DaemonState): { nodeId: string; waiting: boolean } | null {
  const t = s.turns[s.turns.length - 1];
  if (!t || t.stopReason || t.nodeId === null) return null;
  return { nodeId: t.nodeId, waiting: !!t.permission };
}

export function useDaemon(): DaemonState {
  useEffect(() => {
    startDaemon();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ---------------------------------------------------------------------------
// §13: activity, resume, view state, feature flags

/** Opens the project (and chat) an activity event or a notification points at. */
export async function openActivityTarget(target: Pick<NotificationTarget, "projectId"> & Partial<NotificationTarget>): Promise<void> {
  const chatId = target.chatId ?? undefined;
  if (state.project?.id === target.projectId) {
    if (chatId) openChat(chatId);
    return;
  }
  const root = target.projectRoot ?? state.recentProjects.find((p) => p.id === target.projectId)?.root;
  if (!root) return;
  try {
    await openProject(root, { projectId: target.projectId, ...(chatId ? { chatId } : {}) });
  } catch {
    /* the folder is gone; the switch UI already reports failures */
  }
}

/** Clears unread markers of a chat (or the whole project). */
export function markActivityRead(projectId: string, chatId?: string): boolean {
  clearUnreadLocally(projectId, chatId);
  return send({ type: "activity.read", projectId, ...(chatId ? { chatId } : {}) });
}

/** GET /api/projects/:id/resume — "where you left off" (§13.4). */
export function fetchResume(projectId: string): Promise<ResumeInfo> {
  return api<ResumeInfo>(`/api/projects/${encodeURIComponent(projectId)}/resume`);
}

/** GET /api/projects/:id/view — the saved view state (§13.5). */
export async function fetchViewState(projectId: string): Promise<{ view: ViewState | null; updatedAt: string | null }> {
  return api(`/api/projects/${encodeURIComponent(projectId)}/view`);
}

export const VIEW_STATE_MAX_BYTES = 16 * 1024;
const VIEW_SAVE_DEBOUNCE_MS = 400;
const viewSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingViews = new Map<string, ViewState>();

/** Saves the view state over the socket (debounced per project; HTTP when the socket is down).
 * Returns false when the state is too large (> 16 KB serialized) and was not saved. */
export function saveViewState(projectId: string, view: ViewState, opts: { immediate?: boolean } = {}): boolean {
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(view)).length;
  } catch {
    return false;
  }
  if (size > VIEW_STATE_MAX_BYTES) return false;
  pendingViews.set(projectId, view);
  const flush = () => {
    viewSaveTimers.delete(projectId);
    const latest = pendingViews.get(projectId);
    pendingViews.delete(projectId);
    if (!latest) return;
    if (!send({ type: "view.save", projectId, view: latest }))
      void api(`/api/projects/${encodeURIComponent(projectId)}/view`, { view: latest }).catch(() => {});
  };
  const timer = viewSaveTimers.get(projectId);
  if (timer !== undefined) clearTimeout(timer);
  if (opts.immediate) flush();
  else viewSaveTimers.set(projectId, setTimeout(flush, VIEW_SAVE_DEBOUNCE_MS));
  return true;
}

/** Feature flags in ~/.ruah/settings.json (§13.6); every viewer gets a new activity.snapshot. */
export function setFeatureFlags(patch: Partial<AppFeatures>): boolean {
  return send({ type: "settings.set", ...patch });
}

export const daemonActions = {
  sendPrompt,
  cancel,
  answerPermission,
  setFocus,
  setAgentMode,
  setModel,
  setAgent,
  prewarmAgents,
  setDefaults,
  resetSession,
  editArchitecture,
  fetchFile,
  fetchContext,
  dismissError,
  // §5
  setAgentModel,
  newChat,
  openChat,
  renameChat,
  deleteChat,
  openChatAnywhere,
  prefetchProject,
  prefetchChat,
  openProject,
  createProject,
  pinProject,
  forgetProject,
  refreshProjects,
  fetchRecentChats,
  rescan,
  // §1.7
  undoMapChanges,
  // §13
  openActivityTarget,
  markActivityRead,
  fetchResume,
  fetchViewState,
  saveViewState,
  setFeatureFlags,
};
