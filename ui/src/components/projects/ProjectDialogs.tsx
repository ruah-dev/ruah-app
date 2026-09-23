// "Open folder…" (browser fallback: a path field) and "New project…" (§5.3 POST
// /api/projects/create). The desktop app opens a native folder picker instead of the first.
import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createProject } from "@/lib/daemon";
import { prettyPath } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { canManageProjects, useProjectActions } from "./useProjectActions";

const dialogClass = "w-[calc(100vw-2rem)] max-w-md gap-0 rounded-2xl border-hairline bg-popover p-0";
const fieldClass =
  "h-9 rounded-lg border-hairline bg-surface-2 text-ui shadow-none focus-visible:ring-1 md:text-ui";

function parentOf(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i > 0 ? trimmed.slice(0, i) : trimmed;
}

export function OpenFolderDialog() {
  const wb = useWorkbench();
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = canManageProjects(daemon);

  useEffect(() => {
    if (wb.openFolderOpen) setPath("");
  }, [wb.openFolderOpen]);

  const submit = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    const ok = await actions.open(path.trim());
    setBusy(false);
    if (ok) wb.setOpenFolderOpen(false);
  };

  return (
    <Dialog open={wb.openFolderOpen} onOpenChange={wb.setOpenFolderOpen}>
      <DialogContent className={dialogClass}>
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle className="text-title font-semibold">Open folder</DialogTitle>
          <DialogDescription className="text-ui-sm">
            A repo folder on the machine running Ruah. Without an architecture.json it is scanned
            first.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2 px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor="open-path" className="text-label text-muted-foreground">
            Absolute path
          </Label>
          <Input
            id="open-path"
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/code/my-repo"
            spellCheck={false}
            className={cn(fieldClass, "font-mono")}
          />
          {!connected ? (
            <p className="text-meta text-warn">No daemon connected — opening needs the Ruah app.</p>
          ) : null}
        </form>
        <DialogFooter className="gap-2 border-t border-hairline px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-ui-sm"
            onClick={() => wb.setOpenFolderOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-lg text-ui-sm"
            disabled={!path.trim() || busy || !connected}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NAME_RE = /^[^\\/:*?"<>|]+$/;

export function NewProjectDialog() {
  const wb = useWorkbench();
  const { daemon } = useWorkspace();
  const connected = canManageProjects(daemon);
  const defaultParent = useMemo(() => {
    const last = daemon.project?.root ?? daemon.recentProjects[0]?.root;
    return last ? parentOf(last) : "";
  }, [daemon.project?.root, daemon.recentProjects]);

  const [name, setName] = useState("");
  const [parent, setParent] = useState(defaultParent);
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wb.newProjectOpen) return;
    setName("");
    setParent(defaultParent);
    setGit(true);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wb.newProjectOpen]);

  const trimmed = name.trim();
  const nameError =
    trimmed && (!NAME_RE.test(trimmed) || trimmed.startsWith(".")) ? "Use a plain folder name." : null;
  const valid = !!trimmed && !nameError && !!parent.trim() && connected;
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      wb.setLauncherOpen(false);
      await createProject({ parentDir: parent.trim(), name: trimmed, git });
      wb.setNewProjectOpen(false);
      toast.success(`Created ${trimmed}`, {
        description: "An empty map — add your first element from the palette.",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={wb.newProjectOpen} onOpenChange={wb.setNewProjectOpen}>
      <DialogContent className={dialogClass}>
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle className="text-title font-semibold">New project</DialogTitle>
          <DialogDescription className="text-ui-sm">
            Creates a folder with an empty architecture.json and opens it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="np-name" className="text-label text-muted-foreground">
              Name
            </Label>
            <Input
              id="np-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="payments-platform"
              spellCheck={false}
              className={fieldClass}
            />
            {nameError ? <p className="text-meta text-bad">{nameError}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-parent" className="text-label text-muted-foreground">
              Parent folder
            </Label>
            <div className="flex gap-2">
              <Input
                id="np-parent"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                placeholder="/Users/you/code"
                spellCheck={false}
                className={cn(fieldClass, "font-mono")}
              />
              {bridge ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 gap-1.5 rounded-lg border-hairline bg-surface-2 text-ui-sm shadow-none"
                  onClick={async () => {
                    const p = await bridge.pickFolder({ title: "Choose the parent folder" }).catch(() => null);
                    if (p) setParent(p);
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  Choose…
                </Button>
              ) : null}
            </div>
            {trimmed && parent.trim() ? (
              <p className="truncate font-mono text-meta text-muted-foreground" title={`${parent.trim()}/${trimmed}`}>
                {prettyPath(`${parent.trim().replace(/[\\/]+$/, "")}/${trimmed}`)}
              </p>
            ) : null}
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 text-ui">
            <Checkbox checked={git} onCheckedChange={(v) => setGit(v === true)} className="size-4 rounded-[4px]" />
            Initialize a git repository
          </label>
          {error ? (
            <p className="rounded-lg bg-bad/10 px-3 py-2 text-ui-sm text-bad">{error}</p>
          ) : null}
          {!connected ? (
            <p className="text-meta text-warn">No daemon connected — creating needs the Ruah app.</p>
          ) : null}
          <button type="submit" className="hidden" />
        </form>
        <DialogFooter className="gap-2 border-t border-hairline px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-ui-sm"
            onClick={() => wb.setNewProjectOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-lg text-ui-sm"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
