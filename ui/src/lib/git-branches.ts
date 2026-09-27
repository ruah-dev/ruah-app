// CONTRACTS §24 in the viewer: the open project's branches (GET /api/git/branches), switching
// (POST /api/git/switch) and the `git.changed` frame every viewer gets after a switch. The
// fetch helpers talk to the daemon's HTTP origin; the rest are pure helpers (ui/test/git-branches.test.ts)
// for the top bar's BranchSwitcher: the chip's tooltip lines, filtering, name checks and the
// "+3 elements, −1, 2 changed" summary of what the switch did to the map.
import { useEffect, useState } from "react";
import type { GitState } from "./contracts";
import { daemonSnapshot, onDaemonMessage, SAMPLE_MODE_MESSAGE } from "./daemon";
import { relativeTime } from "./time";

export interface BranchCommit {
  sha: string;
  subject: string;
  /** ISO 8601 */
  date: string;
}

export interface LocalBranch {
  name: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  lastCommit: BranchCommit;
  current: boolean;
  /** Checked out in another worktree: git will not switch to it here. */
  worktree?: string;
}

export interface RemoteBranch {
  name: string; // origin/feature-x
  remote: string;
  branch: string; // feature-x
  hasLocal: boolean;
  lastCommit: BranchCommit;
}

export interface BranchList {
  projectId: string;
  current: string | null; // null = detached
  head: string;
  detached: boolean;
  dirty: { staged: number; unstaged: number; untracked: number };
  local: LocalBranch[];
  remote: RemoteBranch[];
  truncated: boolean;
}

export interface ArchitectureDiff {
  added: { id: string; name: string; type: string }[];
  removed: { id: string; name: string; type: string }[];
  changed: { id: string; name: string; fields: string[] }[];
  edges: { added: { from: string; to: string; label?: string }[]; removed: { from: string; to: string; label?: string }[] };
  workflows: { added: { id: string; name: string }[]; removed: { id: string; name: string }[] };
}

export interface SwitchResult {
  ok: true;
  branch: string;
  previous: string | null;
  created: boolean;
  carried: number;
  architecture: "tracked" | "generated" | "rescanned";
  architectureError?: string;
  diff: ArchitectureDiff;
}

export class GitApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GitApiError";
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const s = daemonSnapshot();
  if (s.source === "sample") throw new GitApiError(0, SAMPLE_MODE_MESSAGE);
  if (!s.httpOrigin) throw new GitApiError(0, "No daemon connected");
  const res = await fetch(`${s.httpOrigin}${path}`, {
    cache: "no-store",
    ...(body !== undefined ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new GitApiError(res.status, data.error ?? `HTTP ${res.status}`, data.code);
  return data;
}

/** GET /api/git/branches — the open project's branches. */
export function fetchBranches(): Promise<BranchList> {
  return api<BranchList>("/api/git/branches");
}

/** POST /api/git/switch — switch (or create and switch); rejects with the daemon's message. */
export function switchBranch(req: { name: string; create?: boolean; from?: string }): Promise<SwitchResult> {
  return api<SwitchResult>("/api/git/switch", req);
}

// ---------------------------------------------------------------------------
// git.changed

/** Calls `listener` when Ruah switched `projectId`'s branch (any viewer did it). */
export function onGitChanged(listener: (projectId: string, branch: string | null) => void): () => void {
  return onDaemonMessage((msg) => {
    if (msg.type === "git.changed") listener(msg.projectId, msg.branch);
  });
}

/** A counter that moves on every `git.changed` of `projectId` (a refresh key for git info). */
export function useGitChangedTick(projectId: string | null | undefined): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    return onGitChanged((id) => {
      if (id === projectId) setTick((n) => n + 1);
    });
  }, [projectId]);
  return tick;
}

// ⌘K "Switch branch…" opens the top bar's switcher (last mounted wins).
const openListeners: (() => boolean)[] = [];

export function onBranchSwitcherRequest(listener: () => boolean): () => void {
  openListeners.push(listener);
  return () => {
    const i = openListeners.lastIndexOf(listener);
    if (i >= 0) openListeners.splice(i, 1);
  };
}

/** False when no switcher can open (none mounted, or the chip is hidden at this width). */
export function requestBranchSwitcher(): boolean {
  const l = openListeners[openListeners.length - 1];
  return l ? l() : false;
}

// ---------------------------------------------------------------------------
// pure helpers

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "+3 elements, −1, 2 changed" (elements only; "+1 link" etc. when only links / workflows moved). */
export function branchSummary(diff: ArchitectureDiff): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`+${plural(diff.added.length, "element")}`);
  if (diff.removed.length) parts.push(diff.added.length ? `−${diff.removed.length}` : `−${plural(diff.removed.length, "element")}`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  if (parts.length > 0) return parts.join(", ");
  const links = diff.edges.added.length + diff.edges.removed.length;
  const flows = diff.workflows.added.length + diff.workflows.removed.length;
  const minor: string[] = [];
  if (links) minor.push(`${plural(links, "link")} changed`);
  if (flows) minor.push(`${plural(flows, "workflow")} changed`);
  return minor.length ? minor.join(", ") : "same map";
}

/** The toast after a switch: "feature-x: +3 elements, −1, 2 changed" and what else happened. */
export function switchToast(result: SwitchResult): { title: string; description: string } {
  const notes: string[] = [];
  if (result.architecture === "generated") notes.push("no map on this branch — scanned one");
  if (result.architecture === "rescanned") notes.push("map rescanned for this branch");
  if (result.architectureError) notes.push(`its architecture.json did not load: ${result.architectureError}`);
  if (result.carried > 0) notes.push(`carried ${plural(result.carried, "changed file")}`);
  if (result.created) notes.push("new branch");
  return { title: `${result.branch}: ${branchSummary(result.diff)}`, description: notes.join(" · ") };
}

/** The chip's label: branch, or the short sha when detached. */
export function chipLabel(git: Extract<GitState, { available: true }>): string {
  return git.branch ?? (git.head ? git.head.slice(0, 7) : "detached");
}

/** The chip's details (tooltip / popover header). */
export function gitChipLines(git: Extract<GitState, { available: true }>, now = Date.now()): string[] {
  return [
    git.branch ? `On ${git.branch}${git.upstream ? ` · tracking ${git.upstream}` : ""}` : `Detached at ${git.head?.slice(0, 7) ?? "?"}`,
    git.ahead ? `${plural(git.ahead, "commit")} to push` : "",
    git.behind ? `${plural(git.behind, "commit")} to pull` : "",
    git.dirty
      ? `${plural(git.dirty, "uncommitted file")}${git.dirtyPaths.length ? `: ${git.dirtyPaths.join(", ")}${git.dirty > git.dirtyPaths.length ? ", …" : ""}` : ""}`
      : "Working tree clean",
    git.lastCommit ? `Last commit: ${git.lastCommit.subject} (${relativeTime(git.lastCommit.at, now)})` : "",
  ].filter(Boolean);
}

/** Local branches and remote branches without a local one, matching `query` (case-insensitive substring). */
export function filterBranches(list: Pick<BranchList, "local" | "remote">, query: string): { local: LocalBranch[]; remote: RemoteBranch[] } {
  const q = query.trim().toLowerCase();
  const hit = (name: string, subject: string) => !q || name.toLowerCase().includes(q) || subject.toLowerCase().includes(q);
  return {
    local: list.local.filter((b) => hit(b.name, b.lastCommit.subject)),
    remote: list.remote.filter((r) => !r.hasLocal && hit(r.name, r.lastCommit.subject)),
  };
}

/** What is wrong with a new branch name (git's check-ref-format rules, roughly); null = fine (the daemon decides). */
export function branchNameProblem(name: string, existing: readonly string[] = []): string | null {
  if (name.trim().length === 0) return "Type a name";
  if (name.length > 250) return "Too long (250 characters at most)";
  if (name.startsWith("-")) return "Can't start with -";
  if (name.includes("@{")) return "Can't contain @{";
  if (name === "@" || name === "HEAD") return `"${name}" is reserved`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return "No spaces or ~ ^ : ? * [ \\";
  if (name.includes("..")) return "Can't contain ..";
  if (name.includes("//") || name.startsWith("/") || name.endsWith("/")) return "Slashes must separate words";
  if (name.endsWith(".") || name.endsWith(".lock")) return "Can't end with . or .lock";
  if (name.split("/").some((part) => part.startsWith("."))) return "A part can't start with .";
  if (existing.includes(name)) return "A branch with this name exists";
  return null;
}

/** "↑2 ↓1" for a local branch (empty when in sync or without upstream). */
export function aheadBehind(b: Pick<LocalBranch, "ahead" | "behind">): string {
  return [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean).join(" ");
}

/** Why switching is not possible right now (null = it is). */
export function switchBlocker(opts: { turnRunning: boolean; kind: "repo" | "system" | undefined; sample: boolean }): string | null {
  if (opts.sample) return "Connect Ruah to switch branches";
  if (opts.kind === "system") return "Switch branches per repo from the system view";
  if (opts.turnRunning) return "An agent is working in this project — switch when it is done";
  return null;
}
