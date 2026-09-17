import * as path from "node:path";
import type { Architecture, ArchNode, Workflow } from "../contracts/architecture.js";

export interface WorkflowMembership {
  workflow: Workflow;
  index: number; // 0-based
  prev: ArchNode | undefined;
  next: ArchNode | undefined;
}

// CONTRACTS.md §3 rule 1: newlines become one space, runs of whitespace
// collapse, trim. Used for name/description/notes/label.
export function collapse(text: string): string {
  return text.replaceAll("\n", " ").replace(/\s+/g, " ").trim();
}

export class ArchIndex {
  readonly arch: Architecture;
  readonly root: string; // absolute repo dir

  private readonly byIdMap: Map<string, ArchNode>;
  private readonly childrenMap: Map<string, ArchNode[]>;
  private readonly incomingMap: Map<string, ArchEdgeRef[]>;
  private readonly outgoingMap: Map<string, ArchEdgeRef[]>;

  constructor(arch: Architecture, root: string) {
    this.arch = arch;
    this.root = root;
    this.byIdMap = new Map(arch.nodes.map((n) => [n.id, n]));
    this.childrenMap = new Map();
    for (const node of arch.nodes) {
      if (node.parent === undefined) continue;
      let list = this.childrenMap.get(node.parent);
      if (list === undefined) {
        list = [];
        this.childrenMap.set(node.parent, list);
      }
      list.push(node);
    }
    this.incomingMap = new Map();
    this.outgoingMap = new Map();
    for (const edge of arch.edges) {
      let out = this.outgoingMap.get(edge.from);
      if (out === undefined) {
        out = [];
        this.outgoingMap.set(edge.from, out);
      }
      out.push({
        from: edge.from,
        to: edge.to,
        ...(edge.label !== undefined ? { label: edge.label } : {}),
        ...(edge.kind !== undefined ? { kind: edge.kind } : {}),
      });
      let inc = this.incomingMap.get(edge.to);
      if (inc === undefined) {
        inc = [];
        this.incomingMap.set(edge.to, inc);
      }
      inc.push(edge);
    }
  }

  byId(id: string): ArchNode | undefined {
    return this.byIdMap.get(id);
  }

  children(id: string): ArchNode[] {
    return this.childrenMap.get(id) ?? [];
  }

  incoming(id: string): ArchEdgeRef[] {
    return this.incomingMap.get(id) ?? [];
  }

  outgoing(id: string): ArchEdgeRef[] {
    return this.outgoingMap.get(id) ?? [];
  }

  // §3 rule 6: unique connected nodes, first-seen order over incoming then
  // outgoing.
  neighbors(id: string): ArchNode[] {
    const out: ArchNode[] = [];
    const seen = new Set<string>();
    for (const edge of [...this.incomingMap.get(id) ?? [], ...this.outgoingMap.get(id) ?? []]) {
      const otherId = edge.from === id ? edge.to : edge.from;
      if (otherId === id || seen.has(otherId)) continue;
      const other = this.byIdMap.get(otherId);
      if (other === undefined) continue;
      seen.add(otherId);
      out.push(other);
    }
    return out;
  }

  // §3 rule 7: every workflow whose steps contain the node, in file order,
  // with 0-based step index.
  workflowsOf(id: string): WorkflowMembership[] {
    const out: WorkflowMembership[] = [];
    for (const workflow of this.arch.workflows) {
      const index = workflow.steps.indexOf(id);
      if (index === -1) continue;
      out.push({
        workflow,
        index,
        prev: this.byId(workflow.steps[index - 1] ?? ""),
        next: this.byId(workflow.steps[index + 1] ?? ""),
      });
    }
    return out;
  }

  toAbs(rel: string): string {
    return path.resolve(this.root, rel);
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs).replaceAll("\\", "/");
  }
}

export interface ArchEdgeRef {
  from: string;
  to: string;
  label?: string | undefined;
  kind?: string | undefined;
}
