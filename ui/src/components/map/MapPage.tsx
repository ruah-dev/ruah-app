// Map: the architecture / workflow canvas with the agent as its side panel.
// Visual patterns adapted from t3code apps/web/src/components/chat/ChatHeader.tsx and
// PanelLayoutControls.tsx (MIT): a borderless header row, quiet crumbs, icon controls on the right.
import { Fragment, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Code2,
  Columns2,
  Layers,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  ScanSearch,
  X,
} from "lucide-react";
import { useWorkspace, type Diagram, type Pane } from "@/lib/workspace";
import { useWorkbench, type PanelView } from "@/lib/workbench";
import { ROOT_DIAGRAM_ID, ancestry, indexArchitecture, levelDiagramId, parseDiagramId } from "@/lib/architecture";
import { dismissError, rescan } from "@/lib/daemon";
import { toast } from "sonner";
import { EditorCanvas } from "@/components/editor/EditorCanvas";
import { Palette } from "@/components/editor/Palette";
import { PropertiesPanel } from "@/components/editor/PropertiesPanel";
import { InspectorPanel } from "@/components/explorer/InspectorPanel";
import { kindStyles } from "@/components/explorer/kinds";
import { NewSessionButton } from "@/components/agent/AgentPanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export const iconButton =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";

/** Small segmented control (Cursor / t3code style): muted track, raised active item. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean | undefined; title?: string | undefined }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("flex h-7 items-center gap-0.5 rounded-lg bg-foreground/[0.045] p-0.5", className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-6 rounded-md px-2.5 text-[12.5px] transition-colors disabled:opacity-40",
            value === o.value
              ? "bg-surface-3 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusIndicators() {
  const { daemon } = useWorkspace();
  return (
    <>
      {daemon.source === "sample" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex h-6 shrink-0 items-center rounded-md bg-warn/10 px-2 text-[11.5px] text-warn">
              Sample data
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            No daemon connected — showing the bundled sample. Run archmap serve &lt;repo&gt; and
            open the page it serves.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {daemon.save === "pending" || daemon.save === "saving" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Saving
        </span>
      ) : null}
      {daemon.archError || daemon.lastError ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={dismissError}
              className="flex h-6 max-w-56 shrink-0 items-center gap-1.5 rounded-md bg-bad/10 px-2 text-[11.5px] text-bad"
            >
              <AlertTriangle className="size-3 shrink-0" />
              <span className="truncate">
                {daemon.save === "error"
                  ? "Save rejected"
                  : daemon.archError
                    ? "architecture.json invalid"
                    : (daemon.lastError?.message ?? "")}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-96 break-words">
            {daemon.archError ?? `${daemon.lastError?.code}: ${daemon.lastError?.message}`} — click
            to dismiss
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

function EditToggle() {
  const ws = useWorkspace();
  const wb = useWorkbench();
  return (
    <Segmented
      value={wb.editing ? "edit" : "view"}
      onChange={(v) => wb.setEditMode(v === "edit")}
      options={[
        { value: "view", label: "View" },
        {
          value: "edit",
          label: "Edit",
          disabled: !ws.editable,
          title: ws.editable ? undefined : "Editing saves to architecture.json and needs a connected daemon",
        },
      ]}
    />
  );
}

function Crumbs({ diagram }: { diagram: Diagram }) {
  const { architecture, app } = useWorkspace();
  const wb = useWorkbench();
  const ref = parseDiagramId(diagram.id);
  const index = indexArchitecture(architecture);
  const chain =
    ref && ref.mode === "architecture" && ref.parentId !== null ? ancestry(index, ref.parentId) : [];
  const atRoot = ref?.mode === "architecture" && ref.parentId === null;
  const root = diagram.mode === "workflow" ? "Workflows" : atRoot ? null : app.name;
  const items: { label: string; id?: string }[] = [];
  if (root) items.push({ label: root, ...(diagram.mode === "architecture" ? { id: ROOT_DIAGRAM_ID } : {}) });
  if (diagram.mode === "architecture")
    chain.forEach((n) => items.push({ label: n.name, id: levelDiagramId(n.id) }));
  else items.push({ label: diagram.title });
  if (items.length === 0) items.push({ label: diagram.title });
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px]">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={`${it.label}-${i}`}>
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" /> : null}
            {last || !it.id ? (
              <span className={cn("truncate", last ? "font-medium text-foreground" : "text-muted-foreground")}>
                {it.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => wb.openDiagram(it.id!)}
                className="shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {it.label}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

function PaletteTray() {
  const wb = useWorkbench();
  const [open, setOpen] = useState(true);
  return (
    <div className="control-glass absolute top-3 left-3 z-20 flex max-h-[calc(100%-4.5rem)] w-56 flex-col rounded-xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 shrink-0 items-center gap-2 px-3 text-left text-[12.5px] font-medium text-foreground"
      >
        <Plus className="size-3.5 text-muted-foreground" />
        Add element
        <ChevronRight
          className={cn("ms-auto size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="min-h-0 overflow-y-auto px-2 pb-2">
          <Palette groups={wb.kindGroups} onQuickAdd={(kind) => wb.addNodeAt(kind, 80, 80, false)} />
        </div>
      ) : null}
    </div>
  );
}

/** A new project (or a repo the scanner found nothing in): scan it, or start drawing. */
function EmptyMap() {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    setScanning(true);
    try {
      const r = await rescan();
      toast.success(r.nodes ? `Found ${r.nodes} elements` : "The scan found no elements", {
        description: r.nodes ? `${r.edges} links · ${Math.round(r.ms)} ms` : "Add them by hand from the palette.",
      });
    } catch (err) {
      toast.error("Scan failed", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setScanning(false);
    }
  };
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-2xl bg-popover/90 px-6 py-6 text-center shadow-[inset_0_0_0_1px_var(--color-hairline)] backdrop-blur">
        <span className="grid size-10 place-items-center rounded-xl bg-surface-3 text-muted-foreground">
          <Layers className="size-4.5" />
        </span>
        <div className="space-y-1">
          <p className="text-title font-medium">An empty map</p>
          <p className="text-ui-sm leading-relaxed text-muted-foreground">
            {wb.editing
              ? "Drag an element from the palette onto the canvas, double-click the canvas, or press N."
              : "Scan the repo to draw its services, modules and files — or start from scratch."}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning || !ws.editable}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-3 px-3 text-ui-sm text-foreground transition-colors hover:bg-surface-3/70 disabled:opacity-50"
          >
            {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
            {scanning ? "Scanning…" : "Scan repo"}
          </button>
          <button
            type="button"
            disabled={!ws.editable}
            onClick={() => {
              if (!wb.editing) wb.setEditMode(true);
              else wb.addNodeAt("service", 160, 120);
            }}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            {wb.editing ? "Add a service" : "Add your first element"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Canvas({ diagram, showTray }: { diagram: Diagram; showTray: boolean }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const emptyProject =
    ws.daemon.source === "daemon" &&
    ws.architecture.nodes.length === 0 &&
    diagram.mode === "architecture";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <EditorCanvas
        emptyHint={!emptyProject}
        diagram={diagram}
        editable={wb.editing}
        selectedNodeId={wb.selectedNodeId}
        selectedEdge={wb.selectedEdge}
        onSelectNode={wb.selectNode}
        onSelectEdge={wb.selectEdge}
        onMoveNode={(id, x, y) => ws.updateNode(diagram.id, id, { x, y })}
        onAddNode={(kind, x, y) => wb.addNodeAt(kind, x, y)}
        onRenameNode={(id, label) => ws.updateNode(diagram.id, id, { label })}
        onConnect={(from, to) => ws.addEdge(diagram.id, from, to)}
        onDeleteNode={(id) => {
          ws.deleteNode(diagram.id, id);
          wb.clearSelection();
        }}
        onDrill={wb.drill}
        onOpenCode={(node) => {
          wb.selectNode(node.id);
          wb.setPanelView("code");
          wb.setSheetOpen(true);
        }}
        onAsk={(node) => wb.ask(node)}
        onCopyContext={wb.copyContext}
      />
      {showTray ? <PaletteTray /> : null}
      {emptyProject ? <EmptyMap /> : null}
      {ws.daemon.source === null ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Connecting to the daemon…
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PaneMenu({ pane, diagram }: { pane: Pane; diagram: Diagram }) {
  const ws = useWorkspace();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={iconButton} aria-label="Canvas options">
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => ws.splitPane(diagram.id)}>
          <Columns2 className="text-muted-foreground" /> Split view
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ws.openTab(pane.id, "agent", diagram.id)}>
          <MessageSquare className="text-muted-foreground" /> Open agent in a tab
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ws.openTab(pane.id, "code", diagram.id)}>
          <Code2 className="text-muted-foreground" /> Open code in a tab
        </DropdownMenuItem>
        {ws.app.panes.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => ws.closePane(pane.id)}>
              <X className="text-muted-foreground" /> Close this view
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaneView({ pane, last }: { pane: Pane; last: boolean }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { app } = ws;
  const isActivePane = pane.id === app.activePaneId;
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]!;
  const diagram = app.diagrams.find((d) => d.id === tab.diagramId) ?? app.diagrams[0]!;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-canvas",
        isActivePane && app.panes.length > 1 ? "ring-1 ring-primary/20 ring-inset" : "",
      )}
      onPointerDownCapture={() => ws.setActivePane(pane.id)}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {pane.tabs.length > 1 ? (
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {pane.tabs.map((t) => {
              const d = app.diagrams.find((x) => x.id === t.diagramId);
              const title = t.type === "diagram" ? (d?.title ?? "Diagram") : t.type === "code" ? "Code" : "Agent";
              const active = t.id === pane.activeTabId;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "group/tab flex h-7 shrink-0 items-center gap-1 rounded-md ps-2.5 pe-1 text-[12.5px]",
                    active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <button type="button" className="max-w-36 truncate" onClick={() => ws.setActiveTab(pane.id, t.id)}>
                    {title}
                  </button>
                  <button
                    type="button"
                    aria-label="Close tab"
                    onClick={() => ws.closeTab(pane.id, t.id)}
                    className="grid size-4 place-items-center rounded opacity-0 group-hover/tab:opacity-100 hover:bg-accent"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {tab.type === "diagram" ? <Crumbs diagram={diagram} /> : null}
        <span className="flex-1" />
        {last ? (
          <>
            <StatusIndicators />
            <EditToggle />
          </>
        ) : null}
        <PaneMenu pane={pane} diagram={diagram} />
        {last && !wb.showPanel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="Show agent panel" className={iconButton} onClick={() => wb.setShowPanel(true)}>
                <PanelRightOpen className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Show agent panel</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {tab.type === "diagram" ? (
        <Canvas diagram={diagram} showTray={wb.editing && isActivePane && wb.sidebarCollapsed} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          <InspectorPanel
            node={wb.selectedNode}
            contextPath={wb.selectedNode ? wb.contextPathFor(wb.selectedNode) : ""}
            view={tab.type === "code" ? "code" : "agent"}
            onDrill={() => wb.selectedNode && wb.drill(wb.selectedNode)}
            onSelectNode={wb.openNode}
            onOpenPath={wb.openPath}
            onClearContext={wb.clearSelection}
            codePath={wb.codePath}
            keyboard={!(wb.showPanel && wb.panelView === "agent")}
          />
        </div>
      )}
    </div>
  );
}

/** The Map's side panel: Agent first, Details and Code as secondary views. */
export function SidePanel({ onClose, mobile = false }: { onClose?: () => void; mobile?: boolean }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const node = wb.selectedNode;
  const options: { value: PanelView; label: string }[] = [
    { value: "agent", label: "Agent" },
    { value: "details", label: "Details" },
    { value: "code", label: "Code" },
  ];
  if (wb.editing) options.push({ value: "properties", label: "Properties" });
  const view = !wb.editing && wb.panelView === "properties" ? "details" : wb.panelView;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-hairline px-3">
        <Segmented value={view} options={options} onChange={wb.setPanelView} />
        <span className="flex-1" />
        {view === "agent" ? <NewSessionButton daemon={ws.daemon} /> : null}
        {onClose && !mobile ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="Hide panel" className={iconButton} onClick={onClose}>
                <PanelRightClose className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Hide panel</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {view === "properties" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PropertiesPanel
              diagram={wb.activeDiagram}
              kinds={wb.kinds}
              node={node && wb.activeDiagram.nodes.some((n) => n.id === node.id) ? node : null}
              edge={wb.selectedEdge}
              editable={ws.editable}
              onNodePatch={(patch) => node && ws.updateNode(wb.activeDiagram.id, node.id, patch)}
              onEdgePatch={(patch) =>
                wb.selectedEdge &&
                ws.updateEdge(wb.activeDiagram.id, wb.selectedEdge.from, wb.selectedEdge.to, patch)
              }
              onDeleteNode={() => {
                if (!node) return;
                ws.deleteNode(wb.activeDiagram.id, node.id);
                wb.clearSelection();
              }}
              onDeleteEdge={() => {
                if (!wb.selectedEdge) return;
                ws.deleteEdge(wb.activeDiagram.id, wb.selectedEdge.from, wb.selectedEdge.to);
                wb.clearSelection();
              }}
              onDiagramPatch={(patch) => ws.updateDiagram(wb.activeDiagram.id, patch)}
            />
          </div>
        ) : (
          <InspectorPanel
            node={node}
            contextPath={node ? wb.contextPathFor(node) : ""}
            view={view}
            onDrill={() => node && wb.drill(node)}
            onSelectNode={wb.openNode}
            onOpenPath={wb.openPath}
            onClearContext={wb.clearSelection}
            codePath={wb.codePath}
            focusSignal={wb.askSignal}
          />
        )}
      </div>
    </div>
  );
}

function MobileMap() {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const node = wb.selectedNode;
  const kind = node ? kindStyles[node.kind] : null;
  const Icon = kind?.icon;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <Crumbs diagram={wb.activeDiagram} />
        <span className="flex-1" />
        <StatusIndicators />
        <EditToggle />
      </div>
      <Canvas diagram={wb.activeDiagram} showTray={false} />
      <div className="flex shrink-0 items-center gap-2 border-t border-hairline bg-background px-3 py-2">
        {node && Icon ? (
          <button
            type="button"
            onClick={() => {
              wb.setPanelView("details");
              wb.setSheetOpen(true);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Icon className={cn("size-4 shrink-0", kind!.color)} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{node.label}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {wb.contextPathFor(node)}
              </span>
            </span>
          </button>
        ) : (
          <span className="flex-1 text-[12.5px] text-muted-foreground">Tap an element to select it</span>
        )}
        <button
          type="button"
          onClick={() => {
            wb.setPanelView("agent");
            wb.setSheetOpen(true);
          }}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground"
        >
          <MessageSquare className="size-3.5" />
          {node ? "Ask" : "Agent"}
        </button>
      </div>
      <Sheet open={wb.sheetOpen} onOpenChange={wb.setSheetOpen}>
        <SheetContent side="bottom" className="flex h-[88dvh] flex-col gap-0 rounded-t-2xl border-hairline p-0 [&>button]:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Agent and details</SheetTitle>
          </SheetHeader>
          <div className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-foreground/15" />
          <div className="min-h-0 flex-1">
            <SidePanel mobile />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function MapPage() {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const isMobile = useIsMobile();
  const { app } = ws;

  if (isMobile) return <MobileMap />;

  return (
    <ResizablePanelGroup className="min-h-0 flex-1">
      <ResizablePanel id="canvas" minSize="30%">
        <ResizablePanelGroup className="min-h-0">
          {app.panes.map((pane, i) => (
            <Fragment key={pane.id}>
              {i > 0 ? <ResizableHandle className="bg-hairline" /> : null}
              <ResizablePanel id={pane.id} minSize="20%">
                <PaneView pane={pane} last={i === app.panes.length - 1} />
              </ResizablePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      </ResizablePanel>
      {wb.showPanel ? (
        <>
          <ResizableHandle className="bg-hairline" />
          <ResizablePanel
            id="agent"
            defaultSize="448px"
            minSize="360px"
            maxSize="680px"
            groupResizeBehavior="preserve-pixel-size"
          >
            <SidePanel onClose={() => wb.setShowPanel(false)} />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}

