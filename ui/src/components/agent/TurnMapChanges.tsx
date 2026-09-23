// §1.7: the map edits an agent made in a turn, as compact rows ("＋ Payments service",
// "↔ Payments → Postgres", "✎ Billing description"), each revealing the element on the map, plus
// "Undo map changes" (the daemon restores the elements the turn changed from its snapshot).
import { useState } from "react";
import { Network, Undo2 } from "lucide-react";
import type { Turn } from "@/lib/daemon";
import { daemonActions, useDaemon } from "@/lib/daemon";
import { changeGlyph, changeTarget, changeText } from "@/lib/map-activity";
import { useWorkbench } from "@/lib/workbench";
import { cn } from "@/lib/utils";

const MAX_ROWS = 12;

export function TurnMapChanges({ turn, running }: { turn: Turn; running: boolean }) {
  return turn.mapChanges?.length ? <MapChangesBlock turn={turn} running={running} /> : null;
}

function MapChangesBlock({ turn, running }: { turn: Turn; running: boolean }) {
  const wb = useWorkbench();
  const s = useDaemon();
  const [expanded, setExpanded] = useState(false);
  const [asked, setAsked] = useState(false);
  const changes = turn.mapChanges ?? [];
  const known = new Set(s.architecture?.nodes.map((n) => n.id) ?? []);
  const rows = expanded ? changes : changes.slice(0, MAX_ROWS);
  const undone = turn.mapUndone === true;

  return (
    <div className="rounded-xl bg-ai/[0.05] px-2.5 py-2 ring-1 ring-ai/20">
      <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-ai">
        <Network className="size-3.5" />
        <span>
          Map{" "}
          {undone
            ? "changes undone"
            : `· ${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </span>
        <span className="flex-1" />
        {!undone ? (
          <button
            type="button"
            disabled={asked || s.connection !== "open"}
            onClick={() => {
              if (!daemonActions.undoMapChanges(turn.id)) return;
              setAsked(true);
              // An error (e.g. nothing left to undo) shows as a notice; let the user try again.
              setTimeout(() => setAsked(false), 4000);
            }}
            title={
              running
                ? "Undo what the agent changed on the map so far"
                : "Put back the elements this turn changed (later edits of yours are kept)"
            }
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-ai/12 hover:text-ai disabled:opacity-50"
          >
            <Undo2 className="size-3" />
            {asked ? "Undoing…" : "Undo map changes"}
          </button>
        ) : null}
      </div>
      <ul className={cn("space-y-0.5", undone && "opacity-55")}>
        {rows.map((c, i) => {
          const target = changeTarget(c);
          const canReveal = target !== null && known.has(target) && !undone;
          return (
            <li key={`${c.id}-${i}`} className="flex min-w-0 items-center gap-1.5 text-[12px]">
              <span aria-hidden className="w-3.5 shrink-0 text-center font-mono text-ai">
                {changeGlyph(c)}
              </span>
              {canReveal ? (
                <button
                  type="button"
                  onClick={() => wb.openNode(target)}
                  title="Show on the map"
                  className="min-w-0 truncate text-left text-foreground/85 underline-offset-2 hover:text-foreground hover:underline"
                >
                  {changeText(c)}
                </button>
              ) : (
                <span
                  className={cn(
                    "min-w-0 truncate text-foreground/70",
                    c.action === "remove" && "line-through",
                  )}
                >
                  {changeText(c)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {changes.length > MAX_ROWS && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-0.5 ps-5 text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          +{changes.length - MAX_ROWS} more
        </button>
      ) : null}
    </div>
  );
}
