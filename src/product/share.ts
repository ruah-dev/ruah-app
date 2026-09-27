// src/product/share.ts — pure helpers shared by the journey exports (storyboard
// HTML, markdown, draw.io pages; CONTRACTS §23.7): finding journeys, labels for
// evidence strength and branches, broken links from the store's warnings, and
// the persona grouping of the "all journeys" index.
import { evidenceStrength, type Branch, type Evidence, type Journey, type Persona, type ProductFile, type Screen } from "../contracts/product.js";

/** A journey by id, or by name (case-insensitive); undefined when none matches. */
export function findJourney(product: ProductFile, ref: string): Journey | undefined {
  return product.journeys.find((j) => j.id === ref) ?? product.journeys.find((j) => j.name.toLowerCase() === ref.toLowerCase());
}

/** Throws the same message as the agent tools for an unknown journey. */
export function requireJourney(product: ProductFile, ref: string): Journey {
  const journey = findJourney(product, ref);
  if (journey === undefined) throw new Error(`unknown journey "${ref}" (journeys: ${product.journeys.map((j) => j.id).join(", ") || "none"})`);
  return journey;
}

export function personaOf(product: ProductFile, journey: Journey): Persona | undefined {
  return journey.persona === undefined ? undefined : product.personas.find((p) => p.id === journey.persona);
}

export function screenOf(product: ProductFile, id: string | undefined): Screen | undefined {
  return id === undefined ? undefined : product.screens.find((s) => s.id === id);
}

const KIND_LABEL: Record<string, string> = {
  opinion: "Opinion",
  thematic: "Thematic",
  stated_preference: "Stated preference",
  past_behavior: "Past behavior",
  past_behavior_pattern: "Past behavior pattern",
  commitment: "Commitment",
  observed_behavior: "Observed behavior",
  launch_data: "Launch data",
};

/** "Observed behavior · strength 6/7", "Not graded", or the raw kind for unknown kinds. */
export function strengthLabel(evidence: Evidence): string {
  const strength = evidenceStrength(evidence);
  if (evidence.kind === undefined) return "Not graded";
  const label = KIND_LABEL[evidence.kind] ?? evidence.kind.replace(/_/g, " ");
  return strength === undefined ? label : `${label} · strength ${strength}/7`;
}

/** Strength bucket for styling: weak (0–2), medium (3–4), strong (5–7), none. */
export function strengthBucket(evidence: Evidence): "weak" | "medium" | "strong" | "none" {
  const s = evidenceStrength(evidence);
  return s === undefined ? "none" : s <= 2 ? "weak" : s <= 4 ? "medium" : "strong";
}

export function contradicts(evidence: Evidence): boolean {
  return evidence.stance === "contradicts";
}

/** 1-based position of a step in its journey, or undefined. */
export function stepNumber(journey: Journey, stepId: string | undefined): number | undefined {
  if (stepId === undefined) return undefined;
  const i = journey.steps.findIndex((s) => s.id === stepId);
  return i === -1 ? undefined : i + 1;
}

/**
 * The target of a branch in words, without the condition:
 * "Top up, back at step 3", "back to step 2 (Edits the amount)", "Top up".
 */
export function branchTarget(product: ProductFile, journey: Journey, branch: Branch): string {
  if (branch.to !== undefined) {
    const n = stepNumber(journey, branch.to);
    const step = journey.steps.find((s) => s.id === branch.to);
    const from = stepNumber(journey, branch.from) ?? 0;
    const verb = n !== undefined && n <= from ? "back to" : "skip to";
    return `${verb} step ${n ?? branch.to}${step !== undefined ? ` (${oneLine(step.action, 80)})` : ""}`;
  }
  const other = product.journeys.find((j) => j.id === branch.journey);
  const name = other?.name ?? branch.journey ?? "";
  const rejoin = stepNumber(journey, branch.rejoin);
  return `${name}${branch.rejoin !== undefined ? `, back at step ${rejoin ?? branch.rejoin}` : ""}`;
}

/** Journeys that branch into `journey`: "Pay rent (step 3, when Insufficient funds)". */
export function branchedFrom(product: ProductFile, journey: Journey): { journey: Journey; branch: Branch }[] {
  return product.journeys.flatMap((j) => (j.branches ?? []).filter((b) => b.journey === journey.id).map((branch) => ({ journey: j, branch })));
}

/** Touches entries of `journeyId` that the store's warnings mark as broken links (§23.2 rule 5). */
export function brokenRefs(warnings: readonly string[] | undefined, journeyId: string): Set<string> {
  const out = new Set<string>();
  const marker = "broken link: ";
  for (const w of warnings ?? []) {
    if (!w.startsWith(`journey ${journeyId}: `)) continue;
    const i = w.indexOf(marker);
    if (i !== -1) out.add(w.slice(i + marker.length));
  }
  return out;
}

const PRIORITY_ORDER: Record<string, number> = { core: 0, secondary: 1, edge: 2 };

/** Journeys grouped by persona (file order; journeys without one last), `core` first inside a group. */
export function journeysByPersona(product: ProductFile): { persona: Persona | undefined; journeys: Journey[] }[] {
  const rank = (j: Journey): number => PRIORITY_ORDER[j.priority ?? ""] ?? 3;
  const sorted = (list: Journey[]): Journey[] =>
    list.map((j, i) => ({ j, i })).sort((a, b) => rank(a.j) - rank(b.j) || a.i - b.i).map((x) => x.j);
  const groups: { persona: Persona | undefined; journeys: Journey[] }[] = [];
  const known = new Set(product.personas.map((p) => p.id));
  for (const persona of product.personas) {
    const journeys = product.journeys.filter((j) => j.persona === persona.id);
    if (journeys.length > 0) groups.push({ persona, journeys: sorted(journeys) });
  }
  const rest = product.journeys.filter((j) => j.persona === undefined || !known.has(j.persona));
  if (rest.length > 0) groups.push({ persona: undefined, journeys: sorted(rest) });
  return groups;
}

export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** YYYY-MM-DD in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A filesystem-safe base name (no extension). */
export function safeFileBase(name: string, fallback: string): string {
  const base = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  return base === "" ? fallback : base;
}
