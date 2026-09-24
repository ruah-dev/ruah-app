// Verify status badge on a map node. Unverifiable is never styled as pass.
import { cn } from "@/lib/utils";
import type { VerifyBadge } from "@/lib/engines";

const LABEL: Record<VerifyBadge, string> = {
  pass: "pass",
  fail: "fail",
  unverifiable: "unverifiable",
  error: "error",
  idle: "",
};

const CLASS: Record<VerifyBadge, string> = {
  pass: "bg-ok/15 text-ok border-ok/30",
  fail: "bg-bad/15 text-bad border-bad/30",
  unverifiable: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  error: "bg-bad/15 text-bad border-bad/30",
  idle: "",
};

export function VerifyBadgeChip({
  badge,
  detail,
  compact,
}: {
  badge: VerifyBadge | undefined;
  detail?: string | undefined;
  compact?: boolean;
}) {
  if (!badge || badge === "idle") return null;
  return (
    <span
      title={detail ?? LABEL[badge]}
      className={cn(
        "inline-flex items-center rounded border px-1.5 font-medium uppercase tracking-wide",
        compact ? "text-[9px] leading-4" : "text-[10px] leading-5",
        CLASS[badge],
      )}
    >
      {LABEL[badge]}
    </span>
  );
}
