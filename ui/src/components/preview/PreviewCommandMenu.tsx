// The command picker: every detected way to run the project (grouped per app in a monorepo),
// your own command, forgetting the saved choice. Picking one runs it and remembers it for the
// project (.ruah/preview.json, committable).
import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, FolderOpen, RefreshCw, SquareTerminal, Undo2, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { candidateLabel, groupCandidates, stateMeta, type PreviewCandidate, type PreviewDetection, type PreviewStatus } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { StatusDot } from "./StatusDot";

export function CandidateLine({ c }: { c: PreviewCandidate }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-1.5 text-ui text-foreground">
        <span className="truncate">{c.title}</span>
        {c.hmr ? <Zap className="size-3 shrink-0 text-primary" aria-label="hot reload" /> : null}
        {c.available === false ? <AlertTriangle className="size-3 shrink-0 text-warn" aria-label={`${c.needs} not found`} /> : null}
      </span>
      <span className="truncate font-mono text-meta text-faint">{c.command}</span>
    </span>
  );
}

export function CustomCommandDialog({
  open,
  onOpenChange,
  initial,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { command?: string | undefined; dir?: string | undefined } | undefined;
  onRun: (input: { command: string; dir: string; remember: boolean }) => void;
}) {
  const [command, setCommand] = useState(initial?.command ?? "");
  const [dir, setDir] = useState(initial?.dir ?? ".");
  const [remember, setRemember] = useState(true);
  const submit = () => {
    const c = command.trim();
    if (!c) return;
    onRun({ command: c, dir: dir.trim() || ".", remember });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Your own dev server command</DialogTitle>
          <DialogDescription>
            Runs in a “preview” terminal tab. <span className="font-mono text-meta">{"{port}"}</span> becomes a free port;
            the address the server prints is shown.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="section-label">Command</span>
            <input
              autoFocus
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npm run dev -- --port {port}"
              spellCheck={false}
              className="h-9 rounded-md border border-input bg-background px-2.5 font-mono text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="section-label">Folder (relative to the project)</span>
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="."
              spellCheck={false}
              className="h-9 rounded-md border border-input bg-background px-2.5 font-mono text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <label className="flex items-center gap-2 text-ui-sm text-muted-foreground">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--primary)]" />
            Remember for this project <span className="font-mono text-meta text-faint">(.ruah/preview.json)</span>
          </label>
          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-8 rounded-md px-3 text-ui-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!command.trim()}
              className="h-8 rounded-md bg-primary px-3 text-ui-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Run
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface PreviewCommandMenuProps {
  status: PreviewStatus | null;
  detection: PreviewDetection | null;
  busy: boolean;
  onPick: (candidate: PreviewCandidate) => void;
  onCustom: () => void;
  onForget: () => void;
  onRedetect: () => void;
  onShowLogs: () => void;
  /** Controlled, so "Change…" elsewhere in the pane can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PreviewCommandMenu({ status, detection, busy, onPick, onCustom, onForget, onRedetect, onShowLogs, open, onOpenChange }: PreviewCommandMenuProps) {
  const selected = detection?.candidates.find((c) => c.id === detection.selected) ?? null;
  const current = status?.candidate ?? selected;
  const meta = stateMeta(status);
  const groups = groupCandidates(detection?.candidates ?? []);
  const live = status?.state === "running" || status?.state === "starting";
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          title={current ? `${current.command} (${current.dir})` : "Choose what to run"}
          className="flex h-7 max-w-[260px] min-w-0 items-center gap-2 rounded-md px-2 text-ui-sm text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          <StatusDot tone={meta.tone} pulse={status?.state === "starting"} label={meta.label} />
          <span className="truncate">{candidateLabel(current)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[340px]">
        {groups.length === 0 ? (
          <div className="px-2 py-3 text-ui-sm text-muted-foreground">No dev server found in this project.</div>
        ) : (
          groups.map((g, i) => (
            <div key={`${g.dir}-${i}`}>
              {i > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel className="flex items-center gap-1.5 text-label font-medium text-faint">
                <FolderOpen className="size-3" />
                <span className="truncate">{g.label}</span>
              </DropdownMenuLabel>
              {g.items.map((c) => {
                const isCurrent = current?.id === c.id && (c.kind !== "custom" || current.command === c.command);
                return (
                  <DropdownMenuItem key={c.id} onSelect={() => onPick(c)} className="items-start gap-2 py-1.5">
                    <Check className={cn("mt-0.5 size-3.5 shrink-0 text-primary", isCurrent ? "opacity-100" : "opacity-0")} />
                    <CandidateLine c={c} />
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCustom} className="gap-2">
          <SquareTerminal className="size-3.5 text-muted-foreground" /> Your own command…
        </DropdownMenuItem>
        {status?.terminalId || live ? (
          <DropdownMenuItem onSelect={onShowLogs} className="gap-2">
            <SquareTerminal className="size-3.5 text-muted-foreground" /> Show the server’s output
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onRedetect} className="gap-2">
          <RefreshCw className="size-3.5 text-muted-foreground" /> Detect again
        </DropdownMenuItem>
        {detection?.choice ? (
          <DropdownMenuItem onSelect={onForget} className="gap-2">
            <Undo2 className="size-3.5 text-muted-foreground" /> Forget the saved choice
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
