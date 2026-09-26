// The standalone Limits page (route /limits): the panel under a page header that carries its
// controls (status, warning settings, refresh-all) — one row of controls, as on every page. The
// shell can link a rail entry here, or mount <AgentLimitsPanel/> in a side panel instead.
import { PageHeader } from "@/components/shell/AppShell";
import { AgentLimitsControls, AgentLimitsPanel } from "./AgentLimitsPanel";

export function AgentLimitsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Limits">
        <AgentLimitsControls statusClassName="max-md:hidden" />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 max-md:px-4">
          <AgentLimitsPanel controls={false} />
        </div>
      </div>
    </div>
  );
}
