// The open project's cloud resources that are down or degraded (§9 health, §14 scope), from the
// shared integrations store — for the rail's Cloud dot, "Needs you" and the resume card. Loads
// the cached snapshot once per project (GET /api/cloud/resources, no provider calls).
import { useMemo } from "react";
import type { CloudResource } from "@/lib/contracts";
import { isUnhealthy, scopeView, useEnsure } from "@/lib/integrations";

export function useProjectCloud(): { resources: CloudResource[]; unhealthy: CloudResource[] } {
  const s = useEnsure("cloud");
  const snapshot = s.cloud.status === "ok" ? s.cloud.data : null;
  return useMemo(() => {
    const resources = snapshot ? scopeView(snapshot.resources).project : [];
    return { resources, unhealthy: resources.filter(isUnhealthy) };
  }, [snapshot]);
}
