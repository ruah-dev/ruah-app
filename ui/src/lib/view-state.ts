// Per-project view state (CONTRACTS.md §13.5) and "where you left off" (§13.4) as React hooks.
// The view state is viewer-owned and opaque to the daemon (map drill path, zoom/pan, open panels,
// active page …): a JSON object of at most 16 KB, stored in the project's state.json.
import { useCallback, useEffect, useState } from "react";
import type { ResumeInfo, ViewState } from "./contracts";
import { fetchResume, fetchViewState, saveViewState } from "./daemon";

/** Last known view per project (this page's life), so a switch back restores without a request. */
const viewCache = new Map<string, ViewState | null>();

/** Loads the project's saved view state once per project; `save` stores a new one (debounced). */
export function useViewState(projectId: string | null | undefined): {
  view: ViewState | null;
  loaded: boolean;
  save: (view: ViewState, opts?: { immediate?: boolean }) => boolean;
} {
  const [view, setView] = useState<ViewState | null>(() => (projectId ? (viewCache.get(projectId) ?? null) : null));
  const [loaded, setLoaded] = useState<boolean>(() => !!projectId && viewCache.has(projectId));

  useEffect(() => {
    if (!projectId) {
      setView(null);
      setLoaded(false);
      return;
    }
    if (viewCache.has(projectId)) {
      setView(viewCache.get(projectId) ?? null);
      setLoaded(true);
      return;
    }
    let live = true;
    setLoaded(false);
    fetchViewState(projectId)
      .then((res) => {
        viewCache.set(projectId, res.view);
        if (live) setView(res.view);
      })
      .catch(() => {
        if (live) setView(null);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const save = useCallback(
    (next: ViewState, opts?: { immediate?: boolean }) => {
      if (!projectId) return false;
      const ok = saveViewState(projectId, next, opts);
      if (ok) {
        viewCache.set(projectId, next);
        setView(next);
      }
      return ok;
    },
    [projectId],
  );

  return { view, loaded, save };
}

/** GET /api/projects/:id/resume for `projectId` (refetched when `refreshKey` changes). */
export function useResume(
  projectId: string | null | undefined,
  refreshKey?: unknown,
): { resume: ResumeInfo | null; loading: boolean; error: string | null } {
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      setResume(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    fetchResume(projectId)
      .then((r) => {
        if (live) setResume(r);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, refreshKey]);
  return { resume, loading, error };
}
