// The journey step the agent panel asks about (CONTRACTS §23.6): set by "Ask agent" on a journey
// step, shown as a chip over the composer, sent as `prompt.journeyStep` until cleared. One per
// project (switching projects clears it).
import { useSyncExternalStore } from "react";

export interface JourneyContext {
  projectId: string;
  journey: string;
  step: string;
  /** "Pay rent · 2. Taps Transfer" */
  label: string;
}

let current: JourneyContext | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setJourneyContext(next: JourneyContext | null) {
  current = next;
  emit();
}

export function clearJourneyContext() {
  if (current === null) return;
  current = null;
  emit();
}

export function journeyContext(projectId: string | null | undefined): JourneyContext | null {
  return current !== null && current.projectId === projectId ? current : null;
}

export function useJourneyContext(projectId: string | null | undefined): JourneyContext | null {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
  return value !== null && value.projectId === projectId ? value : null;
}
