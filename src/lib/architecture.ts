// Pure mapping between architecture.json (src/lib/contracts.ts) and the viewer's
// diagram model (src/data/graphs.ts). CONTRACTS.md §1.3. No React, no I/O.
import type { Architecture, ArchEdge, ArchNode, Workflow } from "./contracts";
import type {
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  Graph,
  NodeKind,
} from "@/data/graphs";

export const NODE_W = 200;
export const NODE_H = 64;
/** Canvas offset for architecture levels: stored (0,0) renders at (ORIGIN, ORIGIN), so layer
 * group frames (24 px padding) and their labels stay on-canvas. Editor moves subtract it again. */
export const ORIGIN = 48;
const GROUP_PAD = 24;
const FLOW_GAP_X = 260;
const FLOW_GAP_Y = 140;
const FLOW_WRAP = 4;

export const ROOT_DIAGRAM_ID = "arch:root";
export const levelDiagramId = (nodeId: string) => `arch:${nodeId}`;
export const workflowDiagramId = (workflowId: string) => `flow:${workflowId}`;

export type DiagramRef =
  | { mode: "architecture"; parentId: string | null }
  | { mode: "workflow"; workflowId: string };

export function parseDiagramId(id: string): DiagramRef | null {
  if (id === ROOT_DIAGRAM_ID) return { mode: "architecture", parentId: null };
  if (id.startsWith("arch:")) return { mode: "architecture", parentId: id.slice(5) };
  if (id.startsWith("flow:")) return { mode: "workflow", workflowId: id.slice(5) };
  return null;
}

export const EMPTY_ARCHITECTURE: Architecture = {
  version: 1,
  name: "",
  nodes: [],
  edges: [],
  workflows: [],
};

// ---------------------------------------------------------------------------
// type <-> kind

const KNOWN_KINDS = new Set<string>([
  "service", "function", "container", "cluster", "worker",
  "database", "cache", "storage", "warehouse", "search",
  "queue", "topic", "stream", "webhook", "scheduler",
  "gateway", "loadbalancer", "cdn", "dns", "firewall",
  "auth", "secret", "monitoring", "analytics", "config", "ml",
  "frontend", "mobile", "user", "external",
  "module", "file", "api",
  "step", "decision", "event", "timer", "approval", "actor",
]);

// Obvious synonyms the scanner or hand-written files use. Anything else -> "module".
const TYPE_ALIASES: Record<string, NodeKind> = {
  datastore: "database",
  db: "database",
  sql: "database",
  bucket: "storage",
  blob: "storage",
  "object-store": "storage",
  bus: "queue",
  broker: "queue",
  "third-party": "external",
  thirdparty: "external",
  saas: "external",
  vendor: "external",
  web: "frontend",
  ui: "frontend",
  client: "frontend",
  spa: "frontend",
  site: "frontend",
  proxy: "gateway",
  ingress: "gateway",
  edge: "gateway",
  "load-balancer": "loadbalancer",
  lambda: "function",
  serverless: "function",
  job: "worker",
  daemon: "service",
  server: "service",
  backend: "service",
  microservice: "service",
  package: "module",
  library: "module",
  lib: "module",
  entry: "module",
  app: "module",
  component: "module",
  person: "actor",
  role: "actor",
};

export function kindFor(type: string): NodeKind {
  const t = type.toLowerCase();
  if (TYPE_ALIASES[t]) return TYPE_ALIASES[t];
  if (KNOWN_KINDS.has(t)) return t as NodeKind;
  return "module";
}

/** Inverse used when the editor changes a node's kind. */
export function typeFor(kind: NodeKind): string {
  return kind === "database" ? "datastore" : kind;
}

// ---------------------------------------------------------------------------
// indexes

export interface ArchIndex {
  byId: Map<string, ArchNode>;
  children: Map<string | null, ArchNode[]>;
  workflowOnly: Set<string>;
}

export function indexArchitecture(arch: Architecture): ArchIndex {
  const byId = new Map<string, ArchNode>();
  const children = new Map<string | null, ArchNode[]>();
  for (const n of arch.nodes) {
    byId.set(n.id, n);
    const key = n.parent ?? null;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  // Step nodes that only exist to be workflow steps are not drawn on architecture levels.
  const inWorkflow = new Set(arch.workflows.flatMap((w) => w.steps));
  const workflowOnly = new Set(
    arch.nodes
      .filter((n) => kindFor(n.type) === "step" && inWorkflow.has(n.id) && !children.has(n.id))
      .map((n) => n.id),
  );
  return { byId, children, workflowOnly };
}

export function hasChildren(index: ArchIndex, id: string): boolean {
  return (index.children.get(id)?.length ?? 0) > 0;
}

/** Ancestors from the top level down to (and including) `id`. */
export function ancestry(index: ArchIndex, id: string | null): ArchNode[] {
  const out: ArchNode[] = [];
  const seen = new Set<string>();
  let cur = id === null ? undefined : index.byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent ? index.byId.get(cur.parent) : undefined;
  }
  return out;
}

export function subtitleFor(node: ArchNode): string {
  if (node.tech?.length) return node.tech.slice(0, 2).join(" · ");
  return node.path ?? "";
}

function toDiagramNode(node: ArchNode, index: ArchIndex, x: number, y: number): DiagramNode {
  return {
    id: node.id,
    label: node.name,
    subtitle: subtitleFor(node),
    kind: kindFor(node.type),
    type: node.type,
    x,
    y,
    ...(hasChildren(index, node.id) ? { drill: levelDiagramId(node.id) } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.notes !== undefined ? { notes: node.notes } : {}),
    ...(node.tech !== undefined ? { tech: node.tech } : {}),
    ...(node.path !== undefined ? { path: node.path } : {}),
    ...(node.layer !== undefined ? { layer: node.layer } : {}),
    ...(node.parent !== undefined ? { parent: node.parent } : {}),
    ...(node.files !== undefined ? { filePaths: node.files } : {}),
  };
}

function toDiagramEdge(edge: ArchEdge): DiagramEdge {
  return {
    from: edge.from,
    to: edge.to,
    ...(edge.label !== undefined ? { label: edge.label } : {}),
    ...(edge.kind !== undefined ? { kind: edge.kind } : {}),
    animated: edge.kind === "async" || edge.kind === "event",
  };
}

function groupsFor(arch: Architecture, nodes: DiagramNode[]): DiagramGroup[] {
  const byLayer = new Map<string, DiagramNode[]>();
  for (const n of nodes) {
    if (!n.layer) continue;
    const list = byLayer.get(n.layer) ?? [];
    list.push(n);
    byLayer.set(n.layer, list);
  }
  const order = [...(arch.layers ?? [])];
  for (const layer of byLayer.keys()) if (!order.includes(layer)) order.push(layer);
  const groups: DiagramGroup[] = [];
  for (const layer of order) {
    const members = byLayer.get(layer);
    if (!members?.length) continue;
    const minX = Math.min(...members.map((n) => n.x));
    const minY = Math.min(...members.map((n) => n.y));
    const maxX = Math.max(...members.map((n) => n.x + (n.w ?? NODE_W)));
    const maxY = Math.max(...members.map((n) => n.y + (n.h ?? NODE_H)));
    groups.push({
      id: `layer:${layer}`,
      label: layer,
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD,
      w: maxX - minX + GROUP_PAD * 2,
      h: maxY - minY + GROUP_PAD * 2,
    });
  }
  return groups;
}

function kindSummary(nodes: DiagramNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, c]) => `${c} ${k === "database" ? "datastore" : k}${c === 1 ? "" : "s"}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// graphs

/** One drill level: the nodes whose `parent` is `parentId` (null = top level). */
export function toGraph(arch: Architecture, parentId: string | null, index = indexArchitecture(arch)): Graph {
  const level = (index.children.get(parentId) ?? []).filter((n) => !index.workflowOnly.has(n.id));
  const nodes = level.map((n) => toDiagramNode(n, index, (n.x ?? 0) + ORIGIN, (n.y ?? 0) + ORIGIN));
  const visible = new Set(nodes.map((n) => n.id));
  const edges = arch.edges.filter((e) => visible.has(e.from) && visible.has(e.to)).map(toDiagramEdge);
  const parent = parentId === null ? undefined : index.byId.get(parentId);
  const summary = kindSummary(nodes);
  return {
    id: parentId === null ? ROOT_DIAGRAM_ID : levelDiagramId(parentId),
    title: parent ? parent.name : "System topology",
    subtitle: parent
      ? [parent.path, summary].filter(Boolean).join(" · ")
      : [arch.name, summary].filter(Boolean).join(" · "),
    nodes,
    edges,
    groups: groupsFor(arch, nodes),
  };
}

export type Positions = Record<string, { x: number; y: number }>;

/** Workflow steps left-to-right, 260 px apart, wrapping every 4, with sequential edges.
 * `positions` holds per-viewer layout overrides (workflow positions are not in architecture.json). */
export function workflowGraph(
  arch: Architecture,
  workflowId: string,
  positions: Positions = {},
  index = indexArchitecture(arch),
): Graph {
  const wf = arch.workflows.find((w) => w.id === workflowId);
  const id = workflowDiagramId(workflowId);
  if (!wf) return { id, title: workflowId, subtitle: "", nodes: [], edges: [], groups: [] };
  const nodes: DiagramNode[] = [];
  const placed = new Set<string>();
  wf.steps.forEach((stepId, i) => {
    const node = index.byId.get(stepId);
    if (!node || placed.has(stepId)) return;
    placed.add(stepId);
    const auto = {
      x: ORIGIN + (i % FLOW_WRAP) * FLOW_GAP_X,
      y: ORIGIN + Math.floor(i / FLOW_WRAP) * FLOW_GAP_Y,
    };
    const p = positions[stepId] ?? auto;
    nodes.push(toDiagramNode(node, index, p.x, p.y));
  });
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < wf.steps.length; i++) {
    const from = wf.steps[i]!;
    const to = wf.steps[i + 1]!;
    const key = `${from}->${to}`;
    if (from === to || seen.has(key) || !placed.has(from) || !placed.has(to)) continue;
    seen.add(key);
    edges.push({ from, to, animated: true });
  }
  return {
    id,
    title: wf.name,
    subtitle: wf.description ?? `${wf.steps.length} steps`,
    nodes,
    edges,
    groups: [],
  };
}

export type DiagramMode = "architecture" | "workflow";
export type DerivedDiagram = Graph & { mode: DiagramMode; group: string };

/** Every diagram the architecture implies: top level, one per node with children, one per workflow. */
export function diagramsFromArchitecture(
  arch: Architecture,
  flowPositions: Record<string, Positions> = {},
): DerivedDiagram[] {
  const index = indexArchitecture(arch);
  const out: DerivedDiagram[] = [{ ...toGraph(arch, null, index), mode: "architecture", group: "System" }];
  const containers = arch.nodes.filter((n) => hasChildren(index, n.id));
  // Order: depth-first in file order so a parent's diagram precedes its children's.
  const visit = (parentId: string | null) => {
    for (const n of index.children.get(parentId) ?? []) {
      if (!hasChildren(index, n.id)) continue;
      const top = ancestry(index, n.id)[0];
      out.push({
        ...toGraph(arch, n.id, index),
        mode: "architecture",
        group: top?.layer ?? top?.name ?? "Components",
      });
      visit(n.id);
    }
  };
  if (containers.length) visit(null);
  for (const wf of arch.workflows) {
    const id = workflowDiagramId(wf.id);
    out.push({ ...workflowGraph(arch, wf.id, flowPositions[id] ?? {}, index), mode: "workflow", group: "Workflows" });
  }
  return out;
}

/** The diagram a node is drawn on: its drill level, or the first workflow for workflow-only steps. */
export function homeDiagramId(arch: Architecture, nodeId: string, index = indexArchitecture(arch)): string | null {
  const node = index.byId.get(nodeId);
  if (!node) return null;
  if (index.workflowOnly.has(nodeId)) {
    const wf = arch.workflows.find((w) => w.steps.includes(nodeId));
    return wf ? workflowDiagramId(wf.id) : null;
  }
  return node.parent ? levelDiagramId(node.parent) : ROOT_DIAGRAM_ID;
}

// ---------------------------------------------------------------------------
// repo tree

export type RepoTreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  nodeId?: string;
  children?: RepoTreeNode[];
};

type MutableTree = {
  name: string;
  path: string;
  children: Map<string, MutableTree>;
  nodeId?: string;
  ownerDepth: number;
  fromFiles: boolean;
};

const looksLikeFile = (p: string) => /\.[A-Za-z0-9]+$/.test(p.split("/").pop() ?? "");

/** Directory tree from every node `path` and `files[]` entry; entries carry the owning node id
 * (the deepest node that lists them). */
export function toRepoTree(arch: Architecture): RepoTreeNode[] {
  const index = indexArchitecture(arch);
  const root: MutableTree = { name: "", path: "", children: new Map(), ownerDepth: -1, fromFiles: false };
  const insert = (rawPath: string, nodeId: string, fromFiles: boolean) => {
    const clean = rawPath.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!clean || clean === ".") return;
    const depth = ancestry(index, nodeId).length;
    let cur = root;
    const parts = clean.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.get(part);
      if (!next) {
        next = { name: part, path, children: new Map(), ownerDepth: -1, fromFiles: false };
        cur.children.set(part, next);
      }
      cur = next;
    });
    if (depth > cur.ownerDepth) {
      cur.nodeId = nodeId;
      cur.ownerDepth = depth;
    }
    if (fromFiles) cur.fromFiles = true;
  };
  for (const n of arch.nodes) {
    if (n.path) insert(n.path, n.id, false);
    for (const f of n.files ?? []) insert(f, n.id, true);
  }
  const finish = (t: MutableTree): RepoTreeNode => {
    const kids = [...t.children.values()].map(finish);
    const isDir = kids.length > 0 || (!t.fromFiles && !looksLikeFile(t.path));
    kids.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    let out: RepoTreeNode = {
      name: t.name,
      path: t.path,
      kind: isDir ? "dir" : "file",
      ...(t.nodeId !== undefined ? { nodeId: t.nodeId } : {}),
      ...(kids.length ? { children: kids } : {}),
    };
    // Compact single-child directory chains without their own node ("src/components").
    while (
      out.kind === "dir" &&
      out.nodeId === undefined &&
      out.children?.length === 1 &&
      out.children[0]!.kind === "dir"
    ) {
      const only = out.children[0]!;
      out = { ...only, name: `${out.name}/${only.name}` };
    }
    return out;
  };
  return [...root.children.values()]
    .map(finish)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// neighbours (inspector "Links" section)

export type NodeLink = { nodeId: string; name: string; type: string; label?: string; kind?: string };

export function linksFor(arch: Architecture, nodeId: string): { incoming: NodeLink[]; outgoing: NodeLink[] } {
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const link = (otherId: string, e: ArchEdge): NodeLink => {
    const other = byId.get(otherId);
    return {
      nodeId: otherId,
      name: other?.name ?? otherId,
      type: other?.type ?? "",
      ...(e.label !== undefined ? { label: e.label } : {}),
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
    };
  };
  return {
    incoming: arch.edges.filter((e) => e.to === nodeId).map((e) => link(e.from, e)),
    outgoing: arch.edges.filter((e) => e.from === nodeId).map((e) => link(e.to, e)),
  };
}

export function workflowsFor(arch: Architecture, nodeId: string): Workflow[] {
  return arch.workflows.filter((w) => w.steps.includes(nodeId));
}
