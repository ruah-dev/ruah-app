// Product health (JOURNEYS.md §5.4): what needs a person on the product side — links into the
// code that broke, core journeys without a why / signal / evidence, weak or contradicting
// evidence, open questions, agent drafts to review, screens no journey uses. Click to go there.
import { CircleHelp, HeartPulse, Link2Off, MessageSquareQuote, Sparkles, Target, TriangleAlert, AppWindow, CheckCheck, NotebookPen, GitCompareArrows } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GAP_LABELS, type Gap, type GapKind } from "@/lib/journeys";
import { cn } from "@/lib/utils";

const ICONS: Record<GapKind, LucideIcon> = {
  broken_link: Link2Off,
  drifted: GitCompareArrows,
  missing_why: NotebookPen,
  no_signal: Target,
  no_evidence: MessageSquareQuote,
  weak_evidence: TriangleAlert,
  open_question: CircleHelp,
  unmapped_screen: AppWindow,
  not_reviewed: CheckCheck,
  agent_draft: Sparkles,
};

const ORDER: GapKind[] = ["broken_link", "drifted", "weak_evidence", "open_question", "missing_why", "no_signal", "no_evidence", "agent_draft", "not_reviewed", "unmapped_screen"];

export function HealthPanel({ gaps, onOpen }: { gaps: readonly Gap[]; onOpen: (gap: Gap) => void }) {
  if (gaps.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <HeartPulse className="size-5 text-ok" aria-hidden />
        <p className="text-ui-sm text-foreground">Nothing needs you.</p>
        <p className="text-meta text-muted-foreground">Every core journey has a why, a signal and evidence, and every link into the code resolves.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {ORDER.map((kind) => {
        const list = gaps.filter((g) => g.kind === kind);
        if (list.length === 0) return null;
        const Icon = ICONS[kind];
        return (
          <section key={kind} className="space-y-1">
            <h3 className="flex items-center gap-1.5 text-label font-medium text-muted-foreground">
              <Icon className={cn("size-3.5", list[0]!.severity === "high" ? "text-bad" : list[0]!.severity === "medium" ? "text-warn" : "text-faint")} aria-hidden />
              {GAP_LABELS[kind]}
              <span className="text-meta font-normal text-faint">{list.length}</span>
            </h3>
            {list.slice(0, 30).map((g, i) => (
              <button
                key={`${kind}-${i}-${g.journey ?? g.screen ?? ""}-${g.step ?? ""}`}
                type="button"
                onClick={() => onOpen(g)}
                title={g.detail ?? g.title}
                className="block w-full truncate rounded-md px-2 py-1 text-start text-meta text-foreground hover:bg-accent"
              >
                {g.title}
              </button>
            ))}
            {list.length > 30 ? <p className="px-2 text-caption text-faint">+{list.length - 30} more</p> : null}
          </section>
        );
      })}
    </div>
  );
}
