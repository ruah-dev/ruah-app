import { Wind } from "lucide-react";
import { cn } from "@/lib/utils";

export function RuahMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary",
        className,
      )}
    >
      <Wind className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}
