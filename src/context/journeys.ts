// Context pack, product side (CONTRACTS §23.6, JOURNEYS.md §4.3): the journeys an
// element serves (lines after `workflows:`), and the `[ruah journey]` block a
// prompt sent from a journey step carries. Deterministic, bounded output.
import type { Architecture } from "../contracts/architecture.js";
import type { Journey, ProductFile } from "../contracts/product.js";
import { stepsTouching } from "../product/read.js";
import { collapse } from "./graph.js";

export const JOURNEYS_MAX = 6;
export const JOURNEY_WHY_MAX = 300;
export const JOURNEY_STEPS_MAX = 20;
export const JOURNEY_EVIDENCE_MAX = 5;

const TRUNCATION_MARK = "…";

function oneLine(text: string, max: number): string {
  let s = collapse(text);
  if (s.length > max) s = s.slice(0, max) + TRUNCATION_MARK;
  return s;
}

function personaOf(product: ProductFile, journey: Journey): string | undefined {
  return journey.persona === undefined ? undefined : collapse(product.personas.find((p) => p.id === journey.persona)?.name ?? journey.persona);
}

/** `journeys:` lines for an element: every journey step that touches it, max 6 (one per journey, first step). */
export function journeyLines(product: ProductFile | null | undefined, elementId: string, arch: Architecture | null): string[] {
  if (product === null || product === undefined) return [];
  const seen = new Set<string>();
  const hits = stepsTouching(product, elementId, arch).filter((h) => {
    if (seen.has(h.journey.id)) return false;
    seen.add(h.journey.id);
    return true;
  });
  if (hits.length === 0) return [];
  const lines = ["journeys:"];
  for (const h of hits.slice(0, JOURNEYS_MAX)) {
    const meta = [personaOf(product, h.journey), h.journey.priority].filter((x) => x !== undefined && x !== "").join(", ");
    lines.push(`- ${collapse(h.journey.name)}${meta !== "" ? ` (${meta})` : ""}: step ${h.index + 1} of ${h.journey.steps.length} "${oneLine(h.step.action, 120)}"`);
    const why = h.step.why ?? h.journey.why;
    if (why !== undefined && collapse(why) !== "") lines.push(`  why: ${oneLine(why, JOURNEY_WHY_MAX)}`);
    const signal = h.step.signal ?? h.journey.signal;
    if (signal !== undefined && collapse(signal) !== "") lines.push(`  signal: ${oneLine(signal, 200)}`);
    if (h.step.question !== undefined && collapse(h.step.question) !== "") lines.push(`  question: ${oneLine(h.step.question, 200)}`);
  }
  if (hits.length > JOURNEYS_MAX) lines.push(`- +${hits.length - JOURNEYS_MAX} more`);
  return lines;
}

export const JOURNEY_INSTRUCTION =
  "The user is working on the customer journey step marked THIS. Keep the change consistent with that step's why and signal; if the request works against them, say so before changing code. Open the touched code first.";

/**
 * The `[ruah journey]` block: the whole journey (every step, THIS marked), then the
 * current step's why, signal, question, evidence and touches. Throws for an unknown
 * journey or step (the hub answers with an error).
 */
export function journeyBlock(product: ProductFile, journeyId: string, stepId: string, arch: Architecture | null): string[] {
  const journey = product.journeys.find((j) => j.id === journeyId);
  if (journey === undefined) throw new Error(`unknown journey: ${journeyId}`);
  const current = journey.steps.findIndex((s) => s.id === stepId);
  if (current < 0) throw new Error(`unknown step: ${journeyId}/${stepId}`);
  const step = journey.steps[current]!;
  const screenName = (id: string | undefined) => {
    if (id === undefined) return "";
    const s = product.screens.find((x) => x.id === id);
    return s === undefined ? `${id}: ` : `${collapse(s.name)}${s.route !== undefined ? ` ${s.route}` : ""}: `;
  };
  const lines = ["[ruah journey]"];
  const meta = [personaOf(product, journey), journey.priority].filter((x) => x !== undefined && x !== "").join(", ");
  lines.push(`journey: ${collapse(journey.name)}${meta !== "" ? ` (${meta})` : ""} id=${journey.id}`);
  lines.push(`goal: ${oneLine(journey.goal, 200)}`);
  if (journey.why !== undefined && collapse(journey.why) !== "") lines.push(`why: ${oneLine(journey.why, 600)}`);
  if (journey.signal !== undefined && collapse(journey.signal) !== "") lines.push(`signal: ${oneLine(journey.signal, 200)}`);
  lines.push("steps:");
  const first = Math.max(0, Math.min(current - Math.floor(JOURNEY_STEPS_MAX / 2), journey.steps.length - JOURNEY_STEPS_MAX));
  if (first > 0) lines.push(`- (${first} earlier)`);
  journey.steps.slice(first, first + JOURNEY_STEPS_MAX).forEach((s, i) => {
    const n = first + i;
    lines.push(`- ${n + 1}. ${n === current ? "THIS " : ""}${screenName(s.screen)}${oneLine(s.action, 160)}`);
  });
  const rest = journey.steps.length - (first + JOURNEY_STEPS_MAX);
  if (rest > 0) lines.push(`- (${rest} later)`);
  for (const b of (journey.branches ?? []).filter((x) => x.from === step.id)) {
    const target = b.to !== undefined ? `step ${b.to}` : `journey ${b.journey}${b.rejoin !== undefined ? ` (rejoins at ${b.rejoin})` : ""}`;
    lines.push(`branch: when "${oneLine(b.when, 120)}" -> ${target}`);
  }
  lines.push(`this step: ${step.id}`);
  if (step.sees !== undefined && collapse(step.sees) !== "") lines.push(`sees: ${oneLine(step.sees, 200)}`);
  lines.push(step.why !== undefined && collapse(step.why) !== "" ? `step why: ${oneLine(step.why, 600)}` : "step why: (not written yet)");
  if (step.signal !== undefined && collapse(step.signal) !== "") lines.push(`step signal: ${oneLine(step.signal, 200)}`);
  if (step.question !== undefined && collapse(step.question) !== "") lines.push(`open question: ${oneLine(step.question, 300)}`);
  const evidence = step.evidence ?? [];
  if (evidence.length > 0) {
    lines.push("evidence:");
    for (const e of evidence.slice(0, JOURNEY_EVIDENCE_MAX)) {
      const tags = [e.source, e.date, e.kind, e.stance === "contradicts" ? "contradicts" : undefined].filter((x) => x !== undefined && x !== "");
      lines.push(`- "${oneLine(e.quote, 240)}"${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`);
    }
    if (evidence.length > JOURNEY_EVIDENCE_MAX) lines.push(`- +${evidence.length - JOURNEY_EVIDENCE_MAX} more`);
  }
  const touches = step.touches ?? [];
  if (touches.length > 0) {
    const nodes = new Map((arch?.nodes ?? []).map((n) => [n.id, n]));
    lines.push("touches:");
    for (const t of touches.slice(0, 12)) {
      const node = nodes.get(t);
      lines.push(node === undefined ? `- ${t}` : `- ${collapse(node.name)} (${node.type}) id=${node.id}${node.path !== undefined ? ` path=${node.path}` : ""}`);
    }
    if (touches.length > 12) lines.push(`- +${touches.length - 12} more`);
  }
  lines.push("[/ruah journey]");
  return lines;
}
