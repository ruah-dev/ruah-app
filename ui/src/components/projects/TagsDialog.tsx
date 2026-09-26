// Tag a project with free-form groups (§20): a client's name, "Job", "Freelance". The first tag
// is the project's group (Home's card meta, the rail's grouping). Stored in the daemon's projects
// registry (POST /api/projects/tags), so every window and the CLI see the same groups. Opened
// from Home's card menu, the rail's right-click menu, All projects and the first-run hints.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check, Hash, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { setProjectTags } from "@/lib/daemon";
import { parseTags, tagCounts } from "@/lib/home";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

let openFor: string | null = null;
const listeners = new Set<() => void>();

/** Opens the dialog for a project (null closes it). */
export function setTagsDialog(projectId: string | null) {
  openFor = projectId;
  for (const l of listeners) l();
}

function useTagsDialog(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => openFor,
    () => null,
  );
}

export function TagsDialog() {
  const projectId = useTagsDialog();
  const { daemon } = useWorkspace();
  const project = daemon.recentProjects.find((p) => p.id === projectId) ?? (daemon.project?.id === projectId ? daemon.project : undefined);
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const known = useMemo(() => tagCounts(daemon.recentProjects).map((t) => t.tag), [daemon.recentProjects]);

  useEffect(() => {
    if (!projectId) return;
    setTags(project?.tags ?? []);
    setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const add = (raw: string) => {
    const next = parseTags([...tags, ...parseTags(raw)].join(","));
    setTags(next);
    setDraft("");
  };
  const toggle = (t: string) => (has(t) ? setTags(tags.filter((x) => x.toLowerCase() !== t.toLowerCase())) : add(t));
  const suggestions = [...new Set([...known, "Freelance", "Job", "Personal"])].filter((t) => !has(t)).slice(0, 8);

  const save = async () => {
    if (!project || busy) return;
    const final = parseTags([...tags, ...parseTags(draft)].join(","));
    setBusy(true);
    try {
      await setProjectTags(project.id, final);
      setTagsDialog(null);
    } catch (err) {
      toast.error(`Couldn't tag ${project.name}`, { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!projectId && !!project} onOpenChange={(v) => !v && setTagsDialog(null)}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md gap-0 rounded-2xl border-hairline bg-popover p-0">
        <div className="px-5 pt-5 pb-3">
          <DialogTitle className="text-title font-semibold">Group {project?.name}</DialogTitle>
          <DialogDescription className="mt-1 text-ui-sm">
            Free-form tags — a client, “Job”, “Freelance”. The first one is the project’s group; Home and the rail filter by them.
          </DialogDescription>
        </div>
        <div className="space-y-3 px-5 pb-4">
          <div
            className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1.5 shadow-[inset_0_0_0_1px_var(--color-hairline)] focus-within:shadow-[inset_0_0_0_1px_var(--color-ring)]"
            onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
          >
            {tags.map((t, i) => (
              <span key={t} className={cn("flex h-6 items-center gap-1 rounded-pill ps-2 pe-1 text-ui-sm", i === 0 ? "bg-primary/12 text-brand" : "bg-surface-3 text-foreground")}>
                {t}
                <button type="button" aria-label={`Remove ${t}`} onClick={() => toggle(t)} className="grid size-4 place-items-center rounded-full hover:bg-foreground/10">
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              autoFocus
              value={draft}
              onChange={(e) => {
                const v = e.target.value;
                if (v.endsWith(",")) add(v);
                else setDraft(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (draft.trim()) add(draft);
                  else void save();
                } else if (e.key === "Backspace" && !draft && tags.length) {
                  setTags(tags.slice(0, -1));
                }
              }}
              placeholder={tags.length ? "Add another…" : "Liquid Money, Job…"}
              aria-label="Add a tag"
              className="h-6 min-w-24 flex-1 bg-transparent text-ui outline-none placeholder:text-faint"
            />
          </div>
          {suggestions.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-meta text-faint">Suggestions</span>
              {suggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggle(t)}
                  className="flex h-6 items-center gap-1 rounded-pill border border-dashed border-hairline px-2 text-ui-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <Hash className="size-3" /> {t}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <Button variant="ghost" size="sm" className="h-8 text-ui-sm" onClick={() => setTagsDialog(null)}>
            Cancel
          </Button>
          <Button size="sm" className="h-8 gap-1.5 rounded-lg text-ui-sm" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
