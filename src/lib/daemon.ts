// WebSocket client for the archmap daemon (CONTRACTS.md §2) exposed as a
// useSyncExternalStore store. Nothing here runs at module load: the socket is
// opened by the first component that calls useDaemon() (in an effect), so the
// SPA prerender never touches window/location.
import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentState,
  Architecture,
  ClientMessage,
  ModeState,
  ModelState,
  PermissionOption,
  ServerMessage,
  StopReason,
  StreamEvent,
  ToolCallView,
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
  error?: string;
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
  events: StreamEvent[];
  permission: PermissionRequest | null;
  resolved: PermissionRecord[];
  stopReason?: StopReason;
  error?: string;
}

export type SaveState = "idle" | "pending" | "saving" | "error";

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
  wsUrl: string | null;
  httpOrigin: string | null;
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
  wsUrl: null,
  httpOrigin: null,
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
  connect();
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
        architecture: draft ?? msg.architecture,
        revision: msg.revision,
        root: msg.root,
        path: msg.path,
        archError: null,
        save: editsPending() ? state.save : "idle",
      });
      return;
    }
    case "architecture.error":
      set({ archError: msg.message });
      return;
    case "agent.status": {
      const prev = state.agent;
      set({
        agent: {
          state: msg.state,
          ...((msg.agent ?? prev?.agent) ? { agent: (msg.agent ?? prev?.agent)! } : {}),
          ...((msg.sessionId ?? prev?.sessionId)
            ? { sessionId: (msg.sessionId ?? prev?.sessionId)! }
            : {}),
          ...((msg.modes ?? prev?.modes) ? { modes: (msg.modes ?? prev?.modes)! } : {}),
          ...((msg.models ?? prev?.models) ? { models: (msg.models ?? prev?.models)! } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        },
      });
      return;
    }
    case "turn.started": {
      if (state.turns.some((t) => t.id === msg.turnId)) {
        updateTurn(msg.turnId, (t) => ({ ...t, contextPack: msg.contextPack, nodeId: msg.nodeId }));
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
              events: [],
              permission: null,
              resolved: [],
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

export function sendPrompt(nodeId: string, text: string): string {
  const turn: Turn = {
    id: newId(),
    nodeId,
    text,
    contextPack: "",
    events: [],
    permission: null,
    resolved: [],
  };
  const ok = state.source === "daemon" && send({ type: "prompt", turnId: turn.id, nodeId, text });
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

export function resetSession() {
  if (send({ type: "session.reset" })) set({ turns: state.turns.filter((t) => !t.stopReason) });
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
  resetSession,
  editArchitecture,
  fetchFile,
  fetchContext,
  dismissError,
};
