// On-demand drill-in (CONTRACTS.md §1.6): client cache of daemon expansions.
// Expanded levels are ephemeral derived data — fetched when the user drills in
// (or opens the Outline), kept in memory per project, merged into the map's
// architecture so toGraph / breadcrumbs / the outline treat them like stored
// levels, and never saved (except by an explicit "Pin to map").
import { useSyncExternalStore } from "react";
import type { Architecture, ArchEdge, ArchNode } from "./contracts";

export type SymbolKind =
  | "function"
  | "component"
  | "hook"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const"
  | "route"
  | "method";

export interface SymbolInfo {
  kind: SymbolKind;
  line: number;
  endLine: number;
  exported: boolean;
  detail?: string;
}

export interface ExpandedNode extends ArchNode {
  expandable?: boolean;
  childCount?: number;
  symbol?: SymbolInfo;
  test?: boolean;
  /** Set by the viewer on nodes that came from an expansion (not in architecture.json). */
  ephemeral?: boolean;
}

export interface ExpandedEdge extends ArchEdge {
  weight?: number;
}

export interface Expansion {
  nodeId: string;
  level: "folder" | "file";
  path: string;
  architecture: Omit<Architecture, "nodes" | "edges"> & { nodes: ExpandedNode[]; edges: ExpandedEdge[] };
  truncated: { children: boolean; edges: boolean; files: boolean };
  total: { children: number; edges: number };
  ms: number;
  lineage?: string[];
}

export type ExpansionEntry =
  | { status: "loading"; previous?: Expansion }
  | { status: "ok"; expansion: Expansion; at: number }
  | { status: "error"; error: string; at: number };

export type ExpansionState = {
  scope: string | null;
  origin: string | null;
  entries: ReadonlyMap<string, ExpansionEntry>;
  /** "N inside" counts for stored leaves (null = not expandable). */
  peeks: ReadonlyMap<string, number | null>;
  /** Positions of expanded nodes moved in Edit mode (stored coordinates; not saved). */
  positions: ReadonlyMap<string, { x: number; y: number }>;
  version: number;
};

/** Ids of expanded elements: `<id>/<name>` or `<fileId>#<symbol>` (stored ids have neither). */
export function isExpandedId(id: string): boolean {
  return id.includes("/") || id.includes("#");
}

let state: ExpansionState = {
  scope: null,
  origin: null,
  entries: new Map(),
  peeks: new Map(),
  positions: new Map(),
  version: 0,
};
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<ExpansionEntry>>();

function set(patch: Partial<ExpansionState>) {
  state = { ...state, ...patch, version: state.version + 1 };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

export function useExpansions(): ExpansionState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function getExpansions(): ExpansionState {
  return state;
}

/** Called by the workspace: a new project (or no daemon) drops every cached level. */
export function bindExpansions(scope: string | null, origin: string | null) {
  if (state.scope === scope && state.origin === origin) return;
  inflight.clear();
  peekQueue.clear();
  set({ scope, origin, entries: new Map(), peeks: new Map(), positions: new Map() });
}

/** Forget every cached level (e.g. after a rescan): open levels refetch on next use. */
export function invalidateExpansions() {
  inflight.clear();
  set({ entries: new Map(), peeks: new Map() });
}

const FRESH_MS = 15_000;

/**
 * Fetch (or reuse) the level below `nodeId`. Resolves with the entry; never throws. Levels older
 * than `maxAge` are refetched in the background while the old one stays visible.
 */
export function requestExpansion(nodeId: string, opts: { maxAge?: number } = {}): Promise<ExpansionEntry> {
  const current = state.entries.get(nodeId);
  const maxAge = opts.maxAge ?? FRESH_MS;
  if (current?.status === "ok" && Date.now() - current.at < maxAge) return Promise.resolve(current);
  if (current?.status === "error" && Date.now() - current.at < 3_000) return Promise.resolve(current);
  const pending = inflight.get(nodeId);
  if (pending) return pending;
  const origin = state.origin;
  const scope = state.scope;
  if (!origin) {
    const entry: ExpansionEntry = { status: "error", error: "Drilling below the stored map needs a connected daemon.", at: Date.now() };
    setEntry(nodeId, entry);
    return Promise.resolve(entry);
  }
  setEntry(nodeId, { status: "loading", ...(current?.status === "ok" ? { previous: current.expansion } : {}) });
  const p = (async (): Promise<ExpansionEntry> => {
    let entry: ExpansionEntry;
    try {
      const r = await fetch(`${origin}/api/expand/${encodeURIComponent(nodeId)}`);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        entry = { status: "error", error: body.error ?? `HTTP ${r.status}`, at: Date.now() };
      } else {
        entry = { status: "ok", expansion: (await r.json()) as Expansion, at: Date.now() };
      }
    } catch (err) {
      entry = { status: "error", error: err instanceof Error ? err.message : String(err), at: Date.now() };
    }
    inflight.delete(nodeId);
    if (state.scope !== scope) return entry; // project switched meanwhile
    setEntry(nodeId, entry);
    // A deep level restored after a reload: fetch the levels above it for the breadcrumb.
    if (entry.status === "ok") {
      for (const id of entry.expansion.lineage ?? []) {
        if (!state.entries.has(id)) void requestExpansion(id);
      }
    }
    return entry;
  })();
  inflight.set(nodeId, p);
  return p;
}

function setEntry(nodeId: string, entry: ExpansionEntry) {
  const entries = new Map(state.entries);
  entries.set(nodeId, entry);
  set({ entries });
}

// Peeks are batched: every card that mounts asks, one request goes out.
const peekQueue = new Set<string>();
let peekTimer: ReturnType<typeof setTimeout> | undefined;

export function requestPeek(ids: readonly string[]) {
  if (!state.origin) return;
  let added = false;
  for (const id of ids) {
    if (state.peeks.has(id) || peekQueue.has(id)) continue;
    peekQueue.add(id);
    added = true;
  }
  if (!added || peekTimer !== undefined) return;
  peekTimer = setTimeout(() => {
    peekTimer = undefined;
    void flushPeeks();
  }, 30);
}

async function flushPeeks() {
  const origin = state.origin;
  const scope = state.scope;
  const ids = [...peekQueue];
  peekQueue.clear();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const qs = chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    let counts: Record<string, number | null> = {};
    try {
      const r = await fetch(`${origin}/api/expand-peek?${qs}`);
      if (r.ok) counts = ((await r.json()) as { counts: Record<string, number | null> }).counts;
    } catch {
      /* daemon gone: leave unknown */
    }
    if (state.scope !== scope) return;
    const peeks = new Map(state.peeks);
    for (const id of chunk) peeks.set(id, counts[id] ?? null);
    set({ peeks });
  }
}

export function moveExpandedNode(nodeId: string, x: number, y: number) {
  const positions = new Map(state.positions);
  positions.set(nodeId, { x, y });
  set({ positions });
}

// ---------------------------------------------------------------------------
// merge

let mergeMemo: { arch: Architecture; state: ExpansionState; out: Architecture } | null = null;

/**
 * The map's architecture: stored nodes (with "N inside" counts from peeks) plus every loaded
 * expansion whose element is on the map, children parented to it. Expansions below an element
 * that now has stored children (pinned) are ignored.
 */
export function mergeExpansions(arch: Architecture, s: ExpansionState = state): Architecture {
  if (mergeMemo && mergeMemo.arch === arch && mergeMemo.state === s) return mergeMemo.out;
  const storedParents = new Set<string>();
  for (const n of arch.nodes) if (n.parent) storedParents.add(n.parent);
  let nodes: ArchNode[] = arch.nodes;
  if (s.peeks.size > 0) {
    nodes = arch.nodes.map((n) => {
      if (storedParents.has(n.id) || !s.peeks.has(n.id)) return n;
      const count = s.peeks.get(n.id) ?? null;
      return { ...n, childCount: count ?? 0, expandable: count !== null && count > 0 } as ExpandedNode;
    });
  }
  const loaded: Expansion[] = [];
  for (const entry of s.entries.values()) {
    const exp = entry.status === "ok" ? entry.expansion : entry.status === "loading" ? entry.previous : undefined;
    if (exp) loaded.push(exp);
  }
  if (loaded.length === 0) {
    const out = nodes === arch.nodes ? arch : { ...arch, nodes };
    mergeMemo = { arch, state: s, out };
    return out;
  }
  // Parents before children: an expanded element must already be on the map.
  loaded.sort((a, b) => a.nodeId.length - b.nodeId.length);
  const present = new Set(nodes.map((n) => n.id));
  const extraNodes: ArchNode[] = [];
  const extraEdges: ArchEdge[] = [];
  const layers = [...(arch.layers ?? [])];
  for (const exp of loaded) {
    if (!present.has(exp.nodeId) || storedParents.has(exp.nodeId)) continue;
    for (const n of exp.architecture.nodes) {
      if (present.has(n.id)) continue;
      present.add(n.id);
      const pos = s.positions.get(n.id);
      extraNodes.push({ ...n, parent: exp.nodeId, ephemeral: true, ...(pos ? { x: pos.x, y: pos.y } : {}) } as ExpandedNode);
    }
    extraEdges.push(...exp.architecture.edges);
    for (const l of exp.architecture.layers ?? []) if (!layers.includes(l)) layers.push(l);
  }
  const out: Architecture = { ...arch, layers, nodes: [...nodes, ...extraNodes], edges: [...arch.edges, ...extraEdges] };
  mergeMemo = { arch, state: s, out };
  return out;
}

export function asExpanded(node: ArchNode | undefined): ExpandedNode | undefined {
  return node as ExpandedNode | undefined;
}
