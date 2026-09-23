// Tasks: ruah orchestration for this repo (`ruah status --json` via the daemon). Task list with
// start / done / merge / cancel (merge and cancel confirmed), and workflows with Run (confirmed).
import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  CircleCheck,
  GitBranch,
  GitMerge,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import {
  loadRuah,
  loadWorkflows,
  ruahTaskAction,
  runRuahWorkflow,
  shortAge,
  useLoad,
  type RuahStatus,
  type RuahTask,
  type RuahTaskAction,
} from "@/lib/integrations";
import { PageHeader } from "@/components/shell/AppShell";
import { Segmented } from "@/components/map/MapPage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CopyCommand,
  Notice,
  Pill,
  RemoteNotice,
  primaryButton,
  quietButton,
} from "@/components/integrations/common";
import type { StatusTone } from "@/lib/integrations";
import { CreateRuahTaskDialog } from "./CreateRuahTaskDialog";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { label: string; tone: StatusTone; order: number }> = {
  "in-progress": { label: "Running", tone: "warn", order: 0 },
  created: { label: "Created", tone: "idle", order: 1 },
  done: { label: "Done", tone: "ok", order: 2 },
  failed: { label: "Failed", tone: "bad", order: 3 },
  merged: { label: "Merged", tone: "idle", order: 4 },
  cancelled: { label: "Cancelled", tone: "idle", order: 5 },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s, tone: "idle" as StatusTone, order: 9 };

const ACTIONS: Record<string, RuahTaskAction[]> = {
  created: ["start", "cancel"],
  "in-progress": ["done", "cancel"],
  done: ["merge", "cancel"],
  failed: ["start", "cancel"],
};

const ACTION_META: Record<RuahTaskAction, { label: string; icon: typeof Play; confirm: boolean }> = {
  start: { label: "Start", icon: Play, confirm: false },
  done: { label: "Mark done", icon: CircleCheck, confirm: false },
  merge: { label: "Merge", icon: GitMerge, confirm: true },
  cancel: { label: "Cancel", icon: Ban, confirm: true },
};

type Pending =
  | { kind: "task"; task: RuahTask; action: RuahTaskAction }
  | { kind: "workflow"; name: string };

const COLS =
  "grid grid-cols-[minmax(0,1.6fr)_6.5rem_7rem_minmax(0,1.7fr)_minmax(0,1.2fr)_3rem_auto] items-center gap-3";

function TaskRow({
  task,
  busy,
  onAction,
}: {
  task: RuahTask;
  busy: RuahTaskAction | null;
  onAction: (a: RuahTaskAction) => void;
}) {
  const st = statusOf(task.status);
  const files = task.files ?? [];
  const actions = ACTIONS[task.status] ?? [];
  const age = task.startedAt ?? task.createdAt ?? null;
  return (
    <div role="row" className={cn(COLS, "min-h-11 border-b border-hairline px-5 py-1.5 max-md:px-3")}>
      <div role="cell" className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-[13px] text-foreground" title={task.prompt ?? undefined}>
          {task.parent ? <span className="text-muted-foreground/50">↳</span> : null}
          <span className="truncate font-mono text-[12.5px]">{task.name}</span>
        </p>
        {task.prompt ? (
          <p className="truncate text-[11.5px] text-muted-foreground">{task.prompt.split("\n")[0]}</p>
        ) : null}
      </div>
      <div role="cell">
        <Pill tone={st.tone} className={task.status === "in-progress" ? "[&>span:first-child]:animate-pulse" : ""}>
          {st.label}
        </Pill>
      </div>
      <div role="cell" className="truncate font-mono text-[12px] text-muted-foreground">
        {task.executor ?? "—"}
      </div>
      <div role="cell" className="min-w-0">
        <p className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-foreground/85">
          <GitBranch className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="truncate" title={task.branch}>
            {task.branch ?? "—"}
          </span>
        </p>
        {task.worktree ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70" title={task.worktree}>
            {task.worktree}
          </p>
        ) : null}
      </div>
      <div role="cell" className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" title={files.join("\n")}>
        {files.length ? (
          <>
            {files[0]}
            {files.length > 1 ? <span className="text-muted-foreground/60"> +{files.length - 1}</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </div>
      <div role="cell" className="text-[12px] text-muted-foreground tabular-nums" title={age ?? undefined}>
        {shortAge(age)}
      </div>
      <div role="cell" className="flex items-center justify-end gap-0.5">
        {actions.map((a) => {
          const meta = ACTION_META[a];
          const Icon = meta.icon;
          return (
            <Tooltip key={a}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${meta.label} ${task.name}`}
                  disabled={busy !== null}
                  onClick={() => onAction(a)}
                  className={cn(
                    "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40",
                    a === "cancel" && "hover:text-bad",
                  )}
                >
                  {busy === a ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{meta.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function NotInitialized({ hint }: { hint?: string | undefined }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="grid size-9 place-items-center rounded-xl bg-surface-2 text-primary">
        <ListChecks className="size-4.5" />
      </span>
      <p className="text-[15px] font-medium text-foreground">ruah isn't set up in this repository</p>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        {hint ??
          "ruah runs coding agents on isolated git worktrees with file locks, so several tasks can run at once without stepping on each other. Initialise it once in the repo root:"}
      </p>
      <CopyCommand command="ruah init" className="w-full max-w-xs" />
      <button type="button" className={quietButton} onClick={() => void loadRuah()}>
        <RefreshCw className="size-3.5" /> Check again
      </button>
    </div>
  );
}

export function TasksPage() {
  const s = useLoad("ruah", { pollMs: 5000 });
  useLoad("workflows");
  const [scope, setScope] = useState<"active" | "all">("active");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<{ key: string; action: RuahTaskAction | "run" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const status: RuahStatus | null =
    s.ruah.status === "ok" && s.ruah.data.initialized ? s.ruah.data : null;
  const notInit = s.ruah.status === "ok" && !s.ruah.data.initialized ? s.ruah.data : null;
  const tasks = status?.tasks ?? [];

  const sorted = useMemo(
    () =>
      [...tasks]
        .filter((t) => scope === "all" || !["merged", "cancelled"].includes(t.status))
        .sort(
          (a, b) =>
            statusOf(a.status).order - statusOf(b.status).order ||
            (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
        ),
    [tasks, scope],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);
  const hidden = tasks.length - sorted.length;

  const workflowFiles = s.workflows.status === "ok" ? s.workflows.data : [];
  const workflows = useMemo(() => {
    const summaries = new Map((status?.workflows ?? []).map((w) => [w.name, w]));
    const names = new Set([...workflowFiles.map((w) => w.name), ...summaries.keys()]);
    return [...names].sort().map((name) => ({
      name,
      path: workflowFiles.find((w) => w.name === name)?.path ?? summaries.get(name)?.path,
      summary: summaries.get(name),
    }));
  }, [workflowFiles, status?.workflows]);

  // Clear a stale error once the list changes underneath it.
  useEffect(() => setError(null), [s.projectKey]);

  const perform = async (p: Pending) => {
    setPending(null);
    setError(null);
    if (p.kind === "task") {
      setBusy({ key: p.task.name, action: p.action });
      const res = await ruahTaskAction(p.task.name, p.action);
      setBusy(null);
      if (!res.ok) setError(`${ACTION_META[p.action].label} ${p.task.name}: ${res.message}`);
    } else {
      setBusy({ key: `wf:${p.name}`, action: "run" });
      const res = await runRuahWorkflow(p.name);
      setBusy(null);
      if (!res.ok) setError(`Run ${p.name}: ${res.message}`);
    }
  };

  const request = (task: RuahTask, action: RuahTaskAction) => {
    const p: Pending = { kind: "task", task, action };
    if (ACTION_META[action].confirm) setPending(p);
    else void perform(p);
  };

  const running = counts["in-progress"] ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Tasks">
        {status ? (
          <span className="text-[12px] text-muted-foreground max-sm:hidden">
            {running ? `${running} running · ` : ""}
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            {status.currentBranch ? ` · on ${status.currentBranch}` : ""}
          </span>
        ) : null}
        <button
          type="button"
          className={quietButton}
          aria-label="Refresh"
          onClick={() => {
            void loadRuah();
            void loadWorkflows();
          }}
        >
          <RefreshCw className={cn("size-3.5", s.ruah.status === "loading" && "animate-spin")} />
        </button>
        <button type="button" className={primaryButton} disabled={!status} onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" /> New task
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {s.ruah.status === "unavailable" || s.ruah.status === "error" ? (
          <div className="mx-auto max-w-3xl px-6 py-8">
            <RemoteNotice remote={s.ruah} what="Orchestration" />
          </div>
        ) : notInit ? (
          <NotInitialized hint={notInit.hint} />
        ) : !status ? (
          <div className="grid h-40 place-items-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex flex-col gap-8 pb-10">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 px-5 pt-4 max-md:px-3">
                <Segmented
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "active", label: "Open" },
                    { value: "all", label: "All" },
                  ]}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {Object.entries(counts)
                    .sort((a, b) => statusOf(a[0]).order - statusOf(b[0]).order)
                    .map(([k, n]) => (
                      <Pill key={k} tone={statusOf(k).tone}>
                        {n} {statusOf(k).label.toLowerCase()}
                      </Pill>
                    ))}
                </div>
                <span className="flex-1" />
                {status.baseBranch ? (
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    base {status.baseBranch}
                  </span>
                ) : null}
              </div>
              {error ? (
                <div className="px-5 max-md:px-3">
                  <Notice tone="bad" title="ruah refused" body={error} />
                </div>
              ) : null}

              <div role="table" className="border-t border-hairline">
                <div
                  role="row"
                  className={cn(COLS, "h-8 border-b border-hairline px-5 text-[11.5px] text-muted-foreground max-md:px-3")}
                >
                  <span role="columnheader">Task</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Executor</span>
                  <span role="columnheader">Branch · worktree</span>
                  <span role="columnheader">Files</span>
                  <span role="columnheader">Age</span>
                  <span role="columnheader" className="sr-only">
                    Actions
                  </span>
                </div>
                {sorted.length ? (
                  sorted.map((t) => (
                    <TaskRow
                      key={t.name}
                      task={t}
                      busy={busy?.key === t.name ? (busy.action as RuahTaskAction) : null}
                      onAction={(a) => request(t, a)}
                    />
                  ))
                ) : (
                  <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                    <ListChecks className="size-5 text-muted-foreground/60" />
                    <p className="text-[13.5px] font-medium text-foreground">
                      {tasks.length ? "No open tasks" : "No tasks yet"}
                    </p>
                    <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
                      Create one here, or from an element's Details on the Map — its files are locked
                      for the agent.
                    </p>
                  </div>
                )}
                {hidden > 0 && scope === "active" ? (
                  <button
                    type="button"
                    onClick={() => setScope("all")}
                    className="w-full px-5 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    {hidden} merged or cancelled hidden — show all
                  </button>
                ) : null}
              </div>
            </div>

            <section className="space-y-2 px-5 max-md:px-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-medium text-foreground">Workflows</h2>
                <span className="text-[12px] text-muted-foreground">.ruah/workflows/*.md</span>
              </div>
              {workflows.length ? (
                <div className="divide-y divide-hairline border-y border-hairline">
                  {workflows.map((w) => {
                    const c = w.summary?.counts ?? {};
                    const total = Object.values(c).reduce((a, b) => a + b, 0);
                    const isBusy = busy?.key === `wf:${w.name}`;
                    return (
                      <div key={w.name} className="flex min-h-11 items-center gap-3 py-1.5">
                        <Workflow className="size-4 shrink-0 text-muted-foreground/70" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] text-foreground">{w.name}</p>
                          {w.path ? (
                            <p className="truncate font-mono text-[11px] text-muted-foreground/70">{w.path}</p>
                          ) : null}
                        </div>
                        {total ? (
                          <span className="text-[12px] text-muted-foreground">
                            {(c["merged"] ?? 0) + (c["done"] ?? 0)}/{total} tasks done
                            {c["in-progress"] ? ` · ${c["in-progress"]} running` : ""}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={quietButton}
                          disabled={busy !== null}
                          onClick={() => setPending({ kind: "workflow", name: w.name })}
                        >
                          {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                          Run
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  No workflows. Create one with{" "}
                  <span className="font-mono text-foreground/80">ruah workflow create &lt;name&gt;</span>.
                </p>
              )}
            </section>
          </div>
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent className="max-w-sm rounded-xl border-hairline bg-popover p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              {pending?.kind === "workflow"
                ? `Run ${pending.name}?`
                : pending?.action === "merge"
                  ? `Merge ${pending.task.name}?`
                  : `Cancel ${pending?.kind === "task" ? pending.task.name : ""}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              {pending?.kind === "workflow"
                ? "Creates the workflow's tasks and starts their agents in separate worktrees."
                : pending?.action === "merge"
                  ? `Merges ${pending.task.branch ?? "the task branch"} into ${pending.task.baseBranch ?? "the base branch"} (governance gates run first).`
                  : "Stops the task and removes its worktree and locks. Subtasks are cancelled too. Uncommitted work in the worktree is lost."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg border-hairline bg-transparent text-[13px]">
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "h-8 rounded-lg text-[13px]",
                pending?.kind === "task" && pending.action === "cancel" && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
              onClick={() => pending && void perform(pending)}
            >
              {pending?.kind === "workflow" ? "Run workflow" : pending?.action === "merge" ? "Merge" : "Cancel task"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateRuahTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingNames={tasks.map((t) => t.name)}
      />
    </div>
  );
}
