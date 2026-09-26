// Integration slots for features built separately (wired at integration, nothing to edit here):
//
// - Extensions page: add the route `/extensions` (routes/extensions.tsx) and the rail's entry
//   (lower group, next to Settings) turns on by itself; until then it shows disabled.
// - Live preview: call `registerPreviewPane(Component)` once (e.g. from the preview module's
//   entry); the top bar's Preview toggle then opens it on the right, as a tab beside the agent
//   panel ("Agent | Preview") or alone when the agent panel is closed. The pane gets
//   `onAskAgent`: call it after drafting a prompt into the composer and the agent comes to front.
// - Agent limits: call `setAgentLimitHint(agentId, "62% left")` (or a LimitHint
//   `{ text, tone?, detail? }`, or null to clear) and the top bar's agent pill shows it as a small
//   segment after the agent's state, for that agent. A plain "N% left" turns amber at 25 % and red
//   at 10 %; nothing shows while no hint is set.
// - Status items: `registerStatusItem({ id, render, order? })` adds a small chip to the top bar's
//   status area (after the cloud health chip), e.g. the live preview's "Preview: running :5173".
//   `render` is a component (hooks allowed) that returns a <StatusChip> (./StatusChips.tsx) or
//   null to hide itself; registering an id again replaces it; the returned function removes it.
import { useSyncExternalStore, type ComponentType } from "react";
import { normalizeLimitHint, type LimitHint } from "@/lib/status-chips";

export type { LimitHint } from "@/lib/status-chips";

/** Props the right panel gives a registered preview pane. */
export interface PreviewSlotProps {
  /** A prompt was drafted into the composer: show the agent (its tab, or the agent panel). */
  onAskAgent?: () => void;
}

export interface StatusItem {
  id: string;
  render: ComponentType;
  /** Lower first; default 100. */
  order?: number;
}

interface Slots {
  preview: ComponentType<PreviewSlotProps> | null;
  limitHints: Readonly<Record<string, LimitHint>>;
  statusItems: readonly StatusItem[];
}

let slots: Slots = { preview: null, limitHints: {}, statusItems: [] };
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

export function registerPreviewPane(component: ComponentType<PreviewSlotProps> | null) {
  set({ preview: component });
}

export function setAgentLimitHint(agentId: string, hint: string | LimitHint | null) {
  const next = { ...slots.limitHints };
  const normalized = normalizeLimitHint(hint);
  if (normalized) next[agentId] = normalized;
  else delete next[agentId];
  set({ limitHints: next });
}

export function registerStatusItem(item: StatusItem): () => void {
  const rest = slots.statusItems.filter((i) => i.id !== item.id);
  const statusItems = [...rest, item].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  set({ statusItems });
  return () => {
    // Only remove this registration (a later one with the same id stays).
    if (slots.statusItems.includes(item)) set({ statusItems: slots.statusItems.filter((i) => i !== item) });
  };
}

/** The current slots, outside React (tests, event handlers). */
export function slotsSnapshot(): Slots {
  return slots;
}

export function useSlots(): Slots {
  return useSyncExternalStore(subscribe, slotsSnapshot, () => INITIAL);
}
