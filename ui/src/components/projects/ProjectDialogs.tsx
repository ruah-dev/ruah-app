// "Open folder…" (browser fallback: a path field) and "New project…" (the §20 wizard). The
// desktop app opens a native folder picker instead of the first.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { Button } from "@/components/ui/button";
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

// "New project…" is the wizard (§20): ./NewProjectWizard.tsx.
export { NewProjectWizard as NewProjectDialog } from "./NewProjectWizard";
