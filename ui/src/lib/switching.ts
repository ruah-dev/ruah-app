// Pure helpers for moving between projects and chats: most-recently-used order (⌘J), date
// groups for chat lists, filtering, neighbours for ⌘[ / ⌘], and a tiny LRU. No React, no DOM —
// unit-tested in ui/test/switching.test.ts.

/** One visited chat, enough to render and reopen it without asking the daemon. */
export interface MruChat {
  chatId: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  title: string;
  agentId: string;
  /** Epoch ms of the visit. */
  at: number;
}

export const MRU_MAX = 30;

/** Moves (or adds) a chat to the front; keeps at most `max` entries. */
export function touchMru(list: readonly MruChat[], entry: MruChat, max = MRU_MAX): MruChat[] {
  return [entry, ...list.filter((e) => e.chatId !== entry.chatId)].slice(0, Math.max(0, max));
}

/** Drops chats that no longer exist (deleted), keeping order. */
export function pruneMru(list: readonly MruChat[], gone: ReadonlySet<string>): MruChat[] {
  return list.filter((e) => !gone.has(e.chatId));
}

/** Index after moving `delta` steps through `length` items, wrapping around. */
export function cycleIndex(length: number, index: number, delta: number): number {
  if (length <= 0) return -1;
  return (((index + delta) % length) + length) % length;
}

export type DateGroupLabel = "Today" | "Yesterday" | "Last 7 days" | "Older";
export const DATE_GROUPS: readonly DateGroupLabel[] = ["Today", "Yesterday", "Last 7 days", "Older"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar bucket of a timestamp relative to `now` (local time). */
export function dateGroupOf(iso: string | number, now = Date.now()): DateGroupLabel {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return "Older";
  const today = startOfDay(now);
  if (t >= today) return "Today";
  const yesterday = startOfDay(today - 1);
  if (t >= yesterday) return "Yesterday";
  if (t >= startOfDay(today - 6 * 86_400_000)) return "Last 7 days";
  return "Older";
}

/** Items bucketed by date (order inside a bucket is kept; empty buckets are dropped). */
export function groupByDate<T>(
  items: readonly T[],
  dateOf: (item: T) => string | number,
  now = Date.now(),
): { label: DateGroupLabel; items: T[] }[] {
  const buckets = new Map<DateGroupLabel, T[]>();
  for (const item of items) {
    const label = dateGroupOf(dateOf(item), now);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(item);
    else buckets.set(label, [item]);
  }
  return DATE_GROUPS.flatMap((label) => {
    const bucket = buckets.get(label);
    return bucket ? [{ label, items: bucket }] : [];
  });
}

/**
 * Case-insensitive match of every word of the query against the title or the agent name
 * ("inv claude" finds "Invoice API" chats run with Claude).
 */
export function matchesChat(
  chat: { title: string; agentId: string },
  query: string,
  agentName: (id: string) => string = (id) => id,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${chat.title} ${agentName(chat.agentId)} ${chat.agentId}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The chat `delta` rows away from the active one in list order (no wrap); null at the ends. */
export function neighborChat<T extends { id: string }>(
  list: readonly T[],
  activeId: string | null,
  delta: number,
): T | null {
  if (list.length === 0) return null;
  const index = activeId === null ? -1 : list.findIndex((c) => c.id === activeId);
  if (index === -1) return delta > 0 ? list[0]! : null;
  return list[index + delta] ?? null;
}

/** Map used as an LRU: re-inserting moves a key to the end; the oldest keys go beyond `max`. */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
