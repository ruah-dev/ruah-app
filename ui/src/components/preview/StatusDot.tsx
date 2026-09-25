import type { Tone } from "@/lib/preview";
import { cn } from "@/lib/utils";

const TONE: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  muted: "bg-faint",
};

/** The preview's state as a small dot (sage running, amber starting, coral crashed, grey stopped). */
export function StatusDot({ tone, pulse, label }: { tone: Tone; pulse?: boolean; label: string }) {
  return (
    <span className="relative inline-flex size-2 shrink-0" role="img" aria-label={label} title={label}>
      {pulse ? <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", TONE[tone])} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE[tone])} />
    </span>
  );
}
