import { Fragment, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Columns2,
  HelpCircle,
  Layers,
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
import { EditorCanvas, type EdgeRef } from "@/components/editor/EditorCanvas";
import { Palette } from "@/components/editor/Palette";
import { Onboarding, useOnboarding } from "@/components/workspace/Onboarding";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { PropertiesPanel } from "@/components/editor/PropertiesPanel";
import { InspectorPanel, type ChatMessage } from "@/components/explorer/InspectorPanel";
import { RepoTree } from "@/components/explorer/RepoTree";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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
    <WorkspaceProvider>
      <Workbench />
    </WorkspaceProvider>
  );
}

function replyFor(node: DiagramNode, prompt: string, path: string) {
  if (/api request|endpoint|where.*handled/i.test(prompt)) {
    return `Requests for ${node.label} enter through the route layer, get validated, then hand off to the service. Persistence goes through the repository only.\n\nEntry point: ${path}`;
  }
  if (/break|fail|risk/i.test(prompt)) {
    return `If ${node.label} fails, the path degrades at its first dependent hop. Retries are bounded, then work lands in the dead-letter topic.`;
  }
  if (node.kind === "step") {
    return `${node.label} is a workflow state. Work arrives from the previous state and can only advance once its exit criteria are met.`;
  }
  return `${node.label} (${node.kind}) — ${node.description ?? "part of this diagram"}.\n\nSelected context: ${path}. Ask for a deeper trace and I will walk the chain step by step.`;
}

function Workbench() {
  const ws = useWorkspace();
  const { app, workspace } = ws;
  const isMobile = useIsMobile();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeRef | null>(null);
  const [inspectorTab, setInspectorTab] = useState("details");
  const [rightMode, setRightMode] = useState<"inspect" | "properties">("inspect");
  const [thread, setThread] = useState<ChatMessage[]>([]);
  const [editMode, setEditMode] = useState(true);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const onboarding = useOnboarding();

  const activePane = app.panes.find((p) => p.id === app.activePaneId) ?? app.panes[0]!;
  const activeTab =
    activePane.tabs.find((t) => t.id === activePane.activeTabId) ?? activePane.tabs[0]!;
  const activeDiagram =
    app.diagrams.find((d) => d.id === activeTab.diagramId) ?? app.diagrams[0]!;

  const selectedNode = useMemo(
    () => activeDiagram.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [activeDiagram, selectedNodeId],
  );

  const kindGroups =
    activeDiagram.mode === "workflow" ? workflowKindGroups : architectureKindGroups;
  const kinds: NodeKind[] = kindGroups.flatMap((g) => g.kinds);
  const contextPathFor = (node: DiagramNode) =>
    node.files?.[0]?.path ?? `${app.repo}/${activeDiagram.id}/${node.label}`;

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

  const ask = (node: DiagramNode, prompt: string) => {
    const path = contextPathFor(node);
    setSelectedNodeId(node.id);
    setRightMode("inspect");
    setInspectorTab("agent");
    setSheetOpen(true);
    setThread((t) => [
      ...t,
      { id: `${Date.now()}-u`, role: "user", text: prompt, context: path },
      { id: `${Date.now()}-a`, role: "assistant", text: replyFor(node, prompt, path) },
    ]);
  };

  const addNodeAt = (kind: NodeKind, x: number, y: number) => {
    const node = makeNode(kind, x, y);
    ws.addNode(activeDiagram.id, node);
    setSelectedNodeId(node.id);
    setSelectedEdge(null);
    setRightMode("properties");
  };

  const canvasFor = (diagram: Diagram) => (
    <EditorCanvas
      diagram={diagram}
      editable={editMode}
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
        setRightMode("inspect");
        setInspectorTab("code");
        setSheetOpen(true);
      }}
      onAsk={(node) => ask(node, "Explain this element and how it connects.")}
    />
  );

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
            drillTargets={app.diagrams.map((d) => ({ id: d.id, title: d.title }))}
            kinds={kinds}
            node={selectedNode}
            edge={selectedEdge}
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
          <InspectorPanel
            node={selectedNode}
            contextPath={selectedNode ? contextPathFor(selectedNode) : ""}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            thread={thread}
            onSend={(prompt) => selectedNode && ask(selectedNode, prompt)}
            onDrill={() => selectedNode && drill(selectedNode)}
          />
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
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${d.title}`}
        className="size-5 opacity-0 transition-opacity group-hover/row:opacity-100"
        onClick={() => ws.deleteDiagram(d.id)}
      >
        <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
      </Button>
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
            </div>
            <div className="space-y-2">
              {groupNames.map((groupName) => {
                const rows = diagrams.filter(
                  (d) => (d.group || defaultGroupFor(section.mode)) === groupName,
                );
                const key = `${section.mode}:${groupName}`;
                const isCollapsed = !!collapsedGroups[key];
                return (
                  <div key={key} className="rounded-[4px] border border-hairline/60 bg-surface-1/40">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedGroups((c) => ({ ...c, [key]: !c[key] }))
                      }
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
                t.type === "diagram" ? (d?.title ?? "Diagram") : t.type === "code" ? "Code" : "Agent";
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
                  <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
                    {diagram.subtitle}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground">
                    {diagram.nodes.length} elements · {diagram.edges.length} links
                  </span>
                </div>
                {canvasFor(diagram)}
              </>
            );
          }
          return (
            <div className="min-h-0 flex-1 overflow-hidden">
              <InspectorPanel
                node={selectedNode}
                contextPath={selectedNode ? contextPathFor(selectedNode) : ""}
                tab={tab.type === "code" ? "code" : "agent"}
                onTabChange={() => {}}
                thread={thread}
                onSend={(prompt) => selectedNode && ask(selectedNode, prompt)}
                onDrill={() => selectedNode && drill(selectedNode)}
              />
            </div>
          );
        })()}
      </div>
    );
  };

  const editToggle = (
    <div className="flex h-7 items-center rounded-md border border-hairline bg-surface-2 p-0.5">
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
          onClick={() => setEditMode(item.id)}
          className={cn(
            "h-6 gap-1.5 rounded-[4px] px-2 text-[11px] shadow-none",
            editMode === item.id
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
      onSelect={(id) => {
        ws.setActiveApp(id);
        clearSelection();
      }}
      onCreate={(name) => {
        ws.createApp(name);
        clearSelection();
      }}
      onClose={(id) => ws.closeApp(id)}
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

  const onboardingDialog = (
    <Onboarding open={onboarding.open} onOpenChange={onboarding.setOpen} />
  );

  if (isMobile) {
    return (
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas">
        {onboardingDialog}
        <header className="grid h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-hairline bg-surface-1 px-2.5">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Open projects and diagrams">
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
                  {helpButton}
                </div>
                {diagramList}
                {editMode ? (
                  <Palette groups={kindGroups} onQuickAdd={(kind) => addNodeAt(kind, 80, 80)} />
                ) : null}
                <div className="py-2">
                  <RepoTree
                    activeNodeId={selectedNodeId}
                    onOpen={() => {
                      setNavOpen(false);
                      setRightMode("inspect");
                      setInspectorTab("code");
                    }}
                  />
                </div>
              </div>
            </SheetContent>
          </Sheet>

          <span className="min-w-0 truncate text-center font-mono text-[11px] text-muted-foreground">
            {app.name}
          </span>
          {editToggle}
        </header>

        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-3">
          <span className="truncate font-display text-[12px] font-medium text-foreground">
            {activeDiagram.title}
          </span>
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
          <span className="hidden items-center gap-2 font-mono text-[10.5px] text-muted-foreground lg:flex">
            {app.repo}
            <Badge variant="outline" className="h-4 rounded-sm px-1 font-mono text-[9.5px]">
              {app.branch}
            </Badge>
          </span>

          <div className="mx-auto flex items-center gap-2">{editToggle}</div>

          <Button
            type="button"
            variant="outline"
            className="h-7 w-52 justify-start gap-2 rounded-md border-hairline bg-surface-2 px-2.5 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-surface-3"
          >
            <Search className="size-3.5" />
            Search elements…
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
                    {editMode ? (
                      <Palette groups={kindGroups} onQuickAdd={(kind) => addNodeAt(kind, 80, 80)} />
                    ) : null}
                    <div className="py-2">
                      <RepoTree
                        activeNodeId={selectedNodeId}
                        onOpen={() => {
                          setRightMode("inspect");
                          setInspectorTab("code");
                        }}
                      />
                    </div>
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
