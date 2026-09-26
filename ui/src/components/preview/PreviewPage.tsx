// /preview: the live preview as a full page (the same pane as the right-hand split).
import { setShellDialog } from "@/components/shell/shellState";
import { useWorkbench } from "@/lib/workbench";
import { PreviewPane } from "./PreviewPane";

export function PreviewPage() {
  const wb = useWorkbench();
  // "Ask agent to fix" drafted a prompt: open the agent panel beside the page (instead of a
  // second preview there) so the composer is in view.
  const showAgent = () => {
    setShellDialog("preview", false);
    wb.setShowPanel(true);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewPane variant="page" onAskAgent={showAgent} />
    </div>
  );
}
