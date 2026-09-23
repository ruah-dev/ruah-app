import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { DiagramNode, NodeKind } from "@/data/graphs";
import type { Diagram } from "@/lib/workspace";
import { kindStyles } from "@/components/explorer/kinds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { EdgeRef } from "./EditorCanvas";

type Props = {
  diagram: Diagram;
  kinds: NodeKind[];
  node: DiagramNode | null;
  edge: EdgeRef | null;
  /** False when no daemon is connected: fields are shown read-only. */
  editable: boolean;
  onNodePatch: (patch: Partial<DiagramNode>) => void;
  onEdgePatch: (patch: { label?: string; animated?: boolean }) => void;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
  onDiagramPatch: (patch: { title?: string; subtitle?: string }) => void;
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center justify-between text-[12px] font-medium text-muted-foreground">
        {label}
        {hint ? <span className="text-[12px] font-normal text-faint">{hint}</span> : null}
      </Label>
      {children}
    </div>
  );
}

const inputClass =
  "h-8 rounded-md border-hairline bg-transparent px-2.5 text-[12.5px] text-foreground shadow-none";

/** Text input that keeps its own draft so comma-separated lists and paths can be typed freely. */
function DraftInput({
  value,
  onCommit,
  placeholder,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={inputClass}
    />
  );
}

export function PropertiesPanel({
  diagram,
  kinds,
  node,
  edge,
  editable,
  onNodePatch,
  onEdgePatch,
  onDeleteNode,
  onDeleteEdge,
  onDiagramPatch,
}: Props) {
  const edgeData = edge
    ? diagram.edges.find((e) => e.from === edge.from && e.to === edge.to)
    : undefined;
  const nameOf = (id: string) => diagram.nodes.find((n) => n.id === id)?.label ?? id;
  const disabled = !editable;
  const kindChoices = node && !kinds.includes(node.kind) ? [node.kind, ...kinds] : kinds;

  return (
    <div className="space-y-4 px-5 py-5">
      {!editable ? (
        <p className="text-[12px] text-muted-foreground">
          Read-only: editing saves to architecture.json and needs a connected ruah daemon.
        </p>
      ) : null}
      {node ? (
        <>
          <Field label="Label">
            <Input
              value={node.label}
              disabled={disabled}
              onChange={(e) => onNodePatch({ label: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field
            label="Type"
            hint={node.type && node.type !== node.kind ? `file: ${node.type}` : undefined}
          >
            <div className="flex flex-wrap gap-1">
              {kindChoices.map((k) => {
                const Icon = kindStyles[k].icon;
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={disabled}
                    onClick={() => onNodePatch({ kind: k })}
                    className={
                      "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors disabled:opacity-60 " +
                      (node.kind === k
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground")
                    }
                  >
                    <Icon className="size-3" />
                    {kindStyles[k].label}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Tech">
            <DraftInput
              value={(node.tech ?? []).join(", ")}
              placeholder="node, postgres"
              disabled={disabled}
              onCommit={(v) =>
                onNodePatch({
                  tech: v
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="Path" hint="repo-relative">
            <DraftInput
              value={node.path ?? ""}
              placeholder="services/api"
              disabled={disabled}
              onCommit={(v) => onNodePatch({ path: v })}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={node.description ?? ""}
              disabled={disabled}
              placeholder="what this element does (1–2 sentences)"
              onChange={(e) => onNodePatch({ description: e.target.value })}
              className="min-h-20 rounded-md border-hairline bg-transparent text-[12.5px] shadow-none"
            />
          </Field>
          <Field label="Notes" hint="sent to the agent">
            <Textarea
              value={node.notes ?? ""}
              disabled={disabled}
              placeholder="gotchas, conventions, known issues"
              onChange={(e) => onNodePatch({ notes: e.target.value })}
              className="min-h-16 rounded-md border-hairline bg-transparent text-[12.5px] shadow-none"
            />
          </Field>
          <Field label="Drill-down">
            <p className="font-mono text-[11.5px] text-muted-foreground">
              {node.drill
                ? "has nested elements (their `parent` is this element)"
                : "none: elements drill in when others name this one as their parent"}
            </p>
          </Field>
          {editable ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onDeleteNode}
              className="h-8 w-full gap-1.5 rounded-md border-hairline bg-transparent text-[12.5px] text-muted-foreground shadow-none hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              {diagram.mode === "workflow" ? "Remove step" : "Delete element"}
            </Button>
          ) : null}
        </>
      ) : edgeData ? (
        <>
          <p className="font-mono text-[12px] text-muted-foreground">
            {nameOf(edgeData.from)} → {nameOf(edgeData.to)}
            {edgeData.kind ? ` · ${edgeData.kind}` : ""}
          </p>
          {diagram.mode === "architecture" ? (
            <>
              <Field label="Connection label" hint="≤ 40 chars">
                <Input
                  value={edgeData.label ?? ""}
                  disabled={disabled}
                  maxLength={40}
                  placeholder="e.g. publishes"
                  onChange={(e) => onEdgePatch({ label: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={!!edgeData.animated}
                  onChange={(e) => onEdgePatch({ animated: e.target.checked })}
                />
                Async / event flow (animated)
              </label>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Workflow arrows follow the step order. Deleting this arrow removes the next step from
              the sequence.
            </p>
          )}
          {editable ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onDeleteEdge}
              className="h-8 w-full gap-1.5 rounded-md border-hairline bg-transparent text-[12.5px] text-muted-foreground shadow-none hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete connection
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Field label="Diagram name">
            <DraftInput
              value={diagram.title}
              disabled={disabled}
              onCommit={(v) => onDiagramPatch({ title: v })}
            />
          </Field>
          <Field label="Group">
            <p className="font-mono text-[11.5px] text-muted-foreground">{diagram.group ?? "—"}</p>
          </Field>
          {diagram.mode === "workflow" ? (
            <Field label="Description">
              <DraftInput
                value={diagram.subtitle}
                disabled={disabled}
                onCommit={(v) => onDiagramPatch({ subtitle: v })}
              />
            </Field>
          ) : null}
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Select an element or a connection to edit it. Drag from the palette, double-click the
            canvas, or press N to add.
          </p>
        </>
      )}
    </div>
  );
}
