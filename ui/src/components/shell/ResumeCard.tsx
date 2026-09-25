// "Where you left off" (§13.4): a dismissible floating card, bottom-left of the page, when you
// switch into a project that has news since your last visit. What happened while you were away,
// the git state, where you were, and one click back into the last chat or element.
import { useEffect } from "react";
import { X } from "lucide-react";
import type { ResumeInfo } from "@/lib/contracts";
import { awayItems, sinceLabel, type AwayTone } from "@/lib/resume-card";
import { pageLabel } from "./nav";
import type { ShellView } from "@/lib/view-restore";
import { useWorkbench } from "@/lib/workbench";
import { useWorkspace } from "@/lib/workspace";
import { Phantom } from "@/components/brand/Phantom";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { cn } from "@/lib/utils";
import { useProjectCloud } from "./useCloudAttention";

const tone: Record<AwayTone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", ai: "bg-ai" };

export function ResumeCard({
  resume,
  view,
  onDismiss,
}: {
  resume: ResumeInfo;
  view: ShellView | null;
  onDismiss: () => void;
}) {
  const wb = useWorkbench();
  const ws = useWorkspace();
  const actions = useProjectActions();
  const { unhealthy } = useProjectCloud();
  const items = awayItems(resume, 3);
  if (unhealthy.length)
    items.push({
      key: "cloud",
      tone: "warn",
      text:
        unhealthy.length === 1
          ? `${unhealthy[0]!.name} is ${unhealthy[0]!.health}${unhealthy[0]!.healthDetail ? ` (${unhealthy[0]!.healthDetail})` : ""}`
          : `${unhealthy.length} cloud resources are down or degraded`,
    });
  const git = resume.git.available ? resume.git : null;
  const chat = resume.lastChat;
  const focus = resume.lastFocus;
  // The map level you were on (a drilled-in level's title), from the saved view.
  const level = view?.diagramId ? ws.app.diagrams.find((d) => d.id === view.diagramId)?.title : undefined;

  // Esc dismisses the card first (before the map takes it as "up one level"), unless typing or a
  // dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (/input|textarea|select/i.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector("[role=dialog][data-state=open], [role=menu][data-state=open], [role=alertdialog]")) return;
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  return (
    <section
      role="dialog"
      aria-label="Where you left off"
      aria-modal={false}
      className="pointer-events-auto flex w-[min(460px,calc(100%-2.5rem))] flex-col gap-3.5 rounded-2xl border border-hairline bg-popover px-5 py-4 shadow-elevated"
    >
      <div className="flex items-center gap-2.5">
        <Phantom expression="success" size={26} still />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">Welcome back to {resume.project.name}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            Last here {sinceLabel(resume.lastViewedAt)}
            {resume.project.kind === "system" ? " · system" : ""}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {items.length ? (
        <div className="flex flex-col gap-2">
          <p className="section-label uppercase tracking-[0.1em]">While you were away</p>
          {items.map((it) => (
            <p key={it.key} className="flex items-start gap-2 text-[13px] leading-snug text-foreground/90">
              <span className={cn("mt-[6px] size-[7px] shrink-0 rounded-full", tone[it.tone])} />
              <span>
                {it.text}
                {it.strong ? (
                  <>
                    {" "}
                    <span className="font-medium text-foreground">“{it.strong}”</span>
                  </>
                ) : null}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {git || focus || view ? (
        <div className="grid grid-cols-2 gap-2.5">
          {git ? (
            <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
              <span className="text-[11px] text-muted-foreground">Git</span>
              <span className="truncate font-mono text-[12px] text-foreground">
                {git.branch ?? git.head?.slice(0, 7) ?? "detached"}
                {git.ahead ? ` ↑${git.ahead}` : ""}
                {git.behind ? ` ↓${git.behind}` : ""}
              </span>
              <span className={cn("text-[12px]", git.dirty ? "text-warn" : "text-muted-foreground")}>
                {git.dirty ? `${git.dirty} uncommitted file${git.dirty === 1 ? "" : "s"}` : "Clean"}
              </span>
            </div>
          ) : null}
          {focus || view ? (
            <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
              <span className="text-[11px] text-muted-foreground">You were on</span>
              <span className="truncate font-mono text-[12px] text-foreground">{focus?.name ?? level ?? "Top level"}</span>
              <span className="truncate text-[12px] text-muted-foreground">
                {view ? pageLabel(view.page) : "Map"}
                {focus && level ? ` · ${level}` : ""}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {chat ? (
          <button
            type="button"
            onClick={() => {
              onDismiss();
              void actions.showChat({ id: chat.id, projectId: resume.project.id });
            }}
            className="h-[34px] max-w-full truncate rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Continue “{chat.title || "Untitled chat"}”
          </button>
        ) : null}
        {focus ? (
          <button
            type="button"
            onClick={() => {
              onDismiss();
              wb.openNode(focus.nodeId);
            }}
            className="h-[34px] max-w-full truncate rounded-lg border border-hairline bg-surface-2 px-3.5 text-[13px] text-foreground hover:bg-surface-3"
          >
            Open {focus.name}
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">esc</span>
      </div>
    </section>
  );
}
