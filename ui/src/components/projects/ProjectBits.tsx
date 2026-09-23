import { Boxes, GitBranch } from "lucide-react";
import type { ProjectInfo } from "@/lib/contracts";
import { cn } from "@/lib/utils";

// Identity tints from the Ruah palette (no teal — that means "interactive"; no lavender — that
// means "agent"). Literal class names so Tailwind generates them.
const TILE_TINTS = [
  "bg-sage-400/16 text-sage-300 [html.light_&]:text-sage-700",
  "bg-amber-400/16 text-amber-300 [html.light_&]:text-amber-700",
  "bg-coral-400/16 text-coral-300 [html.light_&]:text-coral-700",
  "bg-slate-300/18 text-slate-200 [html.light_&]:text-slate-600",
  "bg-warm-400/18 text-warm-200 [html.light_&]:text-warm-600",
] as const;

/** Initial tile for a project: a warm tint derived from the id so rows differ. */
export function ProjectTile({
  project,
  className,
}: {
  project: Pick<ProjectInfo, "id" | "name">;
  className?: string;
}) {
  let h = 0;
  for (const ch of project.id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const letter = (project.name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold",
        TILE_TINTS[h % TILE_TINTS.length],
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function KindBadge({ kind, className }: { kind: ProjectInfo["kind"]; className?: string }) {
  const Icon = kind === "system" ? Boxes : GitBranch;
  return (
    <span
      title={kind === "system" ? "System: several repos in one map" : "Repository"}
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-pill bg-surface-3 px-1.5 text-[10.5px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-2.5" />
      {kind}
    </span>
  );
}
