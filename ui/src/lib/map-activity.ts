// Live map activity (CONTRACTS §1.7): when an agent edits the map through the ruah_* tools
// (or the user undoes a turn's map changes), the daemon broadcasts `architecture` with `by` and
// `changes`. This module turns that into
// - flashes: new elements animate in, changed ones glow lavender for a moment (NodeCard reads
//   them through useMapFlashes; reduced motion gets a static ring instead of motion);
// - ghosts: removed elements fade out (a DOM clone of the card, removed after the animation —
//   the card itself is already gone from React's tree);
// - events for the "Claude added Payments · Show" toast (MapActivityToasts).
// Pure client state, no daemon calls; daemon.ts feeds it from its `architecture` handler.
import { useSyncExternalStore } from "react";
import type { Architecture, ArchNode, MapActor, MapChange } from "./contracts";
import { prefersReducedMotion } from "./motion";

export type Flash = "added" | "changed";

export interface MapActivityEvent {
  by: MapActor;
  changes: MapChange[];
  at: number;
}

const FLASH_MS = 2400;
const GHOST_MS = 460;

let flashes: ReadonlyMap<string, Flash> = new Map();
const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
const flashListeners = new Set<() => void>();
const eventListeners = new Set<(event: MapActivityEvent) => void>();

function emitFlashes() {
  for (const l of flashListeners) l();
}

function setFlash(id: string, flash: Flash | null) {
  const next = new Map(flashes);
  if (flash === null) next.delete(id);
  else next.set(id, flash);
  flashes = next;
}


/** Fades out the cards of removed elements (clones placed where the cards were). */
function ghost(ids: string[]) {
  if (typeof document === "undefined" || ids.length === 0 || prefersReducedMotion()) return;
  for (const id of ids) {
    const escaped =
      typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    for (const el of document.querySelectorAll<HTMLElement>(`[data-node][data-id="${escaped}"]`)) {
      const parent = el.parentElement;
      if (!parent) continue;
      const clone = el.cloneNode(true) as HTMLElement;
      clone.removeAttribute("data-node");
      clone.removeAttribute("data-id");
      clone.setAttribute("data-map-ghost", "");
      clone.setAttribute("aria-hidden", "true");
      parent.appendChild(clone);
      setTimeout(() => clone.remove(), GHOST_MS);
    }
  }
}

const strip = (n: ArchNode) => JSON.stringify({ ...n, x: undefined, y: undefined });

/**
 * Called by daemon.ts for every `architecture` frame, before the new revision is rendered.
 * Only agent edits and undos animate; the user's own edits and file reloads do not.
 */
export function noteArchitectureUpdate(
  prev: Architecture | null,
  next: Architecture,
  by: MapActor | undefined,
  changes: MapChange[] | undefined,
) {
  if (!prev || !by || (by.kind !== "agent" && by.undo !== true)) return;
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Map(next.nodes.map((n) => [n.id, n]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, n] of after) {
    const old = before.get(id);
    if (!old) added.push(id);
    else if (strip(old) !== strip(n) || old.x !== n.x || old.y !== n.y) changed.push(id);
  }
  // A new or removed link lights up both ends.
  const edgeKey = (e: { from: string; to: string; label?: string }) =>
    `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
  const beforeEdges = new Set(prev.edges.map(edgeKey));
  const afterEdges = new Set(next.edges.map(edgeKey));
  for (const e of next.edges)
    if (!beforeEdges.has(edgeKey(e)))
      for (const id of [e.from, e.to]) if (!added.includes(id)) changed.push(id);
  for (const e of prev.edges)
    if (!afterEdges.has(edgeKey(e)))
      for (const id of [e.from, e.to]) if (after.has(id)) changed.push(id);
  const removed = [...before.keys()].filter((id) => !after.has(id));

  ghost(removed);
  for (const id of new Set([...added, ...changed])) {
    setFlash(id, added.includes(id) ? "added" : "changed");
    const old = flashTimers.get(id);
    if (old) clearTimeout(old);
    flashTimers.set(
      id,
      setTimeout(() => {
        flashTimers.delete(id);
        setFlash(id, null);
        emitFlashes();
      }, FLASH_MS),
    );
  }
  for (const id of removed) setFlash(id, null);
  emitFlashes();

  if (changes && changes.length > 0) {
    const event: MapActivityEvent = { by, changes, at: Date.now() };
    for (const l of eventListeners) l(event);
  }
}

export function onMapActivity(listener: (event: MapActivityEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function subscribeFlashes(listener: () => void) {
  flashListeners.add(listener);
  return () => flashListeners.delete(listener);
}

const EMPTY: ReadonlyMap<string, Flash> = new Map();

/** Element id → current flash. A new Map on every change (cards re-render only when theirs changed). */
export function useMapFlashes(): ReadonlyMap<string, Flash> {
  return useSyncExternalStore(
    subscribeFlashes,
    () => flashes,
    () => EMPTY,
  );
}

/** One element's flash; only the cards whose flash changes re-render. */
export function useMapFlash(id: string): Flash | undefined {
  return useSyncExternalStore(
    subscribeFlashes,
    () => flashes.get(id),
    () => undefined,
  );
}

// ---------------------------------------------------------------------------
// display helpers (chat rows, toasts)

export function changeGlyph(change: MapChange): string {
  switch (change.action) {
    case "add":
    case "add_workflow":
      return "＋";
    case "remove":
    case "remove_workflow":
    case "disconnect":
      return "−";
    case "connect":
      return "↔";
    case "move":
      return "⇢";
    default:
      return "✎";
  }
}

export function changeText(change: MapChange): string {
  const label = change.label ? ` [${change.label}]` : "";
  switch (change.action) {
    case "update":
    case "update_workflow":
      return `${change.name}${change.fields?.length ? ` ${change.fields.filter((f) => f !== "x" && f !== "y").join(", ") || "position"}` : ""}${label}`;
    case "add_workflow":
    case "remove_workflow":
      return `workflow ${change.name}`;
    default:
      return `${change.name}${label}`;
  }
}

/** The element to reveal on the map for a change (links: their source). */
export function changeTarget(change: MapChange): string | null {
  if (change.target === "link") return change.from ?? null;
  if (change.target === "element" && change.action !== "remove") return change.id;
  return null;
}

/** "added Payments service", "linked data → Stripe", "made 4 map changes". */
export function summarizeChanges(changes: MapChange[]): string {
  const meaningful = changes.filter((c) => c.action !== "move");
  const list = meaningful.length > 0 ? meaningful : changes;
  if (list.length === 1) {
    const c = list[0]!;
    const verb: Record<string, string> = {
      add: "added",
      remove: "removed",
      update: "updated",
      connect: "linked",
      disconnect: "unlinked",
      move: "moved",
      add_workflow: "added workflow",
      update_workflow: "updated workflow",
      remove_workflow: "removed workflow",
    };
    return `${verb[c.action] ?? "changed"} ${c.name}`;
  }
  return `made ${list.length} map changes`;
}
