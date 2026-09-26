// Auto-reload on a newer viewer build. Each `vite build` stamps an id (ui/vite.config.ts →
// import.meta.env.VITE_RUAH_BUILD_ID, also a <meta name="ruah-build"> in index.html); the daemon
// reports the id of the viewer it serves (`viewerBuild` in GET /api/health, CONTRACTS §2.3). A
// window still running older code reloads by itself when nothing would be lost, else offers a
// "Reload" toast. One reload per served build (sessionStorage): never a loop.
// The decision is pure; unit-tested in ui/test/build-reload.test.ts. Contract: CONTRACTS §2.6.

/** This window's build (null in `vite dev` and tests: never compared). */
export const BUILD_ID: string | null = import.meta.env.DEV ? null : (import.meta.env.VITE_RUAH_BUILD_ID ?? null);

export type ReloadDecision = "none" | "reload" | "prompt";

export interface ReloadInputs {
  /** This window's build id. */
  own: string | null;
  /** The build the daemon serves now (null: unknown, an older daemon or no viewer dir). */
  served: string | null;
  /** The page was served by that daemon (not a dev server or a Lovable preview with ?daemon=). */
  sameOrigin: boolean;
  /** Something would be lost or interrupted (busyReasons). */
  busy: boolean;
  /** The served build this window already reloaded for (the one-reload guard). */
  attempted: string | null;
}

/**
 * none: up to date, or nothing to compare. reload: silently. prompt: show "Ruah was updated —
 * Reload" (busy, or a reload for this build already happened and did not help — no loop).
 */
export function reloadDecision(i: ReloadInputs): ReloadDecision {
  if (!i.own || !i.served || !i.sameOrigin || i.own === i.served) return "none";
  if (i.attempted === i.served) return "prompt";
  return i.busy ? "prompt" : "reload";
}

export interface BusyState {
  /** A turn of the chat in front is running (or waits for a permission answer). */
  turnRunning: boolean;
  /** Typed text that is not sent or saved yet (composer, dialog fields, a rename). */
  unsavedInput: boolean;
  /** The map is in edit mode or an edit is still being saved. */
  mapEditing: boolean;
  /** A dialog or menu is open (the user is in the middle of something). */
  dialogOpen: boolean;
}

export function busyReasons(s: BusyState): string[] {
  return [
    s.turnRunning ? "an agent turn is running" : "",
    s.unsavedInput ? "there is unsent input" : "",
    s.mapEditing ? "the map is being edited" : "",
    s.dialogOpen ? "a dialog is open" : "",
  ].filter(Boolean);
}

const KEY = "ruah.buildReload.v1";

/** The served build id this window (tab session) already reloaded for. */
export function reloadAttempted(): string | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Records the attempt, then reloads; false when storage is unavailable (no guard = no reload). */
export function reloadForBuild(served: string, delayMs = 0): boolean {
  try {
    sessionStorage.setItem(KEY, served);
  } catch {
    return false;
  }
  // The delay lets debounced saves (view state: 400 ms) go out first.
  setTimeout(() => window.location.reload(), delayMs);
  return true;
}

/** Text fields holding typed text, ignoring the terminal's hidden input. DOM only. */
export function hasUnsavedInput(doc: Document): boolean {
  const fields = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=email]",
  );
  for (const f of fields) {
    if (f.readOnly || f.disabled || f.classList.contains("xterm-helper-textarea")) continue;
    if (f.value.trim().length > 0) return true;
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[contenteditable=true]")) {
    if ((el.textContent ?? "").trim().length > 0) return true;
  }
  return false;
}

/** An open dialog, alert or menu (Radix marks them with data-state=open). DOM only. */
export function hasOpenOverlay(doc: Document): boolean {
  return !!doc.querySelector(
    '[role=dialog][data-state=open], [role=alertdialog][data-state=open], [role=menu][data-state=open]',
  );
}
