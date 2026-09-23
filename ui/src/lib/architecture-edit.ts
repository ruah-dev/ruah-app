// Editor operations expressed directly on architecture.json (L7). Each function
// returns a new Architecture (or null when the edit is not allowed) and only
// touches the fields it changes, so everything the editor does not know about
// (files, notes, layer, unknown node types, generatedBy, ...) survives a save.
import type { Architecture, ArchEdge, ArchNode } from "./contracts";
import type { DiagramNode, NodeKind } from "@/data/graphs";
import { ORIGIN, isFlowType, parseDiagramId, typeFor } from "./architecture";

// Same rule as the daemon (src/contracts/validate.ts): multi-repo systems
// namespace ids as "<repoId>:<nodeId>".
const ID_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,63}$/;

export function slugId(base: string, taken: Set<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "")
      .slice(0, 48) || "node";
  let id = slug;
  for (let i = 2; taken.has(id); i++) id = `${slug}-${i}`;
  return id;
}

const nodeIds = (arch: Architecture) => new Set(arch.nodes.map((n) => n.id));

function withNode(arch: Architecture, id: string, fn: (n: ArchNode) => ArchNode): Architecture {
  return { ...arch, nodes: arch.nodes.map((n) => (n.id === id ? fn(n) : n)) };
}

function setOpt<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  value: T[K] | undefined | "",
): T {
  const next = { ...obj };
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))
    delete next[key];
  else next[key] = value;
  return next;
}

export type NodePatch = Partial<
  Pick<DiagramNode, "label" | "kind" | "x" | "y" | "description" | "notes" | "tech" | "path">
>;

/** Apply an editor patch to one node. x/y only apply on architecture levels. */
export function patchNode(
  arch: Architecture,
  diagramId: string,
  nodeId: string,
  patch: NodePatch,
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  const current = arch.nodes.find((n) => n.id === nodeId);
  if (!ref || !current) return null;
  const next = withNode(arch, nodeId, (n) => {
    let next: ArchNode = { ...n };
    if (patch.label !== undefined && patch.label.trim()) next.name = patch.label;
    if (patch.kind !== undefined) next.type = typeFor(patch.kind);
    if (ref.mode === "architecture") {
      if (patch.x !== undefined) next.x = Math.round(patch.x - ORIGIN);
      if (patch.y !== undefined) next.y = Math.round(patch.y - ORIGIN);
    }
    if ("description" in patch) next = setOpt(next, "description", patch.description);
    if ("notes" in patch) next = setOpt(next, "notes", patch.notes);
    if ("tech" in patch) next = setOpt(next, "tech", patch.tech);
    if ("path" in patch)
      next = setOpt(next, "path", patch.path?.trim().replace(/^\.\//, "").replace(/\/+$/, ""));
    return next;
  });
  const updated = next.nodes.find((n) => n.id === nodeId);
  return JSON.stringify(updated) === JSON.stringify(current) ? null : next;
}

/** Add a node on a diagram. Architecture level: child of that level. Workflow: appended step. */
export function addNode(
  arch: Architecture,
  diagramId: string,
  node: DiagramNode,
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref) return null;
  const taken = nodeIds(arch);
  const id = ID_PATTERN.test(node.id) && !taken.has(node.id) ? node.id : slugId(node.label, taken);
  const created: ArchNode = { id, type: typeFor(node.kind), name: node.label };
  if (ref.mode === "architecture") {
    if (ref.parentId !== null) created.parent = ref.parentId;
    created.x = Math.round(node.x - ORIGIN);
    created.y = Math.round(node.y - ORIGIN);
    return { ...arch, nodes: [...arch.nodes, created] };
  }
  const wf = arch.workflows.find((w) => w.id === ref.workflowId);
  if (!wf) return null;
  return {
    ...arch,
    nodes: [...arch.nodes, created],
    workflows: arch.workflows.map((w) => (w.id === wf.id ? { ...w, steps: [...w.steps, id] } : w)),
  };
}

function removeNodes(arch: Architecture, ids: Set<string>): Architecture {
  return {
    ...arch,
    nodes: arch.nodes.filter((n) => !ids.has(n.id)),
    edges: arch.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
    workflows: arch.workflows
      .map((w) => ({ ...w, steps: w.steps.filter((s) => !ids.has(s)) }))
      .filter((w) => w.steps.length >= 2),
  };
}

/** Architecture level: delete the node and everything nested under it. Workflow: drop the step
 * (and the node itself when it is a step node nothing else uses). */
export function deleteNode(
  arch: Architecture,
  diagramId: string,
  nodeId: string,
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref) return null;
  if (ref.mode === "architecture") {
    const doomed = new Set([nodeId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of arch.nodes) {
        if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
    return removeNodes(arch, doomed);
  }
  const wf = arch.workflows.find((w) => w.id === ref.workflowId);
  if (!wf) return null;
  const steps = wf.steps.filter((s) => s !== nodeId);
  if (steps.length < 2) return null;
  let next: Architecture = {
    ...arch,
    workflows: arch.workflows.map((w) => (w.id === wf.id ? { ...w, steps } : w)),
  };
  const node = arch.nodes.find((n) => n.id === nodeId);
  const usedElsewhere =
    next.workflows.some((w) => w.steps.includes(nodeId)) ||
    arch.edges.some((e) => e.from === nodeId || e.to === nodeId) ||
    arch.nodes.some((n) => n.parent === nodeId);
  if (node && isFlowType(node.type) && !usedElsewhere) next = removeNodes(next, new Set([nodeId]));
  return next;
}

export function addEdge(
  arch: Architecture,
  diagramId: string,
  from: string,
  to: string,
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref || from === to) return null;
  if (ref.mode === "architecture") {
    if (arch.edges.some((e) => e.from === from && e.to === to && e.label === undefined))
      return null;
    // Drawn by hand: re-scans replace only source "scan" edges, so this one survives.
    return { ...arch, edges: [...arch.edges, { from, to, kind: "sync", source: "manual" }] };
  }
  const wf = arch.workflows.find((w) => w.id === ref.workflowId);
  if (!wf) return null;
  const i = wf.steps.indexOf(from);
  if (i === -1 || wf.steps[i + 1] === to) return null;
  const steps = [...wf.steps.slice(0, i + 1), to, ...wf.steps.slice(i + 1)];
  return { ...arch, workflows: arch.workflows.map((w) => (w.id === wf.id ? { ...w, steps } : w)) };
}

export function patchEdge(
  arch: Architecture,
  diagramId: string,
  from: string,
  to: string,
  patch: { label?: string; animated?: boolean },
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref || ref.mode !== "architecture") return null; // workflow arrows are derived from steps
  const idx = arch.edges.findIndex((e) => e.from === from && e.to === to);
  if (idx === -1) return null;
  const edges = arch.edges.map((e, i): ArchEdge => {
    if (i !== idx) return e;
    // An edited scan edge becomes the user's: re-scans would otherwise overwrite the edit.
    let next: ArchEdge = { ...e, ...(e.source === "scan" ? { source: "manual" } : {}) };
    if ("label" in patch) next = setOpt(next, "label", patch.label?.slice(0, 40));
    if (patch.animated !== undefined) {
      const flowing = next.kind === "async" || next.kind === "event";
      if (patch.animated && !flowing) next.kind = "async";
      if (!patch.animated && flowing) next.kind = "sync";
    }
    return next;
  });
  return { ...arch, edges };
}

export function deleteEdge(
  arch: Architecture,
  diagramId: string,
  from: string,
  to: string,
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref) return null;
  if (ref.mode === "architecture") {
    const idx = arch.edges.findIndex((e) => e.from === from && e.to === to);
    if (idx === -1) return null;
    return { ...arch, edges: arch.edges.filter((_, i) => i !== idx) };
  }
  const wf = arch.workflows.find((w) => w.id === ref.workflowId);
  if (!wf) return null;
  const i = wf.steps.findIndex((s, k) => s === from && wf.steps[k + 1] === to);
  if (i === -1) return null;
  const steps = wf.steps.filter((_, k) => k !== i + 1);
  if (steps.length < 2) return null;
  return { ...arch, workflows: arch.workflows.map((w) => (w.id === wf.id ? { ...w, steps } : w)) };
}

/** Rename a diagram: top level -> architecture name, drill level -> its node, workflow -> workflow. */
export function patchDiagram(
  arch: Architecture,
  diagramId: string,
  patch: { title?: string; subtitle?: string },
): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref) return null;
  const title = patch.title?.trim();
  if (ref.mode === "workflow") {
    return {
      ...arch,
      workflows: arch.workflows.map((w) => {
        if (w.id !== ref.workflowId) return w;
        let next = { ...w, ...(title ? { name: title } : {}) };
        if ("subtitle" in patch) next = setOpt(next, "description", patch.subtitle);
        return next;
      }),
    };
  }
  if (!title) return null;
  if (ref.parentId === null) return { ...arch, name: title };
  return withNode(arch, ref.parentId, (n) => ({ ...n, name: title }));
}

/** New architecture diagram = a new top-level container with one element inside. */
export function addArchitectureDiagram(
  arch: Architecture,
  kind: NodeKind = "service",
): { arch: Architecture; parentId: string } {
  const taken = nodeIds(arch);
  const parentId = slugId("new-area", taken);
  taken.add(parentId);
  const childId = slugId(`new-${kind}`, taken);
  const maxY = Math.max(0, ...arch.nodes.filter((n) => !n.parent).map((n) => (n.y ?? 0) + 110));
  return {
    parentId,
    arch: {
      ...arch,
      nodes: [
        ...arch.nodes,
        { id: parentId, type: "module", name: "New area", x: 0, y: maxY },
        { id: childId, type: typeFor(kind), name: `New ${kind}`, parent: parentId, x: 0, y: 0 },
      ],
    },
  };
}

/** New workflow = two fresh step nodes (validation needs >= 2 steps). */
export function addWorkflow(
  arch: Architecture,
  index: number,
): { arch: Architecture; workflowId: string } {
  const taken = nodeIds(arch);
  const start = slugId(`step-start-${index}`, taken);
  taken.add(start);
  const end = slugId(`step-finish-${index}`, taken);
  const wfIds = new Set(arch.workflows.map((w) => w.id));
  const workflowId = slugId(`workflow-${index}`, wfIds);
  return {
    workflowId,
    arch: {
      ...arch,
      nodes: [
        ...arch.nodes,
        { id: start, type: "step", name: "Start" },
        { id: end, type: "step", name: "Finish" },
      ],
      workflows: [
        ...arch.workflows,
        { id: workflowId, name: `Workflow ${index}`, steps: [start, end] },
      ],
    },
  };
}

export function deleteWorkflow(arch: Architecture, diagramId: string): Architecture | null {
  const ref = parseDiagramId(diagramId);
  if (!ref || ref.mode !== "workflow") return null;
  return { ...arch, workflows: arch.workflows.filter((w) => w.id !== ref.workflowId) };
}
