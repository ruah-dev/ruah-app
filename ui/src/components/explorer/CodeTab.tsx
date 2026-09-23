import { useEffect, useState } from "react";
import type { DiagramNode } from "@/data/graphs";
import { codeFilesOf } from "@/lib/architecture";
import { fetchFile, type FileResult } from "@/lib/daemon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodePreview } from "./CodePreview";

/** L5: Code tab backed by GET /api/file?path= (sample snippets when no daemon is connected). */
export function CodeTab({
  node,
  repo,
  root,
  preferredPath,
  onDrill,
}: {
  node: DiagramNode;
  repo: string;
  root: string | null;
  preferredPath?: string | null | undefined;
  onDrill: () => void;
}) {
  const files = codeFilesOf({
    ...(node.path !== undefined ? { path: node.path } : {}),
    ...(node.filePaths !== undefined ? { files: node.filePaths } : {}),
  });
  const initial =
    preferredPath && files.includes(preferredPath) ? preferredPath : (files[0] ?? null);
  const [path, setPath] = useState<string | null>(initial);
  const [result, setResult] = useState<FileResult | null>(null);

  useEffect(() => {
    setPath(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, preferredPath, files.join("\n")]);

  useEffect(() => {
    if (!path) return;
    let live = true;
    setResult(null);
    void fetchFile(path).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [path]);

  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="heading text-title text-foreground">No file attached</p>
        <p className="text-[12.5px] text-muted-foreground">
          Add paths to <span className="font-mono">files</span> in architecture.json, or drill in to
          a child element.
        </p>
        {node.drill ? (
          <Button variant="ghost" size="sm" className="mt-1 h-7 text-[12px]" onClick={onDrill}>
            Open level
          </Button>
        ) : null}
      </div>
    );
  }

  const fileSwitcher =
    files.length > 1 ? (
      <Select value={path} onValueChange={setPath}>
        <SelectTrigger className="h-7 w-auto max-w-[75%] min-w-0 gap-1.5 rounded-md border-0 bg-transparent px-2 font-mono text-[12px] text-foreground/90 shadow-none hover:bg-accent focus:ring-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-lg border-hairline">
          {files.map((f) => (
            <SelectItem key={f} value={f} className="font-mono text-[12px]">
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {result === null ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ) : result.ok ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodePreview
            pathSlot={fileSwitcher}
            file={{ repo, branch: "", path: result.path, lang: result.lang, code: result.content }}
            href={root ? `vscode://file/${root.replace(/\/+$/, "")}/${result.path}` : undefined}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          {fileSwitcher ? <div className="mb-2">{fileSwitcher}</div> : null}
          <p className="text-[12px] text-foreground">
            {result.status === 404 ? "File not found in the repo" : "Cannot show this file"}
          </p>
          <p className="font-mono text-[11px] break-all text-muted-foreground">{path}</p>
          <p className="text-[11px] text-muted-foreground">{result.message}</p>
        </div>
      )}
    </div>
  );
}
