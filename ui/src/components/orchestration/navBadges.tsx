// Cheap counts for the rail: running ruah tasks. Reads the shared store; refreshes slowly only
// while something is running (the Tasks page polls faster on its own).
import { useEffect } from "react";
import { loadRuah, useEnsure } from "@/lib/integrations";

export function useRunningTaskCount(): number {
  const s = useEnsure("ruah");
  const running =
    s.ruah.status === "ok" && s.ruah.data.initialized
      ? s.ruah.data.tasks.filter((t) => t.status === "in-progress").length
      : 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void loadRuah();
    }, 20_000);
    return () => clearInterval(t);
  }, [running]);
  return running;
}
