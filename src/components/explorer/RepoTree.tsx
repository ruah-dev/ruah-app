import { useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Folder, GitBranch } from "lucide-react";
import { repoTree, type RepoTreeNode } from "@/data/graphs";
import { cn } from "@/lib/utils";

type Props = {
  onOpen: (graphId: string, nodeId: string) => void;
  activeNodeId: string | null;
};

function TreeRow({ node, depth, onOpen, activeNodeId }: Props & { node: RepoTreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = !!node.children?.length;
  const isActive = !!node.nodeId && node.nodeId === activeNodeId;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (hasChildren) setOpen((o) => !o);
          if (node.graphId && node.nodeId) onOpen(node.graphId, node.nodeId);
        }}
        style={{ paddingLeft: 6 + depth * 12 }}
        className={cn(
          "relative mx-1 flex h-7 w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-[4px] pr-2 text-left font-mono text-[11px] transition-colors duration-150",
          isActive ? "bg-surface-3 text-foreground before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-primary" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
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
          <Folder className="size-3.5 shrink-0 text-node-step" />
        ) : (
          <FileCode2 className="size-3.5 shrink-0 text-node-file" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {open && hasChildren
        ? node.children!.map((child) => (
            <TreeRow
              key={child.name}
              node={child}
              depth={depth + 1}
              onOpen={onOpen}
              activeNodeId={activeNodeId}
            />
          ))
        : null}
    </div>
  );
}

export function RepoTree({ onOpen, activeNodeId }: Props) {
  return (
    <div className="min-h-0">
      <div className="flex h-8 items-center gap-1.5 px-3 text-[10px] font-semibold text-muted-foreground uppercase">
        <GitBranch className="size-3" />
        acme/platform · main
      </div>
      {repoTree.map((node) => (
        <TreeRow
          key={node.name}
          node={node}
          depth={0}
          onOpen={onOpen}
          activeNodeId={activeNodeId}
        />
      ))}
    </div>
  );
}
