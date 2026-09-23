import { useState } from "react";
import { ChevronRight, FileCode2, Folder } from "lucide-react";
import type { RepoTreeNode } from "@/lib/architecture";
import { cn } from "@/lib/utils";

type Props = {
  onOpen: (nodeId: string, path: string) => void;
  activeNodeId: string | null;
};

function TreeRow({
  node,
  depth,
  onOpen,
  activeNodeId,
}: Props & { node: RepoTreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = !!node.children?.length;
  const isActive = !!node.nodeId && node.nodeId === activeNodeId;

  return (
    <div>
      <button
        type="button"
        title={node.path}
        onClick={() => {
          if (hasChildren) setOpen((o) => !o);
          if (node.nodeId) onOpen(node.nodeId, node.path);
        }}
        style={{ paddingLeft: 6 + depth * 12 }}
        className={cn(
          "flex h-6.5 w-full items-center gap-1.5 rounded-md pr-2 text-left font-mono text-[11.5px] transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        )}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn("size-3 shrink-0 opacity-70 transition-transform", open && "rotate-90")}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {node.kind === "dir" ? (
          <Folder className="size-3.5 shrink-0 opacity-70" />
        ) : (
          <FileCode2 className="size-3.5 shrink-0 opacity-70" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {open && hasChildren
        ? node.children!.map((child) => (
            <TreeRow
              key={child.path}
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

export function RepoTree({
  tree,
  onOpen,
  activeNodeId,
}: Props & { tree: RepoTreeNode[] }) {
  return (
    <div className="min-h-0">
      {tree.length === 0 ? (
        <p className="px-2 text-[12px] text-muted-foreground/70">
          No paths in architecture.json yet.
        </p>
      ) : null}
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          onOpen={onOpen}
          activeNodeId={activeNodeId}
        />
      ))}
    </div>
  );
}
