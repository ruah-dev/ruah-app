import { cn } from "@/lib/utils";

// A placeholder in the shape of the content that is loading (rows, cards, chart bars). Neutral —
// never the brand tint, so a loading page does not read as "selected" — and it only pulses when
// motion is allowed (the global reduced-motion rule stops the animation).
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-3", className)} {...props} />;
}

/** `n` skeleton rows of a list, announced once as "Loading …" to assistive tech. */
function SkeletonRows({
  rows = 4,
  label = "Loading",
  className,
  rowClassName,
}: {
  rows?: number;
  label?: string;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-col gap-2", className)}>
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn("flex items-center gap-3", rowClassName)}>
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 rounded" style={{ width: `${62 - ((i * 17) % 30)}%` }} />
            <Skeleton className="h-2.5 rounded" style={{ width: `${38 - ((i * 11) % 18)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonRows };
