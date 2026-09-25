// Integration slots for features built separately (wired at integration, nothing to edit here):
//
// - Extensions page: add the route `/extensions` (routes/extensions.tsx) and the rail's entry
//   (lower group, next to Settings) turns on by itself; until then it shows disabled.
// - Live preview: call `registerPreviewPane(Component)` once (e.g. from the preview module's
//   entry); the top bar's Preview toggle then opens it on the right, as a tab beside the agent
//   panel ("Agent | Preview") or alone when the agent panel is closed.
// - Agent limits: call `setAgentLimitHint(agentId, "62% left")` (or null) and the top bar's agent
//   pill shows it after the agent's state for that agent.
import { useSyncExternalStore, type ComponentType } from "react";

export const EXTENSIONS_ROUTE = "/extensions";

interface Slots {
  preview: ComponentType | null;
  limitHints: Readonly<Record<string, string>>;
}

let slots: Slots = { preview: null, limitHints: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<Slots>) {
  slots = { ...slots, ...patch };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const INITIAL = slots;

export function registerPreviewPane(component: ComponentType | null) {
  set({ preview: component });
}

export function setAgentLimitHint(agentId: string, hint: string | null) {
  const next = { ...slots.limitHints };
  if (hint) next[agentId] = hint;
  else delete next[agentId];
  set({ limitHints: next });
}

export function useSlots(): Slots {
  return useSyncExternalStore(subscribe, () => slots, () => INITIAL);
}
