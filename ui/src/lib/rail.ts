// Projects in the shell's icon rail (Arc-spaces style tiles), as pure functions: which projects
// get a tile for the height available, in which order, and what their badge says. No React;
// unit-tested in ui/test/rail.test.ts.
//
// Order: pinned projects first (their order is the ⌘1…⌘9 order), then the most recently opened
// ones that fit. Tiles keep their place while you switch between them: a recent project that is
// already in the rail does not jump to the top when opened (the daemon's list is sorted by
// lastOpenedAt, so it would), a newcomer takes the slot of the one it pushed out. Pinned projects
// keep the order they were pinned in (pinnedOrder / sortProjectList: the daemon sorts them by
// lastOpenedAt too, which would renumber ⌘1…⌘9 on every switch).
import type { ProjectActivity, ProjectInfo } from "./contracts";

/** Tile size and gap in the rail (px); the component uses the same numbers. */
export const RAIL_TILE = 40;
export const RAIL_GAP = 6;
/** More tiles than this never helps: the rest are one click away in "All projects". */
export const MAX_RAIL_TILES = 10;

export interface RailProject {
  project: ProjectInfo;
  current: boolean;
  /** ⌘1…⌘9 for the first nine pinned projects (the shell's shortcut). */
  shortcut: string | null;
}

export interface RailProjectsLayout {
  tiles: RailProject[];
  /** Projects without a tile (the "+N" tile opens All projects). */
  overflow: number;
  /** Order of the unpinned tiles, to pass back as `prevOrder` next time (stable slots). With
   * `complete: false` it also holds the saved ids the list does not know yet. */
  order: string[];
}

/** How many tiles fit in `heightPx` (tiles plus the "more" tile). */
export function railCapacity(heightPx: number, tile = RAIL_TILE, gap = RAIL_GAP): number {
  if (!Number.isFinite(heightPx) || heightPx < tile) return 0;
  return Math.floor((heightPx + gap) / (tile + gap));
}

/**
 * Keeps `ids` in the order they had in `prev`: ids already placed keep their relative order,
 * a new id takes the slot of an id that left (first free slot first), else goes last. An id of
 * `prev` that is not in `ids` but for which `keep(id)` holds (not known to this render, e.g. the
 * project list has not loaded yet) keeps its slot: it is in the result, and a newcomer does not
 * take its place. Filter the result by `ids` for what to show.
 */
export function stableOrder(prev: readonly string[], ids: readonly string[], keep?: (id: string) => boolean): string[] {
  const want = new Set(ids);
  const slots: (string | null)[] = prev.map((id) => (want.has(id) || keep?.(id) ? id : null));
  const placed = new Set(slots.filter((s): s is string => s !== null));
  for (const id of ids) {
    if (placed.has(id)) continue;
    const free = slots.indexOf(null);
    if (free >= 0) slots[free] = id;
    else slots.push(id);
    placed.add(id);
  }
  return slots.filter((s): s is string => s !== null);
}

/**
 * The pinned projects' order (the ⌘1…⌘9 order everywhere): ids of `prev` that are still pinned
 * keep their place, newly pinned ones go last in the order given (the daemon's). Unpinned ids drop.
 */
export function pinnedOrder(prev: readonly string[], pinnedIds: readonly string[]): string[] {
  const want = new Set(pinnedIds);
  const out = [...new Set(prev)].filter((id) => want.has(id));
  for (const id of want) if (!out.includes(id)) out.push(id);
  return out;
}

/** §20: the pinned ids in the daemon's explicit order (`pinOrder`; pins without one last, most recent first). */
export function pinOrderIds(list: readonly ProjectInfo[]): string[] {
  return list
    .filter((p) => p.pinned)
    .sort((a, b) => (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER) || Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
    .map((p) => p.id);
}

/**
 * Moves `id` to `toIndex` in `ids` (drag to reorder); an unknown id or a no-op returns `ids` as is.
 * `toIndex` is clamped into the list.
 */
export function moveId(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const next = ids.filter((x) => x !== id);
  const to = Math.max(0, Math.min(next.length, Math.round(toIndex)));
  next.splice(to, 0, id);
  return next;
}

/** Where `dragged` lands (its index after the move) when dropped before / after `target`. */
export function dropIndex(ids: readonly string[], dragged: string, target: string, after: boolean): number {
  const t = ids.indexOf(target);
  const from = ids.indexOf(dragged);
  let to = t + (after ? 1 : 0);
  if (from >= 0 && from < to) to -= 1;
  return to;
}

/**
 * The recent list as the viewer shows it: pinned first in `pinned` order (pinnedOrder; pinned
 * projects not in it follow, most recent first), then the rest most recently opened first.
 */
export function sortProjectList(list: readonly ProjectInfo[], pinned: readonly string[] = []): ProjectInfo[] {
  const rank = new Map(pinned.map((id, i) => [id, i]));
  const recent = (a: ProjectInfo, b: ProjectInfo) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt);
  return [...list].sort((a, b) => {
    const pin = Number(!!b.pinned) - Number(!!a.pinned);
    if (pin || !a.pinned) return pin || recent(a, b);
    const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || recent(a, b);
  });
}

/**
 * The rail's project tiles for `capacity` slots (railCapacity). `projects` is the recent list
 * (pinned first, then most recent first: sortProjectList). The current project always has a tile.
 * `complete: false` says the list has not loaded yet (the page just opened: empty, or only the
 * open project): saved ids it does not know keep their slots in `order` instead of being dropped.
 */
export function railProjects(
  projects: readonly ProjectInfo[],
  currentId: string | null,
  capacity: number,
  prevOrder: readonly string[] = [],
  opts: { complete?: boolean; pinnedIds?: readonly string[] } = {},
): RailProjectsLayout {
  const pinned = projects.filter((p) => p.pinned);
  const recents = projects.filter((p) => !p.pinned);
  // ⌘1…⌘9 follow every pinned project (`pinnedIds`, when the list is a group's), not just the shown ones.
  const shortcutOf = new Map((opts.pinnedIds ?? pinned.map((p) => p.id)).slice(0, 9).map((id, i) => [id, `⌘${i + 1}`]));
  const max = Math.max(0, Math.min(capacity, MAX_RAIL_TILES));

  let shownPinned: ProjectInfo[];
  let shownRecents: ProjectInfo[];
  if (projects.length <= max) {
    shownPinned = pinned;
    shownRecents = recents;
  } else if (max <= 1) {
    // Room for one tile at most: the open project (the "+N" tile still leads to the rest).
    const current = currentId ? projects.find((p) => p.id === currentId) : undefined;
    shownPinned = current?.pinned ? [current] : [];
    shownRecents = current && !current.pinned ? [current] : [];
  } else {
    // One slot goes to the "+N" tile.
    const slots = Math.max(1, max - 1);
    shownPinned = pinned.slice(0, slots);
    shownRecents = recents.slice(0, slots - shownPinned.length);
    const current = currentId ? projects.find((p) => p.id === currentId) : undefined;
    if (current && !shownPinned.includes(current) && !shownRecents.includes(current)) {
      // The open project replaces the least recent tile (or the last pinned one).
      if (shownRecents.length) shownRecents = [...shownRecents.slice(0, -1), current];
      else if (current.pinned || shownPinned.length) shownPinned = [...shownPinned.slice(0, -1), current];
      else shownRecents = [current];
    }
  }

  const byId = new Map(shownRecents.map((p) => [p.id, p]));
  const known = new Set(projects.map((p) => p.id));
  const keep = opts.complete === false ? (id: string) => !known.has(id) : undefined;
  const order = stableOrder(prevOrder, shownRecents.map((p) => p.id), keep);
  const ordered = order.flatMap((id) => byId.get(id) ?? []);
  const tiles = [...shownPinned, ...ordered].map((project) => ({
    project,
    current: project.id === currentId,
    shortcut: shortcutOf.get(project.id) ?? null,
  }));
  return { tiles, overflow: projects.length - tiles.length, order };
}

export type RailBadgeDot = "waiting" | "running" | null;

export interface RailBadge {
  /** Amber dot: an agent waits for permission; pulsing AI dot: an agent is working. */
  dot: RailBadgeDot;
  unread: number;
  /** For screen readers and the tooltip ("" when the project is quiet). */
  label: string;
}

/**
 * What a project's tile shows, from its activity counts (CONTRACTS §13.2). `running` counts the
 * turns in flight, the ones waiting for a permission answer included: "working" is the rest.
 */
export function railBadge(activity: Pick<ProjectActivity, "running" | "waitingPermission" | "unread"> | undefined): RailBadge {
  if (!activity) return { dot: null, unread: 0, label: "" };
  const { running, waitingPermission, unread } = activity;
  const working = Math.max(0, running - waitingPermission);
  const dot: RailBadgeDot = waitingPermission > 0 ? "waiting" : running > 0 ? "running" : null;
  const label = [
    waitingPermission > 0 ? `${waitingPermission === 1 ? "an agent is" : `${waitingPermission} agents are`} waiting for you` : "",
    working > 0 ? `${working === 1 ? "agent" : `${working} agents`} working` : "",
    unread > 0 ? `${unread} unread` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { dot, unread: Math.max(0, unread), label: label ? label[0]!.toUpperCase() + label.slice(1) : "" };
}

/** "3", "99+" for the unread pill. */
export function unreadText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

// ---------------------------------------------------------------- groups (§20 tags)

export const RAIL_ALL_GROUPS = "all";

/**
 * The groups the rail's switcher offers: tags that at least two projects share (a tag on one
 * project is a label, not a group), most used first. Empty = no switcher (the rail stays calm).
 */
export function railGroups(projects: readonly ProjectInfo[]): { key: string; label: string; count: number }[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const p of projects) {
    for (const tag of new Set((p.tags ?? []).map((t) => t.trim()).filter(Boolean))) {
      const key = tag.toLowerCase();
      const hit = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      hit.count += 1;
      hit.spellings.set(tag, (hit.spellings.get(tag) ?? 0) + 1);
      byKey.set(key, hit);
    }
  }
  return [...byKey]
    .filter(([, h]) => h.count >= 2)
    .map(([key, h]) => ({ key, count: h.count, label: [...h.spellings].sort((a, b) => b[1] - a[1] || capitalFirst(a[0], b[0]))[0]![0] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The projects the rail shows for a group (`key` from railGroups, or "all"): the group's projects
 * plus the open one (it always has a tile). An unknown group shows everything.
 */
export function railGroupProjects(projects: readonly ProjectInfo[], group: string, currentId: string | null): ProjectInfo[] {
  if (group === RAIL_ALL_GROUPS) return [...projects];
  const inGroup = (p: ProjectInfo) => (p.tags ?? []).some((t) => t.trim().toLowerCase() === group);
  if (!projects.some(inGroup)) return [...projects];
  return projects.filter((p) => inGroup(p) || p.id === currentId);
}

/** Two letters for the switcher's tile ("Liquid Money" → "LM", "Job" → "Jo"). */
export function groupInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const w = words[0] ?? "?";
  return w.slice(0, 1).toUpperCase() + w.slice(1, 2).toLowerCase();
}

/** Spelling ties: a capitalized spelling ("Job") wins over "job", then alphabetical. */
function capitalFirst(a: string, b: string): number {
  const ca = a[0] !== undefined && a[0] !== a[0].toLowerCase();
  const cb = b[0] !== undefined && b[0] !== b[0].toLowerCase();
  return Number(cb) - Number(ca) || a.localeCompare(b);
}
