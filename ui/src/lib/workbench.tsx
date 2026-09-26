// UI state shared by every page of the shell: the selected element (the chat's @context), the
// Map's side panel, edit mode and the global dialogs. Data lives in workspace.tsx / daemon.ts;
// this is only "what the user is looking at".
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { toast } from "sonner";
import {
  contextPathOf,
  homeDiagramId,
  indexArchitecture,
  levelDiagramId,
  nodeForPath,
  parseDiagramId,
} from "./architecture";
import { fetchContext, setFocus } from "./daemon";
import { quickAddPosition } from "./architecture-edit";
import { isCloudNodeId } from "./integrations";
import { isExpandedId, requestExpansion, requestPeek } from "./expand";
import { onboardingInput, shouldOnboard } from "./start-screen";

export type PanelView = "agent" | "details" | "code" | "properties";
export type EdgeRef = { from: string; to: string };

const ONBOARDING_KEY = "ruah.onboarded.v1";
/** The one-time "New to Ruah?" pointer shown when the first run opened a project (not "onboarded"). */
const ONBOARDING_OFFERED_KEY = "ruah.onboarding.offered.v1";
const OUTLINE_KEY = "ruah.map.outline.open";

type Ctx = {
  selectedNodeId: string | null;
  selectedNode: DiagramNode | null;
  selectedEdge: EdgeRef | null;
  selectNode: (id: string | null) => void;
  selectEdge: (edge: EdgeRef | null) => void;
  clearSelection: () => void;
  /** What the agent talks about: the selection, else the element whose level is open. */
  contextNode: DiagramNode | null;
  /** The element whose level is open (null at the top level and on workflows). */
  levelNode: DiagramNode | null;
  /** Element id being expanded right now (drill-in pending). */
  drillPending: string | null;

  activePane: Pane;
  activeTab: PaneTab;
  activeDiagram: Diagram;
  kindGroups: KindGroup[];
  kinds: NodeKind[];

  panelView: PanelView;
  setPanelView: (v: PanelView) => void;
  codePath: string | null;
  /** Lines to highlight in the Code view (a symbol's range). */
  codeRange: [number, number] | null;
  /** Show a file in the Code view, optionally scrolled to a line range. */
  openCode: (path: string, range?: [number, number] | null) => void;
  /** Symbol on a file level: select it and show its lines. */
  activateSymbol: (node: DiagramNode) => void;
  /** Backspace / ⌥↑ / the breadcrumb: the level above, selecting the element you came from. */
  goUp: () => void;
  showPanel: boolean;
  setShowPanel: (v: boolean | ((v: boolean) => boolean)) => void;
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  /** editMode && the daemon accepts edits. */
  editing: boolean;

  askSignal: number;
  focusTurnId: string | null;
  focusTurn: (turnId: string) => void;

  sheetOpen: boolean;
  setSheetOpen: (v: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  /** The Map's left drawer (outline, workflows, files; the element palette in Edit mode). */
  outlineOpen: boolean;
  setOutlineOpen: (v: boolean | ((v: boolean) => boolean)) => void;
  /** First-run flow on the start screen (dismissible, re-openable from Help / Settings). */
  onboardingOpen: boolean;
  setOnboardingOpen: (v: boolean) => void;
  finishOnboarding: () => void;
  resetOnboarding: () => void;

  // §5 launcher + project switching
  /** Start screen shown over an open project (the daemon's launcher state shows it anyway). */
  launcherOpen: boolean;
  setLauncherOpen: (v: boolean) => void;
  /** ⌘K / ⌘P command launcher (projects, chats, elements, cloud, actions). */
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  /** Browser fallback for "Open folder…" (no desktop bridge): a path field. */
  openFolderOpen: boolean;
  setOpenFolderOpen: (v: boolean) => void;
  newProjectOpen: boolean;
  setNewProjectOpen: (v: boolean) => void;

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
  const { app } = ws;
  // The map's architecture: stored + expanded levels (drill-in below architecture.json).
  const architecture = ws.mapArchitecture;
  const router = useRouter();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeRef | null>(null);
  const [panelView, setPanelViewState] = useState<PanelView>("agent");
  const [codePath, setCodePath] = useState<string | null>(null);
  const [codeRange, setCodeRange] = useState<[number, number] | null>(null);
  const [drillPending, setDrillPending] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const [editMode, setEditModeState] = useState(false);
  const [askSignal, setAskSignal] = useState(0);
  const [focusTurnId, setFocusTurnId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [outlineOpen, setOutlineOpenState] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openFolderOpen, setOpenFolderOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  useEffect(() => {
    setOutlineOpenState(readFlag(OUTLINE_KEY));
  }, []);

  // First run (lib/start-screen.ts): the "Getting started" card only on a true first run; the start
  // screen itself shows because no project is open — never as an overlay over an open project on
  // page load. Only dismissing the card marks the profile onboarded.
  const onboardingDecided = useRef(false);
  const { projectsLoaded, project: openProjectInfo, source: daemonSource, projectsSupported } = ws.daemon;
  const recentCount = ws.daemon.recentProjects.length;
  useEffect(() => {
    if (onboardingDecided.current) return;
    const verdict = shouldOnboard(
      onboardingInput({ source: daemonSource, projectsLoaded, recentCount, projectOpen: !!openProjectInfo }, readFlag(ONBOARDING_KEY)),
    );
    if (verdict === "wait") return;
    onboardingDecided.current = true;
    if (verdict === "show") {
      setOnboardingOpen(true);
      // No daemon (the sample): the start screen isn't the page, so it opens over the sample map.
      if (!projectsSupported) setLauncherOpen(true);
    } else if (verdict === "offer") {
      // A project opened on the very first run: the card waits on the start screen; one quiet
      // pointer to it, never an overlay on the project.
      setOnboardingOpen(true);
      if (!readFlag(ONBOARDING_OFFERED_KEY)) {
        writeFlag(ONBOARDING_OFFERED_KEY, true);
        toast("New to Ruah?", {
          description: "Getting started: three steps, one minute.",
          action: { label: "Show me", onClick: () => setLauncherOpen(true) },
        });
      }
    }
  }, [projectsLoaded, recentCount, openProjectInfo, daemonSource, projectsSupported]);

  // Project changed: reset what the user was looking at. A new, empty project starts in Edit
  // mode so the element palette is right there.
  const projectKey = ws.daemon.project?.id ?? ws.daemon.root ?? ws.daemon.source ?? null;
  const lastProjectKey = useRef<string | null>(null);
  const emptyCheckPending = useRef(false);
  useEffect(() => {
    if (projectKey === lastProjectKey.current) return;
    const first = lastProjectKey.current === null;
    lastProjectKey.current = projectKey;
    if (!first) {
      setSelectedNodeId(null);
      setSelectedEdge(null);
      setEditModeState(false);
      setFocusTurnId(null);
    }
    emptyCheckPending.current = true;
  }, [projectKey]);
  useEffect(() => {
    if (!emptyCheckPending.current || ws.daemon.projectSwitch || !ws.daemon.architecture) return;
    emptyCheckPending.current = false;
    if (ws.daemon.architecture.nodes.length === 0 && ws.editable) setEditModeState(true);
  }, [ws.daemon.architecture, ws.daemon.projectSwitch, ws.editable]);

  const setOutlineOpen = useCallback((v: boolean | ((v: boolean) => boolean)) => {
    setOutlineOpenState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      writeFlag(OUTLINE_KEY, next);
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

  // The element whose level is open: the default subject for the agent when nothing is selected.
  const levelNode = useMemo(() => {
    const ref = parseDiagramId(activeDiagram.id);
    if (ref?.mode !== "architecture" || ref.parentId === null) return null;
    return app.diagrams.flatMap((d) => d.nodes).find((n) => n.id === ref.parentId) ?? null;
  }, [activeDiagram.id, app.diagrams]);
  const contextNode = selectedNode ?? levelNode;

  // "N inside" chips: ask the daemon how much is below each stored leaf on the open level.
  useEffect(() => {
    if (activeDiagram.mode !== "architecture") return;
    const ids = activeDiagram.nodes
      .filter((n) => !n.ephemeral && n.path && !n.drill && n.childCount === undefined && !isCloudNodeId(n.id))
      .map((n) => n.id);
    if (ids.length) requestPeek(ids);
  }, [activeDiagram]);

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
      ws.navigate(paneId, diagramId);
      clearSelection();
      goToMap();
      // Expanded levels are live data: refresh in the background when revisited.
      const ref = parseDiagramId(diagramId);
      if (ref?.mode === "architecture" && ref.parentId !== null && ws.expansions.entries.has(ref.parentId)) {
        void requestExpansion(ref.parentId);
      }
    };
    const drillInto = (node: DiagramNode) => {
      const target = node.drill ?? levelDiagramId(node.id);
      if (app.diagrams.some((d) => d.id === target && d.nodes.length > 0)) {
        openDiagram(target);
        return;
      }
      // On-demand level (§1.6): fetch it, then open.
      setDrillPending(node.id);
      void requestExpansion(node.id, { maxAge: 0 }).then((entry) => {
        setDrillPending((p) => (p === node.id ? null : p));
        if (entry.status === "ok") {
          if (entry.expansion.architecture.nodes.length === 0) {
            toast.message(`${node.label} has nothing inside to show`);
            return;
          }
          openDiagram(levelDiagramId(node.id));
        } else if (entry.status === "error") {
          toast.error(`Couldn't open ${node.label}`, { description: entry.error });
        }
      });
    };
    const openNode = (nodeId: string) => {
      if (!activeDiagram.nodes.some((n) => n.id === nodeId)) {
        const home = homeDiagramId(architecture, nodeId, archIndex);
        if (home) ws.navigate(activePane.id, home);
      }
      setSelectedNodeId(nodeId);
      setSelectedEdge(null);
      goToMap();
    };
    const openCode = (path: string, range: [number, number] | null = null) => {
      setCodePath(path);
      setCodeRange(range);
      setPanelView("code");
      setSheetOpen(true);
    };
    return {
      selectedNodeId,
      selectedNode,
      selectedEdge,
      selectNode: (id) => {
        setSelectedNodeId(id);
        if (id) setSelectedEdge(null);
      },
      contextNode,
      levelNode,
      drillPending,
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
      codeRange,
      openCode,
      activateSymbol: (node) => {
        setSelectedNodeId(node.id);
        setSelectedEdge(null);
        if (node.path && node.symbol) openCode(node.path, [node.symbol.line, node.symbol.endLine]);
      },
      goUp: () => {
        const ref = parseDiagramId(activeDiagram.id);
        if (ref?.mode !== "architecture" || ref.parentId === null) return;
        const from = ref.parentId;
        const home = homeDiagramId(architecture, from, archIndex);
        if (!home) return;
        ws.navigate(activePane.id, home);
        setSelectedNodeId(from);
        setSelectedEdge(null);
        goToMap();
      },
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
      sheetOpen,
      setSheetOpen,
      mobileNavOpen,
      setMobileNavOpen,
      outlineOpen,
      setOutlineOpen,
      onboardingOpen,
      setOnboardingOpen,
      finishOnboarding: () => {
        writeFlag(ONBOARDING_KEY, true);
        setOnboardingOpen(false);
      },
      resetOnboarding: () => {
        writeFlag(ONBOARDING_KEY, false);
        setOnboardingOpen(true);
        setLauncherOpen(true);
      },
      launcherOpen,
      setLauncherOpen,
      paletteOpen,
      setPaletteOpen,
      openFolderOpen,
      setOpenFolderOpen,
      newProjectOpen,
      setNewProjectOpen,
      contextPathFor: (node) =>
        node.symbol && node.path
          ? `${node.path}:${node.symbol.line}`
          : contextPathOf({
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
        openCode(path);
      },
      ask: (node) => {
        if (node) {
          setSelectedNodeId(node.id);
          setSelectedEdge(null);
        }
        // The agent panel is on every page but the Agent page (which is the chat itself).
        if (router.state.location.pathname !== "/agent") {
          setPanelView("agent");
          setSheetOpen(true);
        }
        setAskSignal((n) => n + 1);
      },
      drill: (node) => {
        if (!node.drill && !isExpandedId(node.id)) return;
        drillInto(node);
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
        // A palette click (not a drop): next to what is on the level, not on top of it.
        const ref = parseDiagramId(activeDiagram.id);
        const at = !placed && ref?.mode === "architecture" && architecture ? quickAddPosition(architecture, ref.parentId) : { x, y };
        const node = makeNode(kind, at.x, at.y);
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
    contextNode,
    levelNode,
    drillPending,
    panelView,
    setPanelView,
    codePath,
    codeRange,
    showPanel,
    editMode,
    setEditMode,
    editing,
    askSignal,
    focusTurnId,
    sheetOpen,
    mobileNavOpen,
    outlineOpen,
    setOutlineOpen,
    onboardingOpen,
    launcherOpen,
    paletteOpen,
    openFolderOpen,
    newProjectOpen,
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
