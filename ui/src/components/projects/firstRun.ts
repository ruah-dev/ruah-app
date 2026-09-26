// What the new project wizard leaves for the shell once the project is open (§20): the first
// prompt for the agent ("Set up the project…") and the first-run hints card. sessionStorage, so a
// reload right after creating still shows the hints, and a later visit does not.
import { useSyncExternalStore } from "react";

export interface FirstRunHints {
  projectId: string;
  template: string;
  templateName: string;
  /** The template's run command ("pnpm install && pnpm dev"). */
  run?: string;
  /** false: the "Empty" template (no scan; the map starts empty in Edit mode). */
  scanned: boolean;
  askedAgent: boolean;
  gitCommit: string | null;
  githubUrl?: string;
}

const HINTS_KEY = "ruah.newProject.hints.v1";
let hints: FirstRunHints | null = read();
let pendingPrompt: { projectId: string; text: string } | null = null;
const listeners = new Set<() => void>();

function read(): FirstRunHints | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(HINTS_KEY);
    return raw ? (JSON.parse(raw) as FirstRunHints) : null;
  } catch {
    return null;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function setFirstRunHints(next: FirstRunHints | null) {
  hints = next;
  try {
    if (next) window.sessionStorage.setItem(HINTS_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(HINTS_KEY);
  } catch {
    /* storage unavailable: the hints last for this page */
  }
  emit();
}

export function useFirstRunHints(): FirstRunHints | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => hints,
    () => null,
  );
}

/** The wizard's "Ask the agent to set it up": sent once the new project is open. */
export function queueFirstPrompt(projectId: string, text: string) {
  pendingPrompt = { projectId, text };
  emit();
}

/** The project whose first prompt waits (re-renders when one is queued or taken). */
export function usePendingPromptProject(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pendingPrompt?.projectId ?? null,
    () => null,
  );
}

/** The prompt for `projectId`, once (null when none is waiting). */
export function takeFirstPrompt(projectId: string): string | null {
  if (!pendingPrompt || pendingPrompt.projectId !== projectId) return null;
  const { text } = pendingPrompt;
  pendingPrompt = null;
  emit();
  return text;
}

export function hasFirstPrompt(projectId: string | undefined): boolean {
  return !!projectId && pendingPrompt?.projectId === projectId;
}
