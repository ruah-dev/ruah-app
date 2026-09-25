// /preview: the live preview as a full page (the same pane as the right-hand split).
import { PreviewPane } from "./PreviewPane";

export function PreviewPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewPane variant="page" />
    </div>
  );
}
