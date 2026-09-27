// The Journeys page's right column: the selected journey (persona, goal, why, priority, signal,
// review) and the selected step (screen, action, why, open question, signal, evidence, the code it
// touches, branches). Every change is an editProduct() — saved to product.json after a short
// debounce. The why is the user's to write: agents leave questions, which are answered here.
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  GitBranch,
  Link2,
  MessageSquareQuote,
  Plus,
  Route,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Architecture, Branch, Evidence, Journey, JourneyStep, ProductFile } from "@/lib/contracts";
import { editProduct } from "@/lib/daemon";
import { brokenTouches, dropDangling, EVIDENCE_KINDS, EVIDENCE_LABELS, evidenceStrength, resolveTouch, type TouchView } from "@/lib/journeys";
import { confirmAction } from "@/lib/confirm";
import { Segmented } from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { aiButton, fieldClass, iconButton, quietButton, solidButton } from "@/components/ui/controls";
import { DraftArea, DraftInput, Field, OptionalSelect, personaOptions, screenOptions } from "./fields";
import { cn } from "@/lib/utils";

type Patch<T> = { [K in keyof T]?: T[K] | null };

function patchJourney(journeyId: string, patch: Patch<Journey>) {
  editProduct((p) => {
    const j = p.journeys.find((x) => x.id === journeyId);
    if (!j) return;
    applyPatch(j, patch);
  });
}

function patchStep(journeyId: string, stepId: string, patch: Patch<JourneyStep>) {
  editProduct((p) => {
    const s = p.journeys.find((x) => x.id === journeyId)?.steps.find((x) => x.id === stepId);
    if (!s) return;
    applyPatch(s, patch);
  });
}

function applyPatch<T extends object>(target: T, patch: Patch<T>) {
  const rec = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete rec[k];
    else if (v !== undefined) rec[k] = typeof v === "string" ? v.trim() : v;
  }
}

const PRIORITIES = [
  { value: "core", label: "Core", title: "A journey the product exists for" },
  { value: "secondary", label: "Secondary" },
  { value: "edge", label: "Edge", title: "An edge case or recovery path" },
] as const;

export function JourneyForm({
  product,
  journey,
  editable,
  onAsk,
  onDeleted,
}: {
  product: ProductFile;
  journey: Journey;
  editable: boolean;
  onAsk: () => void;
  onDeleted: () => void;
}) {
  const id = journey.id;
  const reviewed = journey.reviewedAt !== undefined ? new Date(journey.reviewedAt) : null;
  const newPersona = () => {
    const name = window.prompt("Persona name (who uses the app?)");
    if (!name?.trim()) return;
    editProduct((p) => {
      const taken = new Set(p.personas.map((x) => x.id));
      let pid = name.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "persona";
      for (let n = 2; taken.has(pid); n += 1) pid = `${pid.replace(/-\d+$/, "")}-${n}`;
      p.personas.push({ id: pid, name: name.trim() });
      const j = p.journeys.find((x) => x.id === id);
      if (j) j.persona = pid;
    });
  };
  return (
    <div className="space-y-3">
      {journey.origin === "agent" ? (
        <div className="flex items-center gap-2 rounded-lg border border-ai/30 bg-ai/5 px-2.5 py-2 text-meta">
          <Sparkles className="size-3.5 shrink-0 text-ai" aria-hidden />
          <span className="min-w-0 flex-1 text-muted-foreground">Drafted by an agent. Check it matches how customers really use the app.</span>
          <button
            type="button"
            disabled={!editable}
            className={solidButton}
            onClick={() =>
              editProduct((p) => {
                const j = p.journeys.find((x) => x.id === id);
                if (!j) return;
                delete j.origin;
                for (const s of j.steps) if (s.origin === "agent") delete s.origin;
              })
            }
          >
            <Check className="size-3.5" aria-hidden />
            Keep
          </button>
        </div>
      ) : null}
      <Field label="Name" htmlFor="journey-name">
        <DraftInput id="journey-name" value={journey.name} maxLength={80} disabled={!editable} onCommit={(v) => v.trim() && patchJourney(id, { name: v })} />
      </Field>
      <Field label="Persona" hint={editable ? <button type="button" className="text-label text-primary hover:underline" onClick={newPersona}>New…</button> : undefined}>
        <OptionalSelect label="Persona" value={journey.persona} options={personaOptions(product)} none="No persona" disabled={!editable} onChange={(v) => patchJourney(id, { persona: v })} />
      </Field>
      <Field label="Goal" hint="in the customer's words" htmlFor="journey-goal">
        <DraftInput id="journey-goal" value={journey.goal} maxLength={200} disabled={!editable} onCommit={(v) => v.trim() && patchJourney(id, { goal: v })} />
      </Field>
      <Field label="Priority">
        <Segmented
          label="Journey priority"
          value={(journey.priority ?? "") as "core" | "secondary" | "edge"}
          options={PRIORITIES.map((p) => ({ ...p, disabled: !editable }))}
          onChange={(v) => patchJourney(id, { priority: journey.priority === v ? null : v })}
        />
      </Field>
      <Field label="Why it matters" hint="for the product" htmlFor="journey-why">
        <DraftArea id="journey-why" value={journey.why ?? ""} rows={3} maxLength={2000} disabled={!editable} placeholder="Why does this journey matter? Who needs it, how often, what happens if it is slow or confusing?" onCommit={(v) => patchJourney(id, { why: v })} />
      </Field>
      <Field label="Success signal" htmlFor="journey-signal">
        <DraftInput id="journey-signal" value={journey.signal ?? ""} maxLength={200} disabled={!editable} placeholder="e.g. median time from open to transfer sent < 30 s" onCommit={(v) => patchJourney(id, { signal: v })} />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <button type="button" className={aiButton} onClick={onAsk}>
          <Sparkles className="size-3.5" aria-hidden />
          Ask agent
        </button>
        <button
          type="button"
          className={solidButton}
          disabled={!editable}
          title="Confirm this journey still matches the code and how customers use the app"
          onClick={() => patchJourney(id, { reviewedAt: new Date().toISOString() })}
        >
          <Check className="size-3.5" aria-hidden />
          Mark reviewed
        </button>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Delete journey"
          title="Delete journey"
          disabled={!editable}
          className={iconButton}
          onClick={async () => {
            const ok = await confirmAction({ title: `Delete “${journey.name}”?`, description: "Its steps, evidence and branches go with it. Other journeys' branches into it are removed.", confirmLabel: "Delete", destructive: true });
            if (!ok) return;
            editProduct((p) => {
              p.journeys = p.journeys.filter((x) => x.id !== id);
              dropDangling(p);
            });
            onDeleted();
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <p className="text-caption text-faint">{reviewed ? `Reviewed ${reviewed.toLocaleDateString()}` : "Never marked reviewed"}</p>
    </div>
  );
}

export function StepForm({
  product,
  journey,
  step,
  architecture,
  warnings,
  editable,
  selectedElement,
  onAsk,
  onOpenElement,
  onSelectStep,
}: {
  product: ProductFile;
  journey: Journey;
  step: JourneyStep;
  architecture: Architecture | null;
  warnings: readonly string[];
  editable: boolean;
  /** The element selected on the Map (offered as "Link …"). */
  selectedElement: { id: string; name: string } | null;
  onAsk: () => void;
  onOpenElement: (touch: TouchView) => void;
  onSelectStep: (stepId: string | null) => void;
}) {
  const jid = journey.id;
  const sid = step.id;
  const index = journey.steps.findIndex((s) => s.id === sid);
  const broken = brokenTouches(warnings, jid, sid);
  const touches = (step.touches ?? []).map((t) => resolveTouch(t, architecture, broken));
  const move = (delta: -1 | 1) =>
    editProduct((p) => {
      const j = p.journeys.find((x) => x.id === jid);
      if (!j) return;
      const i = j.steps.findIndex((s) => s.id === sid);
      const k = i + delta;
      if (i < 0 || k < 0 || k >= j.steps.length) return;
      const [s] = j.steps.splice(i, 1);
      j.steps.splice(k, 0, s!);
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <span className="text-label font-medium text-muted-foreground">
          Step {index + 1} of {journey.steps.length}
        </span>
        <span className="flex-1" />
        <button type="button" aria-label="Move step earlier" title="Move earlier" disabled={!editable || index === 0} className={iconButton} onClick={() => move(-1)}>
          <ArrowLeft className="size-3.5" />
        </button>
        <button type="button" aria-label="Move step later" title="Move later" disabled={!editable || index === journey.steps.length - 1} className={iconButton} onClick={() => move(1)}>
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Delete step"
          title={journey.steps.length === 1 ? "A journey needs at least one step" : "Delete step"}
          disabled={!editable || journey.steps.length === 1}
          className={iconButton}
          onClick={() => {
            editProduct((p) => {
              const j = p.journeys.find((x) => x.id === jid);
              if (!j || j.steps.length === 1) return;
              j.steps = j.steps.filter((s) => s.id !== sid);
              dropDangling(p);
            });
            onSelectStep(journey.steps[index + 1]?.id ?? journey.steps[index - 1]?.id ?? null);
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {step.origin === "agent" ? (
        <div className="flex items-center gap-2 rounded-lg border border-ai/30 bg-ai/5 px-2.5 py-2 text-meta">
          <Sparkles className="size-3.5 shrink-0 text-ai" aria-hidden />
          <span className="min-w-0 flex-1 text-muted-foreground">Drafted by an agent.</span>
          <button type="button" disabled={!editable} className={solidButton} onClick={() => patchStep(jid, sid, { origin: null })}>
            <Check className="size-3.5" aria-hidden />
            Keep
          </button>
        </div>
      ) : null}

      <Field label="What the customer does" htmlFor="step-action">
        <DraftInput id="step-action" value={step.action} maxLength={200} disabled={!editable} onCommit={(v) => v.trim() && patchStep(jid, sid, { action: v })} />
      </Field>
      <Field label="Screen">
        <OptionalSelect label="Screen" value={step.screen} options={screenOptions(product)} none="Same screen as before" disabled={!editable} onChange={(v) => patchStep(jid, sid, { screen: v })} />
      </Field>
      <Field label="What they expect to see" htmlFor="step-sees">
        <DraftInput id="step-sees" value={step.sees ?? ""} maxLength={200} disabled={!editable} placeholder="e.g. the balance, then the last 3 transactions" onCommit={(v) => patchStep(jid, sid, { sees: v })} />
      </Field>

      {step.question ? <QuestionCard step={step} editable={editable} onAnswer={(answer) => patchStep(jid, sid, { why: step.why ? `${step.why}\n\n${answer}` : answer, question: null })} onDismiss={() => patchStep(jid, sid, { question: null })} /> : null}

      <Field label="Why it is designed this way" htmlFor="step-why">
        <DraftArea
          id="step-why"
          value={step.why ?? ""}
          rows={4}
          maxLength={1000}
          disabled={!editable}
          placeholder="The reason, from the customer's side: what they want at this moment, and why this layout serves it."
          onCommit={(v) => patchStep(jid, sid, { why: v })}
        />
      </Field>
      <Field label="Success signal" htmlFor="step-signal">
        <DraftInput id="step-signal" value={step.signal ?? ""} maxLength={200} disabled={!editable} placeholder="e.g. ≥ 70 % of transfers start from this button" onCommit={(v) => patchStep(jid, sid, { signal: v })} />
      </Field>
      {!step.question && editable ? (
        <button type="button" className={cn(quietButton, "-ms-2")} onClick={() => {
          const q = window.prompt("Open question about this step");
          if (q?.trim()) patchStep(jid, sid, { question: q.slice(0, 400) });
        }}>
          <CircleHelp className="size-3.5" aria-hidden />
          Add an open question
        </button>
      ) : null}

      <EvidenceSection journeyId={jid} step={step} editable={editable} />
      <TouchesSection journeyId={jid} step={step} touches={touches} architecture={architecture} editable={editable} selectedElement={selectedElement} onOpenElement={onOpenElement} />
      <BranchesSection product={product} journey={journey} step={step} editable={editable} />

      <div className="pt-1">
        <button type="button" className={aiButton} onClick={onAsk}>
          <Sparkles className="size-3.5" aria-hidden />
          Ask agent about this step
        </button>
      </div>
    </div>
  );
}

function QuestionCard({ step, editable, onAnswer, onDismiss }: { step: JourneyStep; editable: boolean; onAnswer: (answer: string) => void; onDismiss: () => void }) {
  const [answer, setAnswer] = useState("");
  return (
    <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-2">
      <div className="flex items-start gap-2 text-ui-sm">
        <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
        <span className="min-w-0 flex-1 text-foreground">{step.question}</span>
        <button type="button" aria-label="Dismiss question" title="Dismiss" disabled={!editable} className={cn(iconButton, "size-6")} onClick={onDismiss}>
          <X className="size-3.5" />
        </button>
      </div>
      <Textarea
        aria-label="Your answer"
        value={answer}
        rows={2}
        disabled={!editable}
        placeholder="Your answer becomes the step's why"
        onChange={(e) => setAnswer(e.target.value)}
        className="min-h-0 rounded-md border-hairline bg-surface-0 px-2.5 py-1.5 text-ui-sm shadow-none"
      />
      <div className="flex justify-end">
        <button type="button" className={solidButton} disabled={!editable || answer.trim() === ""} onClick={() => onAnswer(answer.trim())}>
          Answer
        </button>
      </div>
    </div>
  );
}

function EvidenceSection({ journeyId, step, editable }: { journeyId: string; step: JourneyStep; editable: boolean }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Evidence>({ quote: "" });
  const evidence = step.evidence ?? [];
  const save = () => {
    if (draft.quote.trim() === "") return;
    const clean: Evidence = { quote: draft.quote.trim().slice(0, 600) };
    if (draft.source?.trim()) clean.source = draft.source.trim();
    if (draft.date?.trim()) clean.date = draft.date.trim();
    if (draft.kind) clean.kind = draft.kind;
    if (draft.stance === "contradicts") clean.stance = "contradicts";
    editProduct((p) => {
      const s = p.journeys.find((x) => x.id === journeyId)?.steps.find((x) => x.id === step.id);
      if (!s) return;
      s.evidence = [...(s.evidence ?? []), clean];
    });
    setDraft({ quote: "" });
    setAdding(false);
  };
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-label font-medium text-muted-foreground">Evidence</h3>
        <span className="text-meta text-faint">{evidence.length}</span>
        <span className="flex-1" />
        {editable && !adding ? (
          <button type="button" className={quietButton} onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add
          </button>
        ) : null}
      </div>
      {evidence.length === 0 && !adding ? <p className="text-meta text-faint">What customers said or did that backs this step. Past behaviour beats opinions.</p> : null}
      {evidence.map((e, i) => {
        const strength = evidenceStrength(e);
        return (
          <figure key={`${i}-${e.quote.slice(0, 12)}`} className={cn("group rounded-md border px-2.5 py-2", e.stance === "contradicts" ? "border-bad/40 bg-bad/5" : "border-hairline bg-surface-1")}>
            <blockquote className="flex gap-1.5 text-ui-sm leading-snug text-foreground">
              <MessageSquareQuote className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1">“{e.quote}”</span>
              {editable ? (
                <button
                  type="button"
                  aria-label="Remove evidence"
                  title="Remove"
                  className={cn(iconButton, "size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                  onClick={() =>
                    editProduct((p) => {
                      const s = p.journeys.find((x) => x.id === journeyId)?.steps.find((x) => x.id === step.id);
                      if (!s?.evidence) return;
                      s.evidence = s.evidence.filter((_, k) => k !== i);
                      if (s.evidence.length === 0) delete s.evidence;
                    })
                  }
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </blockquote>
            <figcaption className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ps-5 text-caption text-muted-foreground">
              {e.source ? <span>{e.source}</span> : null}
              {e.date ? <span>{e.date}</span> : null}
              {strength !== undefined ? (
                <span className="inline-flex items-center gap-1" title={`Evidence strength ${strength} of 7`}>
                  <StrengthBar value={strength} />
                  {EVIDENCE_LABELS[e.kind ?? ""] ?? e.kind}
                </span>
              ) : (
                <span className="text-faint">not graded</span>
              )}
              {e.stance === "contradicts" ? <span className="pill-bad rounded px-1 text-micro">contradicts the why</span> : null}
            </figcaption>
          </figure>
        );
      })}
      {adding ? (
        <div className="space-y-2 rounded-md border border-hairline bg-surface-1 px-2.5 py-2">
          <Textarea aria-label="Quote" autoFocus rows={2} value={draft.quote} placeholder="Their words, or the data point — verbatim" onChange={(e) => setDraft({ ...draft, quote: e.target.value })} className="min-h-0 rounded-md border-hairline bg-surface-0 px-2.5 py-1.5 text-ui-sm shadow-none" />
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="Source" value={draft.source ?? ""} placeholder="Source (interview, ticket…)" onChange={(e) => setDraft({ ...draft, source: e.target.value })} className={fieldClass} />
            <Input aria-label="Date" type="date" value={draft.date ?? ""} onChange={(e) => setDraft({ ...draft, date: e.target.value })} className={fieldClass} />
          </div>
          <OptionalSelect label="Kind of evidence" value={draft.kind} none="Kind of evidence…" options={EVIDENCE_KINDS.map((k) => ({ id: k, name: EVIDENCE_LABELS[k]! }))} onChange={(v) => setDraft({ ...draft, ...(v ? { kind: v } : { kind: undefined }) } as Evidence)} />
          <Segmented
            label="Evidence stance"
            value={draft.stance === "contradicts" ? "contradicts" : "supports"}
            options={[
              { value: "supports", label: "Supports the why" },
              { value: "contradicts", label: "Contradicts it" },
            ]}
            onChange={(v) => setDraft({ ...draft, stance: v })}
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" className={quietButton} onClick={() => { setAdding(false); setDraft({ quote: "" }); }}>
              Cancel
            </button>
            <button type="button" className={solidButton} disabled={draft.quote.trim() === ""} onClick={save}>
              Add evidence
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StrengthBar({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-px" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className={cn("h-2 w-1 rounded-sm", i < value ? (value <= 2 ? "bg-warn" : "bg-ok") : "bg-surface-3")} />
      ))}
    </span>
  );
}

function TouchesSection({
  journeyId,
  step,
  touches,
  architecture,
  editable,
  selectedElement,
  onOpenElement,
}: {
  journeyId: string;
  step: JourneyStep;
  touches: TouchView[];
  architecture: Architecture | null;
  editable: boolean;
  selectedElement: { id: string; name: string } | null;
  onOpenElement: (touch: TouchView) => void;
}) {
  const [query, setQuery] = useState("");
  const listId = `touch-options-${journeyId}-${step.id}`;
  const options = useMemo(() => (architecture?.nodes ?? []).map((n) => ({ id: n.id, label: `${n.name} · ${n.type}${n.path ? ` · ${n.path}` : ""}` })), [architecture]);
  const setTouches = (next: string[]) => patchStep(journeyId, step.id, { touches: next.slice(0, 20) });
  const add = (ref: string) => {
    const r = ref.trim();
    if (!r || (step.touches ?? []).includes(r)) return;
    setTouches([...(step.touches ?? []), r]);
    setQuery("");
  };
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-label font-medium text-muted-foreground">Code behind it</h3>
        <span className="text-meta text-faint">{touches.length}</span>
      </div>
      {touches.length === 0 ? <p className="text-meta text-faint">Link the elements, files or workflows that serve this step, so changes to them come with this step's why.</p> : null}
      {touches.map((t) => (
        <div key={t.ref} className={cn("group flex items-center gap-1.5 rounded-md border px-2 py-1", t.broken ? "border-bad/50 bg-bad/5" : "border-hairline bg-surface-1")}>
          {t.broken ? <TriangleAlert className="size-3.5 shrink-0 text-bad" aria-hidden /> : <Link2 className="size-3.5 shrink-0 text-faint" aria-hidden />}
          <button type="button" className="min-w-0 flex-1 truncate text-start text-meta text-foreground hover:underline" title={t.ref} onClick={() => onOpenElement(t)}>
            {t.label}
            <span className="ms-1.5 text-faint">{t.broken ? "no longer in the code" : t.type}</span>
          </button>
          {editable ? (
            <button type="button" aria-label={`Unlink ${t.label}`} title="Unlink" className={cn(iconButton, "size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")} onClick={() => setTouches((step.touches ?? []).filter((x) => x !== t.ref))}>
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
      {editable ? (
        <div className="flex items-center gap-1.5">
          <Input
            aria-label="Link an element by id"
            list={listId}
            value={query}
            placeholder="Element id, file id or workflow…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add(query);
            }}
            className={cn(fieldClass, "h-7 text-ui-sm")}
          />
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            {(architecture?.workflows ?? []).map((w) => (
              <option key={`wf-${w.id}`} value={w.id}>
                {w.name} · workflow
              </option>
            ))}
          </datalist>
          <button type="button" className={solidButton} disabled={query.trim() === ""} onClick={() => add(query)}>
            Link
          </button>
        </div>
      ) : null}
      {editable && selectedElement && !(step.touches ?? []).includes(selectedElement.id) ? (
        <button type="button" className={cn(quietButton, "-ms-2")} onClick={() => add(selectedElement.id)}>
          <Route className="size-3.5" aria-hidden />
          Link {selectedElement.name} (selected on the map)
        </button>
      ) : null}
    </section>
  );
}

function BranchesSection({ product, journey, step, editable }: { product: ProductFile; journey: Journey; step: JourneyStep; editable: boolean }) {
  const branches = (journey.branches ?? []).filter((b) => b.from === step.id);
  const [adding, setAdding] = useState(false);
  const [when, setWhen] = useState("");
  const [target, setTarget] = useState<string | undefined>(undefined); // "step:<id>" | "journey:<id>"
  const [rejoin, setRejoin] = useState<string | undefined>(undefined);
  const targets = [
    ...journey.steps.filter((s) => s.id !== step.id).map((s, i) => ({ id: `step:${s.id}`, name: `Step ${journey.steps.indexOf(s) + 1}: ${s.action}`, i })),
    ...product.journeys.filter((j) => j.id !== journey.id).map((j) => ({ id: `journey:${j.id}`, name: `Journey: ${j.name}`, i: 0 })),
  ];
  const save = () => {
    if (!when.trim() || !target) return;
    const [kind, id] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
    const branch: Branch = { from: step.id, when: when.trim().slice(0, 200), ...(kind === "step" ? { to: id } : { journey: id }), ...(kind === "journey" && rejoin ? { rejoin } : {}) };
    editProduct((p) => {
      const j = p.journeys.find((x) => x.id === journey.id);
      if (!j) return;
      j.branches = [...(j.branches ?? []).filter((b) => !(b.from === branch.from && b.when === branch.when)), branch];
    });
    setAdding(false);
    setWhen("");
    setTarget(undefined);
    setRejoin(undefined);
  };
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-label font-medium text-muted-foreground">Branches</h3>
        <span className="text-meta text-faint">{branches.length}</span>
        <span className="flex-1" />
        {editable && !adding ? (
          <button type="button" className={quietButton} onClick={() => setAdding(true)}>
            <GitBranch className="size-3.5" aria-hidden />
            Add
          </button>
        ) : null}
      </div>
      {branches.map((b) => {
        const alt = b.journey !== undefined ? product.journeys.find((j) => j.id === b.journey) : undefined;
        const to = b.to !== undefined ? journey.steps.findIndex((s) => s.id === b.to) : -1;
        const back = b.rejoin !== undefined ? journey.steps.findIndex((s) => s.id === b.rejoin) : -1;
        return (
          <div key={`${b.from}-${b.when}`} className="group flex items-center gap-1.5 rounded-md border border-dashed border-hairline px-2 py-1 text-meta">
            <GitBranch className="size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              When {b.when} → {alt ? alt.name : to >= 0 ? `step ${to + 1}` : b.to ?? b.journey}
              {back >= 0 ? `, back at step ${back + 1}` : ""}
            </span>
            {editable ? (
              <button
                type="button"
                aria-label="Remove branch"
                title="Remove branch"
                className={cn(iconButton, "size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                onClick={() =>
                  editProduct((p) => {
                    const j = p.journeys.find((x) => x.id === journey.id);
                    if (!j?.branches) return;
                    j.branches = j.branches.filter((x) => !(x.from === b.from && x.when === b.when));
                    if (j.branches.length === 0) delete j.branches;
                  })
                }
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
      {adding ? (
        <div className="space-y-2 rounded-md border border-hairline bg-surface-1 px-2.5 py-2">
          <Input aria-label="When" autoFocus value={when} placeholder="When… (e.g. insufficient funds)" onChange={(e) => setWhen(e.target.value)} className={fieldClass} />
          <OptionalSelect label="Goes to" value={target} none="Goes to…" options={targets} onChange={(v) => setTarget(v ?? undefined)} />
          {target?.startsWith("journey:") ? (
            <OptionalSelect label="Comes back at" value={rejoin} none="Does not come back" options={journey.steps.map((s, i) => ({ id: s.id, name: `Step ${i + 1}: ${s.action}` }))} onChange={(v) => setRejoin(v ?? undefined)} />
          ) : null}
          <div className="flex justify-end gap-1.5">
            <button type="button" className={quietButton} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className={solidButton} disabled={!when.trim() || !target} onClick={save}>
              Add branch
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
