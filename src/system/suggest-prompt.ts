// Prompt template for "Suggest connections" (docs/MULTI-REPO.md decision 2).
//
// The agent gets the system's top-level services, the edges already known,
// and where each repo lives; it answers with JSON only. It must not edit
// anything: suggestions are proposals the user accepts or rejects one by one
// (parsed and validated in suggest.ts). Output is deterministic for a given
// architecture, so the prompt is cacheable and golden-testable.
import type { ArchEdge, ArchNode } from "../contracts/architecture.js";

export const SUGGEST_PROMPT_VERSION = 1;

export interface SuggestPromptInput {
  systemName: string;
  services: Pick<ArchNode, "id" | "type" | "name" | "description" | "tech">[];
  existingEdges: Pick<ArchEdge, "from" | "to" | "label">[];
  repos: { id: string; path: string }[]; // path as the agent can open it (absolute, or relative to its cwd)
  maxSuggestions?: number;
  /** Edges the user rejected before (CONTRACTS §12.5): listed so the agent does not spend tokens on them. */
  rejectedEdges?: Pick<ArchEdge, "from" | "to" | "label">[];
}

function oneLine(s: string | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildSuggestPrompt(input: SuggestPromptInput): string {
  const max = input.maxSuggestions ?? 30;
  const services = input.services
    .map((s) => {
      const tech = s.tech !== undefined && s.tech.length > 0 ? ` [${s.tech.slice(0, 4).join(", ")}]` : "";
      const desc = oneLine(s.description, 160);
      return `- ${s.id} (${s.type})${tech}${desc !== "" ? `: ${desc}` : ""}`;
    })
    .join("\n");
  const repos = input.repos.map((r) => `- ${r.id}: ${r.path}`).join("\n");
  const edges =
    input.existingEdges.length > 0
      ? input.existingEdges.map((e) => `- ${e.from} -> ${e.to}${e.label !== undefined ? ` [${e.label}]` : ""}`).join("\n")
      : "- (none)";
  const rejected =
    input.rejectedEdges !== undefined && input.rejectedEdges.length > 0
      ? `\nRejected by the user (never propose these again):\n${input.rejectedEdges
          .map((e) => `- ${e.from} -> ${e.to}${e.label !== undefined ? ` [${e.label}]` : ""}`)
          .join("\n")}\n`
      : "";
  return `You are mapping the architecture of the multi-repo system "${input.systemName}".
Find runtime connections BETWEEN the services listed below that are not in the known edges yet:
HTTP/gRPC/WebSocket calls, published/consumed queue topics or events, shared databases or
caches, and packages one repo imports from another.

Rules:
- Read-only. Do not edit, create, or delete any file. Do not run builds, installs, or servers.
- Only use the service ids listed under "Services" for "from" and "to". "from" is the caller,
  publisher, or dependent; "to" is the callee, consumer, or dependency.
- Every edge needs evidence: 1 to 5 locations as "<repoId>/<path inside that repo>:<line>",
  pointing at the line that proves it (the URL, client call, topic name, or import).
- Skip edges you cannot back with evidence. Skip edges already listed under "Known edges".
- confidence is a number from 0 to 1: 0.9+ when the evidence names the other service
  explicitly, 0.5–0.8 when it is inferred (e.g. a URL read from config), below 0.5 when guessing.
- At most ${max} edges.

Services:
${services}

Repos (id: location):
${repos}

Known edges:
${edges}
${rejected}
Answer with a single JSON object and nothing else:
{"edges":[{"from":"<service id>","to":"<service id>","label":"<= 40 chars, e.g. HTTP or topic name","kind":"sync|async|event|data","confidence":0.8,"evidence":["<repoId>/<path>:<line>"],"reason":"<one sentence>"}]}
If you find nothing, answer {"edges":[]}.
`;
}
