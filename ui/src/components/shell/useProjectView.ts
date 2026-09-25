// Per-project view state (§13.5) for the shell: restores the page, the map level and camera, the
// left drawer and the agent panel (open, view, width) when a project is entered, and saves them
// (debounced) as they change. The URL wins on the first load of the window, and a switch that
// opens a chat keeps the chat in front.
import { useEffect, useRef, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { parseDiagramId } from "@/lib/architecture";
import { onCameraSettled, recallCamera, resetCameras } from "@/lib/camera";
import { requestExpansion } from "@/lib/expand";
import { useViewState } from "@/lib/view-state";
import {
  decodeShellView,
  encodeShellView,
  isShellPage,
  restorePage,
  sameShellView,
  type ShellView,
} from "@/lib/view-restore";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { panelWidth, setPanelWidth, usePanelWidth } from "./RightPanel";

export function useProjectView(): { saved: ShellView | null; projectId: string | null } {
  const ws = useWorkspace();
  const { daemon } = ws;
  const wb = useWorkbench();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projectId = daemon.projectSwitch || !daemon.project ? null : daemon.project.id;
  const { view, loaded, save } = useViewState(projectId);
  const width = usePanelWidth();
  const restoredFor = useRef<string | null>(null);
  const firstEntry = useRef(true);
  const chatSwitchTo = useRef<string | null>(null);
  const skipNext = useRef(false);
  // The view as saved when the project was entered (the resume card's "You were on").
  const [entry, setEntry] = useState<{ projectId: string; view: ShellView | null } | null>(null);

  // A switch that opens a chat (Chats page, notification, launcher) keeps the chat in front.
  const sw = daemon.projectSwitch;
  useEffect(() => {
    if (sw?.chatId) chatSwitchTo.current = sw.projectId ?? sw.root;
  }, [sw]);

  // Restore once per project entry.
  useEffect(() => {
    if (!projectId || !loaded || restoredFor.current === projectId) return;
    restoredFor.current = projectId;
    skipNext.current = true;
    const saved = decodeShellView(view);
    const first = firstEntry.current;
    firstEntry.current = false;
    const project = daemon.project;
    const viaChat = !!chatSwitchTo.current && (chatSwitchTo.current === projectId || chatSwitchTo.current === project?.root);
    chatSwitchTo.current = null;
    setEntry({ projectId, view: saved });
    resetCameras(saved?.diagramId && saved.camera ? { diagramId: saved.diagramId, camera: saved.camera } : null);
    if (!saved) return;
    // setPanelView also opens the panel: set the view first, then the open state.
    wb.setPanelView(saved.panelView);
    wb.setShowPanel(saved.panelOpen);
    wb.setOutlineOpen(saved.drawerOpen);
    setPanelWidth(saved.panelWidth);
    const target = saved.diagramId;
    if (target && target !== wb.activeDiagram.id) {
      const paneId = wb.activePane.id;
      if (ws.app.diagrams.some((d) => d.id === target)) ws.navigate(paneId, target);
      else {
        // A drilled-in level is read on demand: fetch it, then open it.
        const ref = parseDiagramId(target);
        if (ref?.mode === "architecture" && ref.parentId !== null)
          void requestExpansion(ref.parentId).then((entry) => {
            if (entry.status === "ok" && restoredFor.current === projectId) ws.navigate(paneId, target);
          });
      }
    }
    const page = restorePage(saved, router.state.location.pathname, first || viaChat);
    if (page) void router.navigate({ to: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loaded, view]);

  // Save what changed (saveViewState debounces per project).
  const snapshot = (): ShellView => ({
    page: isShellPage(router.state.location.pathname) ? router.state.location.pathname : "/map",
    diagramId: wb.activeDiagram.id,
    camera: recallCamera(wb.activeDiagram.id) ?? null,
    drawerOpen: wb.outlineOpen,
    panelOpen: wb.showPanel,
    panelView: wb.panelView,
    panelWidth: panelWidth(),
  });
  const latest = useRef({ snapshot, view, save, projectId });
  latest.current = { snapshot, view, save, projectId };
  const persist = () => {
    const { snapshot, view, save, projectId } = latest.current;
    if (!projectId || restoredFor.current !== projectId) return;
    const next = snapshot();
    if (sameShellView(decodeShellView(view), next)) return;
    save(encodeShellView(next, view));
  };

  useEffect(() => {
    // The pass that restored still shows the previous project's state: save from the next one.
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loaded, pathname, wb.activeDiagram.id, wb.outlineOpen, wb.showPanel, wb.panelView, width]);

  useEffect(() => onCameraSettled(persist), []);

  return { saved: entry && entry.projectId === projectId ? entry.view : null, projectId };
}
