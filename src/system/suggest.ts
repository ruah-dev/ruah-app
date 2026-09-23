// "Suggest connections" (docs/MULTI-REPO.md decision 2), library side.
//
// suggestConnections(system, runAgent) builds the prompt (suggest-prompt.ts),
// calls the injected agent function (wired to a real agent by the daemon),
// and returns validated proposals. Nothing is written: the UI shows each
// proposal with its evidence and the user accepts (acceptSuggestion → an
// edge with `source: "suggested"`) or rejects it.
//
// Validation of the agent's JSON (parseSuggestions):
// - from/to must be listed services (top-level nodes); no self-edges;
// - confidence is a number in [0, 1] (>= minConfidence);
// - evidence entries must look like `<repoId>/<path>:<line>` for a known repo;
//   with repo roots given, the file must exist and have that line; an edge
//   without any valid evidence is rejected;
// - duplicates of existing edges (same from/to and same label, or no label)
//   are rejected; duplicates among the proposals merge (max confidence,
//   evidence union).
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ArchEdge, Architecture } from "../contracts/architecture.js";
import { buildSuggestPrompt } from "./suggest-prompt.js";
import { sortEvidence } from "./signals.js";

export type RunAgent = (prompt: string) => Promise<string>;

export interface SuggestedEdge {
  from: string;
  to: string;
  label?: string;
  kind?: string;
  confidence: number;
  evidence: string[];
  reason?: string;
}

export interface RejectedSuggestion {
  item: unknown;
  reason: string;
}

export interface SuggestSystem {
  name: string;
  architecture: Architecture;
  repos: { id: string; root?: string; path?: string }[]; // root enables on-disk evidence checks
}

export interface SuggestOptions {
  minConfidence?: number; // default 0
  maxSuggestions?: number; // default 30
  verifyEvidence?: boolean; // default true when repo roots are known
}

export interface SuggestResult {
  suggestions: SuggestedEdge[];
  rejected: RejectedSuggestion[];
  prompt: string;
  raw: string;
}

const RawEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional().nullable(),
  kind: z.string().optional().nullable(),
  confidence: z.number(),
  evidence: z.array(z.string()),
  reason: z.string().optional().nullable(),
});

// First JSON value in the agent's reply: a ```json fence, else the outermost
// {...} or [...] span.
export function extractJson(raw: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(raw);
  const spans: { at: number; text: string }[] = [];
  const o = raw.indexOf("{");
  const oc = raw.lastIndexOf("}");
  if (o !== -1 && oc > o) spans.push({ at: o, text: raw.slice(o, oc + 1) });
  const a = raw.indexOf("[");
  const ac = raw.lastIndexOf("]");
  if (a !== -1 && ac > a) spans.push({ at: a, text: raw.slice(a, ac + 1) });
  // The span that opens first is the outer value.
  spans.sort((x, y) => x.at - y.at);
  const candidates = [...(fence !== null ? [fence[1] ?? ""] : []), ...spans.map((s) => s.text)];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // next candidate
    }
  }
  throw new Error("no JSON object in the agent's answer");
}

export function topLevelServices(arch: Architecture): Architecture["nodes"] {
  return arch.nodes.filter((n) => n.parent === undefined);
}

const EVIDENCE_RE = /^([a-z0-9][a-z0-9-]*)\/(.+?):(\d+)(?:-(\d+))?$/;

function lineCount(file: string): number | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(file, "utf8").split(/\r?\n/).length;
  } catch {
    return null;
  }
}

export function parseSuggestions(
  raw: string,
  system: SuggestSystem,
  opts: SuggestOptions = {},
): { suggestions: SuggestedEdge[]; rejected: RejectedSuggestion[] } {
  const rejected: RejectedSuggestion[] = [];
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (err) {
    return { suggestions: [], rejected: [{ item: raw.slice(0, 200), reason: (err as Error).message }] };
  }
  let items: unknown[];
  if (Array.isArray(json)) items = json;
  else if (typeof json === "object" && json !== null && Array.isArray((json as { edges?: unknown }).edges)) {
    items = (json as { edges: unknown[] }).edges;
  } else {
    return { suggestions: [], rejected: [{ item: json, reason: 'expected {"edges": [...]}' }] };
  }

  const services = new Set(topLevelServices(system.architecture).map((n) => n.id));
  const roots = new Map(system.repos.filter((r) => r.root !== undefined).map((r) => [r.id, r.root ?? ""]));
  const repoIds = new Set(system.repos.map((r) => r.id));
  const verify = opts.verifyEvidence ?? roots.size > 0;
  const minConfidence = opts.minConfidence ?? 0;
  const max = opts.maxSuggestions ?? 30;
  const existing = system.architecture.edges;
  const norm = (l: string | undefined): string => (l ?? "").trim().toLowerCase();
  const duplicateOfExisting = (s: SuggestedEdge): ArchEdge | undefined =>
    existing.find((e) => e.from === s.from && e.to === s.to && (s.label === undefined || norm(e.label) === norm(s.label)));

  const byKey = new Map<string, SuggestedEdge>();
  for (const item of items) {
    const p = RawEdgeSchema.safeParse(item);
    if (!p.success) {
      rejected.push({ item, reason: `invalid edge: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      continue;
    }
    const e = p.data;
    if (!services.has(e.from)) {
      rejected.push({ item, reason: `unknown node: ${e.from}` });
      continue;
    }
    if (!services.has(e.to)) {
      rejected.push({ item, reason: `unknown node: ${e.to}` });
      continue;
    }
    if (e.from === e.to) {
      rejected.push({ item, reason: "self-edge" });
      continue;
    }
    if (!(e.confidence >= 0 && e.confidence <= 1)) {
      rejected.push({ item, reason: `confidence out of range: ${e.confidence}` });
      continue;
    }
    if (e.confidence < minConfidence) {
      rejected.push({ item, reason: `confidence ${e.confidence} below ${minConfidence}` });
      continue;
    }
    const evidence: string[] = [];
    for (const ev of e.evidence) {
      const m = EVIDENCE_RE.exec(ev.trim());
      if (m === null || !repoIds.has(m[1] ?? "")) continue;
      const rel = path.posix.normalize(m[2] ?? "");
      if (rel.startsWith("../") || rel === ".." || path.posix.isAbsolute(rel)) continue;
      const line = Number(m[3]);
      if (line < 1) continue;
      if (verify) {
        const root = roots.get(m[1] ?? "");
        if (root === undefined) continue;
        const n = lineCount(path.join(root, rel));
        if (n === null || line > n) continue;
      }
      evidence.push(`${m[1]}/${rel}:${m[3]}${m[4] !== undefined ? `-${m[4]}` : ""}`);
    }
    if (evidence.length === 0) {
      rejected.push({ item, reason: "no valid evidence (<repoId>/<path>:<line> of an existing file)" });
      continue;
    }
    const label = e.label !== undefined && e.label !== null && e.label.trim() !== "" ? e.label.trim().slice(0, 40) : undefined;
    const s: SuggestedEdge = {
      from: e.from,
      to: e.to,
      ...(label !== undefined ? { label } : {}),
      ...(e.kind !== undefined && e.kind !== null && e.kind !== "" ? { kind: e.kind } : {}),
      confidence: e.confidence,
      evidence: sortEvidence(evidence),
      ...(e.reason !== undefined && e.reason !== null && e.reason !== "" ? { reason: e.reason.slice(0, 300) } : {}),
    };
    const dup = duplicateOfExisting(s);
    if (dup !== undefined) {
      rejected.push({ item, reason: `duplicate of existing edge ${dup.from} -> ${dup.to}${dup.label !== undefined ? ` [${dup.label}]` : ""}` });
      continue;
    }
    const key = `${s.from}\u0000${s.to}\u0000${norm(s.label)}`;
    const prev = byKey.get(key);
    if (prev !== undefined) {
      prev.confidence = Math.max(prev.confidence, s.confidence);
      prev.evidence = sortEvidence([...prev.evidence, ...s.evidence]);
      continue;
    }
    byKey.set(key, s);
  }
  const suggestions = [...byKey.values()].sort(
    (a, b) => b.confidence - a.confidence || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  for (const s of suggestions.slice(max)) rejected.push({ item: s, reason: `over the ${max}-suggestion limit` });
  return { suggestions: suggestions.slice(0, max), rejected };
}

export async function suggestConnections(system: SuggestSystem, runAgent: RunAgent, opts: SuggestOptions = {}): Promise<SuggestResult> {
  const services = topLevelServices(system.architecture);
  const prompt = buildSuggestPrompt({
    systemName: system.name,
    services,
    existingEdges: system.architecture.edges.filter((e) => services.some((s) => s.id === e.from) && services.some((s) => s.id === e.to)),
    repos: system.repos.map((r) => ({ id: r.id, path: r.root ?? r.path ?? r.id })),
    ...(opts.maxSuggestions !== undefined ? { maxSuggestions: opts.maxSuggestions } : {}),
  });
  const raw = await runAgent(prompt);
  return { ...parseSuggestions(raw, system, opts), prompt, raw };
}

// Adds an accepted suggestion as an edge with `source: "suggested"`. Throws
// when an end is unknown; a no-op when the same (from, to, label) exists.
export function acceptSuggestion(arch: Architecture, s: SuggestedEdge): Architecture {
  const ids = new Set(arch.nodes.map((n) => n.id));
  if (!ids.has(s.from) || !ids.has(s.to)) throw new Error(`unknown node in suggestion ${s.from} -> ${s.to}`);
  if (arch.edges.some((e) => e.from === s.from && e.to === s.to && (e.label ?? "") === (s.label ?? ""))) return arch;
  const edge: ArchEdge = {
    from: s.from,
    to: s.to,
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.kind !== undefined ? { kind: s.kind } : {}),
    source: "suggested",
    evidence: s.evidence,
  };
  return { ...arch, edges: [...arch.edges, edge] };
}
