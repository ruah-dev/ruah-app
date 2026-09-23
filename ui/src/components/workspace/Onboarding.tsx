import { useEffect, useState } from "react";
import {
  ArrowRight,
  Columns2,
  FolderPlus,
  Layers,
  MousePointerClick,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const KEY = "ruah.onboarded.v1";

const steps = [
  {
    title: "Welcome to Ruah",
    body: "Ruah draws your repo from its architecture.json: an overview, a level for every element you can open, and every workflow. Pick one in the sidebar.",
    points: [
      { icon: Layers, text: "Architecture levels, from services down to files" },
      { icon: Workflow, text: "Workflows: how work moves, step by step" },
    ],
  },
  {
    title: "Ask about any element",
    body: "Select an element and ask the agent on the right. Its path, files, links and workflows travel with your message.",
    points: [
      { icon: MousePointerClick, text: "The selection becomes the chat's @context" },
      { icon: Sparkles, text: "Pick the agent, model and permission mode in the composer" },
    ],
  },
  {
    title: "Edit when you need to",
    body: "Switch to Edit to add elements from the tray, connect them and rename them in place. Split the canvas to compare views; ⌘K switches projects.",
    points: [
      { icon: Columns2, text: "Up to three canvases side by side" },
      { icon: FolderPlus, text: "Edits are saved to the repo's architecture.json" },
    ],
  },
];

export function Onboarding({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const current = steps[step]!;

  const finish = () => {
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      /* noop */
    }
    setStep(0);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : finish())}>
      <DialogContent className="w-[92vw] max-w-md gap-0 rounded-2xl border-hairline bg-popover p-0">
        <div className="px-6 pt-6">
          <p className="text-[12px] text-muted-foreground">
            {step + 1} of {steps.length}
          </p>
          <DialogTitle className="mt-1 text-[17px] font-semibold tracking-tight">
            {current.title}
          </DialogTitle>
        </div>

        <div className="space-y-4 px-6 pt-3 pb-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{current.body}</p>
          <ul className="space-y-2">
            {current.points.map((p) => (
              <li key={p.text} className="flex items-center gap-2.5 text-[13px] text-foreground/90">
                <p.icon className="size-4 shrink-0 text-primary" />
                {p.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-2 px-6 pb-5">
          <div className="flex items-center gap-1">
            {steps.map((s, i) => (
              <span
                key={s.title}
                className={cn("h-1 w-4 rounded-full", i === step ? "bg-foreground/70" : "bg-surface-3")}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={finish}
            className="ml-auto h-8 px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            Skip
          </Button>
          {step > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep((s) => s - 1)}
              className="h-8 rounded-lg border-0 bg-surface-3 px-3 text-[13px] shadow-none hover:bg-surface-3/70"
            >
              Back
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => (step === steps.length - 1 ? finish() : setStep((s) => s + 1))}
            className="h-8 gap-1.5 rounded-lg px-3.5 text-[13px]"
          >
            {step === steps.length - 1 ? "Get started" : "Next"}
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function useOnboarding() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(KEY)) setOpen(true);
    } catch {
      /* noop */
    }
  }, []);
  return { open, setOpen };
}
