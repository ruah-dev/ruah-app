// The standalone Limits page (route /limits): the panel under a page header. The shell can link
// a rail entry here, or mount <AgentLimitsPanel/> in a side panel instead.
import { PageHeader } from "@/components/shell/AppShell";
import { AgentLimitsPanel } from "./AgentLimitsPanel";

export function AgentLimitsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Limits" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 max-md:px-4">
          <AgentLimitsPanel />
        </div>
      </div>
    </div>
  );
}
