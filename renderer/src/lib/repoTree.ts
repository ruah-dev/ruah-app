import type { Architecture } from "./contract/index.js";
import type { RepoTreeNode } from "./graphTypes.js";

// CONTRACTS.md §1.3 — tree derived from every `path` and `files[]` value;
// leaves carry the owning node id so a click selects that node.

type DirNode = { name: string; kind: "dir"; children: RepoTreeNode[] };

function ensureDir(children: RepoTreeNode[], name: string): DirNode {
  const existing = children.find((c) => c.kind === "dir" && c.name === name);
  if (existing !== undefined) return existing as DirNode;
  const created: DirNode = { name, kind: "dir", children: [] };
  children.push(created);
  return created;
}

function addFile(children: RepoTreeNode[], segments: string[], nodeId: string): void {
  const head = segments[0];
  if (head === undefined) return;
  if (segments.length === 1) {
    if (!children.some((c) => c.kind === "file" && c.name === head)) {
      children.push({ name: head, kind: "file", nodeId });
    }
    return;
  }
  const dir = ensureDir(children, head);
  addFile(dir.children, segments.slice(1), nodeId);
}

function sortTree(nodes: RepoTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === "dir" && node.children !== undefined) sortTree(node.children);
  }
}

export function toRepoTree(architecture: Architecture): RepoTreeNode[] {
  const root: RepoTreeNode[] = [];
  for (const node of architecture.nodes) {
    if (node.path !== undefined) addFile(root, node.path.split("/"), node.id);
    for (const file of node.files ?? []) addFile(root, file.split("/"), node.id);
  }
  sortTree(root);
  return root;
}
