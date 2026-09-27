// Dialogs of the Journeys page: a new journey (by hand, or drafted by the agent from the code),
// and customer notes (paste an interview or support thread; the agent files verbatim quotes as
// evidence on the matching steps and turns contradictions into open questions).
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import { aiButton, fieldClass, primaryButton, quietButton } from "@/components/ui/controls";
import type { ProductFile } from "@/lib/contracts";
import { editProduct } from "@/lib/daemon";
import { slugId } from "@/lib/journeys";
import { Field, OptionalSelect, personaOptions } from "./fields";

const dialogClass = "w-[calc(100vw-2rem)] max-w-lg gap-0 rounded-2xl border-hairline bg-popover p-0";

export function NewJourneyDialog({
  open,
  onOpenChange,
  product,
  onCreated,
  onDraftWithAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductFile | null;
  onCreated: (journeyId: string) => void;
  onDraftWithAgent: (prompt: string) => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [persona, setPersona] = useState<string | undefined>(undefined);
  const [newPersona, setNewPersona] = useState("");
  const [priority, setPriority] = useState<"core" | "secondary" | "edge">("core");
  const [first, setFirst] = useState("");
  useEffect(() => {
    if (!open) return;
    setName("");
    setGoal("");
    setPersona(product?.personas[0]?.id);
    setNewPersona("");
    setPriority("core");
    setFirst("");
  }, [open, product?.personas]);

  const personaName = persona !== undefined ? product?.personas.find((p) => p.id === persona)?.name : newPersona.trim() || undefined;
  const ready = name.trim() !== "" && goal.trim() !== "";

  const create = () => {
    if (!ready) return;
    let id = "";
    editProduct((p) => {
      let pid = persona;
      if (pid === undefined && newPersona.trim()) {
        pid = slugId(newPersona, new Set(p.personas.map((x) => x.id)), "persona");
        p.personas.push({ id: pid, name: newPersona.trim().slice(0, 80) });
      }
      id = slugId(name, new Set(p.journeys.map((j) => j.id)), "journey");
      const action = first.trim() || "Opens the app";
      p.journeys.push({
        id,
        name: name.trim().slice(0, 80),
        ...(pid !== undefined ? { persona: pid } : {}),
        goal: goal.trim().slice(0, 200),
        priority,
        steps: [{ id: slugId(action, new Set(), "step-1"), action: action.slice(0, 200) }],
      });
    });
    onOpenChange(false);
    if (id) onCreated(id);
  };

  const draft = () => {
    if (!ready) return;
    onOpenChange(false);
    onDraftWithAgent(
      `Map the “${name.trim()}” journey${personaName ? ` for the persona “${personaName}”` : ""}: the goal is “${goal.trim()}” (priority ${priority}). Find the screens, what the user does and sees at each step, and the code each step touches (elements, files, symbols, workflows). Add it with ruah_product_apply (add the persona first if it does not exist). Leave every why empty and put what you need to know from me in the step's question.`,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClass}>
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle className="text-title font-semibold">New journey</DialogTitle>
          <DialogDescription className="text-ui-sm">One goal a customer comes to the app for, walked step by step.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Field label="Name" htmlFor="nj-name">
            <Input id="nj-name" autoFocus value={name} maxLength={80} placeholder="Pay rent" onChange={(e) => setName(e.target.value)} className={fieldClass} />
          </Field>
          <Field label="Goal" hint="in the customer's words" htmlFor="nj-goal">
            <Input id="nj-goal" value={goal} maxLength={200} placeholder="Pay my rent before the 1st" onChange={(e) => setGoal(e.target.value)} className={fieldClass} />
          </Field>
          <Field label="Persona">
            {product && product.personas.length > 0 ? (
              <OptionalSelect label="Persona" value={persona} options={personaOptions(product)} none="A new persona…" onChange={(v) => setPersona(v ?? undefined)} />
            ) : null}
            {persona === undefined ? (
              <Input aria-label="New persona name" value={newPersona} maxLength={80} placeholder="Who? e.g. Retail customer" onChange={(e) => setNewPersona(e.target.value)} className={fieldClass} />
            ) : null}
          </Field>
          <Field label="Priority">
            <Segmented
              label="Priority"
              value={priority}
              options={[
                { value: "core", label: "Core" },
                { value: "secondary", label: "Secondary" },
                { value: "edge", label: "Edge case" },
              ]}
              onChange={setPriority}
            />
          </Field>
          <Field label="First step" hint="optional" htmlFor="nj-first">
            <Input id="nj-first" value={first} maxLength={200} placeholder="Opens the app and reads the balance" onChange={(e) => setFirst(e.target.value)} className={fieldClass} />
          </Field>
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
        <DialogFooter className="gap-2 border-t border-hairline px-5 py-3">
          <button type="button" className={quietButton} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className={aiButton} onClick={draft} disabled={!ready} title="The agent finds the screens, steps and code; you write the why">
            <Sparkles className="size-3.5" aria-hidden />
            Draft with agent
          </button>
          <button type="button" className={primaryButton} onClick={create} disabled={!ready}>
            Create
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerNotesDialog({ open, onOpenChange, onSend }: { open: boolean; onOpenChange: (open: boolean) => void; onSend: (prompt: string) => void }) {
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(() => {
    if (open) setNotes("");
  }, [open]);
  const send = () => {
    if (!notes.trim()) return;
    onOpenChange(false);
    onSend(
      [
        `Here are customer notes (source: ${source.trim() || "customer conversation"}, date: ${date}). Attach them to this project's journeys:`,
        "- Read the journeys with ruah_get_product.",
        "- For every statement that is about a journey step, add it with ruah_product_apply add_evidence: quote the customer verbatim (never paraphrase, never invent), set source and date, and kind (opinion, stated_preference, past_behavior, past_behavior_pattern, commitment, observed_behavior…). Past behaviour beats opinions.",
        "- When something contradicts a step's why or how the step is designed, add it with stance \"contradicts\" and set the step's question to what we should decide.",
        "- Do not change any why yourself. At the end, list what you attached and the contradictions.",
        "",
        "Notes:",
        notes.trim(),
      ].join("\n"),
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClass}>
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle className="text-title font-semibold">Customer notes</DialogTitle>
          <DialogDescription className="text-ui-sm">
            Paste an interview, a call summary or a support thread. The agent files the customers' own words as evidence on the steps they are about, and flags what contradicts the current design.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 pb-4">
          <Textarea aria-label="Notes" autoFocus rows={9} value={notes} placeholder="“I only open the app to see if my salary landed…”" onChange={(e) => setNotes(e.target.value)} className="min-h-0 rounded-md border-hairline bg-surface-0 px-2.5 py-2 text-ui-sm shadow-none" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Source" htmlFor="cn-source">
              <Input id="cn-source" value={source} placeholder="Interview — customer 4" onChange={(e) => setSource(e.target.value)} className={fieldClass} />
            </Field>
            <Field label="Date" htmlFor="cn-date">
              <Input id="cn-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
            </Field>
          </div>
          <p className="text-caption text-faint">Only the text goes to the agent. Remove names or details the customer would not want shared.</p>
        </div>
        <DialogFooter className="gap-2 border-t border-hairline px-5 py-3">
          <button type="button" className={quietButton} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className={aiButton} onClick={send} disabled={!notes.trim()}>
            <Sparkles className="size-3.5" aria-hidden />
            Send to agent
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
