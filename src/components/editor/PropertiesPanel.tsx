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
  drillTargets: { id: string; title: string }[];
  kinds: NodeKind[];
  node: DiagramNode | null;
  edge: EdgeRef | null;
  onNodePatch: (patch: Partial<DiagramNode>) => void;
  onEdgePatch: (patch: { label?: string; animated?: boolean }) => void;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
  onDiagramPatch: (patch: { title?: string; subtitle?: string; group?: string }) => void;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-semibold text-muted-foreground uppercase">{label}</Label>
      {children}
    </div>
  );
}

const inputClass =
  "h-7 rounded-[4px] border-hairline bg-surface-2 px-2 font-mono text-[11px] text-foreground shadow-none";

export function PropertiesPanel({
  diagram,
  drillTargets,
  kinds,
  node,
  edge,
  onNodePatch,
  onEdgePatch,
  onDeleteNode,
  onDeleteEdge,
  onDiagramPatch,
}: Props) {
  const edgeData = edge
    ? diagram.edges.find((e) => e.from === edge.from && e.to === edge.to)
    : undefined;

  return (
    <div className="space-y-4 p-3">
      {node ? (
        <>
          <Field label="Label">
            <Input
              value={node.label}
              onChange={(e) => onNodePatch({ label: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Subtitle">
            <Input
              value={node.subtitle ?? ""}
              placeholder="short descriptor"
              onChange={(e) => onNodePatch({ subtitle: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Type">
            <div className="flex flex-wrap gap-1">
              {kinds.map((k) => {
                const Icon = kindStyles[k].icon;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onNodePatch({ kind: k })}
                    className={
                      "flex items-center gap-1 rounded-[4px] border px-1.5 py-1 font-mono text-[10px] transition-colors " +
                      (node.kind === k
                        ? "border-ring/60 bg-surface-3 text-foreground"
                        : "border-hairline bg-surface-2 text-muted-foreground hover:text-foreground")
                    }
                  >
                    <Icon className="size-3" />
                    {kindStyles[k].label}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Owner">
            <Input
              value={node.owner ?? ""}
              placeholder="team"
              onChange={(e) => onNodePatch({ owner: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Tech">
            <Input
              value={(node.tech ?? []).join(", ")}
              placeholder="node, postgres"
              onChange={(e) =>
                onNodePatch({
                  tech: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className={inputClass}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={node.description ?? ""}
              placeholder="what this element does"
              onChange={(e) => onNodePatch({ description: e.target.value })}
              className="min-h-20 rounded-[4px] border-hairline bg-surface-2 text-[11px] shadow-none"
            />
          </Field>
          <Field label="Drill-down target">
            <select
              value={node.drill ?? ""}
              onChange={(e) => onNodePatch({ drill: e.target.value })}
              className="h-7 w-full rounded-[4px] border border-hairline bg-surface-2 px-1.5 text-[11px] text-foreground outline-none"
            >
              <option value="">none</option>
              {drillTargets
                .filter((d) => d.id !== diagram.id)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            variant="outline"
            size="sm"
            onClick={onDeleteNode}
            className="h-7 w-full gap-1.5 rounded-[4px] border-hairline bg-surface-2 text-[11px] text-muted-foreground shadow-none hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete element
          </Button>
        </>
      ) : edgeData ? (
        <>
          <p className="font-mono text-[11px] text-muted-foreground">
            {edgeData.from} → {edgeData.to}
          </p>
          <Field label="Connection label">
            <Input
              value={edgeData.label ?? ""}
              placeholder="e.g. publishes"
              onChange={(e) => onEdgePatch({ label: e.target.value })}
              className={inputClass}
            />
          </Field>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={!!edgeData.animated}
              onChange={(e) => onEdgePatch({ animated: e.target.checked })}
            />
            Animate flow
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={onDeleteEdge}
            className="h-7 w-full gap-1.5 rounded-[4px] border-hairline bg-surface-2 text-[11px] text-muted-foreground shadow-none hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete connection
          </Button>
        </>
      ) : (
        <>
          <Field label="Diagram name">
            <Input
              value={diagram.title}
              onChange={(e) => onDiagramPatch({ title: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Group">
        <Input
          value={diagram.group ?? ""}
          placeholder="e.g. Cloud topology"
          onChange={(e) => onDiagramPatch({ group: e.target.value })}
          className={inputClass}
        />
      </Field>
      <Field label="Diagram subtitle">
            <Input
              value={diagram.subtitle}
              onChange={(e) => onDiagramPatch({ subtitle: e.target.value })}
              className={inputClass}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Select an element or a connection to edit it. Drag from the palette, double-click the
            canvas, or press N to add.
          </p>
        </>
      )}
    </div>
  );
}
