import type { Architecture, ArchNode } from "./contract/index.js";
import type {
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  Graph,
  NodeKind,
} from "./graphTypes.js";

// CONTRACTS.md §1.3 — pure mapper from the wire Architecture onto the viewer
// graph model. No layout engine: x/y come from the file (the daemon fills
// them); a deterministic fallback grid keeps hand-written files usable.

const NODE_W = 200;
const NODE_H = 64;
const GROUP_PAD = 24;

function kindOf(type: string): NodeKind {
  switch (type) {
    case "datastore":
      return "database";
    case "service":
    case "queue":
    case "external":
    case "frontend":
    case "gateway":
    case "module":
    case "file":
    case "step":
      return type;
    default:
      return "module";
  }
}

function fallbackLayout(nodes: ArchNode[]): void {
  const columnOfType = (type: string): number =>
    type === "frontend" || type === "external" ? 0
    : type === "gateway" ? 1
    : type === "datastore" || type === "queue" ? 3 : 2;
  const rows = [0, 0, 0, 0];
  for (const node of nodes) {
    if (node.x !== undefined && node.y !== undefined) continue;
    const column = columnOfType(node.type);
    const row = rows[column] ?? 0;
    rows[column] = row + 1;
    node.x = column * 260;
    node.y = row * 110;
  }
}

function subtitleOf(node: ArchNode): string | undefined {
  if (node.tech !== undefined && node.tech.length > 0) {
    return node.tech.slice(0, 2).join(" · ");
  }
  return node.path;
}

export function toGraph(architecture: Architecture, parentId: string | null): Graph {
  const atLevel = architecture.nodes.filter((n) =>
    parentId === null ? n.parent === undefined : n.parent === parentId,
  );
  const laid = [...atLevel];
  fallbackLayout(laid);

  const childrenOf = new Map<string, number>();
  for (const node of architecture.nodes) {
    if (node.parent !== undefined) {
      childrenOf.set(node.parent, (childrenOf.get(node.parent) ?? 0) + 1);
    }
  }
  const idsAtLevel = new Set(atLevel.map((n) => n.id));

  const nodes: DiagramNode[] = atLevel.map((node) => ({
    id: node.id,
    label: node.name,
    kind: kindOf(node.type),
    x: node.x ?? 0,
    y: node.y ?? 0,
    drill: (childrenOf.get(node.id) ?? 0) > 0,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.notes !== undefined ? { notes: node.notes } : {}),
    ...(node.tech !== undefined ? { tech: node.tech } : {}),
    ...(node.layer !== undefined ? { layer: node.layer } : {}),
    ...(subtitleOf(node) !== undefined ? { subtitle: subtitleOf(node) } : {}),
  }));

  const edges: DiagramEdge[] = architecture.edges
    .filter((e) => idsAtLevel.has(e.from) && idsAtLevel.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.label !== undefined ? { label: e.label } : {}),
      animated: e.kind === "async" || e.kind === "event",
    }));

  const groups: Graph["groups"] = [];
  if (architecture.layers !== undefined) {
    for (const layer of architecture.layers) {
      const members = nodes.filter((n) => n.layer === layer);
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((n) => n.x)) - GROUP_PAD;
      const minY = Math.min(...members.map((n) => n.y)) - GROUP_PAD;
      const maxX = Math.max(...members.map((n) => n.x + (n.w ?? NODE_W))) + GROUP_PAD;
      const maxY = Math.max(...members.map((n) => n.y + (n.h ?? NODE_H))) + GROUP_PAD;
      groups.push({ id: layer, label: layer, x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }
  }

  return {
    id: parentId ?? "root",
    title: parentId === null ? architecture.name : architecture.nodes.find((n) => n.id === parentId)?.name ?? parentId,
    subtitle: "",
    nodes,
    edges,
    ...(groups.length > 0 ? { groups } : {}),
  };
}

export function workflowGraph(architecture: Architecture, workflowId: string): Graph {
  const wf = architecture.workflows.find((w) => w.id === workflowId);
  const byId = new Map(architecture.nodes.map((n) => [n.id, n]));
  const steps = (wf?.steps ?? [])
    .map((id) => byId.get(id))
    .filter((n): n is ArchNode => n !== undefined);
  const nodes: DiagramNode[] = steps.map((node, i) => ({
    id: node.id,
    label: node.name,
    kind: kindOf(node.type),
    x: (i % 4) * 260,
    y: Math.floor(i / 4) * 110,
    drill: false,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.tech !== undefined ? { tech: node.tech } : {}),
    ...(node.path !== undefined ? { subtitle: node.path } : {}),
  }));
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) continue;
    edges.push({ from: a.id, to: b.id, animated: true });
  }
  const groups: DiagramGroup[] = [];
  if (architecture.layers !== undefined) {
    for (const layer of architecture.layers) {
      const members = nodes.filter((n) => n.layer === layer);
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((n) => n.x)) - GROUP_PAD;
      const minY = Math.min(...members.map((n) => n.y)) - GROUP_PAD;
      const maxX = Math.max(...members.map((n) => n.x + NODE_W)) + GROUP_PAD;
      const maxY = Math.max(...members.map((n) => n.y + NODE_H)) + GROUP_PAD;
      groups.push({ id: layer, label: layer, x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }
  }
  return {
    id: `workflow-${workflowId}`,
    title: wf?.name ?? workflowId,
    subtitle: wf?.description ?? "",
    nodes,
    edges,
    ...(groups.length > 0 ? { groups } : {}),
  };
}
