// "Issues" in an element's Details: linked Jira / GitHub items with status, assignee and age;
// Link issue… (search), unlink, Create issue… (confirmed), and "Draft an issue with the agent",
// which only puts a prompt in the composer.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Link2, Loader2, MoreHorizontal, Plus, Sparkles, X } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import type { WorkItem } from "@/lib/contracts";
import { fetchWorkItems, linkWorkItem, timeAgo, useEnsure } from "@/lib/integrations";
import { requestComposerDraft } from "@/lib/composer-draft";
import { useWorkbench } from "@/lib/workbench";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  IntegrationsLink,
  Pill,
  ProviderGlyph,
  quietButton,
  workStatusTone,
} from "@/components/integrations/common";
import { CreateIssueDialog } from "./CreateIssueDialog";
import { cn } from "@/lib/utils";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; items: WorkItem[] };

function LinkIssuePopover({
  nodeId,
  linkedIds,
  onLinked,
}: {
  nodeId: string;
  linkedIds: Set<string>;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<WorkItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    setSearching(true);
    const t = setTimeout(() => {
      void fetchWorkItems(query ? { q: query } : { q: "" }).then((res) => {
        setSearching(false);
        if (res.ok) {
          setResults(res.data);
          setError(null);
        } else setError(res.message);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const link = async (item: WorkItem) => {
    setLinking(item.id);
    const res = await linkWorkItem(item, nodeId, true);
    setLinking(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOpen(false);
    setQ("");
    onLinked();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={quietButton}>
          <Link2 className="size-3.5" /> Link issue…
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 border-hairline p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder="Search issues by key or text…"
            className="h-9 text-ui"
          />
          <CommandList className="max-h-72">
            {searching && results.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-5 text-ui-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Searching…
              </div>
            ) : null}
            {error ? <p className="px-3 py-4 text-ui-sm text-bad">{error}</p> : null}
            {!searching && !error ? (
              <CommandEmpty className="py-5 text-center text-ui-sm text-muted-foreground">
                No issues found.
              </CommandEmpty>
            ) : null}
            {results.length ? (
              <CommandGroup heading={q.trim() ? "Results" : "Recent"}>
                {results.map((it) => {
                  const already = linkedIds.has(`${it.provider}:${it.id}`);
                  return (
                    <CommandItem
                      key={`${it.provider}:${it.id}`}
                      value={`${it.provider}:${it.id}`}
                      disabled={already || linking !== null}
                      onSelect={() => void link(it)}
                      className="gap-2 text-ui"
                    >
                      <ProviderGlyph id={it.provider} />
                      <span className="shrink-0 font-mono text-meta text-muted-foreground">{it.id}</span>
                      <span className="min-w-0 flex-1 truncate">{it.title}</span>
                      {linking === it.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : already ? (
                        <Check className="size-3.5 text-primary" />
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function IssueRow({ item, onUnlink }: { item: WorkItem; onUnlink: () => void }) {
  return (
    <li className="group/issue -mx-1.5 flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent/60">
      <ProviderGlyph id={item.provider} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground/90 hover:underline"
          title={`${item.id} — open in ${item.provider === "jira" ? "Jira" : "GitHub"}`}
        >
          <span className="shrink-0 font-mono text-meta text-muted-foreground">{item.id}</span>
          <span className="truncate">{item.title}</span>
        </a>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          <Pill tone={workStatusTone(item.status)} className="h-4 px-1 text-caption">
            {item.status}
          </Pill>
          {item.assignee ? <span className="truncate">{item.assignee}</span> : <span className="text-faint">Unassigned</span>}
          <span className="shrink-0 text-faint">· {timeAgo(item.updatedAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/issue:opacity-100 focus-within:opacity-100">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${item.id}`}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
        <button
          type="button"
          aria-label={`Unlink ${item.id}`}
          title="Unlink from this element"
          onClick={onUnlink}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

export function IssuesSection({ node }: { node: DiagramNode }) {
  const s = useEnsure("integrations");
  const wb = useWorkbench();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [createOpen, setCreateOpen] = useState(false);

  const providers = useMemo(
    () =>
      s.integrations.status === "ok"
        ? s.integrations.data.filter((i) => i.family === "work" && i.status === "connected")
        : [],
    [s.integrations],
  );
  const connected = providers.length > 0;

  const refresh = useCallback(() => {
    if (!s.origin) return;
    void fetchWorkItems({ nodeId: node.id }).then((res) =>
      setLoad(res.ok ? { status: "ok", items: res.data } : { status: "error", message: res.message }),
    );
  }, [node.id, s.origin]);

  useEffect(() => {
    setLoad({ status: "loading" });
    refresh();
  }, [refresh]);

  const items = load.status === "ok" ? load.items : [];
  const linkedIds = useMemo(() => new Set(items.map((i) => `${i.provider}:${i.id}`)), [items]);

  const unlink = async (item: WorkItem) => {
    setLoad((l) => (l.status === "ok" ? { ...l, items: l.items.filter((i) => i !== item) } : l));
    const res = await linkWorkItem(item, node.id, false);
    if (!res.ok) refresh();
  };

  const draftWithAgent = () => {
    const tracker = providers[0]?.name ?? "Jira or GitHub";
    requestComposerDraft(
      `Draft a ${tracker} issue for ${node.label}. Look at its code first, then suggest a concise title, a description with context and acceptance criteria, and labels. Don't create the issue — I'll review it first.`,
    );
    wb.ask(node);
  };

  if (!s.origin) return null;

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h3 className="text-label font-medium text-muted-foreground">Issues</h3>
        {items.length ? <span className="text-meta text-faint">{items.length}</span> : null}
        <span className="flex-1" />
        {connected ? (
          <>
            <LinkIssuePopover nodeId={node.id} linkedIds={linkedIds} onLinked={refresh} />
            <button type="button" className={quietButton} onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" /> Create
            </button>
          </>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More issue actions"
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={draftWithAgent}>
              <Sparkles className="text-muted-foreground" /> Draft an issue with the agent
            </DropdownMenuItem>
            {connected ? (
              <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                <Plus className="text-muted-foreground" /> Create issue…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {load.status === "loading" ? (
        <p className="flex items-center gap-2 text-label text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading issues…
        </p>
      ) : load.status === "error" ? (
        <p className="text-label text-muted-foreground">
          {connected ? `Couldn't load issues: ${load.message}` : null}
          {!connected ? (
            <>
              Connect Jira or GitHub in <IntegrationsLink /> to link issues.
            </>
          ) : null}
        </p>
      ) : items.length ? (
        <ul>
          {items.map((it) => (
            <IssueRow key={`${it.provider}:${it.id}`} item={it} onUnlink={() => void unlink(it)} />
          ))}
        </ul>
      ) : (
        <p className={cn("text-label text-faint")}>
          {connected ? (
            "No linked issues."
          ) : (
            <>
              Connect Jira or GitHub in <IntegrationsLink /> to link issues.
            </>
          )}
        </p>
      )}

      {connected ? (
        <CreateIssueDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          node={node}
          providers={providers}
          onCreated={() => refresh()}
        />
      ) : null}
    </section>
  );
}
