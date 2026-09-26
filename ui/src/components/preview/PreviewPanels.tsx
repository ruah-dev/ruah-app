// What the preview pane shows when there is no page yet: looking for a dev server, nothing
// found, several apps to pick from, ready to start, starting (with the output so far), and a
// crash (the last lines, "Ask agent to fix", restart).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, FolderOpen, Loader2, Play, RotateCw, Sparkles, SquareTerminal, Zap } from "lucide-react";
import { Phantom } from "@/components/brand/Phantom";
import { groupCandidates, type PreviewCandidate, type PreviewDetection, type PreviewStatus } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { CandidateLine } from "./PreviewCommandMenu";

function Centered({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className={cn("m-auto flex w-full max-w-lg flex-col items-center gap-3 px-6 py-10 text-center", className)}>{children}</div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex max-w-full items-center truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-meta text-muted-foreground">{children}</span>;
}

const primaryBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-ui-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const ghostBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-ui-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50";
const outlineBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface-1 px-3 text-ui-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50";

/** Missing tool / dependencies notes under a candidate. */
export function CandidateNotes({ c, onSetup }: { c: PreviewCandidate; onSetup?: ((command: string, dir: string) => void) | undefined }) {
  if (c.available !== false && !c.setup) return null;
  return (
    <div className="flex w-full flex-col gap-1.5 text-left">
      {c.available === false ? (
        <p className="flex items-start gap-1.5 rounded-md bg-warn/10 px-2.5 py-1.5 text-ui-sm text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-mono text-meta">{c.needs}</span> is not on your PATH{c.install ? ` — ${c.install}` : ""}.
          </span>
        </p>
      ) : null}
      {c.setup ? (
        <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-ui-sm text-muted-foreground">
          <span className="min-w-0 flex-1">
            Dependencies look missing — <span className="font-mono text-meta">{c.setup}</span> first.
          </span>
          {onSetup ? (
            <button type="button" onClick={() => onSetup(c.setup!, c.dir)} className="shrink-0 text-ui-sm text-primary hover:underline">
              Type it in a terminal
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LookingPanel() {
  return (
    <Centered>
      <Phantom expression="tracking" size="md" />
      <p className="text-ui-sm text-muted-foreground">Looking for the project’s dev server…</p>
    </Centered>
  );
}

export function NoProjectPanel() {
  return (
    <Centered>
      <Phantom expression="idle" size="md" />
      <p className="heading text-title text-foreground">Open a project to preview it</p>
      <p className="text-ui-sm text-muted-foreground">The preview runs the project’s dev server and shows the page, reloading as the agent edits.</p>
    </Centered>
  );
}

export function NothingFoundPanel({ detection, onCustom }: { detection: PreviewDetection | null; onCustom: () => void }) {
  return (
    <Centered>
      <Phantom expression="warning" size="md" />
      <p className="heading text-title text-foreground">No dev server found</p>
      <p className="text-ui-sm text-muted-foreground">
        Ruah looks for <span className="font-mono text-meta">package.json</span> scripts (dev, start, serve), Django, Flask, FastAPI,
        Rails, Go with air, Hugo, docker compose and plain <span className="font-mono text-meta">index.html</span> sites.
      </p>
      {detection?.configError ? <p className="text-ui-sm text-bad">{detection.configError}</p> : null}
      <button type="button" onClick={onCustom} className={primaryBtn}>
        <SquareTerminal className="size-3.5" /> Run your own command
      </button>
    </Centered>
  );
}

export function PickPanel({
  detection,
  busy,
  onPick,
  onCustom,
}: {
  detection: PreviewDetection;
  busy: boolean;
  onPick: (c: PreviewCandidate) => void;
  onCustom: () => void;
}) {
  const groups = groupCandidates(detection.candidates);
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-5 py-8">
        <div className="flex flex-col gap-1">
          <p className="eyebrow">Live preview</p>
          <p className="heading text-title text-foreground">What should the preview run?</p>
          <p className="text-ui-sm text-muted-foreground">This project has several apps. Your pick is remembered on this computer; nothing is written into the repo.</p>
        </div>
        {groups.map((g) => (
          <section key={`${g.dir}-${g.label}`} className="flex flex-col gap-1.5">
            <p className="section-label flex items-center gap-1.5">
              <FolderOpen className="size-3" /> {g.label}
            </p>
            <div className="card-warm flex flex-col divide-y divide-hairline overflow-hidden">
              {g.items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(c)}
                  className="group flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/60 disabled:opacity-60"
                >
                  <CandidateLine c={c} />
                  <span className="flex shrink-0 items-center gap-1 text-meta text-faint">
                    {c.port !== undefined ? <span className="font-mono">:{c.port}</span> : null}
                  </span>
                  <Play className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </section>
        ))}
        <button type="button" onClick={onCustom} className={cn(ghostBtn, "self-start")}>
          <SquareTerminal className="size-3.5" /> Your own command…
        </button>
      </div>
    </div>
  );
}

export function ReadyPanel({
  candidate,
  busy,
  onStart,
  onChange,
  onSetup,
}: {
  candidate: PreviewCandidate;
  busy: boolean;
  onStart: () => void;
  onChange: () => void;
  onSetup: (command: string, dir: string) => void;
}) {
  return (
    <Centered>
      <Phantom expression="idle" size="md" />
      <div className="flex flex-col items-center gap-1">
        <p className="heading text-title text-foreground">Preview {candidate.title}</p>
        <p className="text-ui-sm text-muted-foreground">
          {candidate.hmr ? (
            <span className="inline-flex items-center gap-1">
              <Zap className="size-3 text-primary" /> Changes appear as they are saved (hot reload).
            </span>
          ) : (
            "No hot reload: the page reloads after each agent turn that edits files."
          )}
        </p>
      </div>
      <Chip>
        {candidate.command}
        {candidate.dir !== "." ? <span className="ms-2 text-faint">in {candidate.dir}</span> : null}
      </Chip>
      <CandidateNotes c={candidate} onSetup={onSetup} />
      <div className="mt-1 flex items-center gap-2">
        <button type="button" onClick={onStart} disabled={busy} className={primaryBtn}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start preview
        </button>
        <button type="button" onClick={onChange} className={ghostBtn}>
          Change…
        </button>
      </div>
    </Centered>
  );
}

function LogTail({ lines, className }: { lines: readonly string[]; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      className={cn(
        "w-full overflow-auto rounded-lg bg-surface-0 p-3 text-left font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground select-text",
        className,
      )}
    >
      {lines.length > 0 ? lines.join("\n") : "(no output yet)"}
    </pre>
  );
}

export function StartingPanel({ status, onShowLogs }: { status: PreviewStatus; onShowLogs: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(t);
  }, [status.startedAt]);
  const title = status.candidate?.title ?? "the dev server";
  return (
    <Centered className="max-w-xl">
      <Phantom expression="loading" size="md" />
      <p className="heading text-title text-foreground">Starting {title}…</p>
      <p className="text-ui-sm text-muted-foreground">
        {status.url ? (
          <>
            Waiting for <span className="font-mono text-meta">{status.url}</span> to answer.
          </>
        ) : (
          "Waiting for the server to print its address."
        )}
      </p>
      {status.command ? <Chip>{status.command}</Chip> : null}
      <LogTail lines={status.logs.slice(-10)} className="max-h-48" />
      {slow ? (
        <p className="text-ui-sm text-muted-foreground">
          Taking a while?{" "}
          <button type="button" onClick={onShowLogs} className="text-primary hover:underline">
            Show the full output
          </button>
          .
        </p>
      ) : null}
    </Centered>
  );
}

export function CrashPanel({
  status,
  busy,
  onAskAgent,
  onRestart,
  onShowLogs,
  onChange,
  onSetup,
}: {
  status: PreviewStatus;
  busy: boolean;
  onAskAgent: () => void;
  onRestart: () => void;
  onShowLogs: () => void;
  onChange: () => void;
  onSetup: (command: string, dir: string) => void;
}) {
  const how =
    status.exitCode !== null ? `exit code ${status.exitCode}` : status.signal !== null ? `signal ${status.signal}` : null;
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-8">
        <div className="flex items-start gap-3">
          <Phantom expression="error" size="sm" className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="heading text-title text-foreground">
              The dev server stopped
              {how ? <span className="ms-2 rounded bg-bad/15 px-1.5 py-0.5 align-middle font-mono text-meta text-bad">{how}</span> : null}
            </p>
            {status.error ? <p className="text-ui-sm break-words text-bad">{status.error}</p> : null}
            {status.command ? (
              <p className="text-meta text-faint">
                <span className="font-mono">{status.command}</span>
                {status.candidate && status.candidate.dir !== "." ? ` · in ${status.candidate.dir}` : ""}
              </p>
            ) : null}
          </div>
        </div>
        {status.candidate ? <CandidateNotes c={status.candidate} onSetup={onSetup} /> : null}
        <LogTail lines={status.logs.slice(-40)} className="max-h-80" />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onAskAgent}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ai px-3 text-ui-sm font-medium text-ai-foreground transition-colors hover:bg-ai/90"
          >
            <Sparkles className="size-3.5" /> Ask agent to fix
          </button>
          <button type="button" onClick={onRestart} disabled={busy} className={outlineBtn}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />} Restart
          </button>
          <button type="button" onClick={onShowLogs} className={ghostBtn}>
            <SquareTerminal className="size-3.5" /> Full output
          </button>
          <button type="button" onClick={onChange} className={ghostBtn}>
            Change command…
          </button>
        </div>
      </div>
    </div>
  );
}
