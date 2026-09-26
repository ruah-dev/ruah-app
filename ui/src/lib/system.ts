// Multi-repo systems management (CONTRACTS.md §12): the /api/system/* client and a tiny
// store for the system dialogs, so any entry point (start screen, project menu, palette)
// can open them without the workbench knowing about systems. Self-contained on purpose:
// the dialogs mount once (SystemDialogs) and move with whatever layout hosts them.
import { useSyncExternalStore } from "react";
import type { ArchEdge } from "./contracts";

// ---- types (mirror src/system/status.ts, github.ts, suggestions-store.ts) -----------------

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  head: string | null;
}

export interface RepoStatus {
  id: string;
  path: string;
  root: string;
  exists: boolean;
  git: GitStatus | null;
  gitError?: string;
  lastScanAt: string | null;
  scanSource: "architecture.json" | "scan" | "missing" | null;
  type: string | null;
  nodes: number;
  warning?: string;
}

export interface SystemStatus {
  name: string;
  dir: string;
  file: string;
  builtAt: string | null;
  repos: RepoStatus[];
}

export interface GithubRepo {
  nameWithOwner: string;
  name: string;
  description: string | null;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  updatedAt: string | null;
  defaultBranch: string | null;
}

export interface StoredSuggestion {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: string;
  confidence: number;
  evidence: string[];
  reason?: string;
  proposedAt: string;
  agentId?: string;
}

export interface RejectedSuggestion {
  id: string;
  from: string;
  to: string;
  label?: string;
  rejectedAt: string;
}

/** A permission request the running agent turn waits on (§20.2). */
export interface WaitingPermission {
  requestId: string;
  toolCall: { toolCallId: string; title: string; kind: string };
  options: { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[];
}

export interface RunningSuggestions {
  startedAt: string;
  agentId: string;
  /** Daemons before §20.2 send neither of these. */
  turnId?: string;
  deadline?: string;
  waitingPermission?: WaitingPermission;
}

export interface SuggestionsView {
  pending: StoredSuggestion[];
  rejected: RejectedSuggestion[];
  lastRun: { at: string; agentId?: string; proposed: number; dropped: number; error?: string } | null;
  running: RunningSuggestions | null;
}

// ---- HTTP -----------------------------------------------------------------------------------

async function call<T>(origin: string | null, path: string, body?: unknown): Promise<T> {
  if (!origin) throw new Error("No daemon connected");
  const r = await fetch(`${origin}${path}`, {
    ...(body !== undefined
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export const systemApi = {
  status: (o: string | null) => call<SystemStatus>(o, "/api/system"),
  create: (o: string | null, body: { dir: string; name?: string; repos: { path: string; id?: string }[] }) =>
    call<{ project: unknown; created: boolean; added: string[]; dir: string }>(o, "/api/system/create", body),
  addRepo: (o: string | null, body: { path?: string; github?: { repo: string; parentDir?: string }; id?: string }) =>
    call<SystemStatus>(o, "/api/system/repos/add", body),
  removeRepo: (o: string | null, id: string) => call<SystemStatus>(o, "/api/system/repos/remove", { id }),
  renameRepo: (o: string | null, id: string, newId: string) =>
    call<SystemStatus>(o, "/api/system/repos/rename", { id, newId }),
  rescanRepo: (o: string | null, id: string) =>
    call<{ status: SystemStatus; nodes: number; edges: number; ms: number }>(o, "/api/system/repos/rescan", { id }),
  signals: (o: string | null) => call<{ edges: ArchEdge[] }>(o, "/api/system/signals"),
  suggestions: (o: string | null) => call<SuggestionsView>(o, "/api/system/suggestions"),
  runSuggestions: (o: string | null, body: { minConfidence?: number } = {}) =>
    call<SuggestionsView>(o, "/api/system/suggestions/run", body),
  cancelSuggestions: (o: string | null) => call<SuggestionsView>(o, "/api/system/suggestions/cancel", {}),
  accept: (o: string | null, id: string) =>
    call<{ edge: ArchEdge; suggestions: SuggestionsView }>(o, "/api/system/suggestions/accept", { id }),
  reject: (o: string | null, id: string) => call<SuggestionsView>(o, "/api/system/suggestions/reject", { id }),
  unreject: (o: string | null, id: string) => call<SuggestionsView>(o, "/api/system/suggestions/unreject", { id }),
  githubRepos: (o: string | null, owner: string) =>
    call<{ repos: GithubRepo[] }>(o, `/api/system/github/repos?owner=${encodeURIComponent(owner)}`),
  clone: (o: string | null, repo: string, parentDir: string) =>
    call<{ path: string }>(o, "/api/system/github/clone", { repo, parentDir }),
};

export const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "web/src/api.js:12-14" → path + line range for the code panel. */
export function parseEvidence(ev: string): { path: string; range: [number, number] | null } {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(ev);
  if (!m) return { path: ev, range: null };
  const start = Number(m[2]);
  return { path: m[1]!, range: [start, m[3] ? Number(m[3]) : start] };
}

// ---- dialog store ---------------------------------------------------------------------------

export type SystemDialog =
  | { kind: "new"; /** Repos to start with (e.g. the open repo for "Add another repo…"). */ seedRepos?: string[] }
  | { kind: "manage"; tab?: "repos" | "connections" }
  | null;

let dialog: SystemDialog = null;
const listeners = new Set<() => void>();

export function openSystemDialog(next: Exclude<SystemDialog, null>): void {
  dialog = next;
  for (const l of listeners) l();
}

export function closeSystemDialog(): void {
  dialog = null;
  for (const l of listeners) l();
}

export function useSystemDialog(): SystemDialog {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => dialog,
    () => null,
  );
}
