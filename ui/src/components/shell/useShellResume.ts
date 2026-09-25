// GET /api/projects/:id/resume (§13.4) for the open project: the top bar's branch chip reads the
// latest answer (refreshed when the project's activity changes or the window regains focus), the
// "Where you left off" card reads the answer from when the project was entered.
import { useEffect, useState } from "react";
import type { ResumeInfo } from "@/lib/contracts";
import { useProjectActivity } from "@/lib/activity";
import { useResume } from "@/lib/view-state";

const FOCUS_REFRESH_MS = 15_000;

export function useShellResume(projectId: string | null): { latest: ResumeInfo | null; entry: ResumeInfo | null } {
  const activity = useProjectActivity(projectId);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < FOCUS_REFRESH_MS) return;
      last = Date.now();
      setFocusTick((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const refreshKey = `${activity?.lastEventAt ?? ""}|${activity?.running ?? 0}|${focusTick}`;
  const { resume } = useResume(projectId, refreshKey);
  const latest = resume && resume.project.id === projectId ? resume : null;

  const [entry, setEntry] = useState<ResumeInfo | null>(null);
  useEffect(() => {
    setEntry((prev) => {
      if (!latest) return prev && prev.project.id === projectId ? prev : null;
      return prev && prev.project.id === latest.project.id ? prev : latest;
    });
  }, [latest, projectId]);

  return { latest, entry: entry && entry.project.id === projectId ? entry : null };
}
