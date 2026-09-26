// Verify status badge on a map node. Unverifiable is never styled as pass. Colours are the
// palette's status tokens as opaque pills (styles.css `pill-*`), so they read on any card.
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
  pass: "pill-ok border-ok/30",
  fail: "pill-bad border-bad/30",
  unverifiable: "pill-warn border-warn/30",
  error: "pill-bad border-bad/30",
  idle: "",
};

const DOT: Record<VerifyBadge, string> = {
  pass: "bg-ok",
  fail: "bg-bad",
  unverifiable: "bg-warn",
  error: "bg-bad",
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
  if (compact) {
    // Zoomed out, a word would cover the card's name: a status dot, the word on hover / to AT.
    return (
      <span
        role="img"
        aria-label={`Verify: ${LABEL[badge]}`}
        title={detail ?? LABEL[badge]}
        className={cn("block size-2.5 rounded-full ring-2 ring-card", DOT[badge])}
      />
    );
  }
  return (
    <span
      title={detail ?? LABEL[badge]}
      className={cn(
        "inline-flex items-center rounded border px-1.5 text-micro leading-5 font-medium uppercase tracking-wide",
        CLASS[badge],
      )}
    >
      {LABEL[badge]}
    </span>
  );
}
