import { Fragment, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns2,
  HelpCircle,
  Layers,
  Loader2,
  Menu,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { DiagramNode, NodeKind } from "@/data/graphs";
import {
  WorkspaceProvider,
  architectureKindGroups,
  defaultGroupFor,
  makeNode,
  useWorkspace,
  workflowKindGroups,
  type Diagram,
  type Pane,
} from "@/lib/workspace";
import {
  ROOT_DIAGRAM_ID,
  ancestry,
  contextPathOf,
  homeDiagramId,
  indexArchitecture,
  kindFor,
  levelDiagramId,
  nodeForPath,
  parseDiagramId,
  toRepoTree,
} from "@/lib/architecture";
import { dismissError, fetchContext, setFocus, type DaemonState } from "@/lib/daemon";
import { EditorCanvas, type EdgeRef } from "@/components/editor/EditorCanvas";
import { Palette } from "@/components/editor/Palette";
import { Onboarding, useOnboarding } from "@/components/workspace/Onboarding";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { PropertiesPanel } from "@/components/editor/PropertiesPanel";
import { InspectorPanel } from "@/components/explorer/InspectorPanel";
import { RepoTree } from "@/components/explorer/RepoTree";
import { kindStyles } from "@/components/explorer/kinds";
import { agentDotClass } from "@/components/agent/AgentPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Atlas — Architecture & Workflow Workspace" },
      {
        name: "description",
        content:
          "Open several projects at once, split windows side by side, and edit architecture diagrams and delivery workflows with an agent on every element.",
      },
      { property: "og:title", content: "Atlas — Architecture & Workflow Workspace" },
      {
        property: "og:description",
        content:
          "A multi-project workspace for mapping systems: editable diagrams from cloud topology down to the exact file, plus workflow editing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <TooltipProvider delayDuration={200}>
      <WorkspaceProvider>
        <Workbench />
      </WorkspaceProvider>
    </TooltipProvider>
  );
}

function connectionLabel(daemon: DaemonState) {
  if (daemon.source === "sample") return "no daemon connected — showing sample data";
  if (daemon.connection === "connecting") return "connecting to daemon…";
  if (daemon.connection === "closed") return "daemon disconnected — reconnecting";
  const agent = daemon.agent?.agent;
  return [
    `daemon ${daemon.daemonVersion ?? ""}`.trim() + " connected",
    agent ? `${agent.name} ${agent.version}` : "agent",
    daemon.agent?.state ?? "unknown",
  ].join(" · ");
}

function StatusDot({ daemon }: { daemon: DaemonState }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={connectionLabel(daemon)}
          className={cn("inline-block size-1.5 shrink-0 rounded-full", agentDotClass(daemon))}
        />
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10.5px]">{connectionLabel(daemon)}</TooltipContent>
    </Tooltip>
  );
}

function Workbench() {
  const ws = useWorkspace();
  const { app, workspace, architecture, daemon } = ws;
  const isMobile = useIsMobile();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeRef | null>(null);
  const [inspectorTab, setInspectorTab] = useState("details");
  const [rightMode, setRightMode] = useState<"inspect" | "properties">("inspect");
  const [codePath, setCodePath] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(true);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const onboarding = useOnboarding();

  const editing = editMode && ws.editable;
  const archIndex = useMemo(() => indexArchitecture(architecture), [architecture]);
  const repoTree = useMemo(() => toRepoTree(architecture), [architecture]);

  const activePane = app.panes.find((p) => p.id === app.activePaneId) ?? app.panes[0]!;
  const activeTab =
    activePane.tabs.find((t) => t.id === activePane.activeTabId) ?? activePane.tabs[0]!;
  const activeDiagram = app.diagrams.find((d) => d.id === activeTab.diagramId) ?? app.diagrams[0]!;

  // Selection is an architecture node id; resolve it on the active diagram first, else anywhere.
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
    if (selectedNodeId && !archIndex.byId.has(selectedNodeId)) setSelectedNodeId(null);
  }, [archIndex, selectedNodeId]);

  useEffect(() => {
    setFocus(selectedNode?.id ?? null);
  }, [selectedNode?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const kindGroups =
    activeDiagram.mode === "workflow" ? workflowKindGroups : architectureKindGroups;
  const kinds: NodeKind[] = kindGroups.flatMap((g) => g.kinds);
  const contextPathFor = (node: DiagramNode) =>
    contextPathOf({
      name: node.label,
      ...(node.path !== undefined ? { path: node.path } : {}),
      ...(node.filePaths !== undefined ? { files: node.filePaths } : {}),
    });

  const clearSelection = () => {
    setSelectedNodeId(null);
    setSelectedEdge(null);
  };

  const openDiagram = (diagramId: string, paneId = activePane.id) => {
    ws.openTab(paneId, "diagram", diagramId);
    clearSelection();
  };

  const drill = (node: DiagramNode) => {
    if (!node.drill) return;
    if (!app.diagrams.some((d) => d.id === node.drill)) return;
    openDiagram(node.drill);
  };

  /** Show a node on the diagram it lives on (its drill level or workflow) and select it. */
  const openNode = (nodeId: string) => {
    if (!activeDiagram.nodes.some((n) => n.id === nodeId)) {
      const home = homeDiagramId(architecture, nodeId, archIndex);
      if (home) ws.openTab(activePane.id, "diagram", home);
    }
    setSelectedNodeId(nodeId);
    setSelectedEdge(null);
    setRightMode("inspect");
  };

  /** Open a repo path: select the node that owns it and show the file in the Code tab. */
  const openPath = (path: string) => {
    const owner = nodeForPath(architecture, path);
    if (owner) openNode(owner.id);
    setCodePath(path);
    setInspectorTab("code");
    setRightMode("inspect");
    setShowRight(true);
    setSheetOpen(true);
  };

  const ask = (node: DiagramNode) => {
    setSelectedNodeId(node.id);
    setRightMode("inspect");
    setInspectorTab("agent");
    setShowRight(true);
    setSheetOpen(true);
  };

  const copyContext = async (node: DiagramNode) => {
    try {
      const text = await fetchContext(node.id);
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const addNodeAt = (kind: NodeKind, x: number, y: number, placed = true) => {
    if (!ws.editable) return;
    const node = makeNode(kind, x, y);
    ws.addNode(activeDiagram.id, node, placed);
    setSelectedNodeId(node.id);
    setSelectedEdge(null);
    setRightMode("properties");
  };

  const canvasFor = (diagram: Diagram) => (
    <EditorCanvas
      diagram={diagram}
      editable={editing}
      selectedNodeId={selectedNodeId}
      selectedEdge={selectedEdge}
      onSelectNode={(id) => {
        setSelectedNodeId(id);
        if (id) setSelectedEdge(null);
      }}
      onSelectEdge={(edge) => {
        setSelectedEdge(edge);
        if (edge) setRightMode("properties");
      }}
      onMoveNode={(id, x, y) => ws.updateNode(diagram.id, id, { x, y })}
      onAddNode={(kind, x, y) => addNodeAt(kind, x, y)}
      onRenameNode={(id, label) => ws.updateNode(diagram.id, id, { label })}
      onConnect={(from, to) => ws.addEdge(diagram.id, from, to)}
      onDeleteNode={(id) => {
        ws.deleteNode(diagram.id, id);
        clearSelection();
      }}
      onDrill={drill}
      onOpenCode={(node) => {
        setSelectedNodeId(node.id);
        setCodePath(null);
        setRightMode("inspect");
        setInspectorTab("code");
        setShowRight(true);
        setSheetOpen(true);
      }}
      onAsk={ask}
      onCopyContext={copyContext}
    />
  );

  const inspectorProps = {
    node: selectedNode,
    contextPath: selectedNode ? contextPathFor(selectedNode) : "",
    onDrill: () => selectedNode && drill(selectedNode),
    onSelectNode: openNode,
    onOpenPath: openPath,
    codePath,
  };

  const inspector = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
        {(
          [
            { id: "inspect", label: "Inspect", icon: Layers },
            { id: "properties", label: "Properties", icon: Settings2 },
          ] as const
        ).map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="sm"
            onClick={() => setRightMode(item.id)}
            className={cn(
              "h-6.5 gap-1.5 rounded-[4px] px-2 text-[11px] shadow-none",
              rightMode === item.id
                ? "bg-surface-3 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <item.icon className="size-3.5" />
            {item.label}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rightMode === "properties" ? (
          <PropertiesPanel
            diagram={activeDiagram}
            kinds={kinds}
            node={
              selectedNode && activeDiagram.nodes.some((n) => n.id === selectedNode.id)
                ? selectedNode
                : null
            }
            edge={selectedEdge}
            editable={ws.editable}
            onNodePatch={(patch) =>
              selectedNode && ws.updateNode(activeDiagram.id, selectedNode.id, patch)
            }
            onEdgePatch={(patch) =>
              selectedEdge &&
              ws.updateEdge(activeDiagram.id, selectedEdge.from, selectedEdge.to, patch)
            }
            onDeleteNode={() => {
              if (!selectedNode) return;
              ws.deleteNode(activeDiagram.id, selectedNode.id);
              clearSelection();
            }}
            onDeleteEdge={() => {
              if (!selectedEdge) return;
              ws.deleteEdge(activeDiagram.id, selectedEdge.from, selectedEdge.to);
              clearSelection();
            }}
            onDiagramPatch={(patch) => ws.updateDiagram(activeDiagram.id, patch)}
          />
        ) : (
          <InspectorPanel {...inspectorProps} tab={inspectorTab} onTabChange={setInspectorTab} />
        )}
      </div>
    </div>
  );

  const diagramRow = (d: Diagram) => (
    <div key={d.id} className="group/row relative flex items-center">
      <button
        type="button"
        onClick={() => {
          openDiagram(d.id);
          setNavOpen(false);
        }}
        className={cn(
          "relative min-w-0 flex-1 rounded-[4px] px-2.5 py-1.5 text-left transition-colors duration-150",
          activeDiagram.id === d.id
            ? "bg-surface-3 text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-primary"
            : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <span className="block truncate text-[11.5px] font-medium">{d.title}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {d.subtitle || `${d.nodes.length} elements`}
        </span>
      </button>
      {ws.editable && d.mode === "workflow" ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${d.title}`}
          className="size-5 opacity-0 transition-opacity group-hover/row:opacity-100"
          onClick={() => ws.deleteDiagram(d.id)}
        >
          <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
        </Button>
      ) : null}
    </div>
  );

  const diagramList = (
    <div className="space-y-3 px-2 py-2.5">
      {(
        [
          { mode: "architecture" as const, label: "Architecture", icon: Layers },
          { mode: "workflow" as const, label: "Workflows", icon: Workflow },
        ] as const
      ).map((section) => {
        const diagrams = app.diagrams.filter((d) => d.mode === section.mode);
        const groupNames = Array.from(
          new Set(diagrams.map((d) => d.group || defaultGroupFor(section.mode))),
        );
        return (
          <div key={section.mode}>
            <div className="flex items-center justify-between px-1 pb-1.5">
              <p className="flex items-center gap-1.5 text-[9.5px] font-semibold text-muted-foreground uppercase">
                <section.icon className="size-3" />
                {section.label}
                <span className="font-mono text-[9px] text-muted-foreground/70 normal-case">
                  {diagrams.length}
                </span>
              </p>
              {ws.editable ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  aria-label={`New ${section.label} diagram`}
                  onClick={() => {
                    ws.addDiagram(section.mode);
                    clearSelection();
                    setNavOpen(false);
                  }}
                >
                  <Plus className="size-3" />
                </Button>
              ) : null}
            </div>
            {diagrams.length === 0 ? (
              <p className="px-1 text-[10.5px] text-muted-foreground">
                {section.mode === "workflow"
                  ? "No workflows in architecture.json."
                  : "No diagrams."}
              </p>
            ) : null}
            <div className="space-y-2">
              {groupNames.map((groupName) => {
                const rows = diagrams.filter(
                  (d) => (d.group || defaultGroupFor(section.mode)) === groupName,
                );
                const key = `${section.mode}:${groupName}`;
                const isCollapsed = !!collapsedGroups[key];
                return (
                  <div
                    key={key}
                    className="rounded-[4px] border border-hairline/60 bg-surface-1/40"
                  >
                    <button
                      type="button"
                      onClick={() => setCollapsedGroups((c) => ({ ...c, [key]: !c[key] }))}
                      className="flex w-full items-center gap-1 px-1.5 py-1 text-left text-[9.5px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="size-3" />
                      ) : (
                        <ChevronDown className="size-3" />
                      )}
                      <span className="truncate">{groupName}</span>
                      <span className="ml-auto font-mono text-[9px] normal-case">
                        {rows.length}
                      </span>
                    </button>
                    {isCollapsed ? null : (
                      <div className="space-y-0.5 px-1 pb-1">{rows.map(diagramRow)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  const crumbsFor = (diagram: Diagram) => {
    const ref = parseDiagramId(diagram.id);
    if (!ref || ref.mode !== "architecture" || ref.parentId === null) return null;
    const chain = ancestry(archIndex, ref.parentId);
    return (
      <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden font-mono text-[10.5px]">
        <button
          type="button"
          onClick={() => openDiagram(ROOT_DIAGRAM_ID)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          top
        </button>
        {chain.map((n, i) => (
          <Fragment key={n.id}>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => openDiagram(levelDiagramId(n.id))}
              className={cn(
                "truncate",
                i === chain.length - 1
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {n.name}
            </button>
          </Fragment>
        ))}
      </span>
    );
  };

  const paneView = (pane: Pane) => {
    const isActivePane = pane.id === app.activePaneId;
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-col bg-canvas",
          isActivePane && app.panes.length > 1 ? "ring-1 ring-ring/25 ring-inset" : "",
        )}
        onPointerDownCapture={() => ws.setActivePane(pane.id)}
      >
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline bg-surface-1 px-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {pane.tabs.map((t) => {
              const d = app.diagrams.find((x) => x.id === t.diagramId);
              const Icon = t.type === "code" ? Code2 : t.type === "agent" ? Sparkles : Layers;
              const title =
                t.type === "diagram"
                  ? (d?.title ?? "Diagram")
                  : t.type === "code"
                    ? "Code"
                    : "Agent";
              const active = t.id === pane.activeTabId;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "group/tab flex h-7 shrink-0 items-center gap-1.5 rounded-[4px] px-2",
                    active
                      ? "bg-surface-3 text-foreground"
                      : "text-muted-foreground hover:bg-surface-2",
                  )}
                >
                  <button
                    type="button"
                    className="flex items-center gap-1.5"
                    onClick={() => ws.setActiveTab(pane.id, t.id)}
                  >
                    <Icon className="size-3.5" />
                    <span className="max-w-32 truncate text-[11px]">{title}</span>
                  </button>
                  {pane.tabs.length > 1 ? (
                    <button
                      type="button"
                      aria-label="Close tab"
                      onClick={() => ws.closeTab(pane.id, t.id)}
                      className="opacity-0 group-hover/tab:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Open agent tab"
            title="Agent in a tab"
            onClick={() => ws.openTab(pane.id, "agent", activeDiagram.id)}
          >
            <Sparkles className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Open code tab"
            title="Code in a tab"
            onClick={() => ws.openTab(pane.id, "code", activeDiagram.id)}
          >
            <Code2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Split window"
            onClick={() => ws.splitPane(activeDiagram.id)}
          >
            <Columns2 className="size-3.5" />
          </Button>
          {app.panes.length > 1 ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Close window"
              onClick={() => ws.closePane(pane.id)}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {(() => {
          const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]!;
          const diagram = app.diagrams.find((d) => d.id === tab.diagramId) ?? app.diagrams[0]!;
          if (tab.type === "diagram") {
            return (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-3">
                  {crumbsFor(diagram)}
                  <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
                    {diagram.subtitle}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground">
                    {diagram.nodes.length} elements · {diagram.edges.length} links
                  </span>
                </div>
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {canvasFor(diagram)}
                  {daemon.source === null ? (
                    <div className="pointer-events-none absolute inset-0 grid place-items-center">
                      <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> connecting to archmap daemon…
                      </p>
                    </div>
                  ) : null}
                </div>
              </>
            );
          }
          return (
            <div className="min-h-0 flex-1 overflow-hidden">
              <InspectorPanel
                {...inspectorProps}
                tab={tab.type}
                onTabChange={() => {}}
                only={tab.type === "code" ? "code" : "agent"}
                keyboard={!(showRight && rightMode === "inspect" && inspectorTab === "agent")}
              />
            </div>
          );
        })()}
      </div>
    );
  };

  const editToggle = (
    <div
      className="flex h-7 items-center rounded-md border border-hairline bg-surface-2 p-0.5"
      title={
        ws.editable
          ? undefined
          : "Editing saves to architecture.json and needs a connected archmap daemon"
      }
    >
      {(
        [
          { id: true, label: "Edit", icon: Pencil },
          { id: false, label: "View", icon: Layers },
        ] as const
      ).map((item) => (
        <Button
          key={String(item.id)}
          variant="ghost"
          size="sm"
          disabled={item.id && !ws.editable}
          onClick={() => setEditMode(item.id)}
          className={cn(
            "h-6 gap-1.5 rounded-[4px] px-2 text-[11px] shadow-none",
            editing === item.id
              ? "bg-surface-3 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <item.icon className="size-3.5" />
          {item.label}
        </Button>
      ))}
    </div>
  );

  const projectSwitcher = (
    <ProjectSwitcher
      workspace={workspace}
      dotClass={agentDotClass(daemon)}
      detail={daemon.root}
      onSelect={() => clearSelection()}
    />
  );

  const statusBadges = (
    <>
      {daemon.source === "sample" ? (
        <Badge
          variant="outline"
          className="h-5 shrink-0 rounded-sm border-warn/40 px-1.5 font-mono text-[9.5px] text-warn"
        >
          Sample data — no daemon connected
        </Badge>
      ) : null}
      {daemon.save === "pending" || daemon.save === "saving" ? (
        <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">saving…</span>
      ) : null}
      {daemon.archError || daemon.lastError ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={dismissError}
              className="flex max-w-56 shrink-0 items-center gap-1 rounded-sm border border-bad/40 px-1.5 py-0.5 font-mono text-[9.5px] text-bad"
            >
              <AlertTriangle className="size-3 shrink-0" />
              <span className="truncate">
                {daemon.save === "error"
                  ? "save rejected"
                  : daemon.archError
                    ? "architecture.json invalid"
                    : (daemon.lastError?.message ?? "")}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-96 font-mono text-[10.5px] break-words">
            {daemon.archError ?? `${daemon.lastError?.code}: ${daemon.lastError?.message}`} (click
            to dismiss)
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );

  const searchDialog = (
    <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
      <CommandInput placeholder="Search elements, paths, workflows…" className="text-[12px]" />
      <CommandList>
        <CommandEmpty className="py-4 text-center text-[11px] text-muted-foreground">
          Nothing in architecture.json matches.
        </CommandEmpty>
        <CommandGroup heading="Elements">
          {architecture.nodes.map((n) => {
            const kind = kindStyles[kindFor(n.type)];
            const Icon = kind.icon;
            return (
              <CommandItem
                key={n.id}
                value={`${n.name} ${n.path ?? ""} ${n.id} ${n.type} ${(n.files ?? []).join(" ")}`}
                onSelect={() => {
                  openNode(n.id);
                  setSearchOpen(false);
                  setNavOpen(false);
                }}
                className="gap-2 rounded-[4px] text-[11.5px]"
              >
                <Icon className={cn("size-3.5", kind.color)} />
                <span className="truncate font-mono">{n.name}</span>
                <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                  {n.path ?? n.type}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {architecture.workflows.length ? (
          <CommandGroup heading="Workflows">
            {architecture.workflows.map((w) => (
              <CommandItem
                key={w.id}
                value={`workflow ${w.name} ${w.id}`}
                onSelect={() => {
                  openDiagram(`flow:${w.id}`);
                  setSearchOpen(false);
                  setNavOpen(false);
                }}
                className="gap-2 rounded-[4px] text-[11.5px]"
              >
                <Workflow className="size-3.5 text-node-step" />
                {w.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );

  const repoPanel = (
    <RepoTree
      tree={repoTree}
      repo={app.repo}
      activeNodeId={selectedNodeId}
      onOpen={(nodeId, path) => {
        setNavOpen(false);
        const entry = architecture.nodes.find((n) => n.id === nodeId);
        const isFile =
          (entry?.files ?? []).includes(path) ||
          /\.[A-Za-z0-9]+$/.test(path.split("/").pop() ?? "");
        if (isFile) openPath(path);
        else openNode(nodeId);
      }}
    />
  );

  const helpButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 rounded-md"
      aria-label="Open getting started guide"
      onClick={() => onboarding.setOpen(true)}
    >
      <HelpCircle className="size-4 text-muted-foreground" />
    </Button>
  );

  const onboardingDialog = <Onboarding open={onboarding.open} onOpenChange={onboarding.setOpen} />;

  if (isMobile) {
    return (
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas">
        {onboardingDialog}
        {searchDialog}
        <header className="grid h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-hairline bg-surface-1 px-2.5">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Open projects and diagrams"
              >
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="flex w-[88vw] flex-col gap-0 border-hairline bg-surface-1 p-0 sm:max-w-sm"
            >
              <SheetHeader className="border-b border-hairline px-3 py-3">
                <SheetTitle className="font-display text-[13px] font-semibold">
                  Atlas Workspace
                </SheetTitle>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="flex items-center gap-2 border-b border-hairline px-2 py-2">
                  {projectSwitcher}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Search"
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="size-4" />
                  </Button>
                  {helpButton}
                </div>
                {daemon.source === "sample" || daemon.archError || daemon.lastError ? (
                  <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
                    {statusBadges}
                  </div>
                ) : null}
                {diagramList}
                {editing ? (
                  <Palette
                    groups={kindGroups}
                    onQuickAdd={(kind) => addNodeAt(kind, 80, 80, false)}
                  />
                ) : null}
                <div className="py-2">{repoPanel}</div>
              </div>
            </SheetContent>
          </Sheet>

          <span className="flex min-w-0 items-center justify-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <StatusDot daemon={daemon} />
            <span className="truncate">{app.name}</span>
          </span>
          {editToggle}
        </header>

        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-3">
          <span className="truncate font-display text-[12px] font-medium text-foreground">
            {activeDiagram.title}
          </span>
          {daemon.source === "sample" ? (
            <span className="shrink-0 font-mono text-[9px] text-warn">sample</span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground">
            {activeDiagram.nodes.length} elements
          </span>
        </div>

        {canvasFor(activeDiagram)}

        {selectedNode ? (
          <div className="shrink-0 border-t border-hairline bg-surface-1 px-3 py-2">
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="flex w-full items-center gap-2 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[12px] font-medium text-foreground">
                  {selectedNode.label}
                </span>
                <span className="block truncate font-mono text-[10px] text-primary">
                  {contextPathFor(selectedNode)}
                </span>
              </span>
              <span className="shrink-0 rounded-[4px] border border-hairline bg-surface-2 px-2 py-1 text-[10.5px] text-muted-foreground">
                Inspect
              </span>
            </button>
          </div>
        ) : null}

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            className="flex h-[80dvh] flex-col gap-0 rounded-t-lg border-hairline bg-surface-1 p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Inspector</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden">{inspector}</div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background p-3">
      {onboardingDialog}
      {searchDialog}
      <div className="workspace-shell flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-surface-1">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-surface-1 px-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-6 place-items-center rounded-[4px] bg-foreground font-display text-[11px] font-semibold text-background">
              A
            </span>
            <span className="font-display text-[13px] font-semibold">Atlas Workspace</span>
          </div>
          <Separator orientation="vertical" className="h-5 bg-hairline" />
          {projectSwitcher}
          <span
            className="hidden min-w-0 items-center gap-2 font-mono text-[10.5px] text-muted-foreground lg:flex"
            title={daemon.root ?? undefined}
          >
            <StatusDot daemon={daemon} />
            <span className="truncate">{app.repo}</span>
          </span>
          {statusBadges}

          <div className="mx-auto flex items-center gap-2">{editToggle}</div>

          <Button
            type="button"
            variant="outline"
            onClick={() => setSearchOpen(true)}
            className="h-7 w-52 justify-start gap-2 rounded-md border-hairline bg-surface-2 px-2.5 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-surface-3"
          >
            <Search className="size-3.5" />
            Search elements…
            <span className="ml-auto font-mono text-[10px]">/</span>
          </Button>
          {helpButton}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md"
            aria-label="Toggle left panel"
            onClick={() => setShowLeft((v) => !v)}
          >
            <PanelLeft
              className={cn("size-4", showLeft ? "text-foreground" : "text-muted-foreground")}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md"
            aria-label="Toggle inspector panel"
            onClick={() => setShowRight((v) => !v)}
          >
            <PanelRight
              className={cn("size-4", showRight ? "text-foreground" : "text-muted-foreground")}
            />
          </Button>
        </header>

        <ResizablePanelGroup className="min-h-0 flex-1">
          {showLeft ? (
            <>
              <ResizablePanel defaultSize="19%" minSize="12%" maxSize="30%">
                <div className="panel-glass flex h-full min-h-0 flex-col">
                  <div className="min-h-0 flex-1 overflow-auto">
                    {diagramList}
                    {editing ? (
                      <Palette
                        groups={kindGroups}
                        onQuickAdd={(kind) => addNodeAt(kind, 80, 80, false)}
                      />
                    ) : null}
                    <div className="py-2">{repoPanel}</div>
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle className="bg-hairline" />
            </>
          ) : null}

          <ResizablePanel defaultSize={showRight ? "55%" : "81%"} minSize="30%">
            <ResizablePanelGroup className="min-h-0">
              {app.panes.map((pane, i) => (
                <Fragment key={pane.id}>
                  {i > 0 ? <ResizableHandle className="bg-hairline" /> : null}
                  <ResizablePanel minSize="20%">{paneView(pane)}</ResizablePanel>
                </Fragment>
              ))}
            </ResizablePanelGroup>
          </ResizablePanel>

          {showRight ? (
            <>
              <ResizableHandle className="bg-hairline" />
              <ResizablePanel defaultSize="26%" minSize="18%" maxSize="44%">
                <div className="panel-glass h-full min-h-0">{inspector}</div>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
