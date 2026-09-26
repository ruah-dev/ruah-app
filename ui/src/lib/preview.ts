// Live preview client (CONTRACTS §18): the open project's dev server status (pushed as
// `preview` frames on /ws, fetched on mount and after reconnects), its detection (what can
// run), the actions (start / stop / restart / choose) and per-project viewer preferences
// (device width, auto-reload). A useSyncExternalStore store like lib/terminal.ts; nothing
// runs at module load. The pure helpers at the bottom are tested in ui/test/preview.test.ts.
import { useEffect, useSyncExternalStore } from "react";
import { daemonSnapshot, onDaemonMessage, resolveDaemonUrls, SAMPLE_MODE_MESSAGE, useDaemonSelector } from "./daemon";
import type { PreviewCandidate, PreviewDetection, PreviewFile, PreviewStatus } from "./preview-types";

export type { PreviewCandidate, PreviewDetection, PreviewFile, PreviewStatus } from "./preview-types";

export type Device = "desktop" | "tablet" | "phone";
export const DEVICES: Record<Device, { label: string; width: number | null }> = {
  desktop: { label: "Desktop", width: null },
  tablet: { label: "Tablet · 820", width: 820 },
  phone: { label: "Phone · 390", width: 390 },
};

export interface PreviewPrefs {
  device: Device;
  /** Reload after agent turns that edited files; unset = on when the server has no HMR. */
  autoReload?: boolean;
}

type Pending = "start" | "stop" | "restart" | "choose";

export interface PreviewState {
  statuses: Record<string, PreviewStatus>;
  detections: Record<string, PreviewDetection>;
  detecting: Record<string, boolean>;
  pending: Record<string, Pending | undefined>;
  /** Last failed action per project (cleared by the next one). */
  errors: Record<string, string | undefined>;
  prefs: Record<string, PreviewPrefs>;
}

const PREFS_KEY = "ruah.preview.v1";
const DEFAULT_PREFS: PreviewPrefs = { device: "desktop" };

const INITIAL: PreviewState = { statuses: {}, detections: {}, detecting: {}, pending: {}, errors: {}, prefs: {} };
let state: PreviewState = INITIAL;
let prefsLoaded = false;
const listeners = new Set<() => void>();

function set(patch: Partial<PreviewState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function readPrefs(): Record<string, PreviewPrefs> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Partial<PreviewPrefs>>) : {};
    const out: Record<string, PreviewPrefs> = {};
    for (const [id, p] of Object.entries(parsed)) {
      const device: Device = p.device === "tablet" || p.device === "phone" ? p.device : "desktop";
      out[id] = { device, ...(typeof p.autoReload === "boolean" ? { autoReload: p.autoReload } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

function ensurePrefs() {
  if (prefsLoaded || typeof window === "undefined") return;
  prefsLoaded = true;
  state = { ...state, prefs: readPrefs() };
}

function writePrefs() {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* storage unavailable */
  }
}

let unsubscribeMessages: (() => void) | null = null;
function ensureListening() {
  if (unsubscribeMessages !== null || typeof window === "undefined") return;
  unsubscribeMessages = onDaemonMessage((msg) => {
    if (msg.type === "preview") noteStatus(msg.status);
  });
}

function subscribe(listener: () => void) {
  ensurePrefs();
  ensureListening();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreviewState(): PreviewState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

// ---------------------------------------------------------------------------
// HTTP

export class PreviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detection?: PreviewDetection,
  ) {
    super(message);
  }
}

function origin(): string {
  // The bundled sample never reaches a daemon: a start would run the real project's dev server.
  if (daemonSnapshot().source === "sample") throw new PreviewApiError(SAMPLE_MODE_MESSAGE, 0);
  const urls = resolveDaemonUrls();
  if (!urls) throw new PreviewApiError("The daemon is not reachable.", 0);
  return urls.httpOrigin;
}

let token: string | null = null;
async function terminalToken(force = false): Promise<string> {
  if (token !== null && !force) return token;
  const base = origin();
  if (typeof window !== "undefined" && base !== window.location.origin) {
    throw new PreviewApiError("Your own commands run only in the viewer the daemon serves (open Ruah itself).", 403);
  }
  const res = await fetch(`${base}/api/terminal/token`, { credentials: "same-origin", cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || typeof body.token !== "string") throw new PreviewApiError(body.error ?? `No terminal token (HTTP ${res.status}).`, res.status);
  token = body.token;
  return token;
}

async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; withToken?: boolean } = {}): Promise<T> {
  const send = async (fresh: boolean): Promise<Response> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.withToken) headers["x-ruah-token"] = await terminalToken(fresh);
    return fetch(`${origin()}${path}`, {
      method: init.method ?? "GET",
      headers,
      cache: "no-store",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  };
  let res = await send(false);
  // The daemon restarted (new token): fetch it once more.
  if (res.status === 403 && init.withToken) res = await send(true);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; detection?: PreviewDetection };
  if (!res.ok) throw new PreviewApiError(body.error ?? `HTTP ${res.status}`, res.status, body.detection);
  return body;
}

// ---------------------------------------------------------------------------
// actions

function setFor<K extends "pending" | "errors" | "detecting">(key: K, projectId: string, value: PreviewState[K][string]) {
  set({ [key]: { ...state[key], [projectId]: value } } as Partial<PreviewState>);
}

/** Keeps the newest status per project (`rev`); `force` after a (re)connect, when the daemon may be new. */
function noteStatus(status: PreviewStatus | null, force = false) {
  if (!status) return;
  const known = state.statuses[status.projectId];
  if (!force && known && known.rev > status.rev) return;
  set({ statuses: { ...state.statuses, [status.projectId]: status } });
}

async function run<T>(projectId: string, kind: Pending, fn: () => Promise<T>): Promise<T | undefined> {
  setFor("pending", projectId, kind);
  setFor("errors", projectId, undefined);
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setFor("errors", projectId, message);
    if (err instanceof PreviewApiError && err.detection) set({ detections: { ...state.detections, [projectId]: err.detection } });
    return undefined;
  } finally {
    setFor("pending", projectId, undefined);
  }
}

export const previewActions = {
  /** Status + detection of the open project (on mount, after a project switch or reconnect). */
  async refresh(projectId: string) {
    ensureListening();
    setFor("detecting", projectId, true);
    try {
      const [status, detection] = await Promise.all([
        api<PreviewStatus>("/api/preview").catch(() => null),
        api<PreviewDetection>("/api/preview/detect").catch(() => null),
      ]);
      if (status && status.projectId === projectId) noteStatus(status, true);
      if (detection) set({ detections: { ...state.detections, [projectId]: detection } });
    } finally {
      setFor("detecting", projectId, false);
    }
  },

  /**
   * A candidate id, your own command (+ folder), or nothing: the saved / obvious choice.
   * `remember` keeps it on this computer; `saveToRepo` writes `.ruah/preview.json` (§21.3).
   */
  start(projectId: string, body: { candidate?: string; command?: string; dir?: string; remember?: boolean; saveToRepo?: boolean } = {}) {
    return run(projectId, "start", async () => {
      const status = await api<PreviewStatus>("/api/preview/start", { method: "POST", body, withToken: body.command !== undefined });
      noteStatus(status);
      if (body.remember || body.saveToRepo) void previewActions.refresh(projectId);
      return status;
    });
  },

  stop(projectId: string) {
    return run(projectId, "stop", async () => {
      const status = await api<PreviewStatus>("/api/preview/stop", { method: "POST", body: {} });
      noteStatus(status);
      return status;
    });
  },

  restart(projectId: string) {
    return run(projectId, "restart", async () => {
      const status = await api<PreviewStatus>("/api/preview/restart", { method: "POST", body: {} });
      noteStatus(status);
      return status;
    });
  },

  /** Saves the project's choice on this computer, or with `saveToRepo` in `.ruah/preview.json`; null clears a field. */
  choose(projectId: string, patch: { candidate?: string | null; command?: string | null; dir?: string | null; url?: string | null; saveToRepo?: boolean }) {
    return run(projectId, "choose", async () => {
      const detection = await api<PreviewDetection>("/api/preview/choice", { method: "POST", body: patch, withToken: typeof patch.command === "string" });
      set({ detections: { ...state.detections, [projectId]: detection } });
      return detection;
    });
  },

  async logs(lines = 300): Promise<string[]> {
    const body = await api<{ lines: string[] }>(`/api/preview/logs?lines=${lines}`);
    return body.lines;
  },

  clearError(projectId: string) {
    setFor("errors", projectId, undefined);
  },

  setDevice(projectId: string, device: Device) {
    ensurePrefs();
    set({ prefs: { ...state.prefs, [projectId]: { ...(state.prefs[projectId] ?? DEFAULT_PREFS), device } } });
    writePrefs();
  },

  setAutoReload(projectId: string, autoReload: boolean) {
    ensurePrefs();
    set({ prefs: { ...state.prefs, [projectId]: { ...(state.prefs[projectId] ?? DEFAULT_PREFS), autoReload } } });
    writePrefs();
  },
};

/** The open project's preview: status, detection, pending action, error, prefs. Refreshes on project switch and reconnect. */
export function usePreview(projectId: string | null) {
  const s = usePreviewState();
  const connection = useDaemonSelector((d) => d.connection);
  const source = useDaemonSelector((d) => d.source);
  useEffect(() => {
    if (projectId && connection === "open" && source === "daemon") void previewActions.refresh(projectId);
  }, [projectId, connection, source]);
  if (!projectId) return null;
  return {
    status: s.statuses[projectId] ?? null,
    detection: s.detections[projectId] ?? null,
    detecting: s.detecting[projectId] === true,
    pending: s.pending[projectId] ?? null,
    error: s.errors[projectId] ?? null,
    prefs: s.prefs[projectId] ?? DEFAULT_PREFS,
  };
}

// ---------------------------------------------------------------------------
// pure helpers

/** Reload after agent edits: the user's choice, else on when the dev server has no hot reload. */
export function effectiveAutoReload(pref: boolean | undefined, hmr: boolean): boolean {
  return pref ?? !hmr;
}

/** What the URL bar's text navigates to: a path on the dev server, or a full http(s) URL. Null = invalid. */
export function resolveNavigation(base: string | null, input: string): string | null {
  const text = input.trim();
  if (text.length === 0) return base;
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).toString();
    } catch {
      return null;
    }
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) {
    try {
      return new URL(`http://${text}`).toString();
    } catch {
      return null;
    }
  }
  if (base === null) return null;
  try {
    return new URL(text.startsWith("/") ? text : `/${text}`, base).toString();
  } catch {
    return null;
  }
}

/** The scale that fits a device width into the pane (never enlarges). */
export function fitScale(containerWidth: number, deviceWidth: number | null, padding = 32): number {
  if (deviceWidth === null || containerWidth <= 0) return 1;
  return Math.min(1, Math.max(0.2, (containerWidth - padding) / deviceWidth));
}

/** Candidates grouped by folder (monorepo apps), in detection order. */
export function groupCandidates(candidates: readonly PreviewCandidate[]): { dir: string; label: string; items: PreviewCandidate[] }[] {
  const groups = new Map<string, { dir: string; label: string; items: PreviewCandidate[] }>();
  for (const c of candidates) {
    const key = c.kind === "custom" ? "custom" : c.dir;
    let g = groups.get(key);
    if (!g) {
      const label = c.kind === "custom" ? "Saved command" : c.dir === "." ? (c.workspace ?? "Project root") : c.workspace ? `${c.dir} · ${c.workspace}` : c.dir;
      g = { dir: c.dir, label, items: [] };
      groups.set(key, g);
    }
    g.items.push(c);
  }
  return [...groups.values()];
}

export type Tone = "ok" | "warn" | "bad" | "muted";

export function stateMeta(status: PreviewStatus | null): { label: string; tone: Tone } {
  if (!status) return { label: "Stopped", tone: "muted" };
  switch (status.state) {
    case "running":
      return status.healthy ? { label: "Running", tone: "ok" } : { label: "Not answering", tone: "warn" };
    case "starting":
      return { label: status.url ? "Waiting for the server" : "Starting", tone: "warn" };
    case "crashed":
      return { label: "Crashed", tone: "bad" };
    default:
      return { label: "Stopped", tone: "muted" };
  }
}

const MAX_PROMPT_LINES = 60;

/** The composer draft for "Ask agent to fix": what ran, where, how it ended, the last output. */
export function buildFixPrompt(status: PreviewStatus, logs: readonly string[] = status.logs): string {
  const lines = logs.slice(-MAX_PROMPT_LINES).map((l) => (l.length > 300 ? `${l.slice(0, 297)}…` : l));
  const where = status.candidate && status.candidate.dir !== "." ? ` (in ${status.candidate.dir})` : "";
  const how =
    status.exitCode !== null ? `It exited with code ${status.exitCode}.` : status.signal !== null ? `It was stopped by signal ${status.signal}.` : "It stopped.";
  const parts = [
    "The live preview's dev server crashed.",
    "",
    `Command: \`${status.command ?? status.candidate?.command ?? "?"}\`${where}. ${how}`,
  ];
  if (status.error) parts.push(`Error: ${status.error}`);
  if (lines.length > 0) parts.push("", "Last output:", "```", ...lines, "```");
  parts.push("", "Find the cause and fix it so the dev server starts again. Tell me what was wrong.");
  return parts.join("\n");
}

/** Short folder + command label for the picker trigger. */
export function candidateLabel(c: PreviewCandidate | null | undefined): string {
  if (!c) return "Choose what to run";
  if (c.kind === "custom") return "Your command";
  return c.dir === "." ? c.title : `${c.title} · ${c.dir}`;
}

export function saved(detection: PreviewDetection | null): PreviewFile | null {
  return detection?.choice ?? null;
}
