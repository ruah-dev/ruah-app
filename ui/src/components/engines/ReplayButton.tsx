// Replay one assistant turn with ruah-watch. Opens an in-app frame, or reveals the file.
import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { engineUrl, useEngineTool, watchReplay } from "@/lib/engines";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ReplayButton({ projectId, chatId, turnId }: { projectId: string; chatId: string; turnId: string }) {
  const { tool } = useEngineTool("watch");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);

  const installed = tool?.installed === true;

  async function replay() {
    setBusy(true);
    setError(null);
    try {
      const result = await watchReplay(projectId, chatId, turnId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setFilePath(result.path);
      setView(engineUrl(`/api/engines/watch/view?name=${encodeURIComponent(result.name)}`) ?? null);
    } finally {
      setBusy(false);
    }
  }

  // Quiet when ruah-watch is missing: not a disabled button and its install command under every
  // turn of every chat (Guard and Optimize show the ruah toolkit's install command once).
  if (!installed) return null;

  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        disabled={busy}
        title="Replay this turn"
        onClick={() => void replay()}
      >
        <Clapperboard className="size-3.5" />
        {busy ? "Rendering…" : "Replay"}
      </button>
      {error ? <span className="text-caption text-bad">{error}</span> : null}
      <Dialog open={view !== null} onOpenChange={(open) => { if (!open) setView(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Replay</DialogTitle>
          </DialogHeader>
          {view ? <iframe title="Session replay" src={view} className="h-[70vh] w-full rounded-md border border-hairline bg-surface-1" /> : null}
          {filePath && typeof window !== "undefined" && window.ruah ? (
            <button type="button" className="text-label text-muted-foreground underline" onClick={() => window.ruah?.revealInFinder(filePath)}>
              Reveal file
            </button>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
