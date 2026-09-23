// WebSocket client for the archmap daemon (CONTRACTS.md §2) exposed as a
// useSyncExternalStore store. Nothing here runs at module load: the socket is
// opened by the first component that calls useDaemon() (in an effect), so the
// SPA prerender never touches window/location.
import { useEffect, useSyncExternalStore } from "react";
import type {
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
import sampleArchitectureJson from "@/data/sample-architecture.json";
import { sampleFiles } from "@/data/sample-files";

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
  nodeId: string;
  text: string;
  contextPack: string;
  /** Images sent with the prompt (§5.6). */
  attachments?: AttachmentMeta[];
  events: StreamEvent[];
  permission: PermissionRequest | null;
  resolved: PermissionRecord[];
  stopReason?: StopReason;
  error?: string;
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
  connect();
}

// ---------------------------------------------------------------------------
// projects + chats (§5): incoming frames

const MODEL_CACHE_KEY = "ruah.models.v1";
const SWITCH_TIMEOUT_MS = 30_000;

/** Model choice for an agent that is not running yet: applied once it reports idle. */
let pendingModel: { agentId: string; modelId: string } | null = null;
/** Chat to open once the (new) project's chat list arrives. */
let pendingChatOpen: string | null = null;
/** Last known turns per chat, so switching back to a chat is instant (history replaces it). */
const turnCache = new Map<string, Turn[]>();
let switchTimer: ReturnType<typeof setTimeout> | undefined;

function loadModelCache() {
  try {
    const raw = window.localStorage.getItem(MODEL_CACHE_KEY);
    if (raw) set({ modelsByAgent: JSON.parse(raw) as Record<string, ModelState> });
  } catch {
    /* ignore */
  }
}

function persistModelCache() {
  try {
    window.localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(state.modelsByAgent));
  } catch {
    /* ignore */
  }
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
  // interrupted before the daemon could record the end.
  const stopReason: StopReason | undefined = r.stopReason ?? (idle ? "cancelled" : undefined);
  return {
    id: r.turnId,
    nodeId: r.nodeId,
    text: r.text,
    contextPack: r.contextPack,
    ...(r.attachments?.length ? { attachments: r.attachments } : {}),
    events: r.events,
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
  if (nextId !== prevId) {
    // Another project: drop everything that belonged to the previous one.
    serverArchitecture = null;
    draft = null;
    needsResend = false;
    savesInFlight = 0;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    turnCache.clear();
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
    if (project) {
      patch.recentProjects = sortProjects([
        project,
        ...state.recentProjects.filter((p) => p.id !== project.id),
      ]);
    }
  }
  if (project === null) {
    patch.projectSwitch = null;
    clearSwitchTimer();
  } else if (state.projectSwitch && nextId !== prevId) {
    // Adopt the daemon's canonical root (realpath) for the pending switch.
    patch.projectSwitch = { ...state.projectSwitch, root: project.root, name: project.name };
  }
  set(patch);
  void refreshProjects();
}

function handleChats(projectId: string, chats: ChatInfo[], activeChatId: string | null) {
  if (state.project && projectId !== state.project.id) return; // stale frame from before a switch
  const sorted = [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const prev = state.activeChatId;
  const patch: Partial<DaemonState> = { chats: sorted, activeChatId };
  if (activeChatId !== prev) {
    if (activeChatId === null) {
      patch.turns = [];
      patch.chatLoading = false;
    } else if (prev !== null) {
      // Switched elsewhere (another tab): show what we know until chat.history arrives.
      turnCache.set(prev, state.turns.filter((t) => t.stopReason));
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
  turnCache.set(chatId, hist);
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
  switch (msg.type) {
    case "architecture": {
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
        },
        ...(msg.models
          ? {
              modelsByAgent: {
                ...state.modelsByAgent,
                [msg.agents?.currentAgentId ?? prev?.agents?.currentAgentId ?? "default"]:
                  msg.models,
              },
            }
          : {}),
      });
      if (msg.models) persistModelCache();
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
      if (state.turns.some((t) => t.id === msg.turnId)) {
        updateTurn(msg.turnId, (t) => ({
          ...t,
          contextPack: msg.contextPack,
          nodeId: msg.nodeId,
          ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
        }));
      } else {
        // Started from another viewer tab: show it here too.
        set({
          turns: [
            ...state.turns,
            {
              id: msg.turnId,
              nodeId: msg.nodeId,
              text: msg.text,
              contextPack: msg.contextPack,
              ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
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
      updateTurn(msg.turnId, (t) => ({ ...t, events: [...t.events, msg.event] }));
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
      updateTurn(msg.turnId, (t) => ({
        ...t,
        permission: null,
        stopReason: msg.stopReason,
        finishedAt: Date.now(),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      }));
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

// ---------------------------------------------------------------------------
// actions

const newId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function sendPrompt(nodeId: string, text: string, attachments: AttachmentMeta[] = []): string {
  const turn: Turn = {
    id: newId(),
    nodeId,
    text,
    contextPack: "",
    ...(attachments.length ? { attachments } : {}),
    events: [],
    permission: null,
    resolved: [],
    startedAt: Date.now(),
  };
  const ok =
    state.source === "daemon" &&
    send({
      type: "prompt",
      turnId: turn.id,
      nodeId,
      text,
      ...(attachments.length
        ? { attachments: attachments.map(({ id, name }) => ({ id, name })) }
        : {}),
    });
  if (!ok) {
    turn.stopReason = "error";
    turn.error =
      "No archmap daemon connected. Start one with `archmap serve <repo>` to talk to the agent.";
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

/** Switch coding agent. The daemon stops any running turn and starts a new session; until the
 * new agent reports idle the UI shows a quiet "Starting …" state (state.agentSwitch). */
export function setAgent(agentId: string): boolean {
  const agents = state.agent?.agents;
  const choice = agents?.available.find((a) => a.id === agentId);
  if (!state.agent || !agents || !choice || !choice.installed) return false;
  if (agents.currentAgentId === agentId) return true;
  if (!send({ type: "agent.set", agentId })) return false;
  const { models: _dropped, ...rest } = state.agent;
  set({
    agentSwitch: { agentId, name: choice.name },
    agent: { ...rest, state: "starting", agents: { ...agents, currentAgentId: agentId } },
  });
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
    turnCache.set(
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
  if (!send({ type: "chat.open", chatId })) return false;
  stashActiveTurns();
  set({ activeChatId: chatId, turns: turnCache.get(chatId) ?? [], chatLoading: true });
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

function beginSwitch(root: string, name: string) {
  clearSwitchTimer();
  set({ projectSwitch: { root, name } });
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
  opts: { name?: string; chatId?: string } = {},
): Promise<ProjectInfo> {
  const target = path.trim();
  if (!target) throw new Error("Choose a folder first");
  if (state.project && sameRoot(state.project.root, target)) {
    if (opts.chatId) openChat(opts.chatId);
    return state.project;
  }
  pendingChatOpen = opts.chatId ?? null;
  beginSwitch(target, opts.name ?? basename(target));
  try {
    const info = await api<ProjectInfo>("/api/projects/open", { path: target });
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

export async function fetchRecentChats(limit = 200): Promise<RecentChat[]> {
  const res = await api<RecentChatsResponse>(`/api/chats/recent?limit=${limit}`);
  return res.chats ?? [];
}

/** Open a chat from any project: switches project first when needed. */
export async function openChatAnywhere(chat: RecentChat): Promise<void> {
  if (state.project?.id === chat.projectId) {
    openChat(chat.id);
    return;
  }
  await openProject(chat.projectRoot, { name: chat.projectName, chatId: chat.id });
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
  return s.source === "daemon" && s.connection === "open" && s.architecture !== null;
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

export function useDaemon(): DaemonState {
  useEffect(() => {
    startDaemon();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const daemonActions = {
  sendPrompt,
  cancel,
  answerPermission,
  setFocus,
  setAgentMode,
  setModel,
  setAgent,
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
  openProject,
  createProject,
  pinProject,
  forgetProject,
  refreshProjects,
  fetchRecentChats,
  rescan,
};
