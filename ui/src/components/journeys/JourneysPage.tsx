// Journeys (JOURNEYS.md §5): the product side of the project. Who uses the app (personas), the
// journeys they take through it, each step's screen, action and why, the success signal, the
// customer evidence, and the code behind every step. Two views of one model: Line (one journey,
// steps left to right over the code lanes) and Flow map (every journey across the app's screens).
// Left: journeys, personas, screens. Right: the selected journey / step, or Product health.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Download, FileText, HeartPulse, MessageSquareQuote, Plus, RefreshCw, Route as RouteIcon, ScanLine, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { DrawerToggle, PageDrawer } from "@/components/shell/PageDrawer";
import { Segmented } from "@/components/ui/segmented";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { aiButton, primaryButton, quietButton, solidButton } from "@/components/ui/controls";
import { useDaemon, editProduct, canEditProduct, rescan } from "@/lib/daemon";
import { useWorkbench } from "@/lib/workbench";
import { requestComposerDraft } from "@/lib/composer-draft";
import { setJourneyContext, clearJourneyContext } from "@/lib/journey-context";
import { attentionCount, productGaps, slugId, type Gap, type JourneyDrift, type TouchView } from "@/lib/journeys";
import { downloadProductExport } from "@/lib/journey-export";
import type { ProductFile } from "@/lib/contracts";
import { JourneyList } from "./JourneyList";
import { LineView } from "./LineView";
import { FlowMap } from "./FlowMap";
import { JourneyForm, StepForm } from "./JourneyInspector";
import { HealthPanel } from "./HealthPanel";
import { NewJourneyDialog, CustomerNotesDialog } from "./JourneyDialogs";
import { priorityPill } from "./fields";
import { cn } from "@/lib/utils";

export type JourneysView = "line" | "map";

export interface JourneysSearch {
  journey?: string;
  step?: string;
  view?: JourneysView;
}

export function JourneysPage({ search }: { search: JourneysSearch }) {
  const daemon = useDaemon();
  const wb = useWorkbench();
  const navigate = useNavigate();
  const product = daemon.product;
  const architecture = daemon.architecture;
  const editable = canEditProduct(daemon);
  const drift = useDrift(daemon.httpOrigin, daemon.productRevision, daemon.revision);
  const gaps = useMemo(() => productGaps(product, daemon.productWarnings, drift), [product, daemon.productWarnings, drift]);

  const [view, setView] = useState<JourneysView>(search.view ?? "line");
  const [journeyId, setJourneyId] = useState<string | null>(search.journey ?? null);
  const [stepId, setStepId] = useState<string | null>(search.step ?? null);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [side, setSide] = useState<"details" | "health">("details");
  const [newOpen, setNewOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  // Deep links (/journeys?journey=…&step=…, from the Map's inspector) win over the local choice.
  useEffect(() => {
    if (search.journey !== undefined) setJourneyId(search.journey);
    if (search.step !== undefined) setStepId(search.step);
    if (search.view !== undefined) setView(search.view);
  }, [search.journey, search.step, search.view]);

  const journey = product?.journeys.find((j) => j.id === journeyId) ?? product?.journeys[0] ?? null;
  const step = journey?.steps.find((s) => s.id === stepId) ?? null;
  const screen = product?.screens.find((s) => s.id === screenId) ?? null;

  const selectJourney = (id: string, step: string | null = null) => {
    setJourneyId(id);
    setStepId(step);
    setScreenId(null);
    setSide("details");
    void navigate({ to: "/journeys", search: { journey: id, ...(step ? { step } : {}), ...(view !== "line" ? { view } : {}) }, replace: true });
  };

  const askAbout = (journeyIdArg: string, stepIdArg: string | null, prompt: string) => {
    const j = product?.journeys.find((x) => x.id === journeyIdArg);
    const target = stepIdArg ?? j?.steps[0]?.id;
    if (!j || !target || !daemon.project) return;
    const idx = j.steps.findIndex((s) => s.id === target);
    setJourneyContext({ projectId: daemon.project.id, journey: j.id, step: target, label: `${j.name} · ${idx + 1}. ${j.steps[idx]?.action ?? ""}` });
    requestComposerDraft(prompt);
    wb.setShowPanel(true);
    wb.ask();
  };

  const openElement = (t: TouchView) => {
    if (t.element) wb.openNode(t.element.id);
    else toast.error(`${t.ref} is not on the map`, { description: "Relink the step to an element that exists, or ask the agent to fix the link." });
  };

  const openGap = (g: Gap) => {
    if (g.journey) {
      selectJourney(g.journey, g.step ?? null);
      setView("line");
    } else if (g.screen) {
      setScreenId(g.screen);
      setView("map");
      setSide("details");
    }
  };

  const addStep = () => {
    if (!journey) return;
    const action = window.prompt("What does the customer do next?");
    if (!action?.trim()) return;
    let newId = "";
    editProduct((p) => {
      const j = p.journeys.find((x) => x.id === journey.id);
      if (!j) return;
      newId = slugId(action, new Set(j.steps.map((s) => s.id)), `step-${j.steps.length + 1}`);
      j.steps.push({ id: newId, action: action.trim().slice(0, 200) });
    });
    if (newId) setStepId(newId);
  };

  const draftAll = () => {
    clearJourneyContext();
    requestComposerDraft(
      "Map this app's main customer journeys. Use ruah_get_product and the code (routes, screens, handlers) to find who the users are and what they come to do. For each journey add the persona, the goal in the user's words, and the steps (screen, what the user does, what they see) with the code each step touches. Leave every why empty and put what you need to know from me in the step's question.",
    );
    wb.setShowPanel(true);
    wb.ask();
  };

  const counts = attentionCount(gaps);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Journeys"
        leading={<DrawerToggle label="Journeys list" />}
        menu={
          <>
            <DropdownMenuItem onSelect={() => void downloadProductExport(daemon.httpOrigin, "html", journey?.id)} disabled={!journey}>
              <FileText className="size-3.5" /> Storyboard of this journey (HTML)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void downloadProductExport(daemon.httpOrigin, "html")} disabled={!product}>
              <Download className="size-3.5" /> Storyboards of all journeys (HTML)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void downloadProductExport(daemon.httpOrigin, "md", journey?.id)} disabled={!journey}>
              <FileText className="size-3.5" /> This journey as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void rescan()
                  .then(() => toast.success("Scanned", { description: "Screens were refreshed from the app's routes." }))
                  .catch((err: unknown) => toast.error("Scan failed", { description: err instanceof Error ? err.message : String(err) }))
              }
            >
              <RefreshCw className="size-3.5" /> Rescan screens from routes
            </DropdownMenuItem>
          </>
        }
      >
        <Segmented
          label="Journeys view"
          kind="tabs"
          value={view}
          options={[
            { value: "line", label: "Line", title: "One journey over the code behind it" },
            { value: "map", label: "Flow map", title: "Every journey across the app's screens" },
          ]}
          onChange={setView}
        />
        <button type="button" className={cn(solidButton, "max-md:hidden")} onClick={() => setNotesOpen(true)} disabled={!product || product.journeys.length === 0}>
          <MessageSquareQuote className="size-3.5" aria-hidden />
          Customer notes
        </button>
        <button type="button" className={primaryButton} onClick={() => setNewOpen(true)} disabled={!editable}>
          <Plus className="size-3.5" aria-hidden />
          New journey
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {wb.outlineOpen && product ? (
          <PageDrawer title="Journeys">
            <JourneyList
              product={product}
              gaps={gaps}
              selectedJourney={journey?.id ?? null}
              selectedScreen={screenId}
              onSelectJourney={(id) => selectJourney(id)}
              onSelectScreen={(id) => {
                setScreenId(id);
                setView("map");
              }}
              onNewJourney={() => setNewOpen(true)}
              editable={editable}
            />
          </PageDrawer>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
          {!daemon.productLoaded ? (
            <Empty title="Loading journeys…" />
          ) : !product || (product.journeys.length === 0 && view === "line") ? (
            <GettingStarted product={product} editable={editable} onNew={() => setNewOpen(true)} onDraft={draftAll} onRescan={() => void rescan()} onFlow={() => setView("map")} />
          ) : view === "map" ? (
            <FlowMap
              product={product}
              selectedScreen={screenId}
              selectedJourney={journey?.id ?? null}
              onSelectScreen={(id) => {
                setScreenId(id);
                setSide("details");
              }}
              onSelectStep={(j, s) => {
                selectJourney(j, s);
              }}
            />
          ) : journey ? (
            <>
              <JourneyHeader product={product} journeyId={journey.id} onSelect={() => setStepId(null)} />
              <LineView
                product={product}
                journey={journey}
                architecture={architecture}
                warnings={daemon.productWarnings}
                selectedStep={step?.id ?? null}
                onSelectStep={(id) => setStepId(id)}
                onAddStep={addStep}
                onOpenElement={openElement}
                onOpenJourney={(id) => selectJourney(id)}
                shotUrl={(shot) => (daemon.httpOrigin ? `${daemon.httpOrigin}/api/product/shot?path=${encodeURIComponent(shot)}&r=${daemon.productRevision}` : null)}
                editable={editable}
              />
            </>
          ) : null}
        </main>

        {product && (journey || screen) ? (
          <aside aria-label="Journey details" className="flex w-[22rem] shrink-0 flex-col border-s border-hairline bg-surface-0 max-lg:hidden">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
              <Segmented
                label="Journey panel"
                kind="tabs"
                value={side}
                options={[
                  { value: "details", label: step ? "Step" : screen && view === "map" ? "Screen" : "Journey" },
                  { value: "health", label: counts > 0 ? `Health · ${counts}` : "Health" },
                ]}
                onChange={setSide}
              />
              {daemon.productSave === "saving" || daemon.productSave === "pending" ? <span className="ms-auto text-caption text-faint">Saving…</span> : null}
              {daemon.productSave === "error" ? <span className="ms-auto text-caption text-bad" title={daemon.productError ?? undefined}>Not saved</span> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {side === "health" ? (
                <HealthPanel gaps={gaps} onOpen={openGap} />
              ) : view === "map" && screen && !step ? (
                <ScreenDetails product={product} screenId={screen.id} onOpenJourney={(j, s) => { selectJourney(j, s); setView("line"); }} />
              ) : journey && step ? (
                <StepForm
                  product={product}
                  journey={journey}
                  step={step}
                  architecture={architecture}
                  warnings={daemon.productWarnings}
                  editable={editable}
                  selectedElement={wb.selectedNode ? { id: wb.selectedNode.id, name: wb.selectedNode.label } : null}
                  onAsk={() => askAbout(journey.id, step.id, "")}
                  onOpenElement={openElement}
                  onSelectStep={setStepId}
                />
              ) : journey ? (
                <JourneyForm
                  product={product}
                  journey={journey}
                  editable={editable}
                  onAsk={() => askAbout(journey.id, null, "")}
                  onDeleted={() => setJourneyId(null)}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      <NewJourneyDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        product={product}
        onCreated={(id) => selectJourney(id)}
        onDraftWithAgent={(prompt) => {
          clearJourneyContext();
          requestComposerDraft(prompt);
          wb.setShowPanel(true);
          wb.ask();
        }}
      />
      <CustomerNotesDialog
        open={notesOpen}
        onOpenChange={setNotesOpen}
        onSend={(prompt) => {
          clearJourneyContext();
          requestComposerDraft(prompt);
          wb.setShowPanel(true);
          wb.ask();
        }}
      />
    </div>
  );
}

function JourneyHeader({ product, journeyId, onSelect }: { product: ProductFile; journeyId: string; onSelect: () => void }) {
  const journey = product.journeys.find((j) => j.id === journeyId);
  if (!journey) return null;
  const persona = product.personas.find((p) => p.id === journey.persona);
  const pill = priorityPill(journey.priority);
  return (
    <button type="button" onClick={onSelect} className="flex shrink-0 flex-col items-start gap-0.5 border-b border-hairline px-4 py-2.5 text-start hover:bg-accent/40">
      <span className="flex items-center gap-2">
        <RouteIcon className="size-4 text-primary" aria-hidden />
        <span className="text-title-sm font-semibold text-foreground">{journey.name}</span>
        {pill ? <span className={cn(pill.className, "rounded px-1.5 text-micro")}>{pill.label}</span> : null}
        {journey.origin === "agent" ? <span className="pill-ai rounded px-1.5 text-micro">agent draft</span> : null}
      </span>
      <span className="text-meta text-muted-foreground">
        {persona ? `${persona.name} · ` : ""}“{journey.goal}”
      </span>
    </button>
  );
}

function ScreenDetails({ product, screenId, onOpenJourney }: { product: ProductFile; screenId: string; onOpenJourney: (journey: string, step: string) => void }) {
  const screen = product.screens.find((s) => s.id === screenId);
  if (!screen) return null;
  const uses = product.journeys.flatMap((j) => j.steps.map((s, i) => ({ j, s, i })).filter((x) => x.s.screen === screenId));
  return (
    <div className="space-y-3">
      <div>
        <div className="text-title-sm font-semibold text-foreground">{screen.name}</div>
        {screen.route ? <div className="font-mono text-meta text-muted-foreground">{screen.route}</div> : null}
        {screen.path ? <div className="mt-1 truncate font-mono text-caption text-faint" title={screen.path}>{screen.path}</div> : null}
        <div className="mt-1 text-caption text-faint">{screen.source === "scan" ? "Found in the app's routes" : screen.source === "agent" ? "Added by an agent" : "Added by hand"}</div>
      </div>
      <section className="space-y-1">
        <h3 className="text-label font-medium text-muted-foreground">Used in {uses.length} step{uses.length === 1 ? "" : "s"}</h3>
        {uses.length === 0 ? <p className="text-meta text-faint">No journey reaches this screen. Is it a dead end, an admin page, or a journey nobody has mapped yet?</p> : null}
        {uses.map(({ j, s, i }) => (
          <button key={`${j.id}/${s.id}`} type="button" onClick={() => onOpenJourney(j.id, s.id)} className="block w-full truncate rounded-md px-2 py-1 text-start text-meta hover:bg-accent">
            <span className="font-medium text-foreground">{j.name}</span>
            <span className="text-muted-foreground"> · {i + 1}. {s.action}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function GettingStarted({
  product,
  editable,
  onNew,
  onDraft,
  onRescan,
  onFlow,
}: {
  product: ProductFile | null;
  editable: boolean;
  onNew: () => void;
  onDraft: () => void;
  onRescan: () => void;
  onFlow: () => void;
}) {
  const screens = product?.screens.length ?? 0;
  return (
    <div className="mx-auto flex max-w-xl flex-1 flex-col justify-center gap-4 px-6 py-10">
      <div className="space-y-2">
        <h2 className="text-headline font-semibold text-foreground">Map how customers use the app</h2>
        <p className="text-ui text-muted-foreground">
          A journey is one customer goal walked step by step: the screen, what they do, why it is designed that way, how you know it works, and the code behind each step. Agents then change code with the why in mind, and Ruah tells you when code and journeys drift apart.
        </p>
        <p className="text-ui-sm text-muted-foreground">
          {screens > 0 ? `${screens} screen${screens === 1 ? "" : "s"} found in the app's routes.` : "No screens found yet: Ruah reads them from the app's routes (Next.js, TanStack, React Router, Expo, SvelteKit, Nuxt)."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={aiButton} onClick={onDraft} disabled={!editable}>
          <Sparkles className="size-3.5" aria-hidden />
          Draft journeys with the agent
        </button>
        <button type="button" className={solidButton} onClick={onNew} disabled={!editable}>
          <Plus className="size-3.5" aria-hidden />
          New journey
        </button>
        {screens > 0 ? (
          <button type="button" className={quietButton} onClick={onFlow}>
            <HeartPulse className="size-3.5" aria-hidden />
            See the screens
          </button>
        ) : (
          <button type="button" className={quietButton} onClick={onRescan} disabled={!editable}>
            <ScanLine className="size-3.5" aria-hidden />
            Scan for screens
          </button>
        )}
      </div>
    </div>
  );
}

/** Reviewed journeys whose code changed since (git, via the daemon); refetched when the product or map changes, and on focus. */
function useDrift(httpOrigin: string | null, productRevision: number, archRevision: number): JourneyDrift[] {
  const [drift, setDrift] = useState<JourneyDrift[]>([]);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocus((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (httpOrigin === null) return;
    let live = true;
    const t = setTimeout(() => {
      fetch(`${httpOrigin}/api/product/drift`)
        .then((r) => (r.ok ? (r.json() as Promise<{ journeys: JourneyDrift[] }>) : { journeys: [] }))
        .then((body) => live && setDrift(body.journeys))
        .catch(() => live && setDrift([]));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [httpOrigin, productRevision, archRevision, focus]);
  return drift;
}

function Empty({ title }: { title: string }) {
  return <div className="grid flex-1 place-items-center text-ui-sm text-muted-foreground">{title}</div>;
}
