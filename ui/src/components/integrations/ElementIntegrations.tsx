// The integration sections of an element's Details panel (one mount point for InspectorPanel):
// linked issues, the cloud resources it runs on, and ruah tasks.
import type { DiagramNode } from "@/data/graphs";
import { isCloudNodeId } from "@/lib/integrations";
import { ElementCloudSection } from "@/components/cloud/CloudDetails";
import { ElementTasksSection } from "@/components/orchestration/ElementTasksSection";
import { IssuesSection } from "@/components/work/IssuesSection";

export function ElementIntegrations({ node }: { node: DiagramNode }) {
  if (isCloudNodeId(node.id)) return null;
  return (
    <>
      <IssuesSection node={node} />
      <ElementCloudSection node={node} />
      <ElementTasksSection node={node} />
    </>
  );
}

export { CloudResourceDetails } from "@/components/cloud/CloudDetails";
