// Visual patterns adapted from t3code apps/web/src/components/Sidebar.tsx (MIT): sentence-case
// section labels, compact rows with a quiet active fill, secondary content under disclosures.
import { useMemo, type ReactNode } from "react";
import { FolderTree, ListTree, Plus, Trash2 } from "lucide-react";
import { toRepoTree } from "@/lib/architecture";
import type { Turn } from "@/lib/daemon";
import { useWorkspace, type Diagram } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { RepoTree } from "@/components/explorer/RepoTree";
import { OutlineTree } from "@/components/explorer/OutlineTree";
import { Palette } from "@/components/editor/Palette";
import { cn } from "@/lib/utils";
import { CollapsibleSection } from "./CollapsibleSection";

export function SectionHeader({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between ps-2 pe-1">
      <span className="section-label">{label}</span>
      {action}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  );
}

/** Map page context: the outline of the whole hierarchy, workflows and the repo tree. */
export function MapSidebarSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { app, architecture } = ws;
  const repoTree = useMemo(() => toRepoTree(architecture), [architecture]);
  const workflows = app.diagrams.filter((d) => d.mode === "workflow");
  const topLevel = architecture.nodes.filter((n) => !n.parent).length;

  const open = (id: string) => {
    wb.openDiagram(id);
    onNavigate?.();
  };

  // Edit mode: the element palette replaces the lists (drag onto the canvas or click to add).
  if (wb.editing) {
    return (
      <div>
        <SectionHeader label={`Add to ${wb.activeDiagram.title}`} />
        <div className="px-1 pt-1">
          <Palette
            groups={wb.kindGroups}
            onQuickAdd={(kind) => {
              wb.addNodeAt(kind, 80, 80, false);
              onNavigate?.();
            }}
          />
        </div>
      </div>
    );
  }

  const row = (d: Diagram, depth = 0) => {
    const active = d.id === wb.activeDiagram.id;
    return (
      <div key={d.id} className="group/row relative">
        <button
          type="button"
          onClick={() => open(d.id)}
          title={d.subtitle || d.title}
          style={{ paddingInlineStart: 8 + depth * 12 }}
          className={cn(
            "flex h-7 w-full min-w-0 items-center rounded-md pe-7 text-left text-[13px] transition-colors",
            active
              ? "bg-accent text-foreground"
              : "text-foreground/65 hover:bg-accent/70 hover:text-foreground",
          )}
        >
          <span className="truncate">{d.title}</span>
        </button>
        {ws.editable && d.mode === "workflow" ? (
          <button
            type="button"
            aria-label={`Delete ${d.title}`}
            onClick={() => ws.deleteDiagram(d.id)}
            className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-destructive"
          >
            <Trash2 className="size-3" />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <CollapsibleSection
        id="map.outline"
        label="Outline"
        count={topLevel}
        icon={<ListTree className="size-3 shrink-0 text-faint" />}
        action={
            ws.editable ? (
              <AddButton
                label="New diagram"
                onClick={() => {
                  ws.addDiagram("architecture");
                  wb.clearSelection();
                }}
              />
            ) : null
          }
      >
        <OutlineTree
          architecture={ws.mapArchitecture}
          expansions={ws.expansions}
          activeDiagramId={wb.activeDiagram.id}
          selectedId={wb.selectedNodeId}
          onSelect={(id) => {
            wb.openNode(id);
            onNavigate?.();
          }}
          onOpenLevel={(id) => {
            const node = app.diagrams.flatMap((d) => d.nodes).find((n) => n.id === id);
            if (node) wb.drill(node);
            onNavigate?.();
          }}
          rootLabel={app.name}
          onOpenRoot={() => {
            wb.openDiagram("arch:root");
            onNavigate?.();
          }}
        />
      </CollapsibleSection>

      <CollapsibleSection
        id="map.workflows"
        label="Workflows"
        count={workflows.length}
        action={
            ws.editable ? (
              <AddButton
                label="New workflow"
                onClick={() => {
                  ws.addDiagram("workflow");
                  wb.clearSelection();
                }}
              />
            ) : null
          }
      >
        {workflows.length ? (
          <div className="space-y-px">{workflows.map((d) => row(d))}</div>
        ) : (
          <p className="px-2 text-label text-faint">None in architecture.json</p>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        id="map.files"
        label="Files"
        defaultOpen={false}
        icon={<FolderTree className="size-3 shrink-0 text-faint" />}
      >
        <div className="pt-0.5">
            <RepoTree
              tree={repoTree}
              activeNodeId={wb.selectedNodeId}
              onOpen={(nodeId, path) => {
                onNavigate?.();
                const entry = architecture.nodes.find((n) => n.id === nodeId);
                const isFile =
                  (entry?.files ?? []).includes(path) ||
                  /\.[A-Za-z0-9]+$/.test(path.split("/").pop() ?? "");
                if (isFile) wb.openPath(path);
                else wb.openNode(nodeId);
              }}
            />
        </div>
      </CollapsibleSection>
    </div>
  );
}

export function turnStatus(t: Turn): { label: string; tone: "run" | "ok" | "warn" | "bad" } {
  if (!t.stopReason) return t.permission ? { label: "Needs approval", tone: "warn" } : { label: "Running", tone: "run" };
  if (t.stopReason === "end_turn") return { label: "Done", tone: "ok" };
  if (t.stopReason === "cancelled") return { label: "Stopped", tone: "warn" };
  if (t.stopReason === "error" || t.stopReason === "refusal") return { label: "Failed", tone: "bad" };
  return { label: "Stopped", tone: "warn" };
}

export const toneDot = {
  run: "bg-ai animate-pulse",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
} as const;

/** Agent page context: the turns of the open chat. */
export function AgentSidebarSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { daemon, mapArchitecture: architecture } = useWorkspace();
  const wb = useWorkbench();
  const names = useMemo(
    () => new Map(architecture.nodes.map((n) => [n.id, n.name])),
    [architecture],
  );
  const turns = [...daemon.turns].reverse();
  return (
    <CollapsibleSection
      id="agent.turns"
      label={daemon.projectsSupported ? "In this chat" : "This session"}
      count={turns.length}
    >
      {turns.length === 0 ? (
        <p className="px-2 text-label leading-relaxed text-faint">
          No messages yet. Select an element and ask about it.
        </p>
      ) : (
        <div className="space-y-px">
          {turns.map((t) => {
            const st = turnStatus(t);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  wb.focusTurn(t.id);
                  onNavigate?.();
                }}
                className={cn(
                  "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/70",
                  wb.focusTurnId === t.id && "bg-accent",
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[st.tone])} />
                  <span className="truncate text-[13px] text-foreground/85">{t.text}</span>
                </span>
                <span className="truncate ps-3.5 text-[11.5px] text-faint">
                  {names.get(t.nodeId) ?? t.nodeId}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}
