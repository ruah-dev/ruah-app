// Visual patterns adapted from t3code apps/web/src/components/Sidebar.tsx (MIT): sentence-case
// section labels, compact rows with a quiet active fill, secondary content under disclosures.
import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, FolderTree, Plus, Trash2 } from "lucide-react";
import { ancestry, parseDiagramId, toRepoTree } from "@/lib/architecture";
import { indexArchitecture } from "@/lib/architecture";
import type { Turn } from "@/lib/daemon";
import { useWorkspace, type Diagram } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { RepoTree } from "@/components/explorer/RepoTree";
import { Palette } from "@/components/editor/Palette";
import { cn } from "@/lib/utils";

export function SectionHeader({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between ps-2 pe-1">
      <span className="text-[12px] font-medium text-muted-foreground/80">{label}</span>
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
      className="grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  );
}

/** Map page context: diagram levels, workflows and the repo tree under a disclosure. */
export function MapSidebarSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { app, architecture } = ws;
  const [filesOpen, setFilesOpen] = useState(false);
  const archIndex = useMemo(() => indexArchitecture(architecture), [architecture]);
  const repoTree = useMemo(() => toRepoTree(architecture), [architecture]);

  const levels = app.diagrams
    .filter((d) => d.mode === "architecture")
    .map((d) => {
      const ref = parseDiagramId(d.id);
      const depth =
        ref && ref.mode === "architecture" && ref.parentId !== null
          ? ancestry(archIndex, ref.parentId).length
          : 0;
      return { diagram: d, depth };
    });
  const workflows = app.diagrams.filter((d) => d.mode === "workflow");

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
    <div className="space-y-4">
      <div>
        <SectionHeader
          label="Architecture"
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
        />
        <div className="space-y-px">{levels.map(({ diagram, depth }) => row(diagram, depth))}</div>
      </div>

      <div>
        <SectionHeader
          label="Workflows"
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
        />
        {workflows.length ? (
          <div className="space-y-px">{workflows.map((d) => row(d))}</div>
        ) : (
          <p className="px-2 text-[12px] text-muted-foreground/70">None in architecture.json</p>
        )}
      </div>

      <div>
        <button
          type="button"
          aria-expanded={filesOpen}
          onClick={() => setFilesOpen((v) => !v)}
          className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          <FolderTree className="size-3.5" />
          Files
          <ChevronRight
            className={cn("ms-auto size-3.5 transition-transform", filesOpen && "rotate-90")}
          />
        </button>
        {filesOpen ? (
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
        ) : null}
      </div>
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
  run: "bg-primary animate-pulse",
  ok: "bg-muted-foreground/50",
  warn: "bg-warn",
  bad: "bg-bad",
} as const;

/** Agent page context: this session's turns. */
export function AgentSidebarSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { daemon, architecture } = useWorkspace();
  const wb = useWorkbench();
  const names = useMemo(
    () => new Map(architecture.nodes.map((n) => [n.id, n.name])),
    [architecture],
  );
  const turns = [...daemon.turns].reverse();
  return (
    <div>
      <SectionHeader label="This session" />
      {turns.length === 0 ? (
        <p className="px-2 text-[12px] leading-relaxed text-muted-foreground/70">
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
                <span className="truncate ps-3.5 text-[11.5px] text-muted-foreground/70">
                  {names.get(t.nodeId) ?? t.nodeId}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
