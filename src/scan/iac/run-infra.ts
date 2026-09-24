// `ruah app infra <repo> [--json] [--kind <k>]…` (CONTRACTS.md §11): prints
// what the infrastructure-as-code scan finds — resources and runtime workloads
// per group, how code is packaged, "how it ships" workflows and the links
// between them — without writing anything. Same scan as `ruah app scan`, so
// the output is exactly what the map would get.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchEdge, ArchNode, Architecture, Workflow } from "../../contracts/architecture.js";
import { scanRepo } from "../index.js";

/** CLI kinds → `infra.tool` values. */
export const INFRA_KINDS_CLI: Record<string, readonly string[]> = {
  terraform: ["terraform"],
  k8s: ["kubernetes", "kustomize"],
  kubernetes: ["kubernetes", "kustomize"],
  kustomize: ["kustomize"],
  helm: ["helm"],
  ansible: ["ansible"],
  compose: ["compose"],
  docker: ["docker"],
  ci: ["ci"],
};

export interface InfraView {
  repo: string;
  kinds: string[];
  nodes: ArchNode[]; // elements with `infra`
  edges: ArchEdge[]; // links touching them (lifted group-level copies left out)
  workflows: Workflow[]; // "how it ships"
  ms: number;
}

/** The infrastructure part of a scanned architecture, optionally only some tools. */
export function infraView(arch: Architecture, repo: string, kinds: readonly string[] = [], ms = 0): InfraView {
  const tools = new Set(kinds.flatMap((k) => INFRA_KINDS_CLI[k] ?? []));
  const want = (n: ArchNode): boolean => n.infra !== undefined && (tools.size === 0 || tools.has(n.infra.tool));
  const nodes = arch.nodes.filter(want);
  const ids = new Set(nodes.map((n) => n.id));
  const groups = new Set(arch.nodes.filter((n) => n.infra !== undefined && arch.nodes.some((c) => c.parent === n.id)).map((n) => n.id));
  const edges = arch.edges.filter((e) => (ids.has(e.from) || ids.has(e.to)) && !groups.has(e.from) && !groups.has(e.to));
  const workflows = arch.workflows.filter((w) => w.source === "scan" && w.steps.some((s) => ids.has(s)));
  return { repo, kinds: [...kinds], nodes, edges, workflows, ms };
}

function fmtSettings(n: ArchNode, max = 6): string {
  return Object.entries(n.infra?.settings ?? {})
    .slice(0, max)
    .map(([k, v]) => `${k}=${v.length > 60 ? `${v.slice(0, 59)}…` : v}`)
    .join(" ");
}

export function formatInfraView(view: InfraView, all: readonly ArchNode[]): string {
  const byId = new Map(all.map((n) => [n.id, n]));
  const name = (id: string): string => {
    const n = byId.get(id);
    if (n === undefined) return id;
    const parent = n.parent !== undefined ? byId.get(n.parent) : undefined;
    return parent !== undefined && parent.infra !== undefined ? `${n.name} (${parent.name})` : n.name;
  };
  const out: string[] = [];
  const groups = view.nodes.filter((n) => view.nodes.some((c) => c.parent === n.id) || (n.parent === undefined && n.infra?.tool !== "docker" && n.infra?.tool !== "compose"));
  const inGroups = new Set<string>();
  for (const g of groups) {
    const kids = view.nodes.filter((c) => c.parent === g.id && !view.nodes.some((x) => x.parent === c.id));
    out.push(`${g.name}  [${g.id}]${g.path !== undefined ? `  ${g.path}` : ""}`);
    if (g.infra?.settings !== undefined && Object.keys(g.infra.settings).length > 0) out.push(`  ${fmtSettings(g, 8)}`);
    for (const c of kids) {
      inGroups.add(c.id);
      const where = c.infra?.source?.[0] ?? c.path ?? "";
      out.push(`  ${c.type.padEnd(12)} ${c.name.padEnd(28)} ${(c.infra?.kind ?? "").padEnd(22)} ${where}`);
      const s = fmtSettings(c);
      if (s !== "") out.push(`  ${"".padEnd(12)} ${s}`);
    }
    const folded = g.infra?.details?.length ?? 0;
    if (folded > 0) out.push(`  (${folded} folded: ${(g.infra?.details ?? []).slice(0, 4).join(", ")}${folded > 4 ? ", …" : ""})`);
    out.push("");
  }
  const packaged = view.nodes.filter((n) => (n.infra?.tool === "docker" || n.infra?.tool === "compose") && !inGroups.has(n.id));
  if (packaged.length > 0) {
    out.push("Code packaging (Dockerfiles, compose services)");
    for (const n of packaged) out.push(`  ${n.name.padEnd(28)} ${`${n.infra?.tool ?? ""} ${n.infra?.kind ?? ""}`.padEnd(22)} ${n.infra?.source?.[0] ?? ""}  ${fmtSettings(n, 4)}`);
    out.push("");
  }
  if (view.workflows.length > 0) {
    out.push("How it ships");
    for (const w of view.workflows) out.push(`  ${w.name}: ${w.steps.map(name).join(" → ")}`);
    out.push("");
  }
  if (view.edges.length > 0) {
    out.push("Links");
    for (const e of view.edges) out.push(`  ${name(e.from)} → ${name(e.to)} [${e.label ?? ""}]${e.evidence?.length ? `  ${e.evidence.slice(0, 2).join(", ")}` : ""}`);
    out.push("");
  }
  if (out.length === 0) out.push("No infrastructure as code found.", "");
  return out.join("\n");
}

export interface RunInfraOptions {
  repo: string;
  json: boolean;
  kinds: string[];
}

export function runInfra(opts: RunInfraOptions, version: string): number {
  const root = path.resolve(opts.repo);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`ruah app infra: not a directory: ${opts.repo}\n`);
    return 2;
  }
  const unknown = opts.kinds.filter((k) => INFRA_KINDS_CLI[k] === undefined);
  if (unknown.length > 0) {
    process.stderr.write(`ruah app infra: unknown --kind ${unknown.join(", ")} (expected ${Object.keys(INFRA_KINDS_CLI).join(", ")})\n`);
    return 2;
  }
  const started = Date.now();
  const arch = scanRepo(root, { version });
  const view = infraView(arch, root, opts.kinds, Date.now() - started);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  } else {
    process.stdout.write(formatInfraView(view, arch.nodes));
  }
  process.stderr.write(`ruah app infra: ${view.nodes.length} elements, ${view.edges.length} links, ${view.workflows.length} workflows in ${view.ms} ms (nothing written)\n`);
  return 0;
}
