// First-run introduction, shown as a card on the start screen: three short steps, dismissible,
// re-openable from Help (sidebar) or Settings → Getting started.
import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, AtSign, FolderOpen, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Phantom, RuahMark } from "@/components/brand/RuahLogo";

function MiniFolder() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-surface-3 text-muted-foreground">
        <FolderOpen className="size-4.5" />
      </span>
      <ArrowRight className="size-3.5 text-faint" />
      <div className="grid grid-cols-3 gap-1.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cn(
              "h-3.5 w-7 rounded-[4px] shadow-[inset_0_0_0_1px_var(--color-hairline)]",
              i === 1 ? "bg-node-service/30" : i === 4 ? "bg-node-data/30" : "bg-surface-3",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function MiniMap() {
  return (
    <div className="relative h-16 w-44">
      <span className="absolute top-1 left-0 h-6 w-14 rounded-md bg-surface-3 shadow-[inset_0_0_0_1px_var(--color-hairline)]" />
      <span className="absolute top-1 left-[4.5rem] h-14 w-[6.5rem] rounded-lg shadow-[inset_0_0_0_1px_var(--color-hairline)]">
        <span className="absolute top-1.5 left-1.5 text-[8px] text-muted-foreground">api</span>
        <span className="absolute top-5 left-2 h-3.5 w-10 rounded-[4px] bg-node-service/30" />
        <span className="absolute top-5 left-14 h-3.5 w-8 rounded-[4px] bg-surface-3" />
        <span className="absolute top-10 left-2 h-2.5 w-16 rounded-[3px] bg-surface-3/70" />
      </span>
      <span className="absolute top-4 left-14 h-px w-4 bg-edge" />
    </div>
  );
}

function MiniAsk() {
  return (
    <div className="w-48 space-y-1.5">
      <span className="flex h-5 w-fit items-center gap-1 rounded-md bg-ai/12 px-1.5 font-mono text-[9.5px] text-foreground/85 ring-1 ring-ai/25">
        <AtSign className="size-2.5" />
        services/api
      </span>
      <span className="ms-auto block w-fit rounded-xl bg-message px-2.5 py-1 text-[10px] text-foreground/85">
        Where are invoices validated?
      </span>
      <span className="flex items-center gap-1.5">
        <RuahMark size={12} />
        <span className="block h-1.5 w-36 rounded bg-surface-3" />
      </span>
      <span className="block h-1.5 w-28 rounded bg-surface-3" />
    </div>
  );
}

const steps: { title: string; body: ReactNode; art: ReactNode }[] = [
  {
    title: "Open or create a project",
    body: "Open a repo folder — Ruah scans it into a map (architecture.json) the first time. Or start an empty project and draw it yourself.",
    art: <MiniFolder />,
  },
  {
    title: "How the map works",
    body: "Every box is a service, module or file of your repo, grouped by layer. Double-click an element to open its level; the sidebar lists every level and workflow. Changes you make on the canvas are saved to architecture.json.",
    art: <MiniMap />,
  },
  {
    title: "Ask the agent about an element",
    body: "Select an element and ask. Its path, files and links travel with your message, and each conversation is kept as a chat of the project. ⌘K jumps between projects and chats; ⌘. switches agent or model.",
    art: <MiniAsk />,
  },
];

export function OnboardingCard({
  onDismiss,
  onOpenFolder,
  onNewProject,
  className,
}: {
  onDismiss: () => void;
  onOpenFolder?: (() => void) | undefined;
  onNewProject?: (() => void) | undefined;
  className?: string;
}) {
  const [step, setStep] = useState(0);
  const current = steps[step]!;
  const last = step === steps.length - 1;
  return (
    <section
      aria-label="Getting started"
      className={cn(
        "card-warm relative overflow-hidden rounded-2xl",
        className,
      )}
    >
      <button
        type="button"
        aria-label="Dismiss getting started"
        onClick={onDismiss}
        className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex gap-5 p-5 max-sm:flex-col">
        <div className="grid h-28 w-52 shrink-0 place-items-center rounded-xl bg-background ring-1 ring-hairline max-sm:w-full">
          {current.art}
        </div>
        <div className="min-w-0 flex-1 pe-6">
          <p className="eyebrow flex items-center gap-2">
            <Phantom size={16} glow={false} float={false} expression={step === 2 ? "agent" : "idle"} />
            Getting started · {step + 1} of {steps.length}
          </p>
          <h2 className="heading mt-2 text-[17px] text-foreground">{current.title}</h2>
          <p className="mt-1.5 text-ui-sm leading-relaxed text-muted-foreground">{current.body}</p>
          {step === 0 && (onOpenFolder || onNewProject) ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {onOpenFolder ? (
                <Button size="sm" variant="secondary" className="h-7 gap-1.5 rounded-lg border border-hairline bg-surface-2 text-ui-sm shadow-none hover:bg-surface-3" onClick={onOpenFolder}>
                  <FolderOpen className="size-3.5" /> Open folder…
                </Button>
              ) : null}
              {onNewProject ? (
                <Button size="sm" variant="secondary" className="h-7 gap-1.5 rounded-lg border border-hairline bg-surface-2 text-ui-sm shadow-none hover:bg-surface-3" onClick={onNewProject}>
                  <FolderPlus className="size-3.5" /> New project…
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-hairline px-5 py-2.5">
        <div className="flex items-center gap-1" aria-hidden>
          {steps.map((s, i) => (
            <button
              key={s.title}
              type="button"
              tabIndex={-1}
              onClick={() => setStep(i)}
              className={cn(
                "h-1 rounded-full transition-all",
                i === step ? "w-5 bg-primary" : "w-2.5 bg-surface-4 hover:bg-foreground/30",
              )}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="ms-auto h-7 px-2.5 text-ui-sm text-muted-foreground hover:text-foreground"
        >
          Skip
        </Button>
        {step > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous step"
            onClick={() => setStep((s) => s - 1)}
            className="h-7 px-2 text-ui-sm"
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={() => (last ? onDismiss() : setStep((s) => s + 1))}
          className="h-7 gap-1.5 rounded-lg px-3 text-ui-sm"
        >
          {last ? "Done" : "Next"}
          {last ? null : <ArrowRight className="size-3.5" />}
        </Button>
      </div>
    </section>
  );
}
