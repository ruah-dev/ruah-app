// UI state shared by every page of the shell: the selected element (the chat's @context), the
// Map's side panel, edit mode and the global dialogs. Data lives in workspace.tsx / daemon.ts;
// this is only "what the user is looking at".
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";
import type { DiagramNode, NodeKind } from "@/data/graphs";
import {
  architectureKindGroups,
  makeNode,
  useWorkspace,
  workflowKindGroups,
  type Diagram,
  type KindGroup,
  type Pane,
  type PaneTab,
} from "./workspace";
import { contextPathOf, homeDiagramId, indexArchitecture, nodeForPath } from "./architecture";
import { fetchContext, setFocus } from "./daemon";
import { isCloudNodeId } from "./integrations";

export type PanelView = "agent" | "details" | "code" | "properties";
export type EdgeRef = { from: string; to: string };

const ONBOARDING_KEY = "ruah.onboarded.v1";
const SIDEBAR_KEY = "ruah.sidebar.collapsed";

type Ctx = {
  selectedNodeId: string | null;
  selectedNode: DiagramNode | null;
  selectedEdge: EdgeRef | null;
  selectNode: (id: string | null) => void;
  selectEdge: (edge: EdgeRef | null) => void;
  clearSelection: () => void;

  activePane: Pane;
  activeTab: PaneTab;
  activeDiagram: Diagram;
  kindGroups: KindGroup[];
  kinds: NodeKind[];

  panelView: PanelView;
  setPanelView: (v: PanelView) => void;
  codePath: string | null;
  showPanel: boolean;
  setShowPanel: (v: boolean | ((v: boolean) => boolean)) => void;
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  /** editMode && the daemon accepts edits. */
  editing: boolean;

  askSignal: number;
  focusTurnId: string | null;
  focusTurn: (turnId: string) => void;

  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  sheetOpen: boolean;
  setSheetOpen: (v: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean | ((v: boolean) => boolean)) => void;
  onboardingOpen: boolean;
  setOnboardingOpen: (v: boolean) => void;
  finishOnboarding: () => void;
  resetOnboarding: () => void;

  contextPathFor: (node: DiagramNode) => string;
  openDiagram: (diagramId: string, paneId?: string) => void;
  /** Select a node on the diagram it lives on (switches to the Map). */
  openNode: (nodeId: string) => void;
  /** Select the node that owns a repo path and show the file in the Code view. */
  openPath: (path: string) => void;
  /** Select a node (or keep the selection) and focus the chat composer. */
  ask: (node?: DiagramNode) => void;
  drill: (node: DiagramNode) => void;
  copyContext: (node: DiagramNode) => Promise<boolean>;
  addNodeAt: (kind: NodeKind, x: number, y: number, placed?: boolean) => void;
};

const WorkbenchContext = createContext<Ctx | null>(null);

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const { app, architecture } = ws;
  const router = useRouter();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeRef | null>(null);
  const [panelView, setPanelViewState] = useState<PanelView>("agent");
  const [codePath, setCodePath] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const [editMode, setEditModeState] = useState(false);
  const [askSignal, setAskSignal] = useState(0);
  const [focusTurnId, setFocusTurnId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  useEffect(() => {
    setSidebarCollapsedState(readFlag(SIDEBAR_KEY));
    if (!readFlag(ONBOARDING_KEY)) setOnboardingOpen(true);
  }, []);

  const setSidebarCollapsed = useCallback((v: boolean | ((v: boolean) => boolean)) => {
    setSidebarCollapsedState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      writeFlag(SIDEBAR_KEY, next);
      return next;
    });
  }, []);

  const editing = editMode && ws.editable;
  const archIndex = useMemo(() => indexArchitecture(architecture), [architecture]);

  const activePane = app.panes.find((p) => p.id === app.activePaneId) ?? app.panes[0]!;
  const activeTab =
    activePane.tabs.find((t) => t.id === activePane.activeTabId) ?? activePane.tabs[0]!;
  const activeDiagram = app.diagrams.find((d) => d.id === activeTab.diagramId) ?? app.diagrams[0]!;

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return (
      activeDiagram.nodes.find((n) => n.id === selectedNodeId) ??
      app.diagrams.flatMap((d) => d.nodes).find((n) => n.id === selectedNodeId) ??
      null
    );
  }, [activeDiagram, app.diagrams, selectedNodeId]);

  // Node removed from architecture.json (on disk or by an edit): drop the selection.
  useEffect(() => {
    // Cloud resources on the derived Cloud level are not architecture nodes.
    if (selectedNodeId && !archIndex.byId.has(selectedNodeId) && !isCloudNodeId(selectedNodeId))
      setSelectedNodeId(null);
  }, [archIndex, selectedNodeId]);

  useEffect(() => {
    setFocus(selectedNode?.id ?? null);
  }, [selectedNode?.id]);

  const setPanelView = useCallback((v: PanelView) => {
    setPanelViewState(v);
    setShowPanel(true);
  }, []);

  const setEditMode = useCallback((v: boolean) => {
    setEditModeState(v);
    if (!v) setPanelViewState((p) => (p === "properties" ? "details" : p));
  }, []);

  const kindGroups = activeDiagram.mode === "workflow" ? workflowKindGroups : architectureKindGroups;
  const kinds = useMemo(() => kindGroups.flatMap((g) => g.kinds), [kindGroups]);

  const goToMap = useCallback(() => {
    if (router.state.location.pathname !== "/map") void router.navigate({ to: "/map" });
  }, [router]);

  const value = useMemo<Ctx>(() => {
    const clearSelection = () => {
      setSelectedNodeId(null);
      setSelectedEdge(null);
    };
    const openDiagram = (diagramId: string, paneId = activePane.id) => {
      ws.openTab(paneId, "diagram", diagramId);
      clearSelection();
      goToMap();
    };
    const openNode = (nodeId: string) => {
      if (!activeDiagram.nodes.some((n) => n.id === nodeId)) {
        const home = homeDiagramId(architecture, nodeId, archIndex);
        if (home) ws.openTab(activePane.id, "diagram", home);
      }
      setSelectedNodeId(nodeId);
      setSelectedEdge(null);
      goToMap();
    };
    return {
      selectedNodeId,
      selectedNode,
      selectedEdge,
      selectNode: (id) => {
        setSelectedNodeId(id);
        if (id) setSelectedEdge(null);
      },
      selectEdge: (edge) => {
        setSelectedEdge(edge);
        if (edge && editing) setPanelView("properties");
      },
      clearSelection,
      activePane,
      activeTab,
      activeDiagram,
      kindGroups,
      kinds,
      panelView,
      setPanelView,
      codePath,
      showPanel,
      setShowPanel,
      editMode,
      setEditMode,
      editing,
      askSignal,
      focusTurnId,
      focusTurn: (turnId) => {
        setFocusTurnId(turnId);
        if (router.state.location.pathname !== "/agent") void router.navigate({ to: "/agent" });
      },
      searchOpen,
      setSearchOpen,
      sheetOpen,
      setSheetOpen,
      mobileNavOpen,
      setMobileNavOpen,
      sidebarCollapsed,
      setSidebarCollapsed,
      onboardingOpen,
      setOnboardingOpen,
      finishOnboarding: () => {
        writeFlag(ONBOARDING_KEY, true);
        setOnboardingOpen(false);
      },
      resetOnboarding: () => {
        writeFlag(ONBOARDING_KEY, false);
        setOnboardingOpen(true);
      },
      contextPathFor: (node) =>
        contextPathOf({
          name: node.label,
          ...(node.path !== undefined ? { path: node.path } : {}),
          ...(node.filePaths !== undefined ? { files: node.filePaths } : {}),
        }),
      openDiagram,
      openNode,
      openPath: (path) => {
        const owner = nodeForPath(architecture, path);
        if (owner) openNode(owner.id);
        else goToMap();
        setCodePath(path);
        setPanelView("code");
        setSheetOpen(true);
      },
      ask: (node) => {
        if (node) {
          setSelectedNodeId(node.id);
          setSelectedEdge(null);
        }
        if (router.state.location.pathname === "/map") {
          setPanelView("agent");
          setSheetOpen(true);
        }
        setAskSignal((n) => n + 1);
      },
      drill: (node) => {
        if (!node.drill || !app.diagrams.some((d) => d.id === node.drill)) return;
        openDiagram(node.drill);
      },
      copyContext: async (node) => {
        try {
          const text = await fetchContext(node.id);
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
      addNodeAt: (kind, x, y, placed = true) => {
        if (!ws.editable) return;
        const node = makeNode(kind, x, y);
        ws.addNode(activeDiagram.id, node, placed);
        setSelectedNodeId(node.id);
        setSelectedEdge(null);
        setPanelView("properties");
      },
    };
  }, [
    ws,
    app.diagrams,
    architecture,
    archIndex,
    activePane,
    activeTab,
    activeDiagram,
    kindGroups,
    kinds,
    selectedNodeId,
    selectedNode,
    selectedEdge,
    panelView,
    setPanelView,
    codePath,
    showPanel,
    editMode,
    setEditMode,
    editing,
    askSignal,
    focusTurnId,
    searchOpen,
    sheetOpen,
    mobileNavOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    onboardingOpen,
    goToMap,
    router,
  ]);

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench() {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return ctx;
}
