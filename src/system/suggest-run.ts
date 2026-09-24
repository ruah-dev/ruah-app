// One "Suggest connections" pass over a system on disk (CONTRACTS §12.5):
// prompt → pluggable agent (RunAgent) → validated proposals → stored as
// pending in .ruah/suggestions.json (previous rejections dropped). Shared by
// the CLI (`ruah app system suggest`, agent = Claude Agent SDK one-shot or a
// reply file) and the daemon (agent = the current agent, as a normal turn).
import * as path from "node:path";
import type { ArchEdge, Architecture } from "../contracts/architecture.js";
import type { LoadedSystem } from "./config.js";
import { readArchitectureFile, rebuildSystem, SYSTEM_ARCHITECTURE_FILE } from "./manage.js";
import { suggestConnections, type RunAgent, type SuggestResult } from "./suggest.js";
import { readSuggestionsFile, recordSuggestionRun, type StoredSuggestion, type SuggestionsFile } from "./suggestions-store.js";

export interface SuggestPassOptions {
  agentId?: string;
  minConfidence?: number;
  maxSuggestions?: number;
  /** The system map to suggest against (default: architecture.json next to ruah.system.json, built when missing). */
  architecture?: Architecture | null;
  version?: string;
}

export interface SuggestPassResult {
  result: SuggestResult;
  /** New pending suggestions from this run. */
  added: StoredSuggestion[];
  droppedRejected: number;
  file: SuggestionsFile;
}

export async function runSuggestPass(sys: LoadedSystem, runAgent: RunAgent, opts: SuggestPassOptions = {}): Promise<SuggestPassResult> {
  let arch = opts.architecture ?? readArchitectureFile(path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE));
  if (arch === null) arch = rebuildSystem(sys, opts.version !== undefined ? { version: opts.version } : {}).architecture;
  const stored = readSuggestionsFile(sys.dir);
  const result = await suggestConnections(
    { name: sys.name, architecture: arch, repos: sys.repos.map((r) => ({ id: r.id, root: r.root, path: r.path })) },
    runAgent,
    {
      rejected: stored.rejected,
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
      ...(opts.maxSuggestions !== undefined ? { maxSuggestions: opts.maxSuggestions } : {}),
    },
  );
  const recorded = recordSuggestionRun(sys.dir, result.suggestions, { agentId: opts.agentId });
  return { result, added: recorded.added, droppedRejected: recorded.droppedRejected, file: recorded.file };
}

/**
 * The deterministic cross-repo edges of a system map (zero tokens): edges
 * between top-level elements (repos, shared infra) that the system scanner
 * produced, each with its file:line evidence.
 */
export function crossRepoSignalEdges(arch: Architecture): ArchEdge[] {
  const top = new Set(arch.nodes.filter((n) => n.parent === undefined).map((n) => n.id));
  return arch.edges.filter((e) => e.source === "scan" && top.has(e.from) && top.has(e.to));
}
