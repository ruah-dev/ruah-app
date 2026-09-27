// The Map's business overlay switch (JOURNEYS.md §5.2): tint elements by how many customer
// journeys they serve, fade the ones no journey uses. Per viewer (a convenience, not project data).
import { useSyncExternalStore } from "react";

const KEY = "ruah.map.business.v1";
let on = read();
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setBusinessOverlay(next: boolean) {
  on = next;
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // storage blocked: the switch still works for this session
  }
  for (const l of listeners) l();
}

export function useBusinessOverlay(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
    () => false,
  );
}
