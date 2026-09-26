// Review state of "Suggest connections" (docs/MULTI-REPO.md decision 2,
// CONTRACTS §12.5): `<system dir>/.ruah/suggestions.json`, next to
// ruah.system.json so a team shares it (commit it with the system file).
//
//   { "version": 1,
//     "pending":  [SuggestedEdge + { id, proposedAt, agentId? }],
//     "rejected": [{ id, from, to, label?, rejectedAt }],
//     "lastRun":  { at, agentId?, proposed, dropped, error? } }
//
// A suggestion's id is stable: "s-" + sha1(from, to, lower-cased label)[:10],
// so the same proposal from a later run keeps its id (and a rejected one is
// recognised and dropped). Accepting adds the edge to the system map with
// `source: "suggested"` (acceptSuggestion) and removes it from `pending`;
// rejecting moves it to `rejected`, which later runs never propose again.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchEdge, Architecture } from "../contracts/architecture.js";
import { acceptSuggestion, type SuggestedEdge } from "./suggest.js";
import { ensureRuahGitignore } from "../projects/repo-files.js";

export const SUGGESTIONS_FILE = path.join(".ruah", "suggestions.json");

export interface StoredSuggestion extends SuggestedEdge {
  id: string;
  proposedAt: string;
  agentId?: string;
}

export interface RejectedSuggestionEntry {
  /** Same id the suggestion had (stable hash of from, to, label). */
  id: string;
  from: string;
  to: string;
  label?: string;
  rejectedAt: string;
}

export interface SuggestionsFile {
  version: 1;
  pending: StoredSuggestion[];
  rejected: RejectedSuggestionEntry[];
  lastRun?: { at: string; agentId?: string; proposed: number; dropped: number; error?: string };
}

export function emptySuggestions(): SuggestionsFile {
  return { version: 1, pending: [], rejected: [] };
}

const norm = (label: string | undefined): string => (label ?? "").trim().toLowerCase();

export function suggestionKey(s: { from: string; to: string; label?: string | undefined }): string {
  return `${s.from}\u0000${s.to}\u0000${norm(s.label)}`;
}

export function suggestionId(s: { from: string; to: string; label?: string | undefined }): string {
  return `s-${createHash("sha1").update(suggestionKey(s)).digest("hex").slice(0, 10)}`;
}

function fileIn(systemDir: string): string {
  return path.join(systemDir, SUGGESTIONS_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Reads the file; anything unreadable or malformed counts as empty (entries that do not parse are dropped). */
export function readSuggestionsFile(systemDir: string): SuggestionsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fileIn(systemDir), "utf8"));
  } catch {
    return emptySuggestions();
  }
  if (!isRecord(raw)) return emptySuggestions();
  const pending: StoredSuggestion[] = [];
  for (const p of Array.isArray(raw.pending) ? raw.pending : []) {
    if (!isRecord(p)) continue;
    const from = str(p.from);
    const to = str(p.to);
    const confidence = typeof p.confidence === "number" ? p.confidence : undefined;
    const evidence = Array.isArray(p.evidence) ? p.evidence.filter((e): e is string => typeof e === "string") : [];
    if (from === undefined || to === undefined || confidence === undefined) continue;
    const label = str(p.label);
    const kind = str(p.kind);
    const reason = str(p.reason);
    const agentId = str(p.agentId);
    pending.push({
      id: str(p.id) ?? suggestionId({ from, to, label }),
      from,
      to,
      ...(label !== undefined ? { label } : {}),
      ...(kind !== undefined ? { kind } : {}),
      confidence,
      evidence,
      ...(reason !== undefined ? { reason } : {}),
      proposedAt: str(p.proposedAt) ?? new Date(0).toISOString(),
      ...(agentId !== undefined ? { agentId } : {}),
    });
  }
  const rejected: RejectedSuggestionEntry[] = [];
  for (const r of Array.isArray(raw.rejected) ? raw.rejected : []) {
    if (!isRecord(r)) continue;
    const from = str(r.from);
    const to = str(r.to);
    if (from === undefined || to === undefined) continue;
    const label = str(r.label);
    rejected.push({ id: suggestionId({ from, to, label }), from, to, ...(label !== undefined ? { label } : {}), rejectedAt: str(r.rejectedAt) ?? new Date(0).toISOString() });
  }
  const out: SuggestionsFile = { version: 1, pending, rejected };
  if (isRecord(raw.lastRun) && typeof raw.lastRun.at === "string") {
    const l = raw.lastRun;
    out.lastRun = {
      at: l.at as string,
      ...(str(l.agentId) !== undefined ? { agentId: str(l.agentId) as string } : {}),
      proposed: typeof l.proposed === "number" ? l.proposed : 0,
      dropped: typeof l.dropped === "number" ? l.dropped : 0,
      ...(str(l.error) !== undefined ? { error: str(l.error) as string } : {}),
    };
  }
  return out;
}

export function writeSuggestionsFile(systemDir: string, file: SuggestionsFile): void {
  const target = fileIn(systemDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(tmp, target);
  ensureRuahGitignore(systemDir);
}

function edgeExists(arch: Architecture, s: { from: string; to: string; label?: string | undefined }): boolean {
  return arch.edges.some((e) => e.from === s.from && e.to === s.to && (s.label === undefined || norm(e.label) === norm(s.label)));
}

/**
 * Pending suggestions that still make sense against `arch`: both ends exist
 * and the edge was not added meanwhile (drawn by hand, found by a scan).
 */
export function livePending(file: SuggestionsFile, arch: Architecture | null): StoredSuggestion[] {
  if (arch === null) return file.pending;
  const ids = new Set(arch.nodes.map((n) => n.id));
  return file.pending.filter((s) => ids.has(s.from) && ids.has(s.to) && !edgeExists(arch, s));
}

/**
 * Stores a run's validated suggestions: rejected ones are dropped, the rest
 * merge into `pending` by id (a repeat proposal refreshes confidence,
 * evidence and reason). Returns the file written and how many were new /
 * dropped as previously rejected.
 */
export function recordSuggestionRun(
  systemDir: string,
  suggestions: readonly SuggestedEdge[],
  meta: { agentId?: string | undefined; now?: Date; error?: string | undefined } = {},
): { file: SuggestionsFile; added: StoredSuggestion[]; droppedRejected: number } {
  const file = readSuggestionsFile(systemDir);
  const at = (meta.now ?? new Date()).toISOString();
  const rejected = new Set(file.rejected.map((r) => r.id));
  const pending = new Map(file.pending.map((p) => [p.id, p]));
  const added: StoredSuggestion[] = [];
  let droppedRejected = 0;
  for (const s of suggestions) {
    if (rejected.has(suggestionId(s))) {
      droppedRejected += 1;
      continue;
    }
    const id = suggestionId(s);
    const stored: StoredSuggestion = { ...s, id, proposedAt: at, ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}) };
    if (!pending.has(id)) added.push(stored);
    pending.set(id, stored);
  }
  const next: SuggestionsFile = {
    ...file,
    pending: [...pending.values()].sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1)),
    lastRun: {
      at,
      ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      proposed: suggestions.length,
      dropped: droppedRejected,
      ...(meta.error !== undefined ? { error: meta.error } : {}),
    },
  };
  writeSuggestionsFile(systemDir, next);
  return { file: next, added, droppedRejected };
}

/** Finds a pending suggestion by id, or by its 1-based position in `pending` ("2"). */
export function findPending(file: SuggestionsFile, ref: string): StoredSuggestion | undefined {
  const byId = file.pending.find((p) => p.id === ref);
  if (byId !== undefined) return byId;
  if (/^\d+$/.test(ref)) return file.pending[Number(ref) - 1];
  return undefined;
}

/**
 * Accepts a pending suggestion: returns the map with the edge added
 * (`source: "suggested"`, its evidence) and removes it from `pending`.
 * The caller saves the map (file write or the daemon's store).
 */
export function acceptPending(
  systemDir: string,
  arch: Architecture,
  ref: string,
): { architecture: Architecture; edge: ArchEdge; suggestion: StoredSuggestion } {
  const file = readSuggestionsFile(systemDir);
  const s = findPending(file, ref);
  if (s === undefined) throw new Error(`unknown suggestion: ${ref}`);
  const { id: _id, proposedAt: _at, agentId: _agent, ...edge } = s;
  const architecture = acceptSuggestion(arch, edge);
  writeSuggestionsFile(systemDir, { ...file, pending: file.pending.filter((p) => p.id !== s.id) });
  const added = architecture.edges.find((e) => e.from === s.from && e.to === s.to && (e.label ?? "") === (s.label ?? ""));
  return { architecture, edge: added ?? { from: s.from, to: s.to, source: "suggested" }, suggestion: s };
}

/** Rejects a pending suggestion: remembered in `rejected`, never proposed again. */
export function rejectPending(systemDir: string, ref: string, now: Date = new Date()): RejectedSuggestionEntry {
  const file = readSuggestionsFile(systemDir);
  const s = findPending(file, ref);
  if (s === undefined) throw new Error(`unknown suggestion: ${ref}`);
  const entry: RejectedSuggestionEntry = {
    id: s.id,
    from: s.from,
    to: s.to,
    ...(s.label !== undefined ? { label: s.label } : {}),
    rejectedAt: now.toISOString(),
  };
  const rejected = [...file.rejected.filter((r) => r.id !== entry.id), entry];
  writeSuggestionsFile(systemDir, { ...file, pending: file.pending.filter((p) => p.id !== s.id), rejected });
  return entry;
}

/** Forgets a rejection (by id), so the edge may be proposed again. */
export function unreject(systemDir: string, id: string): boolean {
  const file = readSuggestionsFile(systemDir);
  const rejected = file.rejected.filter((r) => r.id !== id);
  if (rejected.length === file.rejected.length) return false;
  writeSuggestionsFile(systemDir, { ...file, rejected });
  return true;
}

/** The file with every id and path rewritten (repo rename). */
export function remapSuggestions(file: SuggestionsFile, id: (id: string) => string, p: (path: string) => string): SuggestionsFile {
  const pending = file.pending.map((s) => {
    const moved = { ...s, from: id(s.from), to: id(s.to), evidence: s.evidence.map(p) };
    return { ...moved, id: suggestionId(moved) };
  });
  const rejected = file.rejected.map((r) => {
    const moved = { ...r, from: id(r.from), to: id(r.to) };
    return { ...moved, id: suggestionId(moved) };
  });
  return { ...file, pending, rejected };
}
