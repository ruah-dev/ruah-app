// The ⌘K launcher's ranking: fuzzy scoring, grouping, group order and de-duplication. Pure (no
// React, no DOM, no network) so a keystroke only re-ranks what the stores already hold; unit-tested
// in ui/test/launcher.test.ts. The component (components/projects/CommandLauncher.tsx) builds the
// items from the stores and renders the result.

export const LAUNCHER_GROUPS = [
  "Needs you",
  "Recent",
  "Projects",
  "Chats",
  "Elements",
  "Cloud",
  "Pages",
  "Actions",
] as const;
export type LauncherGroup = (typeof LAUNCHER_GROUPS)[number];

export interface LauncherItem {
  /** Unique per row. */
  id: string;
  group: LauncherGroup;
  label: string;
  sub?: string | undefined;
  /** Extra words that match but are not shown (path, agent, provider, "project" …). */
  keywords?: readonly string[] | undefined;
  /** What the row opens (a project id, a chat id …): the same target is listed once, in the
   * highest group, so a recent chat does not appear again under Chats. */
  target?: string | undefined;
  /** Epoch ms of the last use: recent things rank higher. */
  recentAt?: number | undefined;
  /** Static boost (e.g. the current project's actions). */
  boost?: number | undefined;
  /** Listed whatever the query (e.g. "Ask the agent …"), after the matches. */
  always?: boolean | undefined;
  /** Hidden while the query is empty (big lists: elements, all cloud resources). */
  queryOnly?: boolean | undefined;
}

export interface RankedGroup<T extends LauncherItem = LauncherItem> {
  group: LauncherGroup;
  items: T[];
}

/** Rows per group: without a query the list stays short; with one, enough to choose from. */
export const GROUP_LIMIT: Record<LauncherGroup, { empty: number; query: number }> = {
  "Needs you": { empty: 5, query: 5 },
  Recent: { empty: 5, query: 4 },
  Projects: { empty: 6, query: 8 },
  Chats: { empty: 4, query: 8 },
  Elements: { empty: 0, query: 8 },
  Cloud: { empty: 3, query: 6 },
  Pages: { empty: 0, query: 4 },
  Actions: { empty: 8, query: 8 },
};

const WORD = /[\s/._:@#-]+/;

/**
 * Score of `query` (one lowercase word) against `text`: exact > prefix > word start > substring >
 * subsequence (letters in order, fewer gaps better). null = no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  if (!t) return null;
  if (t === query) return 1000;
  if (t.startsWith(query)) return 900 - Math.min(100, t.length - query.length);
  const at = t.indexOf(query);
  if (at > 0) {
    const wordStart = WORD.test(t[at - 1]!);
    return (wordStart ? 800 : 600) - Math.min(100, at);
  }
  // Subsequence: every query letter in order; reward consecutive runs and word starts.
  let score = 300;
  let ti = 0;
  let prev = -2;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (found === prev + 1) score += 8;
    else score -= Math.min(20, found - ti);
    if (found === 0 || WORD.test(t[found - 1]!)) score += 6;
    prev = found;
    ti = found + 1;
  }
  return Math.max(1, score);
}

/** Below this a match is only a scattered subsequence: accepted in the label, not elsewhere. */
const SUBSTRING = 500;

/**
 * Every query word must match the label, the sub line or a keyword; the label counts most. The
 * sub line and keywords (paths, providers …) need the word itself (a substring), so letters
 * scattered along a long path do not match.
 */
export function scoreItem(item: Pick<LauncherItem, "label" | "sub" | "keywords">, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let total = 0;
  for (const w of words) {
    let best: number | null = null;
    const label = fuzzyScore(w, item.label);
    if (label !== null) best = label + 50;
    const sub = item.sub ? fuzzyScore(w, item.sub) : null;
    if (sub !== null && sub >= SUBSTRING && (best === null || sub > best)) best = sub;
    for (const k of item.keywords ?? []) {
      const s = fuzzyScore(w, k);
      if (s !== null && s >= SUBSTRING && (best === null || s - 20 > best)) best = s - 20;
    }
    if (best === null) return null;
    total += best;
  }
  return total / words.length;
}

/** Up to +60 for something used in the last minutes, fading over about a week. */
export function recencyBoost(recentAt: number | undefined, now: number): number {
  if (!recentAt) return 0;
  const hours = Math.max(0, (now - recentAt) / 3_600_000);
  return 60 / (1 + hours / 12);
}

const GROUP_BIAS: Partial<Record<LauncherGroup, number>> = {
  "Needs you": 40,
  Recent: 30,
  Projects: 10,
  Chats: 5,
};

/**
 * Ranks the launcher rows for `query`. Empty query: the groups in their fixed order (Needs you,
 * Recent, Projects, Chats, …, Actions), each in the given order, big lists hidden. With a query:
 * matches only, each group sorted by score (+ recency), groups ordered by their best row (recent
 * and attention groups first on ties); `always` rows come last in their group. A target is listed
 * once, in the first group that shows it.
 */
export function rankLauncher<T extends LauncherItem>(
  items: readonly T[],
  query: string,
  opts: { now?: number; limits?: Partial<Record<LauncherGroup, number>> } = {},
): RankedGroup<T>[] {
  const now = opts.now ?? Date.now();
  const q = query.trim();
  const buckets = new Map<LauncherGroup, { item: T; score: number; order: number }[]>();
  items.forEach((item, order) => {
    let score: number | null;
    if (!q) {
      if (item.queryOnly) return;
      score = 0;
    } else if (item.always) {
      score = -1;
    } else {
      score = scoreItem(item, q);
      if (score === null) return;
      score += recencyBoost(item.recentAt, now) + (item.boost ?? 0);
    }
    const list = buckets.get(item.group) ?? [];
    list.push({ item, score, order });
    buckets.set(item.group, list);
  });

  const groups: { group: LauncherGroup; rows: { item: T; score: number; order: number }[]; best: number; rank: number }[] = [];
  for (const [group, rows] of buckets) {
    if (q) rows.sort((a, b) => b.score - a.score || a.order - b.order);
    const best = rows.reduce((m, r) => Math.max(m, r.score), -Infinity);
    groups.push({ group, rows, best: q ? best + (GROUP_BIAS[group] ?? 0) : 0, rank: LAUNCHER_GROUPS.indexOf(group) });
  }
  // By best match (a group holding only `always` rows scores -1: it goes last); fixed order
  // without a query.
  groups.sort((a, b) => (q ? b.best - a.best || a.rank - b.rank : a.rank - b.rank));

  const seen = new Set<string>();
  const out: RankedGroup<T>[] = [];
  for (const g of groups) {
    const limit = opts.limits?.[g.group] ?? (q ? GROUP_LIMIT[g.group].query : GROUP_LIMIT[g.group].empty);
    const picked: T[] = [];
    for (const { item } of g.rows) {
      if (picked.length >= limit) break;
      if (item.target !== undefined) {
        if (seen.has(item.target)) continue;
        seen.add(item.target);
      }
      picked.push(item);
    }
    if (picked.length) out.push({ group: g.group, items: picked });
  }
  return out;
}

/** The rows in display order (for ↑↓ and Enter). */
export function flattenRanked<T extends LauncherItem>(groups: readonly RankedGroup<T>[]): T[] {
  return groups.flatMap((g) => g.items);
}

/** Next highlighted row after ↑ / ↓ (clamped, no wrap past the ends… except to loop around). */
export function moveActive(length: number, index: number, delta: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
