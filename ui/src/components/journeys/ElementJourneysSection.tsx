// "Journeys" in an element's Details (JOURNEYS.md §5.2): the customer journey steps this element
// serves — directly, through something inside it, through a workflow, or through its screens —
// with each step's why, so a change to the element comes with what it is for.
import { Link } from "@tanstack/react-router";
import { Route as RouteIcon } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { useDaemonSelector } from "@/lib/daemon";
import { stepsForElement } from "@/lib/journeys";

export function ElementJourneysSection({ node }: { node: DiagramNode }) {
  const product = useDaemonSelector((s) => s.product);
  const architecture = useDaemonSelector((s) => s.architecture);
  const loaded = useDaemonSelector((s) => s.productLoaded);
  if (!loaded) return null;
  const hits = stepsForElement(product, architecture, node.id);
  const groups: { journey: (typeof hits)[number]["journey"]; steps: typeof hits }[] = [];
  for (const h of hits) {
    const g = groups.find((x) => x.journey.id === h.journey.id);
    if (g) g.steps.push(h);
    else groups.push({ journey: h.journey, steps: [h] });
  }
  const journeys = groups.length;
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h3 className="text-label font-medium text-muted-foreground">Journeys</h3>
        {hits.length ? <span className="text-meta text-faint">{journeys}</span> : null}
      </div>
      {hits.length === 0 ? (
        <p className="text-label text-faint">
          No customer journey step uses this yet.{" "}
          <Link to="/journeys" className="text-foreground/90 hover:underline">
            Journeys
          </Link>
        </p>
      ) : (
        <ul className="space-y-0.5">
          {groups.slice(0, 6).map(({ journey, steps }) => (
            <li key={journey.id}>
              <Link
                to="/journeys"
                search={{ journey: journey.id, step: steps[0]!.step.id }}
                className="flex min-w-0 items-start gap-2 rounded-md px-1 py-1 hover:bg-accent"
                title={steps[0]!.step.why ?? journey.why ?? "No why written yet"}
              >
                <RouteIcon className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label text-foreground/90">
                    {journey.name}
                    {journey.priority === "core" ? <span className="ms-1 text-caption text-faint">core</span> : null}
                  </span>
                  <span className="block truncate text-meta text-muted-foreground">
                    {steps.length === 1 ? `Step ${steps[0]!.index + 1}: ${steps[0]!.step.action}` : `Steps ${steps.map((h) => h.index + 1).join(", ")} of ${journey.steps.length}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {groups.length > 6 ? <li className="px-1 text-meta text-faint">+{groups.length - 6} more journeys</li> : null}
        </ul>
      )}
    </section>
  );
}
