import { Network, Workflow as WorkflowIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import type { Workflow } from "../lib/contract/index.js";

export type ViewMode = "architecture" | { workflow: string };

// Sidebar view list: the architecture root plus one entry per workflow
// (CONTRACTS §1.3 — "Workflows" mode lists workflows).

export function ViewList({
  workflows,
  rootActive,
  activeWorkflow,
  onSelectRoot,
  onSelectWorkflow,
}: {
  workflows: Workflow[];
  rootActive: boolean;
  activeWorkflow: string | null;
  onSelectRoot: () => void;
  onSelectWorkflow: (id: string) => void;
}) {
  return (
    <div className="border-b px-2 py-2.5" style={{ borderColor: "var(--hairline)" }}>
      <p className="px-1 pb-2 text-[9.5px] font-semibold uppercase" style={{ color: "var(--muted-foreground)" }}>
        Views
      </p>
      <ViewButton
        active={rootActive}
        icon={<Network className={cn("size-3.5", rootActive ? "" : "opacity-70")} />}
        label="Architecture"
        hint="system map"
        onClick={onSelectRoot}
      />
      {workflows.map((wf) => {
        const active = activeWorkflow === wf.id;
        return (
          <ViewButton
            key={wf.id}
            active={active}
            icon={<WorkflowIcon className={cn("size-3.5", active ? "" : "opacity-70")} />}
            label={wf.name}
            hint={`${wf.steps.length} steps`}
            onClick={() => onSelectWorkflow(wf.id)}
          />
        );
      })}
    </div>
  );
}

function ViewButton({
  active,
  icon,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative mb-0.5 w-full rounded-[4px] px-2.5 py-1.5 text-left transition-colors duration-150",
        active
          ? "text-[var(--foreground)] before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-[var(--accent)]"
          : "cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
      )}
      style={active ? { backgroundColor: "var(--surface-3)" } : undefined}
    >
      <span className="flex items-center gap-1.5">
        {icon}
        <span className="block truncate text-[11.5px] font-medium">{label}</span>
      </span>
      <span className="mono block truncate pl-5 text-[10px]" style={{ color: "var(--muted-foreground)" }}>
        {hint}
      </span>
    </button>
  );
}
