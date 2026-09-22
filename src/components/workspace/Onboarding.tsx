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

const KEY = "atlas.onboarded.v1";

const steps = [
  {
    title: "Map your system",
    body: "Diagrams come from the repo's architecture.json: the top level, one per element you can drill into, and every workflow. Pick one on the left to open it in a window.",
    points: [
      { icon: Layers, text: "Architecture: cloud, services, data, edge, code" },
      { icon: Workflow, text: "Workflows: how work moves, step by step" },
    ],
  },
  {
    title: "Build by dragging",
    body: "Elements are grouped by category. Drag one onto the board, or click it to drop it in. Double-click an element to rename it.",
    points: [
      { icon: MousePointerClick, text: "Connect two elements with the link button" },
      { icon: Sparkles, text: "Ask the agent about anything you select" },
    ],
  },
  {
    title: "Work side by side",
    body: "Split the board to compare a diagram with a flow, and switch projects any time with ⌘K.",
    points: [
      { icon: Columns2, text: "Up to three windows at once" },
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
      <DialogContent className="w-[92vw] max-w-md gap-0 rounded-lg border-hairline bg-surface-1 p-0">
        <div className="border-b border-hairline px-5 py-4">
          <p className="font-mono text-[9.5px] text-muted-foreground uppercase">
            Getting started · {step + 1} of {steps.length}
          </p>
          <DialogTitle className="mt-1 font-display text-[16px] font-semibold">
            {current.title}
          </DialogTitle>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">{current.body}</p>
          <ul className="space-y-1.5">
            {current.points.map((p) => (
              <li
                key={p.text}
                className="flex items-center gap-2 rounded-[4px] border border-hairline bg-surface-2 px-2.5 py-2 text-[11.5px] text-foreground"
              >
                <p.icon className="size-3.5 shrink-0 text-primary" />
                {p.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <div className="flex items-center gap-1">
            {steps.map((s, i) => (
              <span
                key={s.title}
                className={cn("h-1 w-5 rounded-full", i === step ? "bg-primary" : "bg-surface-3")}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={finish}
            className="ml-auto h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Skip
          </Button>
          {step > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep((s) => s - 1)}
              className="h-7 rounded-[4px] border-hairline bg-surface-2 px-2.5 text-[11px] shadow-none"
            >
              Back
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => (step === steps.length - 1 ? finish() : setStep((s) => s + 1))}
            className="h-7 gap-1.5 rounded-[4px] px-3 text-[11px]"
          >
            {step === steps.length - 1 ? "Start building" : "Next"}
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
