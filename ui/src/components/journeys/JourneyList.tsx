// The Journeys page's left drawer: journeys grouped by persona (core first), the personas
// themselves, and the app's screens (scanned from its routes, or added by hand).
import { useState } from "react";
import { AppWindow, CircleHelp, Pencil, Plus, Sparkles, TriangleAlert, UserRound, X } from "lucide-react";
import type { ProductFile } from "@/lib/contracts";
import { editProduct } from "@/lib/daemon";
import { dropDangling, journeyColorIndex, journeysByPersona, slugId, type Gap } from "@/lib/journeys";
import { confirmAction } from "@/lib/confirm";
import { CollapsibleSection } from "@/components/shell/CollapsibleSection";
import { iconButton } from "@/components/ui/controls";
import { JOURNEY_COLORS } from "./fields";
import { cn } from "@/lib/utils";

export function JourneyList({
  product,
  gaps,
  selectedJourney,
  selectedScreen,
  onSelectJourney,
  onSelectScreen,
  onNewJourney,
  editable,
}: {
  product: ProductFile;
  gaps: readonly Gap[];
  selectedJourney: string | null;
  selectedScreen: string | null;
  onSelectJourney: (id: string) => void;
  onSelectScreen: (id: string) => void;
  onNewJourney: () => void;
  editable: boolean;
}) {
  const groups = journeysByPersona(product);
  const used = new Set(product.journeys.flatMap((j) => j.steps.map((s) => s.screen).filter((s): s is string => s !== undefined)));
  const addButton = (label: string, onClick: () => void) =>
    editable ? (
      <button type="button" aria-label={label} title={label} onClick={onClick} className={cn(iconButton, "size-6")}>
        <Plus className="size-3.5" />
      </button>
    ) : null;

  return (
    <div className="space-y-2">
      <CollapsibleSection id="journeys.list" label="Journeys" count={product.journeys.length} action={addButton("New journey", onNewJourney)}>
        {product.journeys.length === 0 ? <p className="px-2 py-1 text-meta text-faint">No journeys yet.</p> : null}
        {groups.map((g) => (
          <div key={g.persona?.id ?? "none"} className="mb-1.5">
            <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-caption text-faint">
              <UserRound className="size-3" aria-hidden />
              <span className="truncate">{g.persona?.name ?? "No persona"}</span>
            </div>
            {g.journeys.map((j) => {
              const open = gaps.filter((x) => x.journey === j.id && x.severity !== "low");
              const broken = open.some((x) => x.kind === "broken_link");
              const questions = gaps.filter((x) => x.journey === j.id && x.kind === "open_question").length;
              return (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => onSelectJourney(j.id)}
                  aria-current={selectedJourney === j.id ? "true" : undefined}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-ui-sm transition-colors",
                    selectedJourney === j.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: JOURNEY_COLORS[journeyColorIndex(product, j.id)] }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{j.name}</span>
                  {j.origin === "agent" ? <Sparkles className="size-3 shrink-0 text-ai" aria-label="Agent draft" /> : null}
                  {broken ? <TriangleAlert className="size-3 shrink-0 text-bad" aria-label="Broken links" /> : null}
                  {questions > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-caption text-warn" title={`${questions} open question${questions === 1 ? "" : "s"}`}>
                      <CircleHelp className="size-3" aria-hidden />
                      {questions}
                    </span>
                  ) : null}
                  {j.priority === "core" ? <span className="shrink-0 text-caption text-faint">core</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </CollapsibleSection>

      <CollapsibleSection
        id="journeys.personas"
        label="Personas"
        count={product.personas.length}
        defaultOpen={false}
        action={addButton("New persona", () => {
          const name = window.prompt("Persona name (who uses the app?)");
          if (!name?.trim()) return;
          editProduct((p) => {
            p.personas.push({ id: slugId(name, new Set(p.personas.map((x) => x.id)), "persona"), name: name.trim().slice(0, 80) });
          });
        })}
      >
        {product.personas.length === 0 ? <p className="px-2 py-1 text-meta text-faint">Who uses the app? A persona per kind of customer.</p> : null}
        {product.personas.map((p) => (
          <PersonaRow key={p.id} id={p.id} name={p.name} goals={p.goals} editable={editable} count={product.journeys.filter((j) => j.persona === p.id).length} />
        ))}
      </CollapsibleSection>

      <CollapsibleSection
        id="journeys.screens"
        label="Screens"
        count={product.screens.length}
        defaultOpen={false}
        action={addButton("New screen", () => {
          const name = window.prompt("Screen name");
          if (!name?.trim()) return;
          const route = window.prompt("Route (optional, e.g. /settings)") ?? "";
          editProduct((p) => {
            p.screens.push({ id: slugId(route.trim() || name, new Set(p.screens.map((x) => x.id)), "screen"), name: name.trim().slice(0, 80), ...(route.trim() ? { route: route.trim() } : {}), source: "user" });
          });
        })}
      >
        {product.screens.length === 0 ? <p className="px-2 py-1 text-meta text-faint">Screens come from the app's routes when the project is scanned.</p> : null}
        {product.screens.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelectScreen(s.id)}
            aria-current={selectedScreen === s.id ? "true" : undefined}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-ui-sm transition-colors",
              selectedScreen === s.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            title={s.path ?? s.route ?? s.name}
          >
            <AppWindow className={cn("size-3.5 shrink-0", used.has(s.id) ? "text-node-frontend" : "text-faint")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {s.route ? <span className="max-w-[45%] shrink-0 truncate font-mono text-caption text-faint">{s.route}</span> : null}
          </button>
        ))}
      </CollapsibleSection>
    </div>
  );
}

function PersonaRow({ id, name, goals, count, editable }: { id: string; name: string; goals: string[] | undefined; count: number; editable: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <div className="group flex h-7 items-center gap-2 rounded-md px-2 text-ui-sm text-muted-foreground hover:bg-accent/60" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} title={goals?.join(" · ")}>
      <UserRound className="size-3.5 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
      <span className="shrink-0 text-caption text-faint">{count}</span>
      {editable ? (
        <span className={cn("flex shrink-0 items-center", hover ? "visible" : "invisible group-focus-within:visible")}>
          <button
            type="button"
            aria-label={`Rename ${name}`}
            title="Rename"
            className={cn(iconButton, "size-6")}
            onClick={() => {
              const next = window.prompt("Persona name", name);
              if (!next?.trim()) return;
              editProduct((p) => {
                const x = p.personas.find((y) => y.id === id);
                if (x) x.name = next.trim().slice(0, 80);
              });
            }}
          >
            <Pencil className="size-3" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${name}`}
            title="Delete"
            className={cn(iconButton, "size-6")}
            onClick={async () => {
              const ok = await confirmAction({ title: `Delete persona “${name}”?`, description: count > 0 ? `${count} journey${count === 1 ? "" : "s"} will have no persona.` : "No journey uses it.", confirmLabel: "Delete", destructive: true });
              if (!ok) return;
              editProduct((p) => {
                p.personas = p.personas.filter((x) => x.id !== id);
                dropDangling(p);
              });
            }}
          >
            <X className="size-3" />
          </button>
        </span>
      ) : null}
    </div>
  );
}
