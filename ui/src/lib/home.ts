// The Home page (§20.5, option C of the 2026-09 layout mockups) as pure functions: one card per
// recent project from GET /api/projects/overview, what it says, how urgent it is, and the filters
// (All · Pinned · the tags in use). No React; unit-tested in ui/test/home.test.ts.
//
// Ranking — what needs you first:
//   an agent waits for a permission  >  a turn failed  >  cloud down  >  the preview crashed
//   >  finished while you were away (unread)  >  cloud degraded  >  an agent is working
//   >  uncommitted / unpushed work  >  quiet.
// Ties: pinned projects in their ⌘ order, then the most recently opened.
import type { ActivityEvent, GitState, ProjectActivity, ProjectInfo, ProjectOverview } from "./contracts";

export type CardStatus =
  | "permission"
  | "failed"
  | "cloud-down"
  | "preview-crashed"
  | "done"
  | "cloud-degraded"
  | "running"
  | "changes"
  | "quiet";

export type CardTone = "warn" | "bad" | "ok" | "ai" | "muted";

export interface HomeCard {
  id: string;
  overview: ProjectOverview;
  status: CardStatus;
  tone: CardTone;
  /** The status pill ("Needs you", "Failed", …). */
  pill: string;
  /** What is going on (null when quiet: the "where you left off" line says it all). */
  headline: string | null;
  /** The one-line "where you left off". */
  leftOff: string;
  /** Branch, ahead / behind, uncommitted, cloud — the card's footer. */
  foot: string;
  /** Higher = needs you first. */
  score: number;
  /** Something needs a look (the card is outlined). */
  attention: boolean;
}

const SCORE: Record<CardStatus, number> = {
  permission: 1000,
  failed: 600,
  "cloud-down": 500,
  "preview-crashed": 400,
  done: 300,
  "cloud-degraded": 200,
  running: 150,
  changes: 20,
  quiet: 0,
};

const PILL: Record<CardStatus, { label: string; tone: CardTone }> = {
  permission: { label: "Needs you", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  "cloud-down": { label: "Cloud down", tone: "bad" },
  "preview-crashed": { label: "Preview crashed", tone: "bad" },
  done: { label: "Done", tone: "ok" },
  "cloud-degraded": { label: "Cloud degraded", tone: "warn" },
  running: { label: "Working", tone: "ai" },
  changes: { label: "Uncommitted", tone: "muted" },
  quiet: { label: "Quiet", tone: "muted" },
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function quoted(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat}”`;
}

/** "main ↑2 ↓1 · 3 uncommitted" — or why there is no git. */
export function gitFoot(git: GitState): string {
  if (!git.available) return git.reason === "not a git repository" ? "no git" : "";
  const parts = [git.branch ?? (git.head ? `detached ${git.head}` : "no commits")];
  if ((git.ahead ?? 0) > 0) parts[0] += ` ↑${git.ahead}`;
  if ((git.behind ?? 0) > 0) parts[0] += ` ↓${git.behind}`;
  if (git.dirty > 0) parts.push(`${git.dirty} uncommitted`);
  else if (git.head) parts.push("clean");
  return parts.join(" · ");
}

/** The one-line "where you left off". */
export function leftOffLine(o: Pick<ProjectOverview, "lastChat">, now = Date.now(), ago: (iso: string, now: number) => string = defaultAgo): string {
  const chat = o.lastChat;
  if (!chat) return "No chats yet — open it to start one";
  const when = ago(chat.updatedAt, now);
  if (chat.lastPrompt) return `You asked ${quoted(chat.lastPrompt)}${when ? ` · ${when}` : ""}`;
  return `${quoted(chat.title)}${when ? ` · ${when}` : ""}`;
}

function defaultAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Live counts: the activity feed (WebSocket, updates every event) wins over the overview's
 * snapshot, which may be a few seconds old.
 */
function liveOf(o: ProjectOverview, activity: ProjectActivity | undefined): { running: number; waiting: number; unread: number } {
  if (activity) return { running: activity.running, waiting: activity.waitingPermission, unread: activity.unread };
  return { running: o.live.running, waiting: Math.max(o.live.waitingPermission, o.permissions.length), unread: o.unread };
}

function failedEvent(o: ProjectOverview): ActivityEvent | null {
  const e = o.lastEvent;
  if (!e) return null;
  if (e.kind === "agent.error") return e;
  if (e.kind === "turn.finished" && e.stopReason === "error") return e;
  return null;
}

export function homeCard(
  o: ProjectOverview,
  opts: { activity?: ProjectActivity; agentName?: (id: string) => string; now?: number } = {},
): HomeCard {
  const now = opts.now ?? Date.now();
  const live = liveOf(o, opts.activity);
  const agent = (id: string | undefined) => (id ? (opts.agentName?.(id) ?? id) : "The agent");
  const failed = failedEvent(o);
  // "While you were away": the open project's news is what you are looking at.
  const away = !o.current;
  const cloud = o.cloud;
  const crashed = o.preview?.state === "crashed";
  const dirty = o.git.available ? o.git.dirty : 0;
  const ahead = o.git.available ? (o.git.ahead ?? 0) : 0;

  let status: CardStatus = "quiet";
  let headline: string | null = null;
  if (live.waiting > 0) {
    status = "permission";
    const p = o.permissions[0];
    headline = p
      ? `${agent(o.lastChat?.agentId)} wants to: ${p.title}`
      : (o.lastEvent?.kind === "permission.requested" ? o.lastEvent.summary : `${plural(live.waiting, "permission request")} waiting`);
    if (live.waiting > 1) headline += ` (+${live.waiting - 1} more)`;
  } else if (failed && (o.since.turnsFailed > 0 || live.unread > 0)) {
    status = "failed";
    headline = failed.error ? `${failed.summary.split(":")[0]}: ${failed.error}` : failed.summary;
  } else if (cloud && cloud.down > 0) {
    status = "cloud-down";
    headline = `${cloud.down} down in the cloud${cloud.unhealthy.length ? `: ${cloud.unhealthy.slice(0, 3).join(", ")}` : ""}`;
  } else if (crashed) {
    status = "preview-crashed";
    headline = `The preview stopped${o.preview?.exitCode != null ? ` (exit ${o.preview.exitCode})` : ""} — restart it or ask the agent to fix it`;
  } else if (live.unread > 0 || (away && o.since.turnsFinished > 0)) {
    status = "done";
    const e = o.lastEvent?.kind === "turn.finished" ? o.lastEvent : null;
    headline = e ? `${agent(e.agentId)}: ${e.summary}` : `${plural(Math.max(live.unread, o.since.turnsFinished), "turn")} finished while you were away`;
  } else if (cloud && cloud.degraded > 0) {
    status = "cloud-degraded";
    headline = `${cloud.degraded} degraded in the cloud${cloud.unhealthy.length ? `: ${cloud.unhealthy.slice(0, 3).join(", ")}` : ""}`;
  } else if (live.running > 0) {
    status = "running";
    headline = `${agent(o.lastChat?.agentId)} is working${o.lastChat ? ` on ${quoted(o.lastChat.title, 50)}` : ""}`;
  } else if (dirty > 0 || ahead > 0) {
    status = "changes";
    headline = [dirty > 0 ? `${plural(dirty, "uncommitted change")}` : "", ahead > 0 ? `${plural(ahead, "commit")} not pushed` : ""].filter(Boolean).join(" · ");
  }
  const pill = PILL[status];
  const score =
    SCORE[status] +
    (status === "permission" ? live.waiting * 10 : 0) +
    (status === "done" ? Math.min(live.unread, 9) : 0) +
    (status !== "running" && live.running > 0 ? 5 : 0) +
    (status !== "changes" && (dirty > 0 || ahead > 0) ? 1 : 0);
  const cloudFoot = cloud ? (cloud.down || cloud.degraded ? "" : `cloud ${cloud.healthy} ok`) : "";
  return {
    id: o.project.id,
    overview: o,
    status,
    tone: pill.tone,
    pill: status === "changes" && dirty === 0 ? "Unpushed" : pill.label,
    headline,
    leftOff: leftOffLine(o, now),
    foot: [gitFoot(o.git), cloudFoot].filter(Boolean).join(" · "),
    score,
    attention: score >= SCORE["cloud-degraded"],
  };
}

/** Score, then pinned (⌘ order), then most recently opened. */
export function sortCards(cards: readonly HomeCard[]): HomeCard[] {
  return [...cards].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = a.overview.project.pinned ? (a.overview.project.pinOrder ?? 999) : Number.POSITIVE_INFINITY;
    const pb = b.overview.project.pinned ? (b.overview.project.pinOrder ?? 999) : Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return Date.parse(b.overview.project.lastOpenedAt) - Date.parse(a.overview.project.lastOpenedAt);
  });
}

// ---------------------------------------------------------------- filters (All · Pinned · tags)

export interface HomeFilter {
  /** "all", "pinned", or "tag:<lower-case tag>". */
  id: string;
  label: string;
  count: number;
}

export const tagKey = (tag: string) => `tag:${tag.trim().toLowerCase()}`;

/** All · Pinned (when any) · one per tag in use, most used first (spelling most projects use). */
export function homeFilters(projects: readonly ProjectInfo[]): HomeFilter[] {
  const out: HomeFilter[] = [{ id: "all", label: "All", count: projects.length }];
  const pinned = projects.filter((p) => p.pinned).length;
  if (pinned > 0) out.push({ id: "pinned", label: "Pinned", count: pinned });
  for (const t of tagCounts(projects)) out.push({ id: tagKey(t.tag), label: t.tag, count: t.count });
  return out;
}

/** Tags in use with how many projects carry each (case-insensitive), most used first. */
export function tagCounts(projects: readonly ProjectInfo[]): { tag: string; count: number }[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const p of projects) {
    for (const tag of p.tags ?? []) {
      const key = tag.trim().toLowerCase();
      if (!key) continue;
      const hit = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      hit.count += 1;
      hit.spellings.set(tag, (hit.spellings.get(tag) ?? 0) + 1);
      byKey.set(key, hit);
    }
  }
  return [...byKey.values()]
    .map((h) => ({ count: h.count, tag: [...h.spellings].sort((a, b) => b[1] - a[1] || capitalFirst(a[0], b[0]))[0]![0] }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function matchesFilter(p: ProjectInfo, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "pinned") return !!p.pinned;
  if (filter.startsWith("tag:")) {
    const key = filter.slice(4);
    return (p.tags ?? []).some((t) => t.trim().toLowerCase() === key);
  }
  return true;
}

/**
 * A project's group: its first tag (cards' meta line, the rail's grouping), spelled the way the
 * filter chip spells it when `spellings` (from groupSpellings) is given — "Job", not this
 * project's "job".
 */
export function groupOf(p: Pick<ProjectInfo, "tags">, spellings?: ReadonlyMap<string, string>): string | null {
  const first = p.tags?.find((t) => t.trim().length > 0)?.trim();
  if (!first) return null;
  return spellings?.get(first.toLowerCase()) ?? first;
}

/** Lower-case tag → the spelling most projects use (the one homeFilters shows). */
export function groupSpellings(projects: readonly ProjectInfo[]): Map<string, string> {
  return new Map(tagCounts(projects).map((t) => [t.tag.trim().toLowerCase(), t.tag]));
}

/** "Good afternoon" by the local hour. */
export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** "2 need you · 1 working · 1 with changes · 5 quiet" for the Home header (a card with a pill is never "quiet"). */
export function homeSummary(cards: readonly HomeCard[]): string {
  const needs = cards.filter((c) => c.attention).length;
  const working = cards.filter((c) => !c.attention && c.status === "running").length;
  const changes = cards.filter((c) => !c.attention && c.status === "changes").length;
  const rest = cards.length - needs - working - changes;
  const parts = [
    needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "",
    working ? `${working} working` : "",
    changes ? `${changes} with changes` : "",
    rest > 0 ? `${rest} quiet` : "",
  ];
  return parts.filter(Boolean).join(" · ") || "No projects yet";
}

/** Parses "Freelance, Acme Studio,  job" into tags (trimmed, de-duplicated ignoring case, ≤ 6, ≤ 40 chars). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const tag = raw.replace(/\s+/g, " ").trim().slice(0, 40).trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === 6) break;
  }
  return out;
}

/** Spelling ties: a capitalized spelling ("Job") wins over "job", then alphabetical. */
function capitalFirst(a: string, b: string): number {
  const ca = a[0] !== undefined && a[0] !== a[0].toLowerCase();
  const cb = b[0] !== undefined && b[0] !== b[0].toLowerCase();
  return Number(cb) - Number(ca) || a.localeCompare(b);
}
