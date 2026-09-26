// <PreviewPane/> — the live preview of the open project (CONTRACTS §18): the project's dev
// server in a frame with a URL bar, reload, device widths, open in browser, start / stop /
// restart and a command picker. Self-contained: it reads the daemon store and lib/preview, and
// works in any slot (the right-hand Agent | Preview split, a full page at /preview, a dialog).
// Hot reload is the dev server's own; without HMR the page reloads after each agent turn that
// edited files (a per-project toggle). A crash shows the last output and drafts a fix request
// for the agent in the composer.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ExternalLink, Globe, Loader2, Monitor, Play, RefreshCcwDot, RefreshCw, RotateCw, Smartphone, Square, Tablet, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { onDaemonMessage, useDaemonSelector } from "@/lib/daemon";
import { requestComposerDraft } from "@/lib/composer-draft";
import { terminalActions } from "@/lib/terminal";
import {
  DEVICES,
  buildFixPrompt,
  effectiveAutoReload,
  previewActions,
  resolveNavigation,
  usePreview,
  type Device,
  type PreviewCandidate,
  type PreviewStatus,
} from "@/lib/preview";
import { cn } from "@/lib/utils";
import { PreviewFrame, openInBrowser } from "./PreviewFrame";
import { CustomCommandDialog, PreviewCommandMenu } from "./PreviewCommandMenu";
import { CrashPanel, LookingPanel, NoProjectPanel, NothingFoundPanel, PickPanel, ReadyPanel, StartingPanel } from "./PreviewPanels";

export interface PreviewPaneProps {
  /** "panel": a side slot (compact); "page": the /preview route. */
  variant?: "panel" | "page";
  /** After "Ask agent to fix" drafted the prompt: the shell shows the agent (composer). */
  onAskAgent?: () => void;
  /** Show the server's output; default: the terminal panel on the "preview" tab (a log dialog without one). */
  onShowLogs?: (terminalId: string | null) => void;
  className?: string;
}

function ToolButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            pressed && "bg-accent text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const DEVICE_ICONS: Record<Device, typeof Monitor> = { desktop: Monitor, tablet: Tablet, phone: Smartphone };

function LogsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const load = () => {
    previewActions.logs(400).then(setLines, () => setLines([]));
  };
  useEffect(() => {
    if (open) load();
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Dev server output</DialogTitle>
          <DialogDescription>The last lines the preview’s server printed.</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60vh] min-h-40 overflow-auto rounded-lg bg-surface-0 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground select-text">
          {lines === null ? "Loading…" : lines.length > 0 ? lines.join("\n") : "(no output)"}
        </pre>
        <div className="flex justify-end">
          <button type="button" onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-ui-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <RefreshCw className="size-3.5" /> Refresh
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PreviewPane({ variant = "panel", onAskAgent, onShowLogs, className }: PreviewPaneProps) {
  const project = useDaemonSelector((s) => (s.source === "daemon" ? s.project : null));
  const projectId = project?.id ?? null;
  const p = usePreview(projectId);
  const status = p?.status ?? null;
  const detection = p?.detection ?? null;
  const prefs = p?.prefs ?? { device: "desktop" as Device };
  const busy = p?.pending !== null && p?.pending !== undefined;

  const [reloadKey, setReloadKey] = useState(0);
  // Where the user navigated (URL bar), tied to the server address it was typed against.
  const [nav, setNav] = useState<{ base: string | null; url: string | null }>({ base: null, url: null });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // A new server address (start, restart, another command) resets the page — in the same render.
  const baseUrl = status?.url ?? null;
  const navUrl = nav.base === baseUrl && nav.url !== null ? nav.url : baseUrl;
  useEffect(() => {
    if (!editing) setDraft(navUrl ?? "");
  }, [navUrl, editing]);

  const selected: PreviewCandidate | null =
    status?.candidate ?? detection?.candidates.find((c) => c.id === detection.selected) ?? null;
  const running = status?.state === "running";
  const liveState = running || status?.state === "starting";
  // What runs now, else what would run: HMR decides whether auto-reload is offered.
  const hmr = (liveState ? status?.hmr : selected?.hmr) ?? false;
  const autoReload = effectiveAutoReload(prefs.autoReload, hmr);
  const live = useRef({ autoReload, running: false });
  live.current = { autoReload, running };

  // No HMR: reload once an agent turn that edited files finishes (§13.2 activity feed).
  useEffect(() => {
    if (!projectId) return;
    return onDaemonMessage((msg) => {
      if (msg.type !== "activity" || msg.event.kind !== "turn.finished" || msg.event.projectId !== projectId) return;
      if (!msg.event.files || msg.event.files.length === 0) return;
      if (!live.current.autoReload || !live.current.running) return;
      setReloadKey((k) => k + 1);
      setFlash(`Reloaded after the agent edited ${msg.event.files.length} file${msg.event.files.length === 1 ? "" : "s"}`);
    });
  }, [projectId]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  if (!projectId || !p) {
    return (
      <section className={cn("flex min-h-0 flex-1 flex-col bg-background", className)} aria-label="Live preview">
        <NoProjectPanel />
      </section>
    );
  }

  const showLogs = () => {
    const terminalId = status?.terminalId ?? null;
    if (onShowLogs) {
      onShowLogs(terminalId);
      return;
    }
    if (terminalId && status?.runner === "pty") {
      terminalActions.setOpen(true);
      terminalActions.setActive(projectId, terminalId);
      terminalActions.focus();
      return;
    }
    setLogsOpen(true);
  };

  const startCandidate = (c: PreviewCandidate, remember: boolean) => {
    if (c.kind === "custom") void previewActions.start(projectId, { command: c.command, dir: c.dir, remember });
    else if (!remember && detection && c.id === detection.selected) void previewActions.start(projectId);
    else void previewActions.start(projectId, { candidate: c.id, remember });
  };

  const askAgent = async (s: PreviewStatus) => {
    const lines = await previewActions.logs(80).catch(() => s.logs);
    requestComposerDraft(buildFixPrompt(s, lines));
    onAskAgent?.();
    toast("Drafted a fix request for the agent", { description: "It’s in the composer — review it and send." });
  };

  const typeSetup = (command: string, dir: string) => {
    terminalActions.create({ ...(dir !== "." ? { cwd: dir } : {}), input: command, title: "install" }).catch((err: unknown) => {
      toast.error("Could not open a terminal", { description: err instanceof Error ? err.message : String(err) });
    });
  };

  const navigate = () => {
    const next = resolveNavigation(baseUrl, draft);
    setEditing(false);
    if (next === null) {
      setDraft(navUrl ?? "");
      toast.error("That is not an address the preview can open");
      return;
    }
    setNav({ base: baseUrl, url: next });
    setReloadKey((k) => k + 1);
  };

  let body: ReactNode;
  if (status === null && detection === null) body = <LookingPanel />;
  else if (running && navUrl) {
    body = (
      <PreviewFrame
        url={navUrl}
        device={prefs.device}
        reloadKey={reloadKey}
        framing={status.framing}
        title={`Preview of ${project?.name ?? "the project"}`}
        onNavigate={(url) => {
          if (!editing) setDraft(url);
        }}
      />
    );
  } else if (status?.state === "starting") body = <StartingPanel status={status} onShowLogs={showLogs} />;
  else if (status?.state === "crashed") {
    body = (
      <CrashPanel
        status={status}
        busy={busy}
        onAskAgent={() => void askAgent(status)}
        onRestart={() => void previewActions.restart(projectId)}
        onShowLogs={showLogs}
        onChange={() => setMenuOpen(true)}
        onSetup={typeSetup}
      />
    );
  } else if (detection === null) body = <LookingPanel />;
  else if (detection.candidates.length === 0) body = <NothingFoundPanel detection={detection} onCustom={() => setCustomOpen(true)} />;
  else if (selected === null) {
    body = <PickPanel detection={detection} busy={busy} onPick={(c) => startCandidate(c, true)} onCustom={() => setCustomOpen(true)} />;
  } else {
    body = (
      <ReadyPanel
        candidate={selected}
        busy={p.pending === "start"}
        onStart={() => startCandidate(selected, false)}
        onChange={() => setMenuOpen(true)}
        onSetup={typeSetup}
      />
    );
  }

  return (
    <section className={cn("flex min-h-0 flex-1 flex-col bg-background", className)} aria-label="Live preview">
      {/* One row when the slot is wide; in a side panel: command + run controls, then the address row. */}
      <header className={cn("@container border-b border-hairline bg-surface-0/50 px-2 py-1.5", variant === "page" && "px-3")}>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          <div className="order-1 min-w-0 shrink">
            <PreviewCommandMenu
              status={status}
              detection={detection}
              busy={busy}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onPick={(c) => startCandidate(c, true)}
              onCustom={() => setCustomOpen(true)}
              onForget={() =>
                void previewActions.choose(projectId, { candidate: null, command: null, ...(detection?.choiceFrom === "repo" ? { saveToRepo: true } : {}) })
              }
              onSaveToRepo={() => {
                const choice = detection?.choice;
                if (!choice) return;
                void previewActions
                  .choose(projectId, {
                    ...(choice.candidate !== undefined ? { candidate: choice.candidate } : {}),
                    ...(choice.command !== undefined ? { command: choice.command, dir: choice.dir ?? "." } : {}),
                    ...(choice.url !== undefined ? { url: choice.url } : {}),
                    saveToRepo: true,
                  })
                  .then((saved) => {
                    if (saved) toast("Saved to .ruah/preview.json", { description: "Commit it to share the choice with your team." });
                  });
              }}
              onRedetect={() => void previewActions.refresh(projectId)}
              onShowLogs={showLogs}
            />
          </div>
          <div className="order-3 flex min-w-0 basis-full items-center gap-1 @2xl:order-2 @2xl:basis-0 @2xl:flex-1">
            <form
              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-surface-2 px-2 focus-within:ring-1 focus-within:ring-ring"
              onSubmit={(e) => {
                e.preventDefault();
                navigate();
              }}
            >
              <Globe className={cn("size-3.5 shrink-0", running ? "text-ok" : "text-faint")} />
              <input
                aria-label="Preview address"
                value={running ? draft : ""}
                placeholder={liveState ? "Waiting for the server…" : "Not running"}
                disabled={!running}
                spellCheck={false}
                onFocus={() => setEditing(true)}
                onBlur={() => {
                  setEditing(false);
                  setDraft(navUrl ?? "");
                }}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                }}
                className="min-w-0 flex-1 bg-transparent font-mono text-meta text-foreground outline-none placeholder:font-sans placeholder:text-faint disabled:cursor-default"
              />
            </form>
            <ToolButton label="Reload the page" onClick={() => setReloadKey((k) => k + 1)} disabled={!running}>
              <RotateCw className="size-3.5" />
            </ToolButton>
            <div className="flex shrink-0 items-center rounded-md bg-surface-2 p-0.5" role="group" aria-label="Device width">
              {(Object.keys(DEVICES) as Device[]).map((d) => {
                const Icon = DEVICE_ICONS[d];
                return (
                  <Tooltip key={d}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={DEVICES[d].label}
                        aria-pressed={prefs.device === d}
                        onClick={() => previewActions.setDevice(projectId, d)}
                        className={cn(
                          "grid h-6 w-7 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground",
                          prefs.device === d && "bg-surface-4 text-foreground shadow-sm",
                        )}
                      >
                        <Icon className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{DEVICES[d].label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            {!hmr || prefs.autoReload !== undefined ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={autoReload}
                    onClick={() => previewActions.setAutoReload(projectId, !autoReload)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta transition-colors hover:bg-accent",
                      autoReload ? "text-primary" : "text-faint",
                    )}
                  >
                    <RefreshCw className="size-3" /> Auto
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {autoReload ? "Reloads after each agent turn that edits files (on)" : "Reload after each agent turn that edits files (off)"}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <ToolButton label="Open in browser" onClick={() => navUrl && openInBrowser(navUrl)} disabled={!running || !navUrl}>
              <ExternalLink className="size-3.5" />
            </ToolButton>
          </div>
          <div className="order-2 ms-auto flex shrink-0 items-center gap-1 @2xl:order-3 @2xl:ms-0">
            <span className="mx-0.5 hidden h-4 w-px bg-hairline @2xl:block" aria-hidden />
            {liveState ? (
              <>
                <ToolButton label="Restart the dev server" onClick={() => void previewActions.restart(projectId)} disabled={busy}>
                  {p.pending === "restart" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcwDot className="size-3.5" />}
                </ToolButton>
                <ToolButton label="Stop the dev server" onClick={() => void previewActions.stop(projectId)} disabled={busy}>
                  {p.pending === "stop" ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3 fill-current" />}
                </ToolButton>
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => (selected ? startCandidate(selected, false) : setMenuOpen(true))}
                    disabled={busy || (detection !== null && detection.candidates.length === 0)}
                    className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-ui-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {p.pending === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    {status?.state === "crashed" ? "Retry" : "Start"}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{selected ? `Run ${selected.command}` : "Choose what to run"}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </header>
      {p.error ? (
        <div className="flex items-start gap-2 border-b border-hairline bg-bad/10 px-3 py-1.5 text-ui-sm text-bad" role="alert">
          <span className="min-w-0 flex-1 break-words">{p.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => previewActions.clearError(projectId)} className="shrink-0 rounded p-0.5 hover:bg-bad/15">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {running && !status.healthy ? (
        <div className="border-b border-hairline bg-warn/10 px-3 py-1 text-ui-sm text-warn">The server is not answering — it may be restarting.</div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {body}
        {flash ? (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-popover px-3 py-1 text-meta text-muted-foreground shadow-elevated ring-1 ring-hairline">
            {flash}
          </div>
        ) : null}
      </div>
      {customOpen ? (
        <CustomCommandDialog
          open={customOpen}
          onOpenChange={setCustomOpen}
          initial={detection?.choice?.command ? { command: detection.choice.command, dir: detection.choice.dir ?? "." } : undefined}
          onRun={({ command, dir, remember, saveToRepo }) => void previewActions.start(projectId, { command, dir, remember, saveToRepo })}
        />
      ) : null}
      <LogsDialog open={logsOpen} onOpenChange={setLogsOpen} />
    </section>
  );
}
