import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { graphs, type DiagramNode, type Graph, type NodeKind } from "@/data/graphs";

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

const STORAGE_KEY = "atlas.workspace.v3";

export const uid = (prefix = "id") =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

const seedGroups: Record<string, string> = {
  system: "Cloud topology",
  "backend-internals": "Backend services",
  "routes-module": "Backend services",
  "frontend-internals": "Client apps",
  "frontend-module": "Client apps",
  "workflow-jira": "Delivery process",
  "workflow-request": "Runtime flows",
};

export const defaultGroupFor = (mode: DiagramMode) =>
  mode === "workflow" ? "Other flows" : "Other diagrams";

function seedDiagrams(): Diagram[] {
  return Object.values(graphs).map((g) => {
    const mode: DiagramMode = g.id.startsWith("workflow") ? "workflow" : "architecture";
    return {
      ...structuredClone(g),
      mode,
      group: seedGroups[g.id] ?? defaultGroupFor(mode),
    };
  });
}

function blankDiagram(mode: DiagramMode, index: number): Diagram {
  return {
    id: uid("dg"),
    mode,
    group: defaultGroupFor(mode),
    title: mode === "architecture" ? `Architecture ${index}` : `Workflow ${index}`,
    subtitle: mode === "architecture" ? "new diagram" : "new process flow",
    nodes: [],
    edges: [],
    groups: [],
  };
}

function makePane(diagramId: string): Pane {
  const tab: PaneTab = { id: uid("tab"), type: "diagram", diagramId };
  return { id: uid("pane"), tabs: [tab], activeTabId: tab.id };
}

function seedApp(): AppProject {
  const diagrams = seedDiagrams();
  const pane = makePane("system");
  return {
    id: uid("app"),
    name: "acme/platform",
    repo: "acme/platform",
    branch: "main",
    diagrams,
    panes: [pane],
    activePaneId: pane.id,
  };
}

export function newApp(name: string): AppProject {
  const arch = blankDiagram("architecture", 1);
  const flow = blankDiagram("workflow", 1);
  arch.title = "System topology";
  arch.subtitle = "draft";
  arch.group = "Cloud topology";
  flow.title = "Delivery flow";
  flow.subtitle = "draft";
  flow.group = "Delivery process";
  const pane = makePane(arch.id);
  return {
    id: uid("app"),
    name,
    repo: name,
    branch: "main",
    diagrams: [arch, flow],
    panes: [pane],
    activePaneId: pane.id,
  };
}

function initialWorkspace(): Workspace {
  const app = seedApp();
  return { apps: [app], activeAppId: app.id };
}

type Ctx = {
  workspace: Workspace;
  app: AppProject;
  setActiveApp: (id: string) => void;
  createApp: (name: string) => void;
  closeApp: (id: string) => void;
  renameApp: (id: string, name: string) => void;
  resetWorkspace: () => void;
  // diagrams
  addDiagram: (mode: DiagramMode) => string;
  updateDiagram: (id: string, patch: Partial<Omit<Diagram, "nodes" | "edges">>) => void;
  deleteDiagram: (id: string) => void;
  // nodes + edges
  addNode: (diagramId: string, node: DiagramNode) => void;
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
  const [workspace, setWorkspace] = useState<Workspace>(() => initialWorkspace());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Workspace;
        if (parsed?.apps?.length) setWorkspace(parsed);
      }
    } catch {
      /* ignore malformed storage */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    } catch {
      /* storage full or unavailable */
    }
  }, [workspace, hydrated]);

  const mutate = useCallback((fn: (w: Workspace) => void) => {
    setWorkspace((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }, []);

  const activeApp = useMemo(
    () => workspace.apps.find((a) => a.id === workspace.activeAppId) ?? workspace.apps[0]!,
    [workspace],
  );

  const mutateApp = useCallback(
    (fn: (a: AppProject) => void) => {
      mutate((w) => {
        const app = w.apps.find((a) => a.id === w.activeAppId) ?? w.apps[0];
        if (app) fn(app);
      });
    },
    [mutate],
  );

  const withDiagram = useCallback(
    (diagramId: string, fn: (d: Diagram) => void) => {
      mutateApp((app) => {
        const d = app.diagrams.find((x) => x.id === diagramId);
        if (d) fn(d);
      });
    },
    [mutateApp],
  );

  const value: Ctx = useMemo(
    () => ({
      workspace,
      app: activeApp,
      setActiveApp: (id) => mutate((w) => void (w.activeAppId = id)),
      createApp: (name) =>
        mutate((w) => {
          const app = newApp(name || `project-${w.apps.length + 1}`);
          w.apps.push(app);
          w.activeAppId = app.id;
        }),
      closeApp: (id) =>
        mutate((w) => {
          if (w.apps.length <= 1) return;
          w.apps = w.apps.filter((a) => a.id !== id);
          if (w.activeAppId === id) w.activeAppId = w.apps[0]!.id;
        }),
      renameApp: (id, name) =>
        mutate((w) => {
          const app = w.apps.find((a) => a.id === id);
          if (app) app.name = name;
        }),
      resetWorkspace: () => {
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* noop */
        }
        setWorkspace(initialWorkspace());
      },

      addDiagram: (mode) => {
        const created = blankDiagram(
          mode,
          activeApp.diagrams.filter((d) => d.mode === mode).length + 1,
        );
        mutateApp((app) => {
          app.diagrams.push(created);
          const pane = app.panes.find((p) => p.id === app.activePaneId) ?? app.panes[0];
          if (pane) {
            const tab: PaneTab = { id: uid("tab"), type: "diagram", diagramId: created.id };
            pane.tabs.push(tab);
            pane.activeTabId = tab.id;
          }
        });
        return created.id;
      },
      updateDiagram: (id, patch) => withDiagram(id, (d) => Object.assign(d, patch)),
      deleteDiagram: (id) =>
        mutateApp((app) => {
          if (app.diagrams.length <= 1) return;
          app.diagrams = app.diagrams.filter((d) => d.id !== id);
          const fallback = app.diagrams[0]!.id;
          app.panes.forEach((p) => {
            p.tabs = p.tabs.map((t) => (t.diagramId === id ? { ...t, diagramId: fallback } : t));
          });
        }),

      addNode: (diagramId, node) => withDiagram(diagramId, (d) => void d.nodes.push(node)),
      updateNode: (diagramId, nodeId, patch) =>
        withDiagram(diagramId, (d) => {
          const n = d.nodes.find((x) => x.id === nodeId);
          if (n) Object.assign(n, patch);
        }),
      deleteNode: (diagramId, nodeId) =>
        withDiagram(diagramId, (d) => {
          d.nodes = d.nodes.filter((n) => n.id !== nodeId);
          d.edges = d.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
        }),
      addEdge: (diagramId, from, to) =>
        withDiagram(diagramId, (d) => {
          if (from === to) return;
          if (d.edges.some((e) => e.from === from && e.to === to)) return;
          d.edges.push({ from, to });
        }),
      updateEdge: (diagramId, from, to, patch) =>
        withDiagram(diagramId, (d) => {
          const e = d.edges.find((x) => x.from === from && x.to === to);
          if (e) Object.assign(e, patch);
        }),
      deleteEdge: (diagramId, from, to) =>
        withDiagram(diagramId, (d) => {
          d.edges = d.edges.filter((e) => !(e.from === from && e.to === to));
        }),

      openTab: (paneId, type, diagramId) =>
        mutateApp((app) => {
          const pane = app.panes.find((p) => p.id === paneId) ?? app.panes[0];
          if (!pane) return;
          const existing = pane.tabs.find((t) => t.type === type && t.diagramId === diagramId);
          if (existing) {
            pane.activeTabId = existing.id;
            return;
          }
          const tab: PaneTab = { id: uid("tab"), type, diagramId };
          pane.tabs.push(tab);
          pane.activeTabId = tab.id;
          app.activePaneId = pane.id;
        }),
      closeTab: (paneId, tabId) =>
        mutateApp((app) => {
          const pane = app.panes.find((p) => p.id === paneId);
          if (!pane || pane.tabs.length <= 1) return;
          const idx = pane.tabs.findIndex((t) => t.id === tabId);
          pane.tabs = pane.tabs.filter((t) => t.id !== tabId);
          if (pane.activeTabId === tabId) {
            pane.activeTabId = (pane.tabs[idx - 1] ?? pane.tabs[0])!.id;
          }
        }),
      setActiveTab: (paneId, tabId) =>
        mutateApp((app) => {
          const pane = app.panes.find((p) => p.id === paneId);
          if (!pane) return;
          pane.activeTabId = tabId;
          app.activePaneId = paneId;
        }),
      setActivePane: (paneId) => mutateApp((app) => void (app.activePaneId = paneId)),
      splitPane: (diagramId) =>
        mutateApp((app) => {
          if (app.panes.length >= 3) return;
          const pane = makePane(diagramId);
          app.panes.push(pane);
          app.activePaneId = pane.id;
        }),
      closePane: (paneId) =>
        mutateApp((app) => {
          if (app.panes.length <= 1) return;
          app.panes = app.panes.filter((p) => p.id !== paneId);
          if (app.activePaneId === paneId) app.activePaneId = app.panes[0]!.id;
        }),
    }),
    [workspace, activeApp, mutate, mutateApp, withDiagram],
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

export function makeNode(kind: NodeKind, x: number, y: number, label?: string): DiagramNode {
  return {
    id: uid("n"),
    label: label ?? `New ${kind}`,
    subtitle: "",
    kind,
    x,
    y,
  };
}
