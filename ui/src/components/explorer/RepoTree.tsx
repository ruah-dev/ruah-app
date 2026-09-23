// Repo paths from architecture.json as a tree. The visible rows are flattened and windowed, so
// large repos stay cheap to render.
import { useMemo, useState } from "react";
import { ChevronRight, FileCode2, Folder } from "lucide-react";
import type { RepoTreeNode } from "@/lib/architecture";
import { VirtualList } from "@/components/common/VirtualList";
import { cn } from "@/lib/utils";

type Props = {
  onOpen: (nodeId: string, path: string) => void;
  activeNodeId: string | null;
};

type Row = { node: RepoTreeNode; depth: number };

const ROW_H = 26;

function initialOpen(tree: RepoTreeNode[]): Set<string> {
  // Top level starts expanded (as before).
  return new Set(tree.filter((n) => n.children?.length).map((n) => n.path));
}

export function RepoTree({
  tree,
  onOpen,
  activeNodeId,
  className,
}: Props & { tree: RepoTreeNode[]; className?: string }) {
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(tree));

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: RepoTreeNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth });
        if (node.children?.length && open.has(node.path)) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, open]);

  if (tree.length === 0) {
    return (
      <p className="px-2 text-label text-faint">No paths in architecture.json yet.</p>
    );
  }

  return (
    <VirtualList
      items={rows}
      itemHeight={ROW_H}
      getKey={(r) => r.node.path}
      className={cn("max-h-[min(50vh,480px)]", className)}
      renderItem={({ node, depth }) => {
        const hasChildren = !!node.children?.length;
        const isOpen = open.has(node.path);
        const isActive = !!node.nodeId && node.nodeId === activeNodeId;
        return (
          <button
            type="button"
            title={node.path}
            aria-expanded={hasChildren ? isOpen : undefined}
            onClick={() => {
              if (hasChildren)
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
              if (node.nodeId) onOpen(node.nodeId, node.path);
            }}
            style={{ paddingLeft: 6 + depth * 12 }}
            className={cn(
              "flex h-6.5 w-full items-center gap-1.5 rounded-md pr-2 text-left font-mono text-meta transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
            )}
          >
            {hasChildren ? (
              <ChevronRight
                className={cn("size-3 shrink-0 opacity-70 transition-transform", isOpen && "rotate-90")}
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
        );
      }}
    />
  );
}
