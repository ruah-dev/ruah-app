// The top bar's git branch chip (CONTRACTS §24): the branch, ↑ahead ↓behind and ●uncommitted
// files as before (details in its tooltip and at the top of the popover), and a click opens the
// switcher — local branches (current marked, ahead / behind, last commit), remote-only branches,
// a filter and "Create branch from <current>…". Switching asks the daemon (POST /api/git/switch),
// which refuses while an agent works in the project, during a merge / rebase and when git would
// overwrite local changes; the map of the new branch loads by itself and a toast says what
// changed ("feature-x: +3 elements, −1, 2 changed"). Hidden below lg like the chip always was;
// ⌘K "Switch branch…" opens it too (lib/git-branches.ts requestBranchSwitcher).
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, CloudDownload, GitBranch, GitBranchPlus, Loader2 } from "lucide-react";
import type { ResumeInfo } from "@/lib/contracts";
import { useDaemonSelector } from "@/lib/daemon";
import { useProjectActivity } from "@/lib/activity";
import {
  aheadBehind,
  branchNameProblem,
  chipLabel,
  fetchBranches,
  filterBranches,
  gitChipLines,
  onBranchSwitcherRequest,
  onGitChanged,
  switchBlocker,
  switchBranch,
  switchToast,
  type BranchList,
} from "@/lib/git-branches";
import { relativeTime } from "@/lib/time";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { fieldClass, primaryButton, quietButton } from "@/components/ui/controls";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const itemClass = "gap-2 rounded-md px-2 py-1.5 text-ui data-[selected=true]:bg-accent data-[disabled=true]:opacity-60";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function BranchSwitcher({ resume }: { resume: ResumeInfo | null }) {
  const projectId = useDaemonSelector((s) => s.project?.id ?? null);
  const kind = useDaemonSelector((s) => s.project?.kind);
  const sample = useDaemonSelector((s) => s.source === "sample");
  const localTurn = useDaemonSelector((s) => s.turns.some((t) => !t.stopReason));
  const activity = useProjectActivity(projectId);
  const turnRunning = localTurn || (activity?.running ?? 0) > 0;
  const blocked = switchBlocker({ turnRunning, kind, sample });

  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    fetchBranches()
      .then((l) => {
        setList(l);
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(message(err)));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    return onGitChanged((id) => {
      if (id === projectId) load();
    });
  }, [open, load, projectId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCreating(false);
      setNewName("");
    }
  }, [open]);

  // Another project: the old list is not this one's.
  useEffect(() => setList(null), [projectId]);

  useEffect(
    () =>
      onBranchSwitcherRequest(() => {
        const el = triggerRef.current;
        if (!el || el.offsetParent === null) return false; // hidden below lg
        setOpen(true);
        return true;
      }),
    [],
  );

  const git = resume?.git;
  if (!git || !git.available) return null;
  const label = chipLabel(git);
  const lines = gitChipLines(git);
  const current = list?.current ?? git.branch;
  const base = current ?? label;
  const shown = list ? filterBranches(list, query) : { local: [], remote: [] };
  const existing = list?.local.map((b) => b.name) ?? [];
  const typed = query.trim();
  const canCreateTyped = typed.length > 0 && branchNameProblem(typed, existing) === null && !shown.local.some((b) => b.name === typed);
  const nameProblem = creating && newName.length > 0 ? branchNameProblem(newName, existing) : null;

  const run = (req: { name: string; create?: boolean }) => {
    if (blocked || pending) return;
    setPending(req.name);
    const id = toast.loading(req.create ? `Creating ${req.name}…` : `Switching to ${req.name}…`);
    switchBranch(req)
      .then((result) => {
        const t = switchToast(result);
        toast.success(t.title, { id, ...(t.description ? { description: t.description } : {}) });
        setOpen(false);
      })
      .catch((err: unknown) => {
        toast.error(req.create ? `Couldn't create ${req.name}` : `Couldn't switch to ${req.name}`, { id, description: message(err) });
        load();
      })
      .finally(() => setPending(null));
  };

  const dirty = list ? list.dirty.staged + list.dirty.unstaged : git.dirty;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Branch ${label} — switch branch. ${lines.join(". ")}`}
              className="group/branch flex h-6 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full bg-surface-2 px-2 font-mono text-meta text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground data-[state=open]:bg-surface-3 data-[state=open]:text-foreground max-lg:hidden"
            >
              {pending ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <GitBranch className="size-3 shrink-0" />}
              <span className="min-w-0 truncate">{label}</span>
              {git.ahead ? <span className="shrink-0">↑{git.ahead}</span> : null}
              {git.behind ? <span className="shrink-0">↓{git.behind}</span> : null}
              {git.dirty ? <span className="shrink-0 text-warn">●{git.dirty}</span> : null}
              <ChevronDown className="size-3 shrink-0 text-faint group-hover/branch:text-muted-foreground" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-96">
          {lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p className="text-muted-foreground">Click to switch branch</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" sideOffset={6} className="w-96 overflow-hidden rounded-xl border-hairline p-0">
        <div className="border-b border-hairline px-3 py-2 text-meta text-muted-foreground">
          {lines.map((l) => (
            <p key={l} className="truncate" title={l}>
              {l}
            </p>
          ))}
          {blocked ? <p className="mt-1 text-warn">{blocked}</p> : null}
        </div>
        {creating ? (
          <form
            className="flex flex-col gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name || branchNameProblem(name, existing) !== null) return;
              run({ name, create: true });
            }}
          >
            <label className="text-ui-sm text-foreground" htmlFor="new-branch-name">
              New branch from <span className="font-mono">{base}</span>
            </label>
            <input
              id="new-branch-name"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  e.preventDefault();
                  setCreating(false);
                }
              }}
              placeholder="feature/my-idea"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={nameProblem !== null}
              aria-describedby="new-branch-hint"
              className={cn(fieldClass, "font-mono", nameProblem && "border-bad")}
            />
            <p id="new-branch-hint" className={cn("text-meta", nameProblem ? "text-bad" : "text-muted-foreground")}>
              {nameProblem ?? (dirty > 0 ? `Your ${dirty} uncommitted change${dirty === 1 ? "" : "s"} come along.` : "Creates the branch and switches to it.")}
            </p>
            <div className="flex justify-end gap-1.5">
              <button type="button" className={quietButton} onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className={primaryButton} disabled={!!blocked || !!pending || !newName.trim() || nameProblem !== null}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranchPlus className="size-3.5" />}
                Create and switch
              </button>
            </div>
          </form>
        ) : (
          <Command loop shouldFilter={false} className="bg-transparent">
            <CommandInput value={query} onValueChange={setQuery} placeholder="Filter branches…" className="h-10 text-ui" />
            <CommandList className="max-h-[min(52vh,380px)] p-1">
              {!list ? (
                <div className="px-2 py-6 text-center text-ui-sm text-muted-foreground">
                  {loadError ?? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="size-3.5 animate-spin" /> Loading branches…
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <CommandEmpty className="py-6 text-center text-ui-sm text-muted-foreground">No branch matches.</CommandEmpty>
                  {shown.local.length > 0 ? (
                    <CommandGroup heading="Branches" className="[&_[cmdk-group-heading]]:section-label">
                      {shown.local.map((b) => {
                        const counts = aheadBehind(b);
                        const disabled = b.current || !!b.worktree || !!blocked || (!!pending && pending !== b.name);
                        return (
                          <CommandItem
                            key={b.name}
                            value={`local:${b.name}`}
                            disabled={disabled}
                            onSelect={() => run({ name: b.name })}
                            className={itemClass}
                            title={b.worktree ? `Checked out in ${b.worktree}` : `${b.lastCommit.sha} ${b.lastCommit.subject}`}
                          >
                            {pending === b.name ? (
                              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                            ) : b.current ? (
                              <Check className="size-3.5 shrink-0 text-primary" />
                            ) : (
                              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className={cn("truncate font-mono text-ui-sm", b.current ? "font-medium text-foreground" : "text-foreground")}>{b.name}</span>
                              <span className="truncate text-meta text-muted-foreground">
                                {b.worktree ? "in another worktree" : b.lastCommit.subject}
                              </span>
                            </span>
                            {counts ? <span className="shrink-0 font-mono text-meta text-muted-foreground">{counts}</span> : null}
                            {b.current ? (
                              <span className="pill-primary shrink-0 rounded-full px-1.5 text-caption">current</span>
                            ) : (
                              <span className="shrink-0 text-meta text-faint">{relativeTime(b.lastCommit.date)}</span>
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null}
                  {shown.remote.length > 0 ? (
                    <CommandGroup heading="Remote only" className="[&_[cmdk-group-heading]]:section-label">
                      {shown.remote.map((r) => (
                        <CommandItem
                          key={r.name}
                          value={`remote:${r.name}`}
                          disabled={!!blocked || (!!pending && pending !== r.name)}
                          onSelect={() => run({ name: r.name })}
                          className={itemClass}
                          title={`Creates ${r.branch} tracking ${r.name}`}
                        >
                          {pending === r.name ? (
                            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                          ) : (
                            <CloudDownload className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-mono text-ui-sm text-foreground">{r.name}</span>
                            <span className="truncate text-meta text-muted-foreground">{r.lastCommit.subject}</span>
                          </span>
                          <span className="shrink-0 text-meta text-faint">{relativeTime(r.lastCommit.date)}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}
                  <CommandGroup className="border-t border-hairline pt-1">
                    {canCreateTyped ? (
                      <CommandItem
                        value={`create-typed:${typed}`}
                        disabled={!!blocked || !!pending}
                        onSelect={() => run({ name: typed, create: true })}
                        className={itemClass}
                      >
                        <GitBranchPlus className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">
                          Create <span className="font-mono">{typed}</span> from <span className="font-mono">{base}</span>
                        </span>
                      </CommandItem>
                    ) : null}
                    <CommandItem
                      value="create-branch"
                      disabled={!!blocked || !!pending}
                      onSelect={() => {
                        setNewName(typed && !canCreateTyped ? "" : typed);
                        setCreating(true);
                      }}
                      className={itemClass}
                    >
                      <GitBranchPlus className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">
                        Create branch from <span className="font-mono">{base}</span>…
                      </span>
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
            <div className="border-t border-hairline px-2.5 py-1.5 text-meta text-muted-foreground">
              {dirty > 0
                ? `${dirty} uncommitted change${dirty === 1 ? "" : "s"} come along — git stops if they clash with the branch.`
                : "The map follows the branch you switch to."}
              {list?.truncated ? " Showing the 200 most recent." : ""}
            </div>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
