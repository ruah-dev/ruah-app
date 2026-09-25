// Viewer-side feature switches (Settings → Features & behaviour), kept in localStorage: things only
// this window does. Daemon-side switches (background agents, notifications, scan options) live in
// $RUAH_HOME and are set through the daemon (§13.6, §11.8).
import { useSyncExternalStore } from "react";

export interface ViewerPrefs {
  /** Keep cloud status live (daemon watch mode, §9.4) while the Cloud page is open. */
  cloudLive: boolean;
  /** Desktop app: ⌥Space anywhere focuses Ruah and opens the launcher. */
  globalShortcut: boolean;
  /** The "Where you left off" card when entering a project with news. */
  resumeCard: boolean;
}

const KEY = "ruah.prefs.v1";
export const DEFAULT_PREFS: ViewerPrefs = { cloudLive: true, globalShortcut: false, resumeCard: true };

let prefs: ViewerPrefs = DEFAULT_PREFS;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<Record<keyof ViewerPrefs, unknown>>;
    prefs = {
      cloudLive: typeof raw.cloudLive === "boolean" ? raw.cloudLive : DEFAULT_PREFS.cloudLive,
      globalShortcut: typeof raw.globalShortcut === "boolean" ? raw.globalShortcut : DEFAULT_PREFS.globalShortcut,
      resumeCard: typeof raw.resumeCard === "boolean" ? raw.resumeCard : DEFAULT_PREFS.resumeCard,
    };
  } catch {
    prefs = DEFAULT_PREFS;
  }
}

export function viewerPrefs(): ViewerPrefs {
  load();
  return prefs;
}

export function setViewerPref<K extends keyof ViewerPrefs>(key: K, value: ViewerPrefs[K]) {
  load();
  prefs = { ...prefs, [key]: value };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useViewerPrefs(): ViewerPrefs {
  return useSyncExternalStore(subscribe, viewerPrefs, () => DEFAULT_PREFS);
}
