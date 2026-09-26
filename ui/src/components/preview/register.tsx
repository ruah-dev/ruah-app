// Puts <PreviewPane/> in the shell's preview slot (components/shell/slots.ts): the top bar's
// Preview toggle appears and the right side offers "Agent | Preview". Called once at startup
// (src/router.tsx — a call, not a bare import: package.json says "sideEffects": false, so the
// bundler drops side-effect-only imports); the pane's code loads the first time it is opened.
import { Suspense, lazy } from "react";
import { Loader2, MonitorPlay } from "lucide-react";
import { registerPreviewPane, registerStatusItem, type PreviewSlotProps } from "@/components/shell/slots";
import { StatusChip } from "@/components/shell/StatusChips";
import { useDaemonSelector } from "@/lib/daemon";
import { usePreview, stateMeta } from "@/lib/preview";

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

/** Top-bar chip while the open project's dev server runs (or is starting / crashed); hidden when stopped. */
function PreviewStatusChip() {
  const projectId = useDaemonSelector((d) => d.project?.id ?? null);
  const preview = usePreview(projectId);
  const status = preview?.status ?? null;
  if (!status || status.state === "stopped") return null;
  const meta = stateMeta(status);
  const where = status.port !== null ? `:${status.port}` : "";
  return (
    <StatusChip
      icon={MonitorPlay}
      tone={meta.tone}
      label={`Preview ${meta.label.toLowerCase()}${where ? ` ${where}` : ""}`}
      short={where || meta.label}
      title={status.url ? `${meta.label} · ${status.url}` : meta.label}
    />
  );
}

export function registerPreview() {
  registerPreviewPane(PreviewSlot);
  registerStatusItem({ id: "preview", order: 10, render: PreviewStatusChip });
}
