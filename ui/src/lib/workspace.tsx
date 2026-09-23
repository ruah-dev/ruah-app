// Workspace state. The project and its diagrams are DERIVED from architecture.json
// (served by the archmap daemon, or the bundled sample when no daemon is reachable);
// editor operations become architecture.json edits that are saved back to the daemon
// (src/lib/architecture-edit.ts + editArchitecture in src/lib/daemon.ts).
// localStorage only keeps UI layout (panes, tabs, workflow node positions), keyed per repo root.
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
import type { DiagramNode, Graph, NodeKind } from "@/data/graphs";
import type { Architecture } from "./contracts";
import {
  EMPTY_ARCHITECTURE,
  ROOT_DIAGRAM_ID,
  diagramsFromArchitecture,
  levelDiagramId,
  parseDiagramId,
  workflowDiagramId,
  type Positions,
} from "./architecture";
import * as edit from "./architecture-edit";
import { canEdit, editArchitecture, reportLocalError, useDaemon, type DaemonState } from "./daemon";

export type DiagramMode = "architecture" | "workflow";

export type Diagram = Graph & { mode: DiagramMode; group?: string };

export type TabType = "diagram" | "code" | "agent";

export type PaneTab = {
  id: string;
  type: TabType;
  diagramId: string;
};

export type Pane = {
  id: string;
  tabs: PaneTab[];
  activeTabId: string;
};

export type AppProject = {
  id: string;
  name: string;
  repo: string;
  branch: string;
  diagrams: Diagram[];
  panes: Pane[];
  activePaneId: string;
};

export type Workspace = {
  apps: AppProject[];
  activeAppId: string;
};

/** v4: UI layout only (v3 stored whole demo projects; those are ignored). */
const STORAGE_PREFIX = "atlas.ui.v4:";

export const uid = (prefix = "id") =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

export const defaultGroupFor = (mode: DiagramMode) =>
  mode === "workflow" ? "Workflows" : "Components";

type UiPrefs = {
  panes: Pane[];
  activePaneId: string;
  /** Workflow node positions per workflow diagram (not part of architecture.json). */
  flowPositions: Record<string, Positions>;
};

function makePane(diagramId: string): Pane {
  const tab: PaneTab = { id: uid("tab"), type: "diagram", diagramId };
  return { id: uid("pane"), tabs: [tab], activeTabId: tab.id };
}

function defaultPrefs(): UiPrefs {
  const pane = makePane(ROOT_DIAGRAM_ID);
  return { panes: [pane], activePaneId: pane.id, flowPositions: {} };
}

function loadPrefs(key: string): UiPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiPrefs>;
      if (parsed.panes?.length && parsed.activePaneId) {
        return {
          panes: parsed.panes,
          activePaneId: parsed.activePaneId,
          flowPositions: parsed.flowPositions ?? {},
        };
      }
    }
  } catch {
    /* ignore malformed storage */
  }
  return defaultPrefs();
}

export function repoBasename(root: string | null): string | null {
  if (!root) return null;
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

export function storageKeyFor(daemon: Pick<DaemonState, "source" | "root">): string | null {
  if (daemon.source === "daemon") return daemon.root ?? "daemon";
  if (daemon.source === "sample") return "sample";
  return null;
}

type Ctx = {
  workspace: Workspace;
  app: AppProject;
  architecture: Architecture;
  daemon: DaemonState;
  /** Editing needs a connected daemon (edits are saved to architecture.json). */
  editable: boolean;
  setActiveApp: (id: string) => void;
  resetWorkspace: () => void;
  // diagrams
  addDiagram: (mode: DiagramMode) => string | null;
  updateDiagram: (id: string, patch: Partial<Omit<Diagram, "nodes" | "edges">>) => void;
  deleteDiagram: (id: string) => void;
  // nodes + edges
  /** `placed` = the user chose the position (drop / double-click); workflow quick-adds auto-layout. */
  addNode: (diagramId: string, node: DiagramNode, placed?: boolean) => void;
  updateNode: (diagramId: string, nodeId: string, patch: Partial<DiagramNode>) => void;
  deleteNode: (diagramId: string, nodeId: string) => void;
  addEdge: (diagramId: string, from: string, to: string) => void;
  updateEdge: (
    diagramId: string,
    from: string,
    to: string,
    patch: { label?: string; animated?: boolean },
  ) => void;
  deleteEdge: (diagramId: string, from: string, to: string) => void;
  // panes / windows
  openTab: (paneId: string, type: TabType, diagramId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  setActivePane: (paneId: string) => void;
  splitPane: (diagramId: string) => void;
  closePane: (paneId: string) => void;
};

const WorkspaceContext = createContext<Ctx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const daemon = useDaemon();
  const architecture = daemon.architecture ?? EMPTY_ARCHITECTURE;
  const storageKey = storageKeyFor(daemon);
  const [prefs, setPrefs] = useState<UiPrefs>(defaultPrefs);
  const loadedKey = useRef<string | null>(null);

  // Load layout prefs for this repo (client only, after the store knows which repo it is).
  useEffect(() => {
    if (storageKey === null || loadedKey.current === storageKey) return;
    loadedKey.current = storageKey;
    setPrefs(loadPrefs(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (storageKey === null || loadedKey.current !== storageKey) return;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(prefs));
    } catch {
      /* storage full or unavailable */
    }
  }, [prefs, storageKey]);

  const diagrams = useMemo<Diagram[]>(
    () => diagramsFromArchitecture(architecture, prefs.flowPositions),
    [architecture, prefs.flowPositions],
  );

  // Tabs pointing at diagrams that no longer exist (node deleted on disk) fall back to the top level.
  const panes = useMemo(() => {
    const ids = new Set(diagrams.map((d) => d.id));
    return prefs.panes.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (ids.has(t.diagramId) ? t : { ...t, diagramId: ROOT_DIAGRAM_ID })),
    }));
  }, [prefs.panes, diagrams]);

  const repo =
    daemon.source === "daemon"
      ? (repoBasename(daemon.root) ?? architecture.name)
      : daemon.source === "sample"
        ? `${architecture.name} (sample)`
        : "connecting…";

  const app: AppProject = useMemo(
    () => ({
      id: storageKey ?? "pending",
      name: architecture.name || repo,
      repo,
      branch: "",
      diagrams,
      panes,
      activePaneId: panes.some((p) => p.id === prefs.activePaneId)
        ? prefs.activePaneId
        : panes[0]!.id,
    }),
    [storageKey, architecture.name, repo, diagrams, panes, prefs.activePaneId],
  );

  const workspace: Workspace = useMemo(() => ({ apps: [app], activeAppId: app.id }), [app]);
  const editable = canEdit(daemon);

  const mutatePrefs = useCallback((fn: (p: UiPrefs) => void) => {
    setPrefs((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }, []);

  const apply = useCallback((fn: (a: Architecture) => Architecture | null, refusal?: string) => {
    let refused = false;
    editArchitecture((a) => {
      const next = fn(a);
      if (!next) refused = true;
      return next;
    });
    if (refused && refusal) reportLocalError(refusal);
  }, []);

  const openTabIn = useCallback((p: UiPrefs, paneId: string, type: TabType, diagramId: string) => {
    const pane = p.panes.find((x) => x.id === paneId) ?? p.panes[0];
    if (!pane) return;
    const existing = pane.tabs.find((t) => t.type === type && t.diagramId === diagramId);
    if (existing) {
      pane.activeTabId = existing.id;
    } else {
      const tab: PaneTab = { id: uid("tab"), type, diagramId };
      pane.tabs.push(tab);
      pane.activeTabId = tab.id;
    }
    p.activePaneId = pane.id;
  }, []);

  const value: Ctx = useMemo(
    () => ({
      workspace,
      app,
      architecture,
      daemon,
      editable,
      setActiveApp: () => {},
      resetWorkspace: () => setPrefs(defaultPrefs()),

      addDiagram: (mode) => {
        if (!editable) return null;
        let created: string | null = null;
        editArchitecture((a) => {
          if (mode === "architecture") {
            const r = edit.addArchitectureDiagram(a);
            created = levelDiagramId(r.parentId);
            return r.arch;
          }
          const r = edit.addWorkflow(a, a.workflows.length + 1);
          created = workflowDiagramId(r.workflowId);
          return r.arch;
        });
        const id = created as string | null;
        if (id !== null) mutatePrefs((p) => openTabIn(p, p.activePaneId, "diagram", id));
        return id;
      },
      updateDiagram: (id, patch) => {
        const { title, subtitle } = patch;
        if (title === undefined && subtitle === undefined) return;
        apply((a) =>
          edit.patchDiagram(a, id, {
            ...(title !== undefined ? { title } : {}),
            ...(subtitle !== undefined ? { subtitle } : {}),
          }),
        );
      },
      deleteDiagram: (id) =>
        apply((a) => edit.deleteWorkflow(a, id), "Only workflows can be deleted from the list."),

      addNode: (diagramId, node, placed = true) => {
        apply((a) => edit.addNode(a, diagramId, node));
        if (placed && parseDiagramId(diagramId)?.mode === "workflow") {
          mutatePrefs((p) => {
            p.flowPositions[diagramId] = {
              ...p.flowPositions[diagramId],
              [node.id]: { x: node.x, y: node.y },
            };
          });
        }
      },
      updateNode: (diagramId, nodeId, patch) => {
        const ref = parseDiagramId(diagramId);
        const { x, y, ...rest } = patch;
        if (ref?.mode === "workflow" && x !== undefined && y !== undefined) {
          if (!editable) return;
          // Workflow layout is per-viewer: architecture.json has no workflow coordinates.
          mutatePrefs((p) => {
            p.flowPositions[diagramId] = { ...p.flowPositions[diagramId], [nodeId]: { x, y } };
          });
        }
        const archPatch: edit.NodePatch = {};
        if (ref?.mode === "architecture") {
          if (x !== undefined) archPatch.x = x;
          if (y !== undefined) archPatch.y = y;
        }
        if (rest.label !== undefined) archPatch.label = rest.label;
        if (rest.kind !== undefined) archPatch.kind = rest.kind;
        if ("description" in rest) archPatch.description = rest.description ?? "";
        if ("notes" in rest) archPatch.notes = rest.notes ?? "";
        if ("tech" in rest) archPatch.tech = rest.tech ?? [];
        if ("path" in rest) archPatch.path = rest.path ?? "";
        if (Object.keys(archPatch).length)
          apply((a) => edit.patchNode(a, diagramId, nodeId, archPatch));
      },
      deleteNode: (diagramId, nodeId) =>
        apply((a) => edit.deleteNode(a, diagramId, nodeId), "A workflow needs at least two steps."),
      addEdge: (diagramId, from, to) => apply((a) => edit.addEdge(a, diagramId, from, to)),
      updateEdge: (diagramId, from, to, patch) =>
        apply(
          (a) => edit.patchEdge(a, diagramId, from, to, patch),
          "Workflow arrows follow the step order; edit the steps instead.",
        ),
      deleteEdge: (diagramId, from, to) =>
        apply(
          (a) => edit.deleteEdge(a, diagramId, from, to),
          "A workflow needs at least two steps.",
        ),

      openTab: (paneId, type, diagramId) =>
        mutatePrefs((p) => openTabIn(p, paneId, type, diagramId)),
      closeTab: (paneId, tabId) =>
        mutatePrefs((p) => {
          const pane = p.panes.find((x) => x.id === paneId);
          if (!pane || pane.tabs.length <= 1) return;
          const idx = pane.tabs.findIndex((t) => t.id === tabId);
          pane.tabs = pane.tabs.filter((t) => t.id !== tabId);
          if (pane.activeTabId === tabId)
            pane.activeTabId = (pane.tabs[idx - 1] ?? pane.tabs[0])!.id;
        }),
      setActiveTab: (paneId, tabId) =>
        mutatePrefs((p) => {
          const pane = p.panes.find((x) => x.id === paneId);
          if (!pane) return;
          pane.activeTabId = tabId;
          p.activePaneId = paneId;
        }),
      setActivePane: (paneId) =>
        setPrefs((p) => (p.activePaneId === paneId ? p : { ...p, activePaneId: paneId })),
      splitPane: (diagramId) =>
        mutatePrefs((p) => {
          if (p.panes.length >= 3) return;
          const pane = makePane(diagramId);
          p.panes.push(pane);
          p.activePaneId = pane.id;
        }),
      closePane: (paneId) =>
        mutatePrefs((p) => {
          if (p.panes.length <= 1) return;
          p.panes = p.panes.filter((x) => x.id !== paneId);
          if (p.activePaneId === paneId) p.activePaneId = p.panes[0]!.id;
        }),
    }),
    [workspace, app, architecture, daemon, editable, apply, mutatePrefs, openTabIn],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}

export type KindGroup = { label: string; kinds: NodeKind[] };

export const architectureKindGroups: KindGroup[] = [
  { label: "Compute", kinds: ["service", "function", "container", "cluster", "worker"] },
  { label: "Data", kinds: ["database", "cache", "storage", "warehouse", "search"] },
  { label: "Messaging", kinds: ["queue", "topic", "stream", "webhook", "scheduler"] },
  { label: "Edge & network", kinds: ["gateway", "loadbalancer", "cdn", "dns", "firewall"] },
  { label: "Platform", kinds: ["auth", "secret", "monitoring", "analytics", "config", "ml"] },
  { label: "Clients", kinds: ["frontend", "mobile", "user", "external"] },
  { label: "Code", kinds: ["module", "file", "api"] },
];

export const workflowKindGroups: KindGroup[] = [
  { label: "Flow", kinds: ["step", "decision", "event", "timer", "approval"] },
  { label: "People", kinds: ["actor", "user"] },
  { label: "Systems", kinds: ["service", "external", "module", "webhook"] },
];

const flatten = (groups: KindGroup[]) => groups.flatMap((g) => g.kinds);

export const architectureKinds: NodeKind[] = flatten(architectureKindGroups);

export const workflowKinds: NodeKind[] = flatten(workflowKindGroups);

/** New node ids follow the architecture.json id rule: ^[a-z0-9][a-z0-9._-]{0,63}$ */
export function makeNode(kind: NodeKind, x: number, y: number, label?: string): DiagramNode {
  return {
    id: uid(kind.replace(/[^a-z0-9]/g, "") || "n"),
    label: label ?? `New ${kind}`,
    subtitle: "",
    kind,
    x,
    y,
  };
}
