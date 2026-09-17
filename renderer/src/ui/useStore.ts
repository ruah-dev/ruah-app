import { useSyncExternalStore } from "react";
import type { DaemonStore } from "../lib/store.js";
import type { Store } from "../lib/store.js";

export function useStore(store: Store): DaemonStore {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
