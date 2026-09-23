// §1.7 "follow the agent": when an agent changes the map somewhere the user is not looking
// (another level, or another page), a toast says so — "Claude added Payments service · Show" —
// and Show navigates to the element's level and selects it. Changes on the visible level need
// no toast: they animate in place. Bursts of ops update one toast instead of stacking.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { MapChange } from "@/lib/contracts";
import { useDaemon } from "@/lib/daemon";
import {
  changeTarget,
  onMapActivity,
  summarizeChanges,
  type MapActivityEvent,
} from "@/lib/map-activity";
import { useWorkbench } from "@/lib/workbench";
import { Phantom } from "@/components/brand/Phantom";

const BURST_MS = 5000;
const TOAST_ID = "map-activity";

export function MapActivityToasts() {
  const wb = useWorkbench();
  const s = useDaemon();
  const latest = useRef({ wb, s });
  latest.current = { wb, s };
  const burst = useRef<{ key: string; changes: MapChange[]; at: number } | null>(null);

  useEffect(
    () =>
      onMapActivity((event) => {
        if (event.by.kind !== "agent") return;
        // The event fires before the new revision renders: look once React has caught up.
        setTimeout(() => show(event), 80);
      }),
    [],
  );

  function show(event: MapActivityEvent) {
    const { wb, s } = latest.current;
    const onMap = typeof window !== "undefined" && window.location.pathname.startsWith("/map");
    const visible = new Set(wb.activeDiagram.nodes.map((n) => n.id));
    const known = new Set(s.architecture?.nodes.map((n) => n.id) ?? event.changes.map((c) => c.id));
    const offscreen = event.changes.filter((c) => {
      const target = changeTarget(c);
      return target !== null && known.has(target) && (!onMap || !visible.has(target));
    });
    if (offscreen.length === 0) return;

    const key = event.by.turnId ?? event.by.agentId ?? "agent";
    const prev = burst.current;
    const changes =
      prev && prev.key === key && event.at - prev.at < BURST_MS
        ? [...prev.changes, ...offscreen]
        : offscreen;
    burst.current = { key, changes, at: event.at };

    const agents = s.agent?.agents;
    const agentName =
      agents?.available.find((a) => a.id === event.by.agentId)?.name?.replace(/ Code$/, "") ??
      (event.by.agentId === "claude" ? "Claude" : "The agent");
    const target = changeTarget(offscreen[offscreen.length - 1]!);
    toast.message(`${agentName} ${summarizeChanges(changes)}`, {
      id: TOAST_ID,
      icon: <Phantom expression="agent" size="xs" />,
      description: onMap ? "On another level of the map" : undefined,
      duration: 6000,
      ...(target
        ? {
            action: {
              label: "Show",
              onClick: () => latest.current.wb.openNode(target),
            },
          }
        : {}),
    });
  }
  return null;
}
