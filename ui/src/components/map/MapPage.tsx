// Map: the architecture / workflow canvas with the agent as its side panel.
// Visual patterns adapted from t3code apps/web/src/components/chat/ChatHeader.tsx and
// PanelLayoutControls.tsx (MIT): a borderless header row, quiet crumbs, icon controls on the right.
import { Fragment, useMemo, useState } from "react";
import { ArrowLeft,
  AlertTriangle,
  ChevronRight,
  Code2,
  Columns2,
  Download,
  HardDrive,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  Pin,
  Plus,
  RefreshCw,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { useWorkspace, type Diagram, type Pane } from "@/lib/workspace";
import { useWorkbench, type PanelView } from "@/lib/workbench";
import {
  ROOT_DIAGRAM_ID,
  ancestry,
  canDrill,
  indexArchitecture,
  kindFor,
  levelDiagramId,
  parseDiagramId,
} from "@/lib/architecture";
import type { ArchNode } from "@/lib/contracts";
import { asExpanded, invalidateExpansions, requestExpansion } from "@/lib/expand";
import { daemonActions, dismissError, rescan } from "@/lib/daemon";
import { downloadDrawio } from "@/lib/export";
import { toast } from "sonner";
import { isCloudDiagramId } from "@/lib/integrations";
import { EditorCanvas, type SearchHit } from "@/components/editor/EditorCanvas";
import { Palette } from "@/components/editor/Palette";
import { PropertiesPanel } from "@/components/editor/PropertiesPanel";
import { InspectorPanel } from "@/components/explorer/InspectorPanel";
import { kindStyles, styleFor } from "@/components/explorer/kinds";
import { NewSessionButton } from "@/components/agent/AgentPanel";
import { ChatSwitcher } from "@/components/chats/ChatSwitcher";
import { ChatStrip } from "@/components/shell/ChatStrip";
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
import { Phantom } from "@/components/brand/Phantom";
import { PhantomPose } from "@/components/brand/PhantomPose";
import { DrawerToggle, PageDrawer } from "@/components/shell/PageDrawer";
import { MapSidebarSection } from "@/components/shell/SidebarSections";

import { iconButton } from "@/components/ui/controls";
import { Segmented as KitSegmented, type SegmentedOption } from "@/components/ui/segmented";

export { iconButton };

function StatusIndicators() {
  const { daemon } = useWorkspace();
  return (
    <>
      {daemon.source === "sample" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex h-6 shrink-0 items-center rounded-md bg-warn/10 px-2 text-meta text-warn">
              Sample data
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            No daemon connected — showing the bundled sample. Run ruah app serve &lt;repo&gt; and
            open the page it serves.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {daemon.save === "pending" || daemon.save === "saving" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-label text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Saving
        </span>
      ) : null}
      {daemon.archError || daemon.lastError ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={dismissError}
              className="flex h-6 max-w-56 shrink-0 items-center gap-1.5 rounded-md bg-bad/10 px-2 text-meta text-bad"
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
    <KitSegmented
      label="Map mode"
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

type Crumb = { label: string; id?: string; nodeId?: string; siblingsOf?: string | null };

/** Siblings menu behind a breadcrumb separator: the other levels you can open from here. */
function CrumbMenu({ parentId, currentId }: { parentId: string | null; currentId?: string | undefined }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const index = useMemo(() => indexArchitecture(ws.mapArchitecture), [ws.mapArchitecture]);
  const items = (index.children.get(parentId) ?? []).filter((n) => !index.workflowOnly.has(n.id));
  const open = (n: ArchNode) => {
    if (canDrill(index, n)) {
      const node = ws.app.diagrams.flatMap((d) => d.nodes).find((d) => d.id === n.id);
      if (node) {
        wb.drill(node);
        return;
      }
    }
    wb.openNode(n.id);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="grid h-5 w-4 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        aria-label="Other elements at this level"
      >
        <ChevronRight className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        {items.length === 0 ? <DropdownMenuItem disabled>Nothing here</DropdownMenuItem> : null}
        {items.map((n) => {
          const x = asExpanded(n);
          const style = styleFor({ kind: kindFor(n.type), symbol: x?.symbol });
          const Icon = style.icon;
          const kids = index.children.get(n.id)?.length ?? x?.childCount;
          const drillable = canDrill(index, n);
          return (
            <DropdownMenuItem key={n.id} onSelect={() => open(n)} className={cn(n.id === currentId && "bg-accent/60")}>
              <Icon className={cn("size-3.5", style.color)} />
              <span className="truncate">{n.name}</span>
              {drillable ? (
                <span className="ms-auto flex items-center gap-0.5 font-mono text-micro text-faint">
                  {kids ? kids : null}
                  <ChevronRight className="size-3" />
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Crumbs({ diagram }: { diagram: Diagram }) {
  const { mapArchitecture: architecture, app } = useWorkspace();
  const wb = useWorkbench();
  const ref = parseDiagramId(diagram.id);
  const index = useMemo(() => indexArchitecture(architecture), [architecture]);
  const chain =
    ref && ref.mode === "architecture" && ref.parentId !== null ? ancestry(index, ref.parentId) : [];
  const items: Crumb[] = [];
  if (diagram.mode === "workflow") {
    items.push({ label: app.name || "System", id: ROOT_DIAGRAM_ID }, { label: "Workflows" }, { label: diagram.title });
  } else if (isCloudDiagramId(diagram.id)) {
    items.push({ label: app.name, id: ROOT_DIAGRAM_ID }, { label: diagram.title });
  } else {
    // system › repo › package › folder › file: every crumb opens its level; the separator before
    // it lists its siblings.
    items.push({ label: app.name || "System", id: ROOT_DIAGRAM_ID });
    chain.forEach((n) => items.push({ label: n.name, id: levelDiagramId(n.id), nodeId: n.id, siblingsOf: n.parent ?? null }));
    if (chain.length === 0 && ref?.mode === "architecture" && ref.parentId !== null) items.push({ label: diagram.title });
  }
  // Long paths: keep the first crumb and the last three, fold the middle into a menu.
  const folded = items.length > 5 ? items.slice(1, items.length - 3) : [];
  const shown = folded.length ? [items[0]!, { label: "…" } as Crumb, ...items.slice(items.length - 3)] : items;
  const inside = diagram.mode === "architecture" && !isCloudDiagramId(diagram.id);
  const currentParent = ref?.mode === "architecture" ? ref.parentId : null;
  const hasChildrenHere = inside && diagram.nodes.some((n) => n.drill);
  const canGoUp = items.length > 1;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-0.5 overflow-hidden text-ui">
      {canGoUp ? (
        <button
          type="button"
          onClick={() => wb.goUp()}
          title="Up one level (Backspace, Esc or ⌥↑)"
          aria-label="Up one level"
          className="mr-1.5 flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-ui-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Up
        </button>
      ) : null}
      {shown.map((it, i) => {
        const last = i === shown.length - 1;
        const isFold = it.label === "…" && folded.length > 0;
        return (
          <Fragment key={`${it.id ?? it.label}-${i}`}>
            {i > 0 ? (
              inside && it.siblingsOf !== undefined ? (
                <CrumbMenu parentId={it.siblingsOf} currentId={it.nodeId} />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-faint" />
              )
            ) : null}
            {isFold ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="shrink-0 rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground">…</DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {folded.map((f) => (
                    <DropdownMenuItem key={f.id ?? f.label} onSelect={() => f.id && wb.openDiagram(f.id)}>
                      {f.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : last || !it.id ? (
              <span className={cn("max-w-56 truncate px-0.5", last ? "font-medium text-foreground" : "text-muted-foreground")} title={it.label}>
                {it.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => wb.openDiagram(it.id!)}
                title={it.label}
                className="max-w-40 shrink-0 truncate rounded px-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                {it.label}
              </button>
            )}
          </Fragment>
        );
      })}
      {hasChildrenHere ? <CrumbMenu parentId={currentParent} /> : null}
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
        className="flex h-9 shrink-0 items-center gap-2 px-3 text-left text-ui-sm font-medium text-foreground"
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

/**
 * A new project (or a repo the scanner found nothing in): scan it, or start drawing.
 * `besidePalette`: Edit mode's element palette sits at the top left (w-56); centre the card in
 * the space right of it, or the palette covers the card's text and buttons.
 */
function EmptyMap({ besidePalette = false }: { besidePalette?: boolean }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    setScanning(true);
    try {
      const r = await rescan();
      invalidateExpansions();
      toast.success(r.nodes ? `Found ${r.nodes} elements` : "The scan found no elements", {
        description: r.nodes ? `${r.edges} links · ${Math.round(r.ms)} ms` : "Add them by hand from the palette.",
      });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      toast.error("Couldn't scan the project", {
        description: `${reason}. Check that the folder still exists and is readable, then scan again.`,
      });
    } finally {
      setScanning(false);
    }
  };
  return (
    <div className={cn("pointer-events-none absolute inset-0 grid place-items-center p-6", besidePalette && "ps-[15.5rem]")}>
      <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-hairline bg-popover/95 px-6 py-6 text-center shadow-elevated backdrop-blur">
        <PhantomPose pose={scanning ? "reading" : "mapping"} size={96} lively={scanning} label={scanning ? "Scanning the repo" : undefined} />
        <div className="space-y-1.5">
          <p className="text-caption font-medium tracking-[0.14em] text-brand uppercase">{scanning ? "Scanning" : "New project"}</p>
          <p className="heading text-headline text-foreground">An empty map</p>
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
            className="flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface-2 px-3 text-ui-sm text-foreground transition-colors hover:bg-surface-3 disabled:opacity-50"
          >
            {scanning ? <Phantom expression="loading" size={14} /> : <ScanSearch className="size-3.5" />}
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

/** Loading / live-from-disk / truncated notice for on-demand levels. */
function LevelNotice({ diagram }: { diagram: Diagram }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const ref = parseDiagramId(diagram.id);
  if (ref?.mode !== "architecture" || ref.parentId === null) return null;
  const entry = ws.expansions.entries.get(ref.parentId);
  if (!entry || ws.architecture.nodes.some((n) => n.parent === ref.parentId)) return null;
  if (entry.status === "loading" && !entry.previous) {
    return (
      <span className="control-glass flex items-center gap-2 rounded-lg px-3 py-1.5 text-label text-muted-foreground">
        <Phantom expression="loading" size="xs" /> Reading {diagram.title} from disk…
      </span>
    );
  }
  if (entry.status === "error") {
    return <span className="control-glass rounded-lg px-3 py-1.5 text-label text-bad">{entry.error}</span>;
  }
  const exp = entry.status === "ok" ? entry.expansion : entry.previous;
  if (!exp) return null;
  const t = exp.truncated;
  return (
    <span className="control-glass flex items-center gap-2 rounded-lg px-2.5 py-1 text-meta text-muted-foreground">
      <HardDrive className="size-3 text-faint" />
      Live from disk{exp.level === "file" ? " · symbols" : " · imports"}
      {t.children ? ` · showing ${exp.architecture.nodes.length} of ${exp.total.children}` : ""}
      {t.edges ? ` · strongest ${exp.architecture.edges.length} of ${exp.total.edges} links` : ""}
      {entry.status === "loading" ? <Phantom expression="loading" size={13} label="Loading" /> : null}
      {/* Edit mode shows no palette here: say why, and how to edit this level. */}
      {wb.editing ? <span className="text-foreground/80">· pin it to the map (⋯ menu) to edit</span> : null}
    </span>
  );
}

function Canvas({ diagram, showTray, active = true }: { diagram: Diagram; showTray: boolean; active?: boolean }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const emptyProject =
    ws.daemon.source === "daemon" &&
    ws.architecture.nodes.length === 0 &&
    diagram.mode === "architecture";
  // The derived Cloud level is read-only: it is not part of architecture.json.
  const derived = isCloudDiagramId(diagram.id);
  const index = useMemo(() => indexArchitecture(ws.mapArchitecture), [ws.mapArchitecture]);
  const ref = parseDiagramId(diagram.id);
  // A level read from disk on demand (§1.6) takes no new elements until it is pinned to the map:
  // no palette there (it offered one, then refused the drop with a truncated notice).
  const readFromDisk =
    ref?.mode === "architecture" &&
    ref.parentId !== null &&
    ws.expansions.entries.has(ref.parentId) &&
    !ws.architecture.nodes.some((n) => n.parent === ref.parentId);
  const depth = ref?.mode === "architecture" && ref.parentId !== null ? ancestry(index, ref.parentId).length : 0;
  const searchIndex = useMemo<SearchHit[]>(
    () =>
      ws.mapArchitecture.nodes
        .filter((n) => !index.workflowOnly.has(n.id))
        .map((n) => ({ id: n.id, label: n.name, where: n.path ?? index.byId.get(n.parent ?? "")?.name ?? "top level" })),
    [ws.mapArchitecture, index],
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <EditorCanvas
        active={active}
        depth={depth}
        onGoUp={wb.goUp}
        onActivateSymbol={wb.activateSymbol}
        searchIndex={searchIndex}
        onReveal={wb.openNode}
        notice={<LevelNotice diagram={diagram} />}
        emptyHint={!emptyProject}
        diagram={diagram}
        // View mode edits too (move, connect, rename — the user relies on it);
        // Edit mode adds the element palette. Derived levels (cloud) stay read-only.
        editable={ws.editable && !derived}
        selectedNodeId={wb.selectedNodeId}
        selectedEdge={wb.selectedEdge}
        onSelectNode={wb.selectNode}
        onSelectEdge={wb.selectEdge}
        onMoveNode={(id, x, y) => ws.updateNode(diagram.id, id, { x, y })}
        onAddNode={(kind, x, y) => wb.addNodeAt(kind, x, y)}
        onRenameNode={(id, label) => ws.updateNode(diagram.id, id, { label })}
        onConnect={(from, to) => ws.addEdge(diagram.id, from, to)}
        onDeleteNode={(id) => {
          void ws.deleteNode(diagram.id, id).then((deleted) => deleted && wb.clearSelection());
        }}
        deleteKey={wb.editing}
        onUndo={() => {
          if (!daemonActions.undoEdit() && ws.editable) toast("Nothing to undo on the map", { id: "map-undo", description: "Agent changes are undone from their chat turn." });
        }}
        onRedo={() => void daemonActions.redoEdit()}
        onDrill={wb.drill}
        onOpenCode={(node) => {
          wb.selectNode(node.id);
          if (node.symbol && node.path) wb.openCode(node.path, [node.symbol.line, node.symbol.endLine]);
          else {
            wb.setPanelView("code");
            wb.setSheetOpen(true);
          }
        }}
        onAsk={(node) => wb.ask(node)}
        onCopyContext={wb.copyContext}
      />
      {showTray && !derived && !readFromDisk ? <PaletteTray /> : null}
      {emptyProject ? <EmptyMap besidePalette={showTray && !derived && !readFromDisk} /> : null}
      {ws.daemon.source === null ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="flex items-center gap-2 text-ui-sm text-muted-foreground">
            <Phantom expression="loading" size="sm" /> Connecting to the daemon…
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PaneMenu({ pane, diagram }: { pane: Pane; diagram: Diagram }) {
  const ws = useWorkspace();
  const ref = parseDiagramId(diagram.id);
  const levelId = ref?.mode === "architecture" ? ref.parentId : null;
  const entry = levelId !== null ? ws.expansions.entries.get(levelId) : undefined;
  const live = entry !== undefined && !ws.architecture.nodes.some((n) => n.parent === levelId);
  const pinnable =
    live && entry?.status === "ok" && entry.expansion.level === "folder" && ws.architecture.nodes.some((n) => n.id === levelId);
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
        {live && levelId !== null ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void requestExpansion(levelId, { maxAge: 0 })}>
              <RefreshCw className="text-muted-foreground" /> Refresh from disk
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!pinnable || !ws.editable}
              onSelect={() => {
                ws.pinLevel(diagram.id);
                toast.success("Pinned to the map", { description: "This level is now part of architecture.json." });
              }}
            >
              <Pin className="text-muted-foreground" /> Pin this level to the map
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={ws.daemon.source !== "daemon"}
          onSelect={() => void downloadDrawio(ws.daemon.httpOrigin)}
        >
          <Download className="text-muted-foreground" /> Export → draw.io
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

function PaneView({ pane, first, last }: { pane: Pane; first: boolean; last: boolean }) {
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
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        {first ? <DrawerToggle label="Outline" /> : null}
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
                    "group/tab flex h-7 shrink-0 items-center gap-1 rounded-md ps-2.5 pe-1 text-ui-sm",
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
      </div>
      {tab.type === "diagram" ? (
        <Canvas diagram={diagram} showTray={wb.editing && isActivePane && !wb.outlineOpen} active={isActivePane} />
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
            codeRange={wb.codeRange}
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
  // The agent talks about the selection, or the element whose level is open (drill-in context).
  const agentNode = wb.contextNode;
  const options: { value: PanelView; label: string }[] = [
    { value: "agent", label: "Agent" },
    { value: "details", label: "Details" },
    { value: "code", label: "Code" },
  ];
  if (wb.editing) options.push({ value: "properties", label: "Properties" });
  const view = !wb.editing && wb.panelView === "properties" ? "details" : wb.panelView;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-hairline px-3">
        <KitSegmented kind="tabs" label="Panel view" value={view} options={options} onChange={wb.setPanelView} />
        {view === "agent" ? <ChatSwitcher compact className="min-w-0 shrink" /> : null}
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
      {view === "agent" && !mobile ? <ChatStrip /> : null}
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
                void ws.deleteNode(wb.activeDiagram.id, node.id).then((deleted) => deleted && wb.clearSelection());
              }}
              onDeleteEdge={() => {
                if (!wb.selectedEdge) return;
                ws.deleteEdge(wb.activeDiagram.id, wb.selectedEdge.from, wb.selectedEdge.to);
                wb.clearSelection();
              }}
              onDiagramPatch={(patch) => ws.updateDiagram(wb.activeDiagram.id, patch)}
              onSelectEdge={(edge) => {
                wb.selectEdge(edge);
                wb.selectNode(null);
              }}
            />
          </div>
        ) : (
          <InspectorPanel
            node={view === "agent" ? agentNode : node}
            contextPath={view === "agent" ? (agentNode ? wb.contextPathFor(agentNode) : "") : node ? wb.contextPathFor(node) : ""}
            view={view}
            onDrill={() => node && wb.drill(node)}
            onSelectNode={wb.openNode}
            onOpenPath={wb.openPath}
            onClearContext={wb.clearSelection}
            codePath={wb.codePath}
            codeRange={wb.codeRange}
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
              <span className="block truncate text-ui font-medium">{node.label}</span>
              <span className="block truncate font-mono text-caption text-muted-foreground">
                {wb.contextPathFor(node)}
              </span>
            </span>
          </button>
        ) : (
          <span className="flex-1 text-ui-sm text-muted-foreground">Tap an element to select it</span>
        )}
        <button
          type="button"
          onClick={() => {
            wb.setPanelView("agent");
            wb.setSheetOpen(true);
          }}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ai px-3.5 text-ui font-medium text-ai-foreground"
        >
          <Sparkles className="size-3.5" />
          {node ? "Ask" : "Agent"}
        </button>
      </div>
      <Sheet open={wb.sheetOpen} onOpenChange={wb.setSheetOpen}>
        <SheetContent side="bottom" className="flex h-[88dvh] flex-col gap-0 rounded-t-2xl border-hairline p-0 [&>button]:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Agent and details</SheetTitle>
          </SheetHeader>
          <div className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-surface-4" />
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

  // The agent panel is the shell's (AppShell, every page); the Map adds its left drawer.
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {wb.outlineOpen ? (
        <PageDrawer title="Outline">
          <MapSidebarSection />
        </PageDrawer>
      ) : null}
      <ResizablePanelGroup className="min-h-0 min-w-0 flex-1">
        {app.panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {i > 0 ? <ResizableHandle className="bg-hairline" /> : null}
            <ResizablePanel id={pane.id} minSize="20%">
              <PaneView pane={pane} first={i === 0} last={i === app.panes.length - 1} />
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    </div>
  );
}

