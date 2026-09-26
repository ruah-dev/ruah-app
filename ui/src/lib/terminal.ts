// Integrated terminal client (CONTRACTS §7): one WebSocket to /ws/terminal multiplexing every
// terminal, the bottom panel's state (open, height, maximized, font size, active tab per
// project) and the actions other parts of the app call ("Open in terminal", "Run in
// terminal"). A useSyncExternalStore store like lib/daemon.ts; nothing runs at module load.
import { useSyncExternalStore } from "react";
import { resolveDaemonUrls } from "./daemon";

export interface TerminalInfo {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  shell: string;
  pid: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  /** §18: the live preview's dev server (a command, not a shell). */
  kind?: "preview";
}

type ServerMessage =
  | { type: "ready"; available: true; projectId: string | null; shell: string }
  | { type: "ready"; available: false; reason: string; projectId: string | null }
  | { type: "created"; requestId: string; terminal: TerminalInfo }
  | { type: "terminals"; projectId: string | null; terminals: TerminalInfo[]; requestId?: string }
  | { type: "attached"; id: string; terminal: TerminalInfo; replay: string }
  | { type: "output"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number | null; signal: number | null }
  | { type: "error"; requestId?: string; id?: string; message: string };

export type TerminalConnection = "idle" | "connecting" | "open" | "closed" | "unavailable";

export interface TerminalState {
  connection: TerminalConnection;
  /** Why the terminal cannot be used (node-pty missing, remote host, cross-origin viewer…). */
  reason: string | null;
  shell: string | null;
  /** Terminals per project id (the daemon's lists). */
  terminals: Record<string, TerminalInfo[]>;
  /** Selected tab per project id. */
  active: Record<string, string>;
  open: boolean;
  maximized: boolean;
  height: number;
  fontSize: number;
  /** Bumped to ask the active terminal to take keyboard focus. */
  focusSignal: number;
}

export interface TerminalViewHandlers {
  onAttached(replay: string, info: TerminalInfo): void;
  onOutput(data: string): void;
  onExit(exitCode: number | null, signal: number | null): void;
}

const PREFS_KEY = "ruah.terminal.v1";
export const MIN_HEIGHT = 120;
export const DEFAULT_HEIGHT = 280;
export const MIN_FONT = 9;
export const MAX_FONT = 24;
export const DEFAULT_FONT = 12.5;

interface Prefs {
  open: boolean;
  height: number;
  fontSize: number;
  active: Record<string, string>;
}

function readPrefs(): Prefs {
  const fallback: Prefs = { open: false, height: DEFAULT_HEIGHT, fontSize: DEFAULT_FONT, active: {} };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      open: p.open === true,
      height: typeof p.height === "number" && p.height >= MIN_HEIGHT ? p.height : DEFAULT_HEIGHT,
      fontSize: typeof p.fontSize === "number" && p.fontSize >= MIN_FONT && p.fontSize <= MAX_FONT ? p.fontSize : DEFAULT_FONT,
      active: p.active && typeof p.active === "object" ? p.active : {},
    };
  } catch {
    return fallback;
  }
}

function writePrefs() {
  try {
    const { open, height, fontSize, active } = state;
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ open, height, fontSize, active }));
  } catch {
    /* storage unavailable */
  }
}

const INITIAL: TerminalState = {
  connection: "idle",
  reason: null,
  shell: null,
  terminals: {},
  active: {},
  open: false,
  maximized: false,
  height: DEFAULT_HEIGHT,
  fontSize: DEFAULT_FONT,
  focusSignal: 0,
};

let state: TerminalState = INITIAL;
let prefsLoaded = false;
const listeners = new Set<() => void>();

function set(patch: Partial<TerminalState>, persist = false) {
  state = { ...state, ...patch };
  if (persist) writePrefs();
  for (const l of listeners) l();
}

function ensurePrefs() {
  if (prefsLoaded || typeof window === "undefined") return;
  prefsLoaded = true;
  const p = readPrefs();
  state = { ...state, open: p.open, height: p.height, fontSize: p.fontSize, active: p.active };
}

function subscribe(listener: () => void) {
  ensurePrefs();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminal(): TerminalState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

export function terminalState(): TerminalState {
  ensurePrefs();
  return state;
}

// ---------------------------------------------------------------------------
// connection

let socket: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let requestSeq = 0;
const pending = new Map<string, { resolve: (t: TerminalInfo) => void; reject: (e: Error) => void }>();
const views = new Map<string, Set<TerminalViewHandlers>>();
/** Characters rendered but not acknowledged yet, per terminal (flow control, §7.3 ack). */
const unacked = new Map<string, number>();
const ACK_EVERY = 5000;
let readyWaiters: (() => void)[] = [];

function send(message: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function fetchToken(httpOrigin: string): Promise<string> {
  // Same-origin only: the daemon refuses cross-site reads (§7.1), and a viewer served from
  // another origin (?daemon=…) cannot read the response at all.
  if (typeof window !== "undefined" && httpOrigin !== window.location.origin) {
    throw new Error("The terminal is only available in the viewer the daemon serves (open Ruah itself, not a preview).");
  }
  const res = await fetch(`${httpOrigin}/api/terminal/token`, { credentials: "same-origin", cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || typeof body.token !== "string") throw new Error(body.error ?? `The terminal is not available (HTTP ${res.status}).`);
  return body.token;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(8000, 500 * 2 ** Math.min(attempt, 4));
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
}

let connecting = false;

async function connect() {
  if (typeof window === "undefined" || connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    await open();
  } finally {
    connecting = false;
  }
}

async function open() {
  const urls = resolveDaemonUrls();
  if (!urls) return;
  if (state.connection !== "open") set({ connection: "connecting" });
  let token: string;
  try {
    token = await fetchToken(urls.httpOrigin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A network failure (daemon restarting) retries; a refusal is final.
    if (err instanceof TypeError) {
      set({ connection: "closed", reason: null });
      scheduleReconnect();
    } else set({ connection: "unavailable", reason: message });
    return;
  }
  const wsUrl = new URL("/ws/terminal", urls.wsUrl);
  wsUrl.searchParams.set("token", token);
  const ws = new WebSocket(wsUrl.toString());
  socket = ws;
  ws.onmessage = (event) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }
    onMessage(msg);
  };
  ws.onopen = () => {
    attempt = 0;
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    for (const [, p] of pending) p.reject(new Error("The terminal connection closed."));
    pending.clear();
    unacked.clear();
    if (state.connection !== "unavailable") {
      set({ connection: "closed" });
      scheduleReconnect();
    }
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function onMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "ready": {
      if (msg.available) set({ connection: "open", reason: null, shell: msg.shell });
      else set({ connection: "unavailable", reason: msg.reason });
      // Re-attach every mounted view (reconnect after a daemon restart or a network blip).
      for (const id of views.keys()) send({ type: "attach", id });
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w();
      return;
    }
    case "terminals": {
      if (msg.projectId === null) return;
      set({ terminals: { ...state.terminals, [msg.projectId]: msg.terminals } });
      const active = state.active[msg.projectId];
      if ((!active || !msg.terminals.some((t) => t.id === active)) && msg.terminals.length > 0) {
        setActive(msg.projectId, msg.terminals[msg.terminals.length - 1]!.id);
      }
      return;
    }
    case "created": {
      const p = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      const list = state.terminals[msg.terminal.projectId] ?? [];
      if (!list.some((t) => t.id === msg.terminal.id)) {
        set({ terminals: { ...state.terminals, [msg.terminal.projectId]: [...list, msg.terminal] } });
      }
      p?.resolve(msg.terminal);
      return;
    }
    case "attached":
      for (const h of views.get(msg.id) ?? []) h.onAttached(msg.replay, msg.terminal);
      return;
    case "output":
      for (const h of views.get(msg.id) ?? []) h.onOutput(msg.data);
      return;
    case "exit":
      for (const h of views.get(msg.id) ?? []) h.onExit(msg.exitCode, msg.signal);
      return;
    case "error": {
      if (msg.requestId && pending.has(msg.requestId)) {
        pending.get(msg.requestId)!.reject(new Error(msg.message));
        pending.delete(msg.requestId);
      }
      return;
    }
  }
}

function whenReady(): Promise<void> {
  if (state.connection === "open") return Promise.resolve();
  if (state.connection === "unavailable") return Promise.reject(new Error(state.reason ?? "The terminal is unavailable."));
  void connect();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The terminal did not connect.")), 10_000);
    readyWaiters.push(() => {
      clearTimeout(timer);
      if (state.connection === "open") resolve();
      else reject(new Error(state.reason ?? "The terminal is unavailable."));
    });
  });
}

// ---------------------------------------------------------------------------
// views (TerminalView registers while mounted)

export function attachView(id: string, handlers: TerminalViewHandlers): () => void {
  let set_ = views.get(id);
  if (!set_) {
    set_ = new Set();
    views.set(id, set_);
  }
  set_.add(handlers);
  send({ type: "attach", id });
  return () => {
    const s = views.get(id);
    if (!s) return;
    s.delete(handlers);
    if (s.size === 0) {
      views.delete(id);
      unacked.delete(id);
      send({ type: "detach", id });
    }
  };
}

/** Called by the view once xterm has rendered `chars` characters of output. */
export function rendered(id: string, chars: number) {
  const total = (unacked.get(id) ?? 0) + chars;
  if (total >= ACK_EVERY) {
    unacked.set(id, 0);
    send({ type: "ack", id, chars: total });
  } else unacked.set(id, total);
}

export function sendInput(id: string, data: string) {
  send({ type: "input", id, data });
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  send({ type: "resize", id, cols, rows });
}

// ---------------------------------------------------------------------------
// actions

export const terminalActions = {
  connect: () => void connect(),

  setOpen(open: boolean) {
    ensurePrefs();
    set({ open, ...(open ? {} : { maximized: false }) }, true);
    if (open) void connect();
  },

  toggle() {
    ensurePrefs();
    terminalActions.setOpen(!state.open);
    if (state.open) terminalActions.focus();
  },

  focus() {
    set({ focusSignal: state.focusSignal + 1 });
  },

  setHeight(height: number) {
    set({ height: Math.max(MIN_HEIGHT, Math.round(height)) }, true);
  },

  setMaximized(maximized: boolean) {
    set({ maximized });
  },

  setFontSize(size: number) {
    set({ fontSize: Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(size * 2) / 2)) }, true);
  },

  /** Asks the daemon for a project's terminals (after a project switch or on first open). */
  list(projectId: string) {
    send({ type: "list", projectId });
  },

  /** A new terminal in the open project; opens the panel and selects the tab. */
  async create(options: { cwd?: string; nodeId?: string; title?: string; input?: string; cols?: number; rows?: number } = {}): Promise<TerminalInfo> {
    ensurePrefs();
    if (!state.open) set({ open: true }, true);
    await whenReady();
    const requestId = `c${++requestSeq}`;
    const created = new Promise<TerminalInfo>((resolve, reject) => pending.set(requestId, { resolve, reject }));
    const ok = send({
      type: "create",
      requestId,
      cols: options.cols ?? lastSize.cols,
      rows: options.rows ?? lastSize.rows,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
      ...(options.title !== undefined ? { title: options.title.slice(0, 80) } : {}),
      ...(options.input !== undefined ? { input: options.input.slice(0, 65_536) } : {}),
    });
    if (!ok) {
      pending.delete(requestId);
      throw new Error("The terminal is not connected.");
    }
    const info = await created;
    setActive(info.projectId, info.id);
    terminalActions.focus();
    return info;
  },

  kill(id: string) {
    send({ type: "kill", id });
  },

  rename(id: string, title: string) {
    const t = title.trim().slice(0, 80);
    if (t) send({ type: "rename", id, title: t });
  },

  clear(id: string) {
    send({ type: "clear", id });
  },

  setActive(projectId: string, id: string) {
    setActive(projectId, id);
  },
};

function setActive(projectId: string, id: string) {
  if (state.active[projectId] === id) return;
  set({ active: { ...state.active, [projectId]: id } }, true);
}

/** Last size a view reported, so new terminals start close to the panel's size. */
export const lastSize = { cols: 120, rows: 30 };

/** A terminal in an element's folder (its path, else its first file's folder). */
export function openTerminalForElement(node: { id: string; label?: string; path?: string; filePaths?: string[] }) {
  const first = node.filePaths?.[0];
  const cwd = node.path ?? (first !== undefined && first.includes("/") ? first.slice(0, first.lastIndexOf("/")) : undefined);
  return terminalActions.create({
    nodeId: node.id,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(node.label ? { title: node.label } : {}),
  });
}

/** "Run in terminal": a new tab with the command typed at the prompt, not run. */
export function runInTerminal(command: string) {
  const first = command.trim().split(/\s+/)[0] ?? "run";
  return terminalActions.create({ input: command, title: first.slice(0, 40) });
}

/** True when a key event comes from inside a terminal (its hidden textarea). */
export function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-ruah-terminal]") !== null;
}
