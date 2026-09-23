// buildSystemArchitecture: ruah.system.json → one federated Architecture
// (docs/MULTI-REPO.md, CONTRACTS.md §1 "System architectures").
//
// Top level: one node per repo (`id` = repo id, `repo` set, type inferred from
// its scan: frontend | service | worker | library | infra | gateway), plus the
// shared infrastructure (datastores, queues, gateways, externals) found in any
// repo, deduplicated by kind (a compose `db: postgres:16` in one repo and a
// `pg` dependency in another are the same `postgres` node).
// Below each repo node: that repo's own architecture, namespaced — ids
// `<repoId>:<nodeId>`, repo-root nodes get `parent = <repoId>`, paths and
// files `<repoId>/<path>`. Each repo keeps its own architecture.json: it is
// reused when present and valid, else the repo is scanned in memory.
// Top-level edges: repo → shared infra (lifted from each repo's own edges)
// and the deterministic cross-repo signals (signals.ts), all `source: "scan"`
// with `evidence`. Existing hand edits merge in via merge.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchEdge, ArchNode, Architecture, Workflow } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { EXTERNAL_KINDS, INFRA_KINDS } from "../scan/detectors/compose.js";
import { readmeLine } from "../scan/detectors/manifests.js";
import { orderLayers, scanRepo } from "../scan/index.js";
import { layoutArchitecture } from "../scan/layout.js";
import { slug } from "../scan/modules.js";
import { listFiles, type FileList } from "../scan/walk.js";
import { SOURCE_EXT } from "../scan/detectors/imports.js";
import { loadSystem, type LoadedRepo, type LoadedSystem } from "./config.js";
import { mergeSystemWithExisting } from "./merge.js";
import {
  type CrossSignal,
  detectCrossRepoSignals,
  edgeKindFor,
  type Endpoint,
  MAX_EVIDENCE,
  type SharedKind,
  sharedKindFromInfraKey,
  type SignalRepo,
  sortEvidence,
} from "./signals.js";

export interface BuildSystemOptions {
  version?: string; // ruah version for generatedBy
  now?: Date; // generatedAt; omitted when absent (byte-stable output)
  useGit?: boolean; // default true (git ls-files when a repo root has .git)
  previous?: Architecture | null; // existing system architecture.json to merge hand edits from
  reuseRepoArchitecture?: boolean; // default true: use <repo>/architecture.json when valid
  outFile?: string; // the system output file; never read back as a repo's own architecture
}

export interface RepoReport {
  id: string;
  root: string;
  source: "architecture.json" | "scan" | "missing";
  type: string;
  nodes: number; // nodes contributed below the repo node
  warning?: string;
}

export interface SystemBuildResult {
  architecture: Architecture;
  repos: RepoReport[];
  signals: CrossSignal[];
}

const PLAIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SERVER_TECH = [
  "Express", "Fastify", "Koa", "Hono", "NestJS", "Elysia", "FastAPI", "Django", "Flask", "Starlette", "Gin", "Echo",
  "Fiber", "chi", "Axum", "Actix Web", "Rocket", "Spring Boot", "Cloudflare Workers",
];
const REPO_LAYER: Record<string, string> = {
  frontend: "frontend",
  gateway: "gateway",
  service: "services",
  worker: "workers",
  infra: "infra",
  library: "packages",
  module: "packages",
};

function sharedLayer(type: string): string {
  return type === "datastore" || type === "queue" ? "data" : type === "external" ? "external" : type === "gateway" ? "edge" : "infra";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface RepoArch {
  arch: Architecture | null;
  source: RepoReport["source"];
  warning?: string;
}

function loadRepoArchitecture(repo: LoadedRepo, opts: BuildSystemOptions): RepoArch {
  if (!fs.existsSync(repo.root) || !fs.statSync(repo.root).isDirectory()) {
    return { arch: null, source: "missing", warning: `repo ${repo.id}: not a directory: ${repo.root}` };
  }
  const file = path.join(repo.root, "architecture.json");
  const isOut = opts.outFile !== undefined && path.resolve(opts.outFile) === file;
  let warning: string | undefined;
  if (opts.reuseRepoArchitecture !== false && !isOut && fs.existsSync(file)) {
    try {
      const r = validateArchitecture(JSON.parse(fs.readFileSync(file, "utf8")), null);
      if (!r.ok) warning = `repo ${repo.id}: architecture.json invalid, scanned instead (${r.errors[0] ?? ""})`;
      else if (!r.value.nodes.every((n) => PLAIN_ID.test(n.id))) warning = `repo ${repo.id}: architecture.json has namespaced ids, scanned instead`;
      else return { arch: r.value, source: "architecture.json" };
    } catch (err) {
      warning = `repo ${repo.id}: cannot read architecture.json, scanned instead (${(err as Error).message})`;
    }
  }
  const arch = scanRepo(repo.root, {
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(opts.useGit === false ? { useGit: false } : {}),
  });
  return { arch, source: "scan", ...(warning !== undefined ? { warning } : {}) };
}

// Top-level repo nodes that stand for shared infrastructure (no path, a
// datastore/queue/external/gateway type or a known infra kind), with the key
// they deduplicate under.
function sharedKindOf(n: ArchNode): SharedKind | undefined {
  if (n.parent !== undefined || n.path !== undefined) return undefined;
  const name = n.name.toLowerCase();
  if (n.type === "external") {
    const e = EXTERNAL_KINDS.find((x) => x.key === n.id || x.name.toLowerCase() === name);
    return e !== undefined
      ? { key: e.key, name: e.name, type: "external", label: "API" }
      : { key: slug(n.name), name: n.name, type: "external", label: "API" };
  }
  const t0 = (n.tech?.[0] ?? "").toLowerCase();
  const k = INFRA_KINDS.find(
    (i) =>
      i.key === n.id ||
      i.key === name ||
      t0 === i.name.toLowerCase() ||
      t0.startsWith(`${i.name.toLowerCase()} `) ||
      i.images.includes(name),
  );
  if (k !== undefined && (["datastore", "queue", "gateway"].includes(n.type) || k.type === n.type)) {
    return { key: k.key, name: k.name, type: k.type, label: k.label };
  }
  if (n.type === "datastore" || n.type === "queue") {
    return { key: `${slug(n.name)}-${n.type}`, name: n.name, type: n.type, label: n.type === "datastore" ? "data" : "messages" };
  }
  return undefined;
}

function isCodeNode(n: ArchNode): boolean {
  return n.parent === undefined && sharedKindOf(n) === undefined && (n.path !== undefined || n.layer === "entry");
}

interface RepoFacts {
  consumesTopics: boolean;
  deployFiles: number;
  sourceFiles: number;
}

function inferRepoType(code: ArchNode[], facts: RepoFacts): string {
  if (code.length === 0) return facts.deployFiles > 0 ? "infra" : "library";
  const count = (t: string): number => code.filter((n) => n.type === t).length;
  const svc = count("service");
  const fe = count("frontend");
  const gw = count("gateway");
  if (svc === 0 && fe === 0 && gw === 0) {
    if (facts.deployFiles > 0 && facts.sourceFiles === 0) return "infra";
    if (facts.consumesTopics) return "worker";
    return "library";
  }
  if (fe > svc) return "frontend";
  if (svc > 0) {
    const servers = code.filter((n) => n.type === "service" && (n.tech ?? []).some((t) => SERVER_TECH.some((s) => t === s || t.startsWith(`${s} `))));
    if (servers.length === 0 && facts.consumesTopics) return "worker";
    return "service";
  }
  return fe > 0 ? "frontend" : "gateway";
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function buildSystemArchitecture(system: LoadedSystem | string, opts: BuildSystemOptions = {}): SystemBuildResult {
  const sys = typeof system === "string" ? loadSystem(system) : system;
  const repoIds = new Set(sys.repos.map((r) => r.id));
  const sharedId = (key: string): string => (repoIds.has(key) ? `shared-${key}` : key);

  const loaded = sys.repos.map((r) => ({ repo: r, ...loadRepoArchitecture(r, opts) }));
  const fileLists = new Map<string, FileList>();
  const signalRepos: SignalRepo[] = [];
  for (const l of loaded) {
    if (l.source === "missing") continue;
    const fl = listFiles(l.repo.root, opts.useGit === false ? { useGit: false } : {});
    fileLists.set(l.repo.id, fl);
    signalRepos.push({ id: l.repo.id, root: l.repo.root, fl });
  }
  const sig = detectCrossRepoSignals(signalRepos);

  const topNodes: ArchNode[] = [];
  const childNodes: ArchNode[] = [];
  const innerEdges: ArchEdge[] = [];
  const workflows: Workflow[] = [];
  const reports: RepoReport[] = [];

  // Top-level edges, keyed (from, to, label); evidence merged.
  const top = new Map<string, { edge: ArchEdge; ev: Set<string> }>();
  const addTop = (from: string, to: string, label: string, kind: string, evidence: string[]): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${label}`;
    let e = top.get(key);
    if (e === undefined) {
      e = { edge: { from, to, label, kind, source: "scan" }, ev: new Set() };
      top.set(key, e);
    }
    for (const x of evidence) e.ev.add(x);
  };

  // Shared infra nodes, by key.
  const shared = new Map<string, { kind: SharedKind; tech: string[]; files: string[] }>();
  const useShared = (kind: SharedKind, tech: string[] = [], files: string[] = []): string => {
    let s = shared.get(kind.key);
    if (s === undefined) {
      s = { kind, tech: [], files: [] };
      shared.set(kind.key, s);
    }
    for (const t of tech) if (!s.tech.includes(t)) s.tech.push(t);
    for (const f of files) if (!s.files.includes(f)) s.files.push(f);
    return sharedId(kind.key);
  };

  for (const l of loaded) {
    const { repo, arch } = l;
    const facts = sig.repoTypes.get(repo.id);
    const fl = fileLists.get(repo.id);
    if (arch === null) {
      topNodes.push({
        id: repo.id,
        type: "module",
        name: repo.id,
        repo: repo.id,
        layer: "packages",
        description: `Repo not found at ${repo.path}.`,
      });
      reports.push({ id: repo.id, root: repo.root, source: "missing", type: "module", nodes: 0, ...(l.warning !== undefined ? { warning: l.warning } : {}) });
      continue;
    }
    const ns = (id: string): string => `${repo.id}:${id}`;
    const sp = (p: string): string => `${repo.id}/${p}`;
    const code = arch.nodes.filter(isCodeNode);
    const type = inferRepoType(code, {
      consumesTopics: facts?.consumesTopics ?? false,
      deployFiles: facts?.deployFiles ?? 0,
      sourceFiles: fl?.files.filter((f) => SOURCE_EXT.test(f)).length ?? 0,
    });

    // Children: the repo's own architecture, namespaced.
    for (const n of arch.nodes) {
      const child: ArchNode = {
        id: ns(n.id),
        type: n.type,
        name: n.name,
        ...(n.description !== undefined ? { description: n.description } : {}),
        ...(n.notes !== undefined ? { notes: n.notes } : {}),
        ...(n.tech !== undefined ? { tech: n.tech } : {}),
        ...(n.path !== undefined ? { path: sp(n.path) } : {}),
        ...(n.files !== undefined ? { files: n.files.map(sp) } : {}),
        ...(n.layer !== undefined ? { layer: n.layer } : {}),
        parent: n.parent !== undefined ? ns(n.parent) : repo.id,
        repo: repo.id,
        ...(n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : {}),
      };
      childNodes.push(child);
    }
    for (const e of arch.edges) {
      innerEdges.push({
        from: ns(e.from),
        to: ns(e.to),
        ...(e.label !== undefined ? { label: e.label } : {}),
        ...(e.kind !== undefined ? { kind: e.kind } : {}),
        source: "scan",
      });
    }
    for (const w of arch.workflows) {
      workflows.push({
        id: ns(w.id),
        name: w.name,
        ...(w.description !== undefined ? { description: w.description } : {}),
        steps: w.steps.map(ns),
      });
    }

    // Lift the repo's infra to shared top-level nodes; its users' edges become repo → shared.
    const lifted = new Map<string, { id: string; kind: SharedKind }>();
    for (const n of arch.nodes) {
      const k = sharedKindOf(n);
      if (k === undefined) continue;
      lifted.set(n.id, { id: useShared(k, n.tech ?? [], (n.files ?? []).map(sp)), kind: k });
    }
    // Only the repo's own code (code nodes and their descendants) counts as a
    // user; edges from other nodes (compose services an infra repo merely
    // deploys) are covered by the deploy-manifest signals instead.
    const codeTree = new Set(code.map((n) => n.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of arch.nodes) {
        if (n.parent !== undefined && codeTree.has(n.parent) && !codeTree.has(n.id)) {
          codeTree.add(n.id);
          grew = true;
        }
      }
    }
    for (const e of arch.edges) {
      const to = lifted.get(e.to);
      if (to === undefined) continue;
      const from = lifted.get(e.from)?.id ?? (codeTree.has(e.from) ? repo.id : undefined);
      if (from === undefined) continue;
      addTop(from, to.id, e.label ?? to.kind.label, e.kind ?? edgeKindFor(to.kind.type), []);
    }

    // The repo node.
    const ctx = fl !== undefined ? { root: repo.root, fl } : null;
    // Single-package repos: the scan's entry node; else the only code node.
    const entries = code.filter((n) => n.layer === "entry");
    const primary = entries.length === 1 ? entries[0] : code.length === 1 ? code[0] : undefined;
    const readme = ctx !== null ? readmeLine(ctx, "") : null;
    const description =
      primary?.description ??
      readme ??
      (type === "infra"
        ? "Deployment and infrastructure definitions."
        : primary !== undefined
          ? `${primary.name} (${type}).`
          : `${code.length} package${code.length === 1 ? "" : "s"}.`);
    let tech = uniq(code.flatMap((n) => n.tech ?? [])).slice(0, 5);
    if (type === "infra" && fl !== undefined) {
      tech = [
        ...(fl.files.some((f) => /(^|\/)(docker-)?compose([.-][\w-]+)*\.ya?ml$/.test(f)) ? ["Docker Compose"] : []),
        ...(fl.files.some((f) => /\.tf$/.test(f)) ? ["Terraform"] : []),
        ...(fl.files.some((f) => /(^|\/)(k8s|kubernetes|manifests|helm|charts)\//.test(f)) ? ["Kubernetes"] : []),
      ];
    }
    const files = (
      type === "infra" && fl !== undefined
        ? fl.files.filter((f) => /(^|\/)(docker-)?compose([.-][\w-]+)*\.ya?ml$|\.tf$|(^|\/)(k8s|kubernetes|manifests|helm|charts)\/.*\.ya?ml$/.test(f))
        : uniq(code.flatMap((n) => n.files ?? []))
    )
      .slice(0, 10)
      .map(sp);
    topNodes.push({
      id: repo.id,
      type,
      name: repo.id,
      description,
      ...(tech.length > 0 ? { tech } : {}),
      path: repo.id,
      ...(files.length > 0 ? { files } : {}),
      layer: REPO_LAYER[type] ?? "packages",
      repo: repo.id,
    });
    reports.push({
      id: repo.id,
      root: repo.root,
      source: l.source,
      type,
      nodes: arch.nodes.length,
      ...(l.warning !== undefined ? { warning: l.warning } : {}),
    });
  }

  // Cross-repo signals.
  const endpointId = (e: Endpoint): string | undefined => {
    if ("repo" in e) return repoIds.has(e.repo) ? e.repo : undefined;
    const k = sig.sharedKinds.get(e.shared) ?? sharedKindFromInfraKey(e.shared);
    return k !== undefined ? useShared(k) : undefined;
  };
  for (const s of sig.signals) {
    const from = endpointId(s.from);
    const to = endpointId(s.to);
    if (from === undefined || to === undefined) continue;
    addTop(from, to, s.label, s.kind, s.evidence);
  }

  // Shared nodes: description from their users, files from evidence.
  const topEdges: ArchEdge[] = [...top.values()].map(({ edge, ev }) => {
    const evidence = sortEvidence([...ev]).slice(0, MAX_EVIDENCE);
    return evidence.length > 0 ? { ...edge, evidence } : edge;
  });
  const sharedNodes: ArchNode[] = [];
  for (const [key, s] of [...shared.entries()].sort((a, b) => cmp(sharedId(a[0]), sharedId(b[0])))) {
    const id = sharedId(key);
    const incoming = topEdges.filter((e) => e.to === id);
    const users = uniq(incoming.filter((e) => e.label !== "deploys").map((e) => e.from)).sort();
    const deployers = uniq(incoming.filter((e) => e.label === "deploys").map((e) => e.from)).sort();
    const evFiles = uniq(incoming.flatMap((e) => (e.evidence ?? []).map((x) => x.replace(/:\d+(-\d+)?$/, "")))).sort();
    const files = uniq([...s.files, ...evFiles]).slice(0, 20);
    const parts = [
      users.length > 0 ? `used by ${users.join(", ")}` : "",
      deployers.length > 0 ? `deployed by ${deployers.join(", ")}` : "",
    ].filter((p) => p !== "");
    // "Kafka" and "Kafka 3" from two repos → "Kafka 3".
    const specific = s.tech.filter((t) => !s.tech.some((o) => o !== t && o.startsWith(`${t} `)));
    const tech = specific.length > 0 ? specific.slice(0, 3) : [s.kind.name];
    sharedNodes.push({
      id,
      type: s.kind.type,
      name: s.kind.name,
      description: `Shared ${s.kind.type === "external" ? "third-party service" : s.kind.type}${parts.length > 0 ? `, ${parts.join("; ")}` : ""}.`,
      tech,
      ...(files.length > 0 ? { files } : {}),
      layer: sharedLayer(s.kind.type),
    });
  }

  const edgeCmp = (a: ArchEdge, b: ArchEdge): number =>
    cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.label ?? "", b.label ?? "");
  const nodes = [...topNodes, ...sharedNodes, ...childNodes];
  const edges = [...topEdges.sort(edgeCmp), ...innerEdges.sort(edgeCmp)];
  const layers = orderLayers(nodes.map((n) => n.layer).filter((l): l is string => l !== undefined));
  let arch: Architecture = {
    version: 1,
    name: sys.name,
    generatedBy: `ruah app system ${opts.version ?? "0.1.0"}`,
    ...(opts.now !== undefined ? { generatedAt: opts.now.toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
    layers,
    nodes,
    edges,
    workflows,
  };
  if (opts.previous !== undefined && opts.previous !== null) arch = mergeSystemWithExisting(arch, opts.previous);
  return { architecture: layoutArchitecture(arch), repos: reports, signals: sig.signals };
}
