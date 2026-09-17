import { useState } from "react";
import { ChevronDown, ChevronRight, FileCode, Folder, GitBranch } from "lucide-react";
import type { RepoTreeNode } from "../lib/graphTypes.js";
import { cn } from "../lib/cn.js";

function TreeRow({
  node,
  depth,
  activeNodeId,
  onOpenNode,
}: {
  node: RepoTreeNode;
  depth: number;
  activeNodeId: string | null;
  onOpenNode: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isActive = node.nodeId !== undefined && node.nodeId === activeNodeId;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (hasChildren) setOpen((o) => !o);
          if (node.nodeId !== undefined) onOpenNode(node.nodeId);
        }}
        style={{ paddingLeft: 6 + depth * 12 }}
        className={cn(
          "mono relative mx-1 flex h-7 w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-[4px] pr-2 text-left text-[11px] transition-colors duration-150",
          isActive
            ? "text-[var(--foreground)] before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-[var(--accent)]"
            : "cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
        )}
      >
        {hasChildren ? (
          open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {node.kind === "dir" ? (
          <Folder className="size-3.5 shrink-0" style={{ color: "var(--node-step)" }} />
        ) : (
          <FileCode className="size-3.5 shrink-0" style={{ color: "var(--node-file)" }} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {open && hasChildren
        ? (node.children ?? []).map((child) => (
            <TreeRow key={`${child.kind}:${child.name}`} node={child} depth={depth + 1} activeNodeId={activeNodeId} onOpenNode={onOpenNode} />
          ))
        : null}
    </div>
  );
}

export function RepoTreeView({
  tree,
  repoName,
  activeNodeId,
  onOpenNode,
}: {
  tree: RepoTreeNode[];
  repoName: string;
  activeNodeId: string | null;
  onOpenNode: (nodeId: string) => void;
}) {
  return (
    <div className="min-h-0">
      <div
        className="mono flex h-8 items-center gap-1.5 px-3 text-[10px] font-semibold uppercase"
        style={{ color: "var(--muted-foreground)" }}
      >
        <GitBranch className="size-3" />
        <span className="truncate">{repoName}</span>
      </div>
      <div className="scroll-thin max-h-[38%] overflow-auto pb-2">
        {tree.length === 0 ? (
          <p className="mono px-3 py-1 text-[10.5px]" style={{ color: "var(--muted-foreground)" }}>
            no paths in the map
          </p>
        ) : (
          tree.map((node) => (
            <TreeRow key={`${node.kind}:${node.name}`} node={node} depth={0} activeNodeId={activeNodeId} onOpenNode={onOpenNode} />
          ))
        )}
      </div>
    </div>
  );
}
