// Shell-only UI that several entry points open (top-bar menu, launcher, start screen): "All
// projects", "Keyboard shortcuts", and the right side's Preview pane (see ./slots.ts). A tiny
// external store, no provider needed.
import { useSyncExternalStore } from "react";

interface ShellDialogs {
  allProjects: boolean;
  shortcuts: boolean;
  /** The live preview pane on the right (only when one is registered, ./slots.ts). */
  preview: boolean;
}

let state: ShellDialogs = { allProjects: false, shortcuts: false, preview: false };
const listeners = new Set<() => void>();

export function setShellDialog(key: keyof ShellDialogs, open: boolean) {
  if (state[key] === open) return;
  state = { ...state, [key]: open };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const INITIAL = state;

export function useShellDialogs(): ShellDialogs {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
