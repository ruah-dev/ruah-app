// Multi-repo systems (CONTRACTS.md §12), self-contained: "New system…" / "Add another repo…"
// and the system manager (Repos + Connections). Mounted once (<SystemDialogs />) and opened
// from anywhere with openSystemDialog(); nothing here is needed for single-repo projects.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  FolderOpen,
  GitBranch,
  Github,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useDaemonSelector } from "@/lib/daemon";
import { useWorkbench } from "@/lib/workbench";
import { absoluteTime, prettyPath, relativeTime } from "@/lib/time";
import type { ArchEdge } from "@/lib/contracts";
import {
  closeSystemDialog,
  openSystemDialog,
  parseEvidence,
  REPO_ID_RE,
  systemApi,
  useSystemDialog,
  type GithubRepo,
  type RepoStatus,
  type StoredSuggestion,
  type SuggestionsView,
  type SystemStatus,
} from "@/lib/system";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const fieldClass = "h-9 rounded-lg border-hairline bg-surface-2 text-ui shadow-none focus-visible:ring-1 md:text-ui";
const smallBtn = "h-7 gap-1.5 rounded-md px-2 text-ui-sm";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function parentOf(p: string) {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i > 0 ? t.slice(0, i) : t;
}
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const deriveId = (p: string) =>
  baseName(p)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "") || "repo";

function useOrigin() {
  return useDaemonSelector((s) => s.httpOrigin);
}

/** Native folder picker in the desktop app; null in a browser (callers show a path field). */
function useFolderPicker() {
  const bridge = typeof window !== "undefined" ? window.ruah : undefined;
  return bridge ? (title: string) => bridge.pickFolder({ title }).catch(() => null) : null;
}

/** Mount once; renders whichever system dialog is open. */
export function SystemDialogs() {
  const d = useSystemDialog();
  return (
    <>
      <NewSystemDialog open={d?.kind === "new"} seedRepos={d?.kind === "new" ? (d.seedRepos ?? []) : []} />
      <ManageSystemDialog open={d?.kind === "manage"} tab={d?.kind === "manage" ? (d.tab ?? "repos") : "repos"} />
    </>
  );
}

// ---- shared bits -------------------------------------------------------------------------

/** A path field plus "Choose…" (desktop) that hands back a folder. */
function FolderField({
  id,
  value,
  onChange,
  placeholder,
  pickTitle,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  pickTitle: string;
}) {
  const pick = useFolderPicker();
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(fieldClass, "font-mono")}
      />
      {pick ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-1.5 rounded-lg border-hairline bg-surface-2 text-ui-sm shadow-none"
          onClick={async () => {
            const p = await pick(pickTitle);
            if (p) onChange(p);
          }}
        >
          <FolderOpen className="size-3.5" /> Choose…
        </Button>
      ) : null}
    </div>
  );
}

/** Browse an owner's GitHub repos (`gh repo list`); `onPick` runs only on an explicit click. */
function GithubPicker({ actionLabel, onPick }: { actionLabel: string; onPick: (repo: GithubRepo) => Promise<void> }) {
  const origin = useOrigin();
  const [owner, setOwner] = useState("");
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = async () => {
    setLoading(true);
    setError(null);
    try {
      setRepos((await systemApi.githubRepos(origin, owner.trim())).repos);
    } catch (err) {
      setError(message(err));
      setRepos(null);
    } finally {
      setLoading(false);
    }
  };
  const shown = (repos ?? []).filter((r) => !filter || r.nameWithOwner.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-2 rounded-xl border border-hairline bg-surface-1 p-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void list();
        }}
      >
        <Input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="GitHub owner or org (empty = you)"
          spellCheck={false}
          className={fieldClass}
        />
        <Button type="submit" variant="outline" size="sm" className="h-9 shrink-0 gap-1.5 rounded-lg" disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Github className="size-3.5" />} List repos
        </Button>
      </form>
      {error ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-ui-sm text-bad">{error}</p> : null}
      {repos ? (
        <>
          {repos.length > 8 ? (
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className={cn(fieldClass, "h-8")} />
          ) : null}
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {shown.length === 0 ? <li className="px-2 py-1.5 text-ui-sm text-muted-foreground">No repos.</li> : null}
            {shown.map((r) => (
              <li key={r.nameWithOwner} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-foreground">
                    {r.nameWithOwner}
                    {r.isPrivate ? <span className="ms-1.5 text-meta text-faint">private</span> : null}
                    {r.isArchived ? <span className="ms-1.5 text-meta text-faint">archived</span> : null}
                  </span>
                  {r.description ? <span className="block truncate text-meta text-muted-foreground">{r.description}</span> : null}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className={smallBtn}
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(r.nameWithOwner);
                    try {
                      await onPick(r);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === r.nameWithOwner ? <Loader2 className="size-3 animate-spin" /> : null}
                  {actionLabel}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-meta text-muted-foreground">
          Uses your <code className="font-mono">gh</code> login. Nothing is cloned until you click {actionLabel}.
        </p>
      )}
    </div>
  );
}

// ---- New system / Add another repo ---------------------------------------------------------

function NewSystemDialog({ open, seedRepos }: { open: boolean; seedRepos: string[] }) {
  const origin = useOrigin();
  const pick = useFolderPicker();
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<{ path: string; id: string }[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [github, setGithub] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addingToRepo = seedRepos.length > 0;

  useEffect(() => {
    if (!open) return;
    setRepos(seedRepos.map((p) => ({ path: p, id: deriveId(p) })));
    setDir(seedRepos[0] ? `${parentOf(seedRepos[0])}/system` : "");
    setName("");
    setManualPath("");
    setGithub(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addPath = (p: string) => {
    const path = p.trim();
    if (!path || repos.some((r) => r.path === path)) return;
    const taken = new Set(repos.map((r) => r.id));
    let id = deriveId(path);
    for (let i = 2; taken.has(id); i++) id = `${deriveId(path)}-${i}`;
    setRepos((rs) => [...rs, { path, id }]);
  };
  const idError = repos.find((r) => !REPO_ID_RE.test(r.id) || repos.filter((x) => x.id === r.id).length > 1);
  const valid = !!dir.trim() && repos.length > 0 && !idError;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await systemApi.create(origin, {
        dir: dir.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        repos: repos.map((x) => ({ path: x.path, id: x.id })),
      });
      closeSystemDialog();
      toast.success(r.created ? "System created" : "Repos added to the system", {
        description: `${prettyPath(r.dir)}/ruah.system.json — commit it to share the system.`,
      });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : closeSystemDialog())}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-xl gap-0 rounded-2xl border-hairline bg-popover p-0">
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle className="text-title font-semibold">{addingToRepo ? "Add another repo" : "New system"}</DialogTitle>
          <DialogDescription className="text-ui-sm">
            A system maps several repos — one per service — as one architecture with the connections between them. Ruah
            writes <code className="font-mono">ruah.system.json</code> in the folder you choose (an existing system there
            gets these repos added). {addingToRepo ? "This repo keeps its own map." : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-h-[65vh] space-y-4 overflow-y-auto px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="sys-dir" className="text-label text-muted-foreground">
              System folder
            </Label>
            <FolderField id="sys-dir" value={dir} onChange={setDir} placeholder="/Users/you/code/platform" pickTitle="Folder for ruah.system.json" />
            <p className="text-meta text-muted-foreground">Created when missing. Pick a folder of its own, or a platform / infra repo.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sys-name" className="text-label text-muted-foreground">
              Name <span className="text-faint">(optional)</span>
            </Label>
            <Input id="sys-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={dir ? baseName(dir) : "acme-platform"} className={fieldClass} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-label text-muted-foreground">Repos</Label>
            {repos.length === 0 ? <p className="text-ui-sm text-muted-foreground">No repos yet.</p> : null}
            <ul className="space-y-1">
              {repos.map((r, i) => (
                <li key={r.path} className="flex items-center gap-2">
                  <Input
                    aria-label="Repo id"
                    value={r.id}
                    onChange={(e) => {
                      const id = e.target.value;
                      setRepos((rs) => rs.map((x, j) => (j === i ? { ...x, id } : x)));
                    }}
                    className={cn(fieldClass, "h-8 w-36 font-mono", !REPO_ID_RE.test(r.id) && "border-bad")}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground" title={r.path}>
                    {prettyPath(r.path)}
                  </span>
                  <Button type="button" variant="ghost" size="sm" className="size-7 p-0" aria-label={`Remove ${r.id}`} onClick={() => setRepos((rs) => rs.filter((_, j) => j !== i))}>
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            {idError ? <p className="text-meta text-bad">Ids: lower-case letters, digits and dashes, unique.</p> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {pick ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={smallBtn}
                  onClick={async () => {
                    const p = await pick("Add a repo folder");
                    if (p) addPath(p);
                  }}
                >
                  <Plus className="size-3.5" /> Add folder…
                </Button>
              ) : (
                <div className="flex w-full gap-2">
                  <Input value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/repo" className={cn(fieldClass, "h-8 font-mono")} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={smallBtn}
                    onClick={() => {
                      addPath(manualPath);
                      setManualPath("");
                    }}
                  >
                    <Plus className="size-3.5" /> Add
                  </Button>
                </div>
              )}
              <Button type="button" variant={github ? "secondary" : "outline"} size="sm" className={smallBtn} onClick={() => setGithub((g) => !g)}>
                <Github className="size-3.5" /> From GitHub…
              </Button>
            </div>
            {github ? (
              <GithubPicker
                actionLabel="Clone"
                onPick={async (r) => {
                  const into = dir.trim() ? parentOf(dir.trim()) : seedRepos[0] ? parentOf(seedRepos[0]) : "";
                  if (!into) {
                    toast.error("Choose the system folder first", { description: "Repos are cloned next to it." });
                    return;
                  }
                  try {
                    const { path } = await systemApi.clone(origin, r.nameWithOwner, into);
                    addPath(path);
                    toast.success(`Cloned ${r.nameWithOwner}`, { description: prettyPath(path) });
                  } catch (err) {
                    toast.error(`Couldn't clone ${r.nameWithOwner}`, { description: message(err) });
                  }
                }}
              />
            ) : null}
          </div>
          {error ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-ui-sm text-bad">{error}</p> : null}
          <button type="submit" className="hidden" />
        </form>
        <DialogFooter className="gap-2 border-t border-hairline px-5 py-3">
          <Button variant="ghost" size="sm" className="h-8 text-ui-sm" onClick={closeSystemDialog}>
            Cancel
          </Button>
          <Button size="sm" className="h-8 gap-1.5 rounded-lg text-ui-sm" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {addingToRepo ? "Create system" : "Create and open"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Manage: Repos + Connections -----------------------------------------------------------

function ManageSystemDialog({ open, tab }: { open: boolean; tab: "repos" | "connections" }) {
  const [current, setCurrent] = useState(tab);
  useEffect(() => {
    if (open) setCurrent(tab);
  }, [open, tab]);
  const name = useDaemonSelector((s) => s.project?.name ?? "System");
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : closeSystemDialog())}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl gap-0 rounded-2xl border-hairline bg-popover p-0">
        <DialogHeader className="px-5 pt-5 pb-2 text-left">
          <DialogTitle className="text-title font-semibold">{name}</DialogTitle>
          <DialogDescription className="text-ui-sm">Repos of this system and the connections between them.</DialogDescription>
        </DialogHeader>
        <Tabs value={current} onValueChange={(v) => setCurrent(v as "repos" | "connections")} className="px-5 pb-5">
          <TabsList className="h-8">
            <TabsTrigger value="repos" className="text-ui-sm">
              Repos
            </TabsTrigger>
            <TabsTrigger value="connections" className="text-ui-sm">
              Connections
            </TabsTrigger>
          </TabsList>
          <TabsContent value="repos" className="mt-3">
            {open ? <ReposPanel /> : null}
          </TabsContent>
          <TabsContent value="connections" className="mt-3">
            {open ? <ConnectionsPanel /> : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Repos of the open system: git state, last scan, add / remove / rename / rescan. Movable as a page section. */
export function ReposPanel() {
  const origin = useOrigin();
  const pick = useFolderPicker();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [github, setGithub] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await systemApi.status(origin));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [origin]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<SystemStatus | { status: SystemStatus }>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      setStatus("status" in r ? r.status : r);
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(null);
    }
  };
  const addPath = (p: string) => void run("add", () => systemApi.addRepo(origin, { path: p }), `Added ${baseName(p)}`);

  if (error) return <p className="rounded-lg bg-bad/10 px-3 py-2 text-ui-sm text-bad">{error}</p>;
  if (!status) return <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={status.file}>
          {prettyPath(status.file)}
        </span>
        {status.builtAt ? <span title={absoluteTime(status.builtAt)}>map built {relativeTime(status.builtAt)}</span> : null}
        <Button variant="ghost" size="sm" className={smallBtn} disabled={busy !== null} onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-hairline">
        <table className="w-full text-ui-sm">
          <thead className="bg-surface-1 text-left text-meta text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-normal">Repo</th>
              <th className="px-3 py-2 font-normal">Branch</th>
              <th className="px-3 py-2 font-normal">Changes</th>
              <th className="px-3 py-2 text-right font-normal">Elements</th>
              <th className="px-3 py-2 font-normal">Scanned</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {status.repos.map((r) => (
              <RepoRow
                key={r.id}
                repo={r}
                busy={busy}
                onRename={(newId) => run(`rename:${r.id}`, () => systemApi.renameRepo(origin, r.id, newId), `Renamed ${r.id} to ${newId}`)}
                onRescan={() => run(`rescan:${r.id}`, () => systemApi.rescanRepo(origin, r.id), `Rescanned ${r.id}`)}
                onRemove={() => run(`remove:${r.id}`, () => systemApi.removeRepo(origin, r.id), `Removed ${r.id} from the system (its folder is untouched)`)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pick ? (
          <Button
            variant="outline"
            size="sm"
            className={smallBtn}
            disabled={busy !== null}
            onClick={async () => {
              const p = await pick("Add a repo to the system");
              if (p) addPath(p);
            }}
          >
            {busy === "add" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add repo…
          </Button>
        ) : (
          <form
            className="flex min-w-[18rem] flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (manualPath.trim()) addPath(manualPath.trim());
              setManualPath("");
            }}
          >
            <Input value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/repo" className={cn(fieldClass, "h-8 font-mono")} />
            <Button type="submit" variant="outline" size="sm" className={smallBtn} disabled={busy !== null}>
              <Plus className="size-3.5" /> Add
            </Button>
          </form>
        )}
        <Button variant={github ? "secondary" : "outline"} size="sm" className={smallBtn} onClick={() => setGithub((g) => !g)}>
          <Github className="size-3.5" /> From GitHub…
        </Button>
      </div>
      {github ? (
        <GithubPicker
          actionLabel="Clone & add"
          onPick={async (r) => {
            await run(`add`, () => systemApi.addRepo(origin, { github: { repo: r.nameWithOwner } }), `Cloned and added ${r.nameWithOwner}`);
          }}
        />
      ) : null}
    </div>
  );
}

function RepoRow({
  repo: r,
  busy,
  onRename,
  onRescan,
  onRemove,
}: {
  repo: RepoStatus;
  busy: string | null;
  onRename: (newId: string) => Promise<void>;
  onRescan: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState(r.id);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const g = r.git;
  const valid = REPO_ID_RE.test(id) && id !== r.id;
  return (
    <tr className="border-t border-hairline align-middle">
      <td className="px-3 py-2">
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) void onRename(id).then(() => setEditing(false));
            }}
          >
            <Input autoFocus value={id} onChange={(e) => setId(e.target.value)} className={cn(fieldClass, "h-7 w-36 font-mono", !REPO_ID_RE.test(id) && "border-bad")} />
            <Button type="submit" variant="ghost" size="sm" className="size-7 p-0" disabled={!valid} aria-label="Save id">
              <Check className="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="size-7 p-0" aria-label="Cancel" onClick={() => (setEditing(false), setId(r.id))}>
              <X className="size-3.5" />
            </Button>
          </form>
        ) : (
          <div className="min-w-0">
            <span className="font-mono text-foreground">{r.id}</span>
            {r.type ? <span className="ms-1.5 text-meta text-faint">{r.type}</span> : null}
            <span className="block truncate font-mono text-meta text-muted-foreground" title={r.root}>
              {r.path}
            </span>
            {r.warning ? <span className="block text-meta text-warn">{r.warning}</span> : null}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {!r.exists ? (
          <span className="text-bad">folder missing</span>
        ) : g ? (
          <span className="inline-flex items-center gap-1 font-mono" title={g.upstream ? `tracking ${g.upstream}` : "no upstream"}>
            <GitBranch className="size-3 text-faint" />
            {g.branch ?? `detached ${g.head ?? ""}`}
            {g.upstream && (g.ahead || g.behind) ? (
              <span className="text-meta text-muted-foreground">
                {g.ahead ? ` ↑${g.ahead}` : ""}
                {g.behind ? ` ↓${g.behind}` : ""}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground" title={r.gitError}>
            {r.gitError ? "git error" : "not a git repo"}
          </span>
        )}
      </td>
      <td className="px-3 py-2">{g ? (g.dirty ? <span className="text-warn">{g.dirty} changed</span> : <span className="text-muted-foreground">clean</span>) : null}</td>
      <td className="px-3 py-2 text-right tabular-nums">{r.nodes}</td>
      <td className="px-3 py-2 text-muted-foreground" title={r.lastScanAt ? `${absoluteTime(r.lastScanAt)} · ${r.scanSource ?? ""}` : undefined}>
        {r.lastScanAt ? relativeTime(r.lastScanAt) : "never"}
      </td>
      <td className="px-2 py-2">
        <div className="flex justify-end gap-0.5">
          {confirmRemove ? (
            <>
              <Button variant="ghost" size="sm" className={cn(smallBtn, "text-bad")} disabled={busy !== null} onClick={() => void onRemove()}>
                Remove from system
              </Button>
              <Button variant="ghost" size="sm" className="size-7 p-0" aria-label="Keep" onClick={() => setConfirmRemove(false)}>
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="size-7 p-0" title="Rename id" aria-label={`Rename ${r.id}`} disabled={busy !== null} onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="size-7 p-0" title="Rescan this repo" aria-label={`Rescan ${r.id}`} disabled={busy !== null || !r.exists} onClick={() => void onRescan()}>
                {busy === `rescan:${r.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              </Button>
              <Button variant="ghost" size="sm" className="size-7 p-0" title="Remove from the system (files untouched)" aria-label={`Remove ${r.id}`} disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function EvidenceChips({ evidence }: { evidence: string[] }) {
  const wb = useWorkbench();
  return (
    <span className="flex flex-wrap gap-1">
      {evidence.map((ev) => (
        <button
          key={ev}
          type="button"
          className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-caption text-muted-foreground hover:text-foreground"
          title="Open at this line"
          onClick={() => {
            const { path, range } = parseEvidence(ev);
            closeSystemDialog();
            wb.openCode(path, range);
          }}
        >
          {ev}
        </button>
      ))}
    </span>
  );
}

const edgeText = (e: Pick<ArchEdge, "from" | "to" | "label">) => `${e.from} → ${e.to}${e.label ? ` · ${e.label}` : ""}`;

/** Deterministic edges (zero tokens) + agent suggestions to review. Movable as a page section. */
export function ConnectionsPanel() {
  const origin = useOrigin();
  const agentName = useDaemonSelector((s) => {
    const id = s.agent?.agents?.currentAgentId;
    return s.agent?.agents?.available.find((a) => a.id === id)?.name ?? "the agent";
  });
  const [signals, setSignals] = useState<ArchEdge[] | null>(null);
  const [view, setView] = useState<SuggestionsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showDetected, setShowDetected] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([systemApi.signals(origin), systemApi.suggestions(origin)]);
      setSignals(s.edges);
      setView(v);
    } catch (err) {
      toast.error(message(err));
    }
  }, [origin]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // While the agent runs: poll, and refresh as soon as any turn finishes.
  useEffect(() => {
    if (!view?.running) return;
    const t = setInterval(() => void refresh(), 2000);
    const onDone = () => void refresh();
    window.addEventListener("ruah:turn-finished", onDone);
    return () => {
      clearInterval(t);
      window.removeEventListener("ruah:turn-finished", onDone);
    };
  }, [view?.running, refresh]);

  const act = async (key: string, fn: () => Promise<SuggestionsView | { suggestions: SuggestionsView }>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      setView("suggestions" in r ? r.suggestions : r);
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(null);
    }
  };

  const byPair = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of signals ?? []) m.set(`${e.from}>${e.to}`, (m.get(`${e.from}>${e.to}`) ?? 0) + 1);
    return m;
  }, [signals]);

  if (!view || !signals) return <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />;
  return (
    <div className="max-h-[60vh] space-y-4 overflow-y-auto pe-1">
      <section className="space-y-1.5">
        <button type="button" className="section-label flex items-center gap-1.5" onClick={() => setShowDetected((s) => !s)}>
          Detected from code and config · {signals.length}
          <span className="text-faint">{showDetected ? "hide" : "show"}</span>
        </button>
        <p className="text-meta text-muted-foreground">
          Found deterministically (compose / k8s / terraform, env and config URLs, topics, packages) — no tokens. {byPair.size} repo pairs.
        </p>
        {showDetected ? (
          <ul className="space-y-1">
            {signals.map((e) => (
              <li key={`${e.from}>${e.to}>${e.label ?? ""}`} className="rounded-lg bg-surface-1 px-3 py-1.5">
                <span className="font-mono text-ui-sm text-foreground">{edgeText(e)}</span>
                {e.kind ? <span className="ms-1.5 text-meta text-faint">{e.kind}</span> : null}
                {e.evidence?.length ? (
                  <div className="mt-1">
                    <EvidenceChips evidence={e.evidence} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="section-label flex-1">Suggested by the agent · {view.pending.length}</h3>
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-lg text-ui-sm"
            disabled={!!view.running || busy !== null}
            onClick={() => void act("run", () => systemApi.runSuggestions(origin), `${agentName} is looking for connections — follow it in the chat`)}
          >
            {view.running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {view.running ? "Suggesting…" : "Suggest connections"}
          </Button>
        </div>
        <p className="text-meta text-muted-foreground">
          Optional second pass: {agentName} reads the repos (read-only) and proposes edges with evidence. It runs as a normal
          turn in the current chat. Accepted edges are kept on every rescan; rejected ones are not proposed again.
        </p>
        {view.lastRun?.error ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-ui-sm text-bad">Last run failed: {view.lastRun.error}</p> : null}
        {view.pending.length === 0 && !view.running ? (
          <p className="text-ui-sm text-muted-foreground">{view.lastRun ? "Nothing to review." : "No suggestions yet."}</p>
        ) : null}
        <ul className="space-y-1.5">
          {view.pending.map((s) => (
            <SuggestionRow
              key={s.id}
              s={s}
              busy={busy}
              onAccept={() => act(`accept:${s.id}`, () => systemApi.accept(origin, s.id), `Added ${edgeText(s)}`)}
              onReject={() => act(`reject:${s.id}`, () => systemApi.reject(origin, s.id))}
            />
          ))}
        </ul>
      </section>

      {view.rejected.length ? (
        <section className="space-y-1.5">
          <button type="button" className="section-label flex items-center gap-1.5" onClick={() => setShowRejected((s) => !s)}>
            Rejected · {view.rejected.length}
            <span className="text-faint">{showRejected ? "hide" : "show"}</span>
          </button>
          {showRejected ? (
            <ul className="space-y-1">
              {view.rejected.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-lg bg-surface-1 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-muted-foreground">{edgeText(r)}</span>
                  <Button variant="ghost" size="sm" className={smallBtn} disabled={busy !== null} onClick={() => void act(`unreject:${r.id}`, () => systemApi.unreject(origin, r.id))}>
                    <Undo2 className="size-3.5" /> Allow again
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function SuggestionRow({ s, busy, onAccept, onReject }: { s: StoredSuggestion; busy: string | null; onAccept: () => void; onReject: () => void }) {
  const pct = Math.round(s.confidence * 100);
  return (
    <li className="space-y-1 rounded-xl border border-hairline bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-ui text-foreground">{edgeText(s)}</span>
        {s.kind ? <span className="text-meta text-faint">{s.kind}</span> : null}
        <span
          className={cn("rounded-pill px-1.5 text-caption tabular-nums", pct >= 80 ? "bg-ok/15 text-ok" : pct >= 50 ? "bg-warn/15 text-warn" : "bg-surface-3 text-muted-foreground")}
          title="Agent's confidence"
        >
          {pct}%
        </span>
        <Button size="sm" variant="outline" className={smallBtn} disabled={busy !== null} onClick={onAccept}>
          {busy === `accept:${s.id}` ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />} Accept
        </Button>
        <Button size="sm" variant="ghost" className={smallBtn} disabled={busy !== null} onClick={onReject}>
          <X className="size-3.5" /> Reject
        </Button>
      </div>
      {s.reason ? <p className="text-ui-sm text-muted-foreground">{s.reason}</p> : null}
      <EvidenceChips evidence={s.evidence} />
    </li>
  );
}

/** Entry points for menus: what to offer for the open project (nothing while no daemon project). */
export function systemMenuActions(project: { kind: string; root: string } | null) {
  if (!project) return [];
  return project.kind === "system"
    ? [
        { key: "repos", label: "Repos…", run: () => openSystemDialog({ kind: "manage", tab: "repos" }) },
        { key: "connections", label: "Suggest connections…", run: () => openSystemDialog({ kind: "manage", tab: "connections" }) },
      ]
    : [{ key: "add-repo", label: "Add another repo…", run: () => openSystemDialog({ kind: "new", seedRepos: [project.root] }) }];
}
