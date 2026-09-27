import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// CONTRACTS.md §23 — product.json: personas, screens and customer journeys, the
// product side of the map (docs/JOURNEYS.md). Open unions use z.string(); the known
// literals are documented in comments. Receivers ignore unknown fields.

export const PRODUCT_FILE = "product.json";

// Same shape as §1 ids, plus an optional repo namespace (journeys can cross repos in a system).
export const PRODUCT_ID_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Evidence kinds, weakest first (docs/research: evidence_strength). The strength of a
 * piece of evidence is derived from its kind, never stored, so the two cannot disagree.
 */
export const EVIDENCE_STRENGTH: Record<string, number> = {
  opinion: 0,
  thematic: 1,
  stated_preference: 2,
  past_behavior: 3,
  past_behavior_pattern: 4,
  commitment: 5,
  observed_behavior: 6,
  launch_data: 7,
};

export const EvidenceSchema = z.object({
  quote: z.string().min(1).max(600),
  source: z.string().max(200).optional(), // "Interview — customer 4", "Support ticket #412", "Amplitude: step 3 drop-off 18 %"
  date: z.string().optional(), // ISO 8601 date
  kind: z.string().optional(), // known: keys of EVIDENCE_STRENGTH; absent = not graded
  stance: z.string().optional(), // known: supports | contradicts (the step's why); absent = supports
});

export const PersonaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  goals: z.array(z.string().max(200)).max(10).optional(),
});

export const ScreenSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  route: z.string().max(200).optional(), // "/home", "/accounts/:id"
  path: z.string().optional(), // file that renders it, repo-relative
  node: z.string().optional(), // the frontend map element it belongs to
  source: z.string().optional(), // known: scan | user | agent; "scan" = replaced on re-scan
  shot: z.string().optional(), // screenshot path (§6 of JOURNEYS.md)
});

export const JourneyStepSchema = z.object({
  id: z.string(),
  screen: z.string().optional(), // screen id
  action: z.string().min(1).max(200),
  sees: z.string().max(200).optional(),
  why: z.string().max(1000).optional(),
  signal: z.string().max(200).optional(),
  touches: z.array(z.string()).max(20).optional(), // map element ids, expanded ids (files, symbols), architecture workflow ids
  evidence: z.array(EvidenceSchema).max(20).optional(),
  question: z.string().max(400).optional(),
  origin: z.string().optional(), // known: user | agent; absent = hand-written
});

// Leaves the main line at `from` when `when` holds: jumps to a step of the same journey
// (`to`) or follows another journey (`journey`) and optionally comes back (`rejoin`).
export const BranchSchema = z.object({
  from: z.string(),
  when: z.string().min(1).max(200),
  to: z.string().optional(),
  journey: z.string().optional(),
  rejoin: z.string().optional(),
});

export const JourneySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  persona: z.string().optional(),
  goal: z.string().min(1).max(200),
  why: z.string().max(2000).optional(),
  priority: z.string().optional(), // known: core | secondary | edge
  steps: z.array(JourneyStepSchema).min(1),
  branches: z.array(BranchSchema).optional(),
  signal: z.string().max(200).optional(),
  origin: z.string().optional(), // known: user | agent; absent = hand-written
  reviewedAt: z.string().optional(), // ISO 8601: last time a person confirmed it matches the code
});

export const ProductFileSchema = z.object({
  version: z.literal(1),
  personas: z.array(PersonaSchema),
  screens: z.array(ScreenSchema),
  journeys: z.array(JourneySchema),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type Screen = z.infer<typeof ScreenSchema>;
export type JourneyStep = z.infer<typeof JourneyStepSchema>;
export type Branch = z.infer<typeof BranchSchema>;
export type Journey = z.infer<typeof JourneySchema>;
export type ProductFile = z.infer<typeof ProductFileSchema>;

export function emptyProduct(): ProductFile {
  return { version: 1, personas: [], screens: [], journeys: [] };
}

/** Strength 0–7 of a piece of evidence, or undefined when its kind is absent or unknown. */
export function evidenceStrength(evidence: Evidence): number | undefined {
  return evidence.kind !== undefined ? EVIDENCE_STRENGTH[evidence.kind] : undefined;
}

export type ProductValidationResult =
  | { ok: true; value: ProductFile; warnings: string[] }
  | { ok: false; errors: string[] };

export interface ProductValidationContext {
  /** Repo root for the on-disk `screen.path` check; null skips it. */
  root?: string | null;
  /** Overrides the on-disk check (multi-repo systems: paths are "<repoId>/<path>"). */
  pathExists?: (rel: string) => boolean;
  /**
   * Does a `touches` entry still resolve (stored element, architecture workflow,
   * expandable file or symbol)? Absent: touches are not checked.
   */
  resolveTouch?: (ref: string) => boolean;
}

// Validates an unknown input as a ProductFile per CONTRACTS.md §23.2: structural problems
// are errors (the daemon keeps the last good version); links into the code that no longer
// resolve are warnings, so a refactor never makes the product file unloadable.
export function validateProduct(input: unknown, context: ProductValidationContext = {}): ProductValidationResult {
  const parsed = ProductFileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const product = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const idSet = (what: string, ids: string[]): Set<string> => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (!PRODUCT_ID_PATTERN.test(id)) errors.push(`${what} ${id}: id must match ^(<repoId>:)?[a-z0-9][a-z0-9._-]{0,63}$`);
      if (seen.has(id)) errors.push(`duplicate ${what} id: ${id}`);
      seen.add(id);
    }
    return seen;
  };
  const personas = idSet("persona", product.personas.map((p) => p.id));
  const screens = idSet("screen", product.screens.map((s) => s.id));
  const journeys = idSet("journey", product.journeys.map((j) => j.id));

  for (const screen of product.screens) {
    if (screen.path !== undefined && !relOk(screen.path)) errors.push(`screen ${screen.id}: path escapes repo: ${screen.path}`);
  }

  for (const journey of product.journeys) {
    const where = `journey ${journey.id}`;
    if (journey.persona !== undefined && !personas.has(journey.persona)) {
      errors.push(`${where}: persona references unknown persona: ${journey.persona}`);
    }
    const steps = new Set<string>();
    for (const step of journey.steps) {
      if (!PRODUCT_ID_PATTERN.test(step.id)) errors.push(`${where}: step ${step.id}: id must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
      if (steps.has(step.id)) errors.push(`${where}: duplicate step id: ${step.id}`);
      steps.add(step.id);
      if (step.screen !== undefined && !screens.has(step.screen)) {
        errors.push(`${where}: step ${step.id}: screen references unknown screen: ${step.screen}`);
      }
    }
    for (const branch of journey.branches ?? []) {
      const label = `${where}: branch from ${branch.from} ("${branch.when}")`;
      if (!steps.has(branch.from)) errors.push(`${label}: from references unknown step: ${branch.from}`);
      if ((branch.to === undefined) === (branch.journey === undefined)) {
        errors.push(`${label}: needs exactly one of to / journey`);
      }
      if (branch.to !== undefined && !steps.has(branch.to)) errors.push(`${label}: to references unknown step: ${branch.to}`);
      if (branch.journey !== undefined) {
        if (branch.journey === journey.id) errors.push(`${label}: journey cannot be its own journey`);
        else if (!journeys.has(branch.journey)) errors.push(`${label}: journey references unknown journey: ${branch.journey}`);
      }
      if (branch.rejoin !== undefined) {
        if (branch.journey === undefined) errors.push(`${label}: rejoin needs journey`);
        else if (!steps.has(branch.rejoin)) errors.push(`${label}: rejoin references unknown step: ${branch.rejoin}`);
      }
    }
  }

  // Warnings: links into the code (§23.2 rules 5–6).
  const root = context.root ?? null;
  const exists = context.pathExists ?? (root !== null ? (rel: string) => fs.existsSync(path.join(root, normalizeRel(rel))) : undefined);
  if (exists !== undefined) {
    for (const screen of product.screens) {
      if (screen.path !== undefined && relOk(screen.path) && !exists(screen.path)) {
        warnings.push(`screen ${screen.id}: path does not exist on disk: ${screen.path}`);
      }
    }
  }
  if (context.resolveTouch !== undefined) {
    for (const journey of product.journeys) {
      for (const step of journey.steps) {
        for (const ref of step.touches ?? []) {
          if (!context.resolveTouch(ref)) warnings.push(`journey ${journey.id}: step ${step.id}: broken link: ${ref}`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: product, warnings };
}

function normalizeRel(p: string): string {
  return path.posix.normalize(p.replaceAll("\\", "/"));
}

function relOk(p: string): boolean {
  const n = normalizeRel(p);
  return n.length > 0 && !path.posix.isAbsolute(n) && n !== ".." && !n.startsWith("../") && n !== ".";
}
