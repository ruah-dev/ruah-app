// Viewer-side preferences (Settings → Features & behaviour, Settings → Appearance), kept in
// localStorage: things only this window's user sees. Daemon-side switches (background agents,
// notifications, scan options) live in $RUAH_HOME and are set through the daemon (§13.6, §11.8).
// Other windows of the same viewer pick a change up through the `storage` event (no reload).
import { useSyncExternalStore } from "react";

/** Standard: the icon rail (labels, project tiles). Advanced: a labelled sidebar with Projects and Chats. */
export type LayoutMode = "standard" | "advanced";

export interface ViewerPrefs {
  /** Keep cloud status live (daemon watch mode, §9.4) while the Cloud page is open. */
  cloudLive: boolean;
  /** Desktop app: ⌥Space anywhere focuses Ruah and opens the launcher. */
  globalShortcut: boolean;
  /** The "Where you left off" card when entering a project with news. */
  resumeCard: boolean;
  /** Shell layout (⌘\ toggles). */
  layout: LayoutMode;
  /** Names under the Standard rail's icons (off = the bare 56px rail). */
  railLabels: boolean;
}

export const PREFS_KEY = "ruah.prefs.v1";
export const DEFAULT_PREFS: ViewerPrefs = {
  cloudLive: true,
  globalShortcut: false,
  resumeCard: true,
  layout: "standard",
  railLabels: true,
};

/** Reads the stored JSON; unknown or malformed values fall back to the defaults. Pure. */
export function parsePrefs(raw: string | null | undefined): ViewerPrefs {
  let data: Partial<Record<keyof ViewerPrefs, unknown>> = {};
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as typeof data;
  } catch {
    return DEFAULT_PREFS;
  }
  const bool = (key: "cloudLive" | "globalShortcut" | "resumeCard" | "railLabels") =>
    typeof data[key] === "boolean" ? (data[key] as boolean) : DEFAULT_PREFS[key];
  return {
    cloudLive: bool("cloudLive"),
    globalShortcut: bool("globalShortcut"),
    resumeCard: bool("resumeCard"),
    layout: data.layout === "advanced" || data.layout === "standard" ? data.layout : DEFAULT_PREFS.layout,
    railLabels: bool("railLabels"),
  };
}

let prefs: ViewerPrefs = DEFAULT_PREFS;
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    prefs = parsePrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    prefs = DEFAULT_PREFS;
  }
  try {
    // Another window changed a preference: apply it here too.
    window.addEventListener("storage", (e) => {
      if (e.key !== PREFS_KEY) return;
      prefs = parsePrefs(e.newValue);
      notify();
    });
  } catch {
    /* no window events (tests) */
  }
}

export function viewerPrefs(): ViewerPrefs {
  load();
  return prefs;
}

export function setViewerPref<K extends keyof ViewerPrefs>(key: K, value: ViewerPrefs[K]) {
  load();
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useViewerPrefs(): ViewerPrefs {
  return useSyncExternalStore(subscribe, viewerPrefs, () => DEFAULT_PREFS);
}
