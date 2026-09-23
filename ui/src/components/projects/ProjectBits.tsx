import { Boxes, GitBranch } from "lucide-react";
import type { ProjectInfo } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/** Initial tile for a project: neutral, with a faint hue derived from the id so rows differ. */
export function ProjectTile({
  project,
  className,
}: {
  project: Pick<ProjectInfo, "id" | "name">;
  className?: string;
}) {
  let h = 0;
  for (const ch of project.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letter = (project.name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      style={{ ["--tile-hue" as string]: h }}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold",
        "bg-[oklch(0.3_0.03_var(--tile-hue))] text-[oklch(0.86_0.05_var(--tile-hue))]",
        "[html.light_&]:bg-[oklch(0.92_0.03_var(--tile-hue))] [html.light_&]:text-[oklch(0.4_0.08_var(--tile-hue))]",
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
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-[5px] bg-foreground/[0.06] px-1.5 text-[10.5px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-2.5" />
      {kind}
    </span>
  );
}
