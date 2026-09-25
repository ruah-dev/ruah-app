// Threshold toasts: when a limit window crosses the warning (default 80%) or critical (95%)
// threshold, one toast per agent, window, level and reset — remembered across reloads. Renders
// nothing; mount it once (the Limits panel does; the shell can mount it app-wide instead).
import { useEffect } from "react";
import { toast } from "sonner";
import { formatResetsIn, limitCrossings } from "./agentLimitsModel";
import { readAnnounced, useAgentLimits, useLimitSettings, writeAnnounced } from "./agentLimitsStore";

/** Crossings announced this session (covers a viewer without localStorage). */
const sessionAnnounced = new Set<string>();

export function AgentLimitToasts() {
  const { report } = useAgentLimits();
  const [settings] = useLimitSettings();

  useEffect(() => {
    if (!settings.toasts || report === null) return;
    const announced = readAnnounced();
    for (const key of sessionAnnounced) announced.add(key);
    const crossings = limitCrossings(report.agents, settings.thresholds, announced);
    if (crossings.length === 0) return;
    const now = Date.now();
    for (const c of crossings) {
      const pct = Math.round(c.meter.usedPercent ?? 0);
      const reset = formatResetsIn(c.meter, now);
      const title = `${c.agentName}: ${c.meter.label} at ${pct}%`;
      const description = `${100 - pct}% left${reset ? ` · ${reset}` : ""}`;
      if (c.level === "critical") toast.error(title, { description });
      else toast.warning(title, { description });
      for (const key of c.keys) {
        announced.add(key);
        sessionAnnounced.add(key);
      }
    }
    writeAnnounced(announced);
  }, [report, settings]);

  return null;
}
