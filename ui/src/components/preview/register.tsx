// Puts <PreviewPane/> in the shell's preview slot (components/shell/slots.ts): the top bar's
// Preview toggle appears and the right side offers "Agent | Preview". Called once at startup
// (src/router.tsx — a call, not a bare import: package.json says "sideEffects": false, so the
// bundler drops side-effect-only imports); the pane's code loads the first time it is opened.
import { Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import { registerPreviewPane, type PreviewSlotProps } from "@/components/shell/slots";

const PreviewPane = lazy(() => import("./PreviewPane").then((m) => ({ default: m.PreviewPane })));

function PreviewSlot({ onAskAgent }: PreviewSlotProps) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground" aria-label="Loading the preview">
          <Loader2 className="size-4 animate-spin" />
        </div>
      }
    >
      <PreviewPane variant="panel" {...(onAskAgent ? { onAskAgent } : {})} />
    </Suspense>
  );
}

export function registerPreview() {
  registerPreviewPane(PreviewSlot);
}
