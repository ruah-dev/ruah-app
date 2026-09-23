// "Tasks" in an element's Details: ruah tasks that lock this element's files, and
// "Create ruah task…" with the prompt and file locks prefilled from the element.
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ListChecks, Plus } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { elementFileGlobs, shortAge, useEnsure, type RuahTask } from "@/lib/integrations";
import { Pill, quietButton } from "@/components/integrations/common";
import { CreateRuahTaskDialog } from "./CreateRuahTaskDialog";

const OPEN = new Set(["created", "in-progress", "done", "failed"]);

function touches(task: RuahTask, node: DiagramNode, globs: string[]): boolean {
  const files = task.files ?? [];
  if (files.some((f) => globs.includes(f))) return true;
  const base = node.path?.replace(/\/+$/, "");
  return !!base && files.some((f) => f === base || f.startsWith(`${base}/`));
}

export function ElementTasksSection({ node }: { node: DiagramNode }) {
  const s = useEnsure("ruah");
  const [open, setOpen] = useState(false);
  const status = s.ruah.status === "ok" ? s.ruah.data : null;
  const globs = useMemo(() => elementFileGlobs(node), [node]);
  const tasks = status?.initialized ? status.tasks : [];
  const mine = useMemo(
    () => tasks.filter((t) => OPEN.has(t.status) && touches(t, node, globs)).slice(0, 4),
    [tasks, node, globs],
  );

  if (!s.origin || s.ruah.status === "unavailable") return null;

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h3 className="text-[12px] font-medium text-muted-foreground">Agent tasks</h3>
        {mine.length ? <span className="text-[11.5px] text-muted-foreground/60">{mine.length}</span> : null}
        <span className="flex-1" />
        {status?.initialized ? (
          <button type="button" className={quietButton} onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> Create ruah task…
          </button>
        ) : null}
      </div>
      {status && !status.initialized ? (
        <p className="text-[12px] text-muted-foreground/80">
          ruah isn't set up here. See <Link to="/tasks" className="text-foreground/90 hover:underline">Tasks</Link>{" "}
          to initialise it.
        </p>
      ) : mine.length ? (
        <ul>
          {mine.map((t) => (
            <li key={t.name} className="flex min-w-0 items-center gap-2 py-1">
              <ListChecks className="size-3.5 shrink-0 text-muted-foreground/70" />
              <Link to="/tasks" className="min-w-0 truncate font-mono text-[12px] text-foreground/90 hover:underline">
                {t.name}
              </Link>
              <span className="flex-1" />
              <Pill
                tone={t.status === "failed" ? "bad" : t.status === "done" ? "ok" : t.status === "in-progress" ? "warn" : "idle"}
                className="h-4 px-1 text-[11px]"
              >
                {t.status === "in-progress" ? "running" : t.status}
              </Pill>
              <span className="w-8 shrink-0 text-right text-[11.5px] text-muted-foreground">
                {shortAge(t.startedAt ?? t.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : status ? (
        <p className="text-[12px] text-muted-foreground/80">
          No open tasks on these files. A task runs an agent in its own worktree with the files locked.
        </p>
      ) : null}
      <CreateRuahTaskDialog
        open={open}
        onOpenChange={setOpen}
        node={node}
        existingNames={tasks.map((t) => t.name)}
      />
    </section>
  );
}
