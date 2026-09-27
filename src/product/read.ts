// src/product/read.ts — read views of product.json for agents (ruah_get_product,
// ruah_get_journey, ruah_journeys_for) and for the context pack: which journey
// steps touch a map element. Pure; `touches` entries are element ids, expanded
// ids under an element (`<id>/<path>`, `<fileId>#<symbol>`) or workflow ids.
import type { Architecture } from "../contracts/architecture.js";
import { evidenceStrength, type Journey, type JourneyStep, type ProductFile } from "../contracts/product.js";

const oneLine = (text: string, max: number): string => {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Does `ref` (a touches entry) point at `elementId` or something inside it? */
export function touchCovers(ref: string, elementId: string, arch: Architecture | null): boolean {
  if (ref === elementId || ref.startsWith(`${elementId}/`) || ref.startsWith(`${elementId}#`)) return true;
  if (arch === null) return false;
  const workflow = arch.workflows.find((w) => w.id === ref);
  if (workflow !== undefined) return workflow.steps.includes(elementId);
  // A stored element inside `elementId` (parent chain), or an expanded id under one.
  const parents = new Map(arch.nodes.map((n) => [n.id, n.parent]));
  let cur: string | undefined = parents.has(ref) ? ref : arch.nodes.find((n) => ref.startsWith(`${n.id}/`) || ref.startsWith(`${n.id}#`))?.id;
  for (let guard = 0; cur !== undefined && guard < 64; guard += 1) {
    if (cur === elementId) return true;
    cur = parents.get(cur);
  }
  return false;
}

export interface StepHit {
  journey: Journey;
  step: JourneyStep;
  index: number; // 0-based
  via: string; // the touches entry, or "screen" when the step's screen belongs to the element
}

/** Steps that touch `elementId` (or anything inside it), or whose screen belongs to it; journeys in file order. */
export function stepsTouching(product: ProductFile, elementId: string, arch: Architecture | null): StepHit[] {
  const screensOf = new Set(product.screens.filter((s) => s.node === elementId).map((s) => s.id));
  const hits: StepHit[] = [];
  for (const journey of product.journeys) {
    journey.steps.forEach((step, index) => {
      const touch = (step.touches ?? []).find((ref) => touchCovers(ref, elementId, arch));
      if (touch !== undefined) hits.push({ journey, step, index, via: touch });
      else if (step.screen !== undefined && screensOf.has(step.screen)) hits.push({ journey, step, index, via: "screen" });
    });
  }
  return hits;
}

function personaName(product: ProductFile, id: string | undefined): string | undefined {
  return id === undefined ? undefined : (product.personas.find((p) => p.id === id)?.name ?? id);
}

function screenLabel(product: ProductFile, id: string | undefined): string {
  if (id === undefined) return "(no screen)";
  const screen = product.screens.find((s) => s.id === id);
  return screen === undefined ? id : `${screen.name}${screen.route !== undefined ? ` ${screen.route}` : ""}`;
}

/** ruah_get_product: personas, screens, journeys with their steps, open questions, warnings. */
export function summarizeProduct(product: ProductFile | null, warnings: readonly string[], journeyId?: string): string {
  if (product === null) {
    return "No product.json yet: no personas, screens or journeys. Create them with ruah_product_apply (add_persona, add_screen, add_journey); the file is created on the first change.";
  }
  const lines: string[] = [];
  const journeys = journeyId === undefined ? product.journeys : product.journeys.filter((j) => j.id === journeyId || j.name.toLowerCase() === journeyId.toLowerCase());
  if (journeyId !== undefined && journeys.length === 0) return `unknown journey "${journeyId}" (journeys: ${product.journeys.map((j) => j.id).join(", ") || "none"})`;
  if (journeyId === undefined) {
    lines.push(`personas (${product.personas.length}):`);
    for (const p of product.personas) lines.push(`- ${p.id} · ${p.name}${p.goals !== undefined && p.goals.length > 0 ? ` · goals: ${p.goals.join("; ")}` : ""}`);
    lines.push(`screens (${product.screens.length}):`);
    for (const s of product.screens.slice(0, 120)) {
      lines.push(`- ${s.id} · ${s.name}${s.route !== undefined ? ` · ${s.route}` : ""}${s.path !== undefined ? ` · ${s.path}` : ""}${s.source !== undefined && s.source !== "scan" ? ` · ${s.source}` : ""}`);
    }
    if (product.screens.length > 120) lines.push(`- +${product.screens.length - 120} more`);
  }
  lines.push(`journeys (${journeys.length}):`);
  for (const j of journeys) {
    const meta = [personaName(product, j.persona), j.priority, j.origin === "agent" ? "agent-made" : undefined].filter((x) => x !== undefined).join(", ");
    lines.push(`- ${j.id} · ${j.name}${meta !== "" ? ` (${meta})` : ""} · goal: ${oneLine(j.goal, 160)}`);
    if (j.why !== undefined) lines.push(`  why: ${oneLine(j.why, 240)}`);
    if (j.signal !== undefined) lines.push(`  signal: ${oneLine(j.signal, 160)}`);
    j.steps.forEach((s, i) => {
      const touches = (s.touches ?? []).length > 0 ? ` · touches: ${(s.touches ?? []).join(", ")}` : "";
      lines.push(`  ${i + 1}. ${s.id} · ${screenLabel(product, s.screen)} · ${oneLine(s.action, 160)}${touches}`);
      if (s.why === undefined) lines.push("     why: (missing)");
      if (s.question !== undefined) lines.push(`     question: ${oneLine(s.question, 200)}`);
    });
    for (const b of j.branches ?? []) {
      lines.push(`  branch: from ${b.from} when "${b.when}" → ${b.to !== undefined ? `step ${b.to}` : `journey ${b.journey}${b.rejoin !== undefined ? `, rejoins at ${b.rejoin}` : ""}`}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 30)) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

/** ruah_get_journey: the journey as JSON, each touch resolved against the map (or marked broken). */
export function describeJourney(product: ProductFile | null, arch: Architecture | null, ref: string, warnings: readonly string[]): string {
  const journey = product?.journeys.find((j) => j.id === ref || j.name.toLowerCase() === ref.toLowerCase());
  if (product === null || product === undefined || journey === undefined) {
    throw new Error(`unknown journey "${ref}" (journeys: ${product?.journeys.map((j) => j.id).join(", ") || "none"})`);
  }
  const nodes = new Map((arch?.nodes ?? []).map((n) => [n.id, n]));
  const workflows = new Map((arch?.workflows ?? []).map((w) => [w.id, w]));
  const broken = new Set(warnings.filter((w) => w.startsWith(`journey ${journey.id}: `) && w.includes("broken link: ")).map((w) => w.slice(w.indexOf("broken link: ") + 13)));
  const resolveTouch = (t: string) => {
    const node = nodes.get(t);
    if (node !== undefined) return { ref: t, element: { id: node.id, name: node.name, type: node.type, ...(node.path !== undefined ? { path: node.path } : {}) } };
    const wf = workflows.get(t);
    if (wf !== undefined) return { ref: t, workflow: { id: wf.id, name: wf.name, steps: wf.steps } };
    return { ref: t, ...(broken.has(t) ? { broken: true } : { expanded: true }) };
  };
  const out = {
    ...journey,
    persona: journey.persona !== undefined ? product.personas.find((p) => p.id === journey.persona) ?? journey.persona : undefined,
    steps: journey.steps.map((s, i) => ({
      position: i + 1,
      ...s,
      screen: s.screen !== undefined ? product.screens.find((x) => x.id === s.screen) ?? s.screen : undefined,
      touches: (s.touches ?? []).map(resolveTouch),
      evidence: (s.evidence ?? []).map((e) => ({ ...e, ...(evidenceStrength(e) !== undefined ? { strength: evidenceStrength(e) } : {}) })),
    })),
    branchedFrom: product.journeys.flatMap((j) => (j.branches ?? []).filter((b) => b.journey === journey.id).map((b) => ({ journey: j.id, from: b.from, when: b.when, ...(b.rejoin !== undefined ? { rejoin: b.rejoin } : {}) }))),
  };
  return JSON.stringify(out, null, 2);
}

/** ruah_journeys_for: the journey steps that touch an element. */
export function journeysForElement(product: ProductFile | null, arch: Architecture | null, elementId: string, elementName: string): string {
  if (product === null) return `${elementName}: no product.json yet, so no journeys touch it.`;
  const hits = stepsTouching(product, elementId, arch);
  if (hits.length === 0) return `${elementName} (${elementId}): no journey step touches it.`;
  const lines = [`${elementName} (${elementId}) is used by ${hits.length} journey step${hits.length === 1 ? "" : "s"}:`];
  for (const h of hits) {
    lines.push(`- ${h.journey.name} (${h.journey.id}${h.journey.priority !== undefined ? `, ${h.journey.priority}` : ""}): step ${h.index + 1} of ${h.journey.steps.length} ${h.step.id} "${oneLine(h.step.action, 120)}" via ${h.via}`);
    const why = h.step.why ?? h.journey.why;
    if (why !== undefined) lines.push(`  why: ${oneLine(why, 200)}`);
  }
  return lines.join("\n");
}
