// One installed extension: kind, scope, status, per-agent switches, exactly what it runs, its
// secrets, and the actions (approve, fetch, also install into, remove). Turning an agent on for
// something that runs commands asks first, showing the commands.
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Download, ExternalLink, Loader2, MoreHorizontal, ShieldAlert, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { cn } from "@/lib/utils";
import {
  AGENT_LABEL,
  TARGET_LABEL,
  needsApproval,
  sourceLabel,
  type ExtensionAgent,
  type ExtensionView,
  type ExtensionsApi,
  type InstallTarget,
} from "@/lib/extensions";
import { AgentSwitches, KindChip, KindMark, ScopeChip, SecretRow, StatusChip, WhatItRunsBlock, primaryButton, quietButton, solidButton } from "./parts";

const TARGETS: InstallTarget[] = ["claude-code", "cursor", "kiro"];

export function ExtensionCard({
  view,
  api,
  installedAgents,
  hasProject,
  highlight,
  onChanged,
  onMessage,
}: {
  view: ExtensionView;
  api: ExtensionsApi;
  installedAgents: Partial<Record<ExtensionAgent, boolean>>;
  hasProject: boolean;
  highlight?: boolean;
  onChanged: () => Promise<void>;
  onMessage: (text: string, tone?: "ok" | "bad") => void;
}) {
  const [open, setOpen] = useState(view.status === "review" || view.enabledFor.length === 0);
  const [busyAgent, setBusyAgent] = useState<ExtensionAgent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ExtensionAgent[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // A just-added extension scrolls into view.
  useEffect(() => {
    if (highlight === true) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlight]);

  const run = async (label: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(label);
    setError(null);
    const result = await action();
    setBusy(null);
    if (!result.ok) setError(result.message ?? "Failed");
    await onChanged();
  };

  const enable = async (agents: ExtensionAgent[]) => {
    setBusyAgent(agents[0] ?? null);
    setError(null);
    // The fingerprint of what this card shows: if it changed meanwhile, the daemon refuses instead of approving it unseen.
    const r = await api.enable(view.id, view.scope, agents, view.fingerprint);
    setBusyAgent(null);
    if (!r.ok) setError(r.message);
    await onChanged();
  };

  const toggle = (agent: ExtensionAgent, on: boolean) => {
    if (on && needsApproval(view)) {
      setOpen(true);
      setConfirm([agent]);
      return;
    }
    if (on) {
      void enable([agent]);
      return;
    }
    setBusyAgent(agent);
    setError(null);
    void api.disable(view.id, view.scope, [agent]).then(async (r) => {
      setBusyAgent(null);
      if (!r.ok) setError(r.message);
      await onChanged();
    });
  };

  const installInto = (target: InstallTarget, targetScope: "global" | "project") =>
    void run(`install-${target}`, async () => {
      const r = await api.installInto(view.id, view.scope, target, targetScope);
      if (r.ok) {
        const where = r.data.written.length === 1 ? r.data.written[0] : `${r.data.written.length} places`;
        onMessage(`Installed ${view.name} into ${TARGET_LABEL[target]} (${where})${r.data.notes.length > 0 ? ` — ${r.data.notes.join(" ")}` : ""}`);
        return { ok: true };
      }
      return { ok: false, message: r.message };
    });

  const approveAgents = view.enabledFor.filter((a): a is ExtensionAgent => a in AGENT_LABEL);

  return (
    <div
      ref={cardRef}
      className={cn(
        "card-warm px-4 py-3.5 transition-shadow",
        highlight && "ring-1 ring-primary/40",
        view.status === "review" && "border-warn/30",
      )}
      id={`ext-${view.scope}-${view.id}`}
    >
      <div className="flex items-start gap-3">
        <KindMark kind={view.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="me-1 text-body font-medium text-foreground">{view.name}</p>
            <KindChip kind={view.kind} />
            <ScopeChip scope={view.scope} />
            <StatusChip view={view} />
          </div>
          {view.description !== undefined ? <p className="mt-0.5 line-clamp-2 text-ui-sm text-muted-foreground">{view.description}</p> : null}
          <p className="mt-0.5 truncate font-mono text-meta text-faint" title={sourceLabel(view.source, view.path)}>
            {view.id} · {sourceLabel(view.source, view.path)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {view.homepage !== undefined ? (
            <a href={view.homepage} target="_blank" rel="noreferrer noopener" className={quietButton} aria-label={`${view.name} homepage`} title="Homepage">
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger className={quietButton} aria-label={`More actions for ${view.name}`}>
              {busy !== null ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-meta font-normal text-faint">Also install into (writes that tool's config)</DropdownMenuLabel>
              {TARGETS.map((target) => (
                <div key={target}>
                  {hasProject ? (
                    <DropdownMenuItem className="text-ui-sm" onSelect={() => installInto(target, "project")} disabled={view.kind === "plugin"}>
                      {TARGET_LABEL[target]} · this project
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem className="text-ui-sm" onSelect={() => installInto(target, "global")} disabled={view.kind === "plugin"}>
                    {TARGET_LABEL[target]} · all projects
                  </DropdownMenuItem>
                </div>
              ))}
              {view.source.type === "git" ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-ui-sm"
                    onSelect={() =>
                      void run("fetch", async () => {
                        const r = await api.fetchSource(view.id, view.scope);
                        return r.ok ? { ok: true } : { ok: false, message: r.message };
                      })
                    }
                  >
                    <Download className="size-3.5" /> Fetch source
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-ui-sm text-bad focus:text-bad" onSelect={() => setRemoving(true)}>
                <Trash2 className="size-3.5" /> Remove…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {view.status === "review" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn/25 bg-warn/[0.06] px-3 py-2">
          <ShieldAlert className="size-4 shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-ui-sm text-foreground">
            {view.statusDetail ?? "Needs review"} — it is not given to agents until you approve what it runs (below).
          </p>
          <button
            type="button"
            className={primaryButton}
            disabled={approveAgents.length === 0 || busyAgent !== null}
            onClick={() => {
              // Something that runs commands is approved from the dialog that lists them.
              if (needsApproval(view)) setConfirm(approveAgents);
              else void enable(approveAgents);
            }}
          >
            Approve
          </button>
        </div>
      ) : null}
      {view.status === "missing" || view.status === "invalid" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-bad/25 bg-bad/[0.05] px-3 py-2">
          <p className="min-w-0 flex-1 text-ui-sm text-foreground">{view.statusDetail ?? view.status}</p>
          {view.status === "missing" && view.source.type === "git" ? (
            <button
              type="button"
              className={solidButton}
              disabled={busy !== null}
              onClick={() =>
                void run("fetch", async () => {
                  const r = await api.fetchSource(view.id, view.scope);
                  return r.ok ? { ok: true } : { ok: false, message: r.message };
                })
              }
            >
              <Download className="size-3.5" /> Fetch
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3">
        <AgentSwitches view={view} installed={installedAgents} busy={busyAgent} onToggle={toggle} />
      </div>

      <button
        type="button"
        className="mt-3 flex items-center gap-1 text-label text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        What it runs
        {view.what.servers.length > 0 ? <span className="text-faint">· {view.what.servers.length} server{view.what.servers.length === 1 ? "" : "s"}</span> : null}
        {view.secrets.some((s) => !s.set && !s.fromEnv) ? <span className="text-warn">· secret not set</span> : null}
      </button>
      {open ? (
        <div className="mt-2 space-y-2.5">
          <WhatItRunsBlock what={view.what} />
          {view.secrets.length > 0 ? (
            <div className="space-y-1.5">
              {view.secrets.map((s) => (
                <SecretRow
                  key={s.name}
                  name={s.name}
                  set={s.set}
                  fromEnv={s.fromEnv}
                  onSave={async (value) => {
                    const r = await api.setSecret(view.id, view.scope, s.name, value);
                    await onChanged();
                    return r.ok ? null : r.message;
                  }}
                  onDelete={async () => {
                    const r = await api.deleteSecret(view.id, view.scope, s.name);
                    await onChanged();
                    return r.ok ? null : r.message;
                  }}
                />
              ))}
            </div>
          ) : null}
          {view.notes !== undefined ? <p className="text-label leading-relaxed text-muted-foreground">{view.notes}</p> : null}
          {(view.installedInto ?? []).length > 0 ? (
            <p className="text-meta text-faint">
              Also installed into: {(view.installedInto ?? []).map((r) => `${TARGET_LABEL[r.target]} (${r.scope === "project" ? "project" : "all projects"})`).join(", ")} — removed with it.
            </p>
          ) : null}
        </div>
      ) : null}
      {error !== null ? <p className="mt-2 text-ui-sm text-bad">{error}</p> : null}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => (o ? null : setConfirm(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Let {confirm !== null ? confirm.map((a) => AGENT_LABEL[a]).join(", ") : ""} use {view.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              When a session starts, the agent will run exactly this. Nothing runs now. If it changes later, Ruah stops giving it to agents until you approve again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <WhatItRunsBlock what={view.what} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const agents = confirm ?? [];
                setConfirm(null);
                void enable([...new Set([...approveAgents, ...agents])]);
              }}
            >
              Enable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {view.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents stop getting it in new sessions. Its Keychain secrets are deleted
              {(view.installedInto ?? []).length > 0 ? ", and what Ruah wrote into other tools is undone" : ""}
              {view.scope === "project" ? ". The project file changes (commit it to share)." : "."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-white hover:bg-bad/90"
              onClick={() =>
                void run("remove", async () => {
                  const r = await api.remove(view.id, view.scope);
                  if (r.ok) onMessage(`Removed ${view.name}${r.data.notes.length > 0 ? ` — ${r.data.notes.join(" ")}` : ""}`);
                  return r.ok ? { ok: true } : { ok: false, message: r.message };
                })
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
