// Line view (JOURNEYS.md §5.1): one journey, steps left to right, and under each step the lanes —
// what the customer does, the screen, and the code behind it sorted into Frontend / Backend /
// Data & external. Columns are steps; the grid scrolls sideways; the lane names stay put.
import { CircleHelp, CornerDownRight, GitBranch, ImageOff, MessageSquareQuote, Plus, Sparkles, Target, TriangleAlert } from "lucide-react";
import type { Architecture, Journey, ProductFile } from "@/lib/contracts";
import { journeyColumns, LANES, type StepColumn, type TouchView } from "@/lib/journeys";
import { kindFor } from "@/lib/architecture";
import { kindStyles } from "@/components/explorer/kinds";
import { cn } from "@/lib/utils";

const COL = "minmax(15rem, 17rem)";

export function LineView({
  product,
  journey,
  architecture,
  warnings,
  selectedStep,
  onSelectStep,
  onAddStep,
  onOpenElement,
  onOpenJourney,
  shotUrl,
  editable,
}: {
  product: ProductFile;
  journey: Journey;
  architecture: Architecture | null;
  warnings: readonly string[];
  selectedStep: string | null;
  onSelectStep: (stepId: string) => void;
  onAddStep: () => void;
  onOpenElement: (touch: TouchView) => void;
  onOpenJourney: (journeyId: string) => void;
  shotUrl: (shot: string) => string | null;
  editable: boolean;
}) {
  const columns = journeyColumns(product, journey, architecture, warnings);
  const template = `8.5rem repeat(${columns.length}, ${COL})`;
  const row = (label: string, hint: string | undefined, render: (c: StepColumn) => React.ReactNode, last = false) => (
    <>
      <div className={cn("sticky start-0 z-10 flex flex-col justify-start border-e border-hairline bg-canvas px-3 py-2.5", !last && "border-b")}>
        <span className="section-label">{label}</span>
        {hint ? <span className="mt-0.5 text-caption text-faint">{hint}</span> : null}
      </div>
      {columns.map((c) => (
        <div
          key={`${label}-${c.step.id}`}
          className={cn(
            "min-w-0 border-e border-hairline/60 px-2 py-2",
            !last && "border-b",
            selectedStep === c.step.id && "bg-primary/[0.04]",
          )}
        >
          {render(c)}
        </div>
      ))}
    </>
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="journey-lines">
      <div className="grid w-max min-w-full" style={{ gridTemplateColumns: template }}>
        {row("Customer", "does · sees · why", (c) => (
          <StepCard column={c} total={columns.length} selected={selectedStep === c.step.id} onSelect={() => onSelectStep(c.step.id)} />
        ))}
        {row("Screen", undefined, (c) => <ScreenCell column={c} shotUrl={shotUrl} />)}
        {LANES.map((lane, i) =>
          row(
            lane.label,
            undefined,
            (c) => (
              <div className="flex flex-col gap-1">
                {c.lanes[lane.id].map((t) => (
                  <TouchChip key={t.ref} touch={t} onOpen={() => onOpenElement(t)} />
                ))}
              </div>
            ),
            i === LANES.length - 1 && !columns.some((c) => (c.branches ?? []).length > 0),
          ),
        )}
        {columns.some((c) => (c.branches ?? []).length > 0)
          ? row(
              "Branches",
              "when … then",
              (c) => (
                <div className="flex flex-col gap-1">
                  {(c.branches ?? []).map((b) => {
                    const target = b.to !== undefined ? journey.steps.findIndex((s) => s.id === b.to) : -1;
                    const alt = b.journey !== undefined ? product.journeys.find((j) => j.id === b.journey) : undefined;
                    const rejoin = b.rejoin !== undefined ? journey.steps.findIndex((s) => s.id === b.rejoin) : -1;
                    return (
                      <div key={`${b.from}-${b.when}`} className="rounded-md border border-dashed border-hairline px-2 py-1.5 text-meta">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <GitBranch className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">When {b.when}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-foreground">
                          <CornerDownRight className="size-3.5 shrink-0 text-faint" aria-hidden />
                          {alt !== undefined ? (
                            <button type="button" onClick={() => onOpenJourney(alt.id)} className="truncate text-start underline-offset-2 hover:underline">
                              {alt.name}
                              {rejoin >= 0 ? `, back at step ${rejoin + 1}` : ""}
                            </button>
                          ) : (
                            <span className="truncate">{target >= 0 ? `Step ${target + 1}` : b.to}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
              true,
            )
          : null}
      </div>
      {editable ? (
        <div className="sticky start-0 px-3 py-3">
          <button type="button" onClick={onAddStep} className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-ui-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <Plus className="size-3.5" aria-hidden />
            Add step
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StepCard({ column, total, selected, onSelect }: { column: StepColumn; total: number; selected: boolean; onSelect: () => void }) {
  const s = column.step;
  const evidence = s.evidence?.length ?? 0;
  const contradicts = (s.evidence ?? []).some((e) => e.stance === "contradicts");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border bg-surface-1 px-2.5 py-2 text-start transition-colors hover:border-ring/60",
        selected ? "border-primary ring-1 ring-primary/40" : "border-hairline",
      )}
    >
      <span className="flex items-center gap-1.5 text-caption text-faint">
        <span className="grid size-4.5 place-items-center rounded-full bg-surface-3 text-micro font-semibold text-foreground">{column.index + 1}</span>
        of {total}
        {s.origin === "agent" ? (
          <span className="ms-auto inline-flex items-center gap-0.5 text-ai" title="Drafted by an agent — review and keep it">
            <Sparkles className="size-3" aria-hidden />
            draft
          </span>
        ) : null}
      </span>
      <span className="text-ui-sm font-medium leading-snug text-foreground">{s.action}</span>
      {s.sees ? <span className="text-meta leading-snug text-muted-foreground">Sees: {s.sees}</span> : null}
      {s.why ? (
        <span className="line-clamp-3 text-meta leading-snug text-muted-foreground">
          <span className="font-medium text-foreground/80">Why </span>
          {s.why}
        </span>
      ) : (
        <span className="text-meta italic text-faint">Why not written yet</span>
      )}
      <span className="mt-0.5 flex flex-wrap items-center gap-1">
        {s.signal ? (
          <span className="pill-ok inline-flex h-5 items-center gap-1 rounded px-1.5 text-micro" title={`Signal: ${s.signal}`}>
            <Target className="size-3" aria-hidden />
            signal
          </span>
        ) : null}
        {evidence > 0 ? (
          <span className={cn("inline-flex h-5 items-center gap-1 rounded px-1.5 text-micro", contradicts ? "pill-bad" : "pill-info")} title={contradicts ? "Some evidence contradicts this step" : `${evidence} piece${evidence === 1 ? "" : "s"} of evidence`}>
            <MessageSquareQuote className="size-3" aria-hidden />
            {evidence}
          </span>
        ) : null}
        {s.question ? (
          <span className="pill-warn inline-flex h-5 items-center gap-1 rounded px-1.5 text-micro" title={s.question}>
            <CircleHelp className="size-3" aria-hidden />
            question
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ScreenCell({ column, shotUrl }: { column: StepColumn; shotUrl: (shot: string) => string | null }) {
  const screen = column.screen;
  if (screen === undefined) {
    return <span className="text-meta text-faint">{column.step.screen !== undefined ? column.step.screen : "Same screen"}</span>;
  }
  const url = screen.shot !== undefined ? shotUrl(screen.shot) : null;
  return (
    <div className="flex flex-col gap-1.5">
      {url !== null ? (
        <img src={url} alt={`Screenshot of ${screen.name}`} className="aspect-[4/3] w-full rounded-md border border-hairline object-cover object-top" loading="lazy" />
      ) : (
        <div className="flex h-9 w-full items-center gap-1.5 rounded-md border border-dashed border-hairline px-2 text-caption text-faint" title="Capture one from the live preview (camera button)">
          <ImageOff className="size-3.5 shrink-0" aria-hidden />
          No screenshot yet
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-ui-sm font-medium text-foreground">{screen.name}</div>
        {screen.route ? <div className="truncate font-mono text-caption text-muted-foreground">{screen.route}</div> : null}
      </div>
    </div>
  );
}

function TouchChip({ touch, onOpen }: { touch: TouchView; onOpen: () => void }) {
  const style =
    touch.type === "symbol" ? kindStyles.symbol : touch.type === "file" ? kindStyles.file : kindStyles[kindFor(touch.type === "workflow" ? "step" : touch.type)];
  const Icon = style.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={touch.broken ? `${touch.ref} no longer exists in the code` : touch.ref}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 text-start text-meta transition-colors hover:bg-accent",
        touch.broken ? "border-bad/50 bg-bad/5 text-bad" : "border-hairline bg-surface-1 text-foreground",
      )}
    >
      {touch.broken ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden /> : <Icon className={cn("size-3.5 shrink-0", style.color)} aria-hidden />}
      <span className="truncate">{touch.label}</span>
      {touch.type === "workflow" ? <span className="ms-auto shrink-0 text-caption text-faint">workflow</span> : null}
    </button>
  );
}
