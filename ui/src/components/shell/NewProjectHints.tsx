// First-run hints for a project the wizard just created (§20): a small dismissible card at the
// bottom-left of the page (where the resume card sits for older projects), plus the wizard's
// "Ask the agent to set it up" prompt, sent once the project is open. What the card says follows
// the template: a scanned map or an empty one (Edit mode), how to run it, the agent, pinning.
import { useEffect } from "react";
import { Hash, MessageSquare, Pin, Play, SquareMousePointer, X } from "lucide-react";
import { sendPrompt } from "@/lib/daemon";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { Phantom } from "@/components/brand/Phantom";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { hasFirstPrompt, setFirstRunHints, takeFirstPrompt, useFirstRunHints, usePendingPromptProject } from "@/components/projects/firstRun";
import { setTagsDialog } from "@/components/projects/TagsDialog";

/** Sends the wizard's first prompt once the new project is open (its agent may still be starting). */
export function useFirstPromptSender() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const projectId = daemon.project?.id;
  const ready = !!projectId && !daemon.projectSwitch && !!daemon.architecture;
  const agentState = daemon.agent?.state;
  // The HTTP answer of create can arrive after the project's frames: re-run when the prompt is queued.
  const waitingFor = usePendingPromptProject();
  useEffect(() => {
    if (!ready || waitingFor !== projectId || !hasFirstPrompt(projectId)) return;
    if (agentState !== "idle" && agentState !== "starting") return;
    const text = takeFirstPrompt(projectId!);
    if (!text) return;
    sendPrompt(null, text);
    wb.setPanelView("agent");
    wb.setShowPanel(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, projectId, agentState, waitingFor]);
}

function Tip({ icon: Icon, children }: { icon: typeof Play; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-ui-sm leading-relaxed text-foreground/90">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

export function NewProjectHints() {
  const hints = useFirstRunHints();
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const wb = useWorkbench();
  const project = daemon.project;
  const visible = !!hints && !!project && project.id === hints.projectId && !daemon.projectSwitch;

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (/input|textarea|select/i.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector("[role=dialog][data-state=open], [role=menu][data-state=open]")) return;
      // First, like the resume card: Esc dismisses the hints, not the map level or a permission.
      e.preventDefault();
      e.stopPropagation();
      setFirstRunHints(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);

  if (!visible || !hints || !project) return null;
  const kbd = (k: string) => <kbd className="kbd mx-0.5">{k}</kbd>;

  return (
    <section
      role="dialog"
      aria-label="Your new project"
      aria-modal={false}
      className="pointer-events-auto flex w-[min(420px,calc(100%-2.5rem))] flex-col gap-3 rounded-2xl border border-hairline bg-popover px-5 py-4 shadow-elevated"
    >
      <div className="flex items-center gap-2.5">
        <Phantom expression="success" eyes="sparkle" size={26} still />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">{project.name} is ready</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {hints.templateName}
            {hints.gitCommit ? ` · first commit ${hints.gitCommit}` : ""}
            {hints.githubUrl ? " · on GitHub" : ""}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setFirstRunHints(null)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <ul className="space-y-2">
        <Tip icon={SquareMousePointer}>
          {hints.scanned
            ? <>The map was drawn from the files. Double-click an element to open its level; {kbd("⌘B")} lists every level.</>
            : <>An empty map in Edit mode: drag your first element from the palette, or ask the agent to propose one.</>}
        </Tip>
        {hints.run ? (
          <Tip icon={Play}>
            Run it: <code className="rounded bg-surface-3 px-1 font-mono text-[11px]">{hints.run}</code> in the terminal ({kbd("⌃`")})
            {hints.template === "infra-terraform" ? " — nothing is applied until you run apply." : ", then Preview."}
          </Tip>
        ) : null}
        <Tip icon={MessageSquare}>
          {hints.askedAgent ? <>The agent is setting it up — follow along in the panel ({kbd("⌘I")}).</> : <>Ask the agent anything about it: {kbd("⌘I")}, or select an element first.</>}
        </Tip>
        <Tip icon={Pin}>
          Pin it for {kbd("⌘1")}…{kbd("⌘9")} and give it a group (a client, “Job”) so Home can filter it.
        </Tip>
      </ul>
      <div className="flex flex-wrap gap-2">
        {!project.pinned ? (
          <button
            type="button"
            onClick={() => void actions.togglePin(project)}
            className="flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-ui-sm text-foreground transition-colors hover:bg-surface-3"
          >
            <Pin className="size-3.5" /> Pin
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setTagsDialog(project.id)}
          className="flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-ui-sm text-foreground transition-colors hover:bg-surface-3"
        >
          <Hash className="size-3.5" /> Group…
        </button>
        {!hints.askedAgent ? (
          <button
            type="button"
            onClick={() => {
              wb.setPanelView("agent");
              wb.setShowPanel(true);
            }}
            className="flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-ui-sm text-foreground transition-colors hover:bg-surface-3"
          >
            <MessageSquare className="size-3.5" /> Open the agent
          </button>
        ) : null}
        <button type="button" onClick={() => setFirstRunHints(null)} className="ms-auto h-7 px-2 text-ui-sm text-muted-foreground hover:text-foreground">
          Got it
        </button>
      </div>
    </section>
  );
}
