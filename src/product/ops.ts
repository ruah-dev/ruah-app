// src/product/ops.ts — applies ProductOps (CONTRACTS §23.5) to a product.json, and
// reverts one agent turn's product changes (three-way, per persona / screen /
// journey). Pure: no I/O. The daemon's MapOpsService validates and saves the result.
import type { MapChange } from "../contracts/map.js";
import {
  emptyProduct,
  PRODUCT_ID_PATTERN,
  type Journey,
  type JourneyStep,
  type Persona,
  type ProductFile,
  type Screen,
} from "../contracts/product.js";
import type { ProductOp, ProductOpResult, StepInput } from "../contracts/product-ops.js";
import { slugify } from "../mcp/ops.js";

export class ProductOpError extends Error {
  constructor(
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
    this.name = "ProductOpError";
  }
}

export interface ProductApplyOutcome {
  product: ProductFile;
  results: ProductOpResult[];
  changes: MapChange[];
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Finds a persona / screen / journey by id, then case-insensitive id, then unique exact name. */
function resolveNamed<T extends { id: string; name: string }>(items: T[], ref: string, what: string): T {
  const exact = items.find((i) => i.id === ref);
  if (exact !== undefined) return exact;
  const key = norm(ref);
  const byId = items.find((i) => i.id.toLowerCase() === key);
  if (byId !== undefined) return byId;
  const byName = items.filter((i) => norm(i.name) === key);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new ProductOpError(`${what} "${ref}" is ambiguous (${byName.map((i) => i.id).join(", ")}); use its id`);
  const close = items.filter((i) => i.id.includes(key) || norm(i.name).includes(key)).slice(0, 3);
  throw new ProductOpError(`unknown ${what} "${ref}"${close.length > 0 ? ` — did you mean ${close.map((i) => i.id).join(", ")}?` : ""}`);
}

/** A step by id, or by 1-based position ("2"). */
function resolveStep(journey: Journey, ref: string): JourneyStep {
  const byId = journey.steps.find((s) => s.id === ref || s.id === norm(ref));
  if (byId !== undefined) return byId;
  if (/^\d+$/.test(ref.trim())) {
    const step = journey.steps[Number.parseInt(ref, 10) - 1];
    if (step !== undefined) return step;
  }
  throw new ProductOpError(`journey ${journey.id} has no step "${ref}" (steps: ${journey.steps.map((s) => s.id).join(", ")})`);
}

function uniqueId(base: string, taken: Set<string>, fallback: string): string {
  let root = slugify(base).slice(0, 48).replace(/[-._]+$/, "");
  if (root === "" || !PRODUCT_ID_PATTERN.test(root)) root = fallback;
  let id = root;
  for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  return id;
}

function explicitId(id: string, taken: Set<string>, what: string): string {
  if (!PRODUCT_ID_PATTERN.test(id)) throw new ProductOpError(`${what} id "${id}" must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
  if (taken.has(id)) throw new ProductOpError(`${what} id "${id}" is taken`);
  return id;
}

/** Sets `key` to `value`, deletes it for null; undefined leaves it. Returns whether it changed. */
function patchField<T extends object>(target: T, key: keyof T & string, value: unknown): boolean {
  if (value === undefined) return false;
  const record = target as Record<string, unknown>;
  if (value === null) {
    if (!(key in record)) return false;
    delete record[key];
    return true;
  }
  if (JSON.stringify(record[key]) === JSON.stringify(value)) return false;
  record[key] = value;
  return true;
}

export interface ProductApplyOptions {
  origin?: string; // written on new personas' journeys / steps (default "agent")
}

export function applyProductOps(base: ProductFile | null, ops: readonly ProductOp[], options: ProductApplyOptions = {}): ProductApplyOutcome {
  const origin = options.origin ?? "agent";
  const product = structuredClone(base ?? emptyProduct()) as ProductFile;
  const results: ProductOpResult[] = [];
  const changes: MapChange[] = [];

  const makeStep = (journey: Journey, input: StepInput): JourneyStep => {
    const taken = new Set(journey.steps.map((s) => s.id));
    const id = input.id !== undefined ? explicitId(input.id, taken, "step") : uniqueId(input.action, taken, `step-${journey.steps.length + 1}`);
    const screen = input.screen !== undefined ? resolveNamed(product.screens, input.screen, "screen").id : undefined;
    const { id: _id, screen: _screen, ...rest } = input;
    return { id, ...(screen !== undefined ? { screen } : {}), ...rest, origin };
  };

  ops.forEach((op, index) => {
    try {
      switch (op.op) {
        case "add_persona": {
          const taken = new Set(product.personas.map((p) => p.id));
          const id = op.id !== undefined ? explicitId(op.id, taken, "persona") : uniqueId(op.name, taken, "persona");
          const persona: Persona = { id, name: op.name, ...(op.description !== undefined ? { description: op.description } : {}), ...(op.goals !== undefined ? { goals: op.goals } : {}) };
          product.personas.push(persona);
          results.push({ op: op.op, id, message: `added persona ${op.name} (${id})` });
          changes.push({ action: "add", target: "persona", id, name: op.name });
          return;
        }
        case "update_persona": {
          const persona = resolveNamed(product.personas, op.id, "persona");
          const fields = Object.entries(op.patch).filter(([k, v]) => patchField(persona, k as keyof Persona & string, v)).map(([k]) => k);
          results.push({ op: op.op, id: persona.id, message: fields.length > 0 ? `updated persona ${persona.id}: ${fields.join(", ")}` : `persona ${persona.id} unchanged` });
          if (fields.length > 0) changes.push({ action: "update", target: "persona", id: persona.id, name: persona.name, fields });
          return;
        }
        case "remove_persona": {
          const persona = resolveNamed(product.personas, op.id, "persona");
          product.personas = product.personas.filter((p) => p !== persona);
          const users = product.journeys.filter((j) => j.persona === persona.id);
          for (const j of users) delete j.persona;
          results.push({ op: op.op, id: persona.id, message: `removed persona ${persona.id}${users.length > 0 ? ` (was on ${users.map((j) => j.id).join(", ")})` : ""}` });
          changes.push({ action: "remove", target: "persona", id: persona.id, name: persona.name });
          return;
        }
        case "add_screen": {
          const taken = new Set(product.screens.map((s) => s.id));
          const id = op.id !== undefined ? explicitId(op.id, taken, "screen") : uniqueId(op.route !== undefined && op.route !== "/" ? op.route : op.name, taken, "screen");
          const screen: Screen = {
            id,
            name: op.name,
            ...(op.route !== undefined ? { route: op.route } : {}),
            ...(op.path !== undefined ? { path: op.path } : {}),
            ...(op.node !== undefined ? { node: op.node } : {}),
            source: origin,
          };
          product.screens.push(screen);
          results.push({ op: op.op, id, message: `added screen ${op.name} (${id})` });
          changes.push({ action: "add", target: "screen", id, name: op.name });
          return;
        }
        case "update_screen": {
          const screen = resolveNamed(product.screens, op.id, "screen");
          const fields = Object.entries(op.patch).filter(([k, v]) => patchField(screen, k as keyof Screen & string, v)).map(([k]) => k);
          // A scanned screen someone edited is theirs now: the next scan leaves it alone.
          if (fields.length > 0 && screen.source === "scan") screen.source = origin;
          results.push({ op: op.op, id: screen.id, message: fields.length > 0 ? `updated screen ${screen.id}: ${fields.join(", ")}` : `screen ${screen.id} unchanged` });
          if (fields.length > 0) changes.push({ action: "update", target: "screen", id: screen.id, name: screen.name, fields });
          return;
        }
        case "remove_screen": {
          const screen = resolveNamed(product.screens, op.id, "screen");
          product.screens = product.screens.filter((s) => s !== screen);
          let cleared = 0;
          for (const j of product.journeys) {
            for (const s of j.steps) {
              if (s.screen === screen.id) {
                delete s.screen;
                cleared += 1;
              }
            }
          }
          results.push({ op: op.op, id: screen.id, message: `removed screen ${screen.id}${cleared > 0 ? ` (cleared from ${cleared} step${cleared === 1 ? "" : "s"})` : ""}` });
          changes.push({ action: "remove", target: "screen", id: screen.id, name: screen.name });
          return;
        }
        case "add_journey": {
          const taken = new Set(product.journeys.map((j) => j.id));
          const id = op.id !== undefined ? explicitId(op.id, taken, "journey") : uniqueId(op.name, taken, "journey");
          const persona = op.persona !== undefined ? resolveNamed(product.personas, op.persona, "persona").id : undefined;
          const journey: Journey = {
            id,
            name: op.name,
            ...(persona !== undefined ? { persona } : {}),
            goal: op.goal,
            ...(op.why !== undefined ? { why: op.why } : {}),
            ...(op.priority !== undefined ? { priority: op.priority } : {}),
            ...(op.signal !== undefined ? { signal: op.signal } : {}),
            steps: [],
            origin,
          };
          for (const input of op.steps) journey.steps.push(makeStep(journey, input));
          product.journeys.push(journey);
          results.push({ op: op.op, id, message: `added journey ${op.name} (${id}) with ${journey.steps.length} step${journey.steps.length === 1 ? "" : "s"}: ${journey.steps.map((s) => s.id).join(", ")}` });
          changes.push({ action: "add", target: "journey", id, name: op.name });
          return;
        }
        case "update_journey": {
          const journey = resolveNamed(product.journeys, op.id, "journey");
          const patch = { ...op.patch };
          if (typeof patch.persona === "string") patch.persona = resolveNamed(product.personas, patch.persona, "persona").id;
          const fields = Object.entries(patch).filter(([k, v]) => patchField(journey, k as keyof Journey & string, v)).map(([k]) => k);
          results.push({ op: op.op, id: journey.id, message: fields.length > 0 ? `updated journey ${journey.id}: ${fields.join(", ")}` : `journey ${journey.id} unchanged` });
          if (fields.length > 0) changes.push({ action: "update", target: "journey", id: journey.id, name: journey.name, fields });
          return;
        }
        case "remove_journey": {
          const journey = resolveNamed(product.journeys, op.id, "journey");
          product.journeys = product.journeys.filter((j) => j !== journey);
          for (const j of product.journeys) {
            if (j.branches !== undefined) {
              j.branches = j.branches.filter((b) => b.journey !== journey.id);
              if (j.branches.length === 0) delete j.branches;
            }
          }
          results.push({ op: op.op, id: journey.id, message: `removed journey ${journey.id}` });
          changes.push({ action: "remove", target: "journey", id: journey.id, name: journey.name });
          return;
        }
        case "add_step": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const step = makeStep(journey, op.step);
          const at = op.after === undefined ? journey.steps.length : op.after === null ? 0 : journey.steps.indexOf(resolveStep(journey, op.after)) + 1;
          journey.steps.splice(at, 0, step);
          results.push({ op: op.op, id: step.id, message: `added step ${step.id} to ${journey.id} at position ${at + 1}` });
          changes.push({ action: "add", target: "step", id: `${journey.id}/${step.id}`, name: `${journey.name}: ${step.action}` });
          return;
        }
        case "update_step": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const step = resolveStep(journey, op.id);
          const patch = { ...op.patch };
          if (typeof patch.screen === "string") patch.screen = resolveNamed(product.screens, patch.screen, "screen").id;
          const fields = Object.entries(patch).filter(([k, v]) => patchField(step, k as keyof JourneyStep & string, v)).map(([k]) => k);
          results.push({ op: op.op, id: step.id, message: fields.length > 0 ? `updated step ${journey.id}/${step.id}: ${fields.join(", ")}` : `step ${journey.id}/${step.id} unchanged` });
          if (fields.length > 0) changes.push({ action: "update", target: "step", id: `${journey.id}/${step.id}`, name: `${journey.name}: ${step.action}`, fields });
          return;
        }
        case "remove_step": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const step = resolveStep(journey, op.id);
          if (journey.steps.length === 1) throw new ProductOpError(`step ${step.id} is the only step of ${journey.id}; remove the journey instead`);
          journey.steps = journey.steps.filter((s) => s !== step);
          if (journey.branches !== undefined) {
            journey.branches = journey.branches.filter((b) => b.from !== step.id && b.to !== step.id && b.rejoin !== step.id);
            if (journey.branches.length === 0) delete journey.branches;
          }
          results.push({ op: op.op, id: step.id, message: `removed step ${journey.id}/${step.id}` });
          changes.push({ action: "remove", target: "step", id: `${journey.id}/${step.id}`, name: `${journey.name}: ${step.action}` });
          return;
        }
        case "move_step": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const step = resolveStep(journey, op.id);
          const anchor = op.after === null ? null : resolveStep(journey, op.after);
          if (anchor === step) throw new ProductOpError(`cannot move step ${step.id} after itself`);
          journey.steps = journey.steps.filter((s) => s !== step);
          journey.steps.splice(anchor === null ? 0 : journey.steps.indexOf(anchor) + 1, 0, step);
          results.push({ op: op.op, id: step.id, message: `moved step ${journey.id}/${step.id} to position ${journey.steps.indexOf(step) + 1}` });
          changes.push({ action: "move", target: "step", id: `${journey.id}/${step.id}`, name: `${journey.name}: ${step.action}` });
          return;
        }
        case "add_evidence": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const step = resolveStep(journey, op.step);
          step.evidence = [...(step.evidence ?? []), op.evidence];
          results.push({ op: op.op, id: step.id, message: `added evidence to ${journey.id}/${step.id} (${step.evidence.length} now)` });
          changes.push({ action: "update", target: "step", id: `${journey.id}/${step.id}`, name: `${journey.name}: ${step.action}`, fields: ["evidence"] });
          return;
        }
        case "add_branch": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const b = op.branch;
          const branch = {
            from: resolveStep(journey, b.from).id,
            when: b.when,
            ...(b.to !== undefined ? { to: resolveStep(journey, b.to).id } : {}),
            ...(b.journey !== undefined ? { journey: resolveNamed(product.journeys, b.journey, "journey").id } : {}),
            ...(b.rejoin !== undefined ? { rejoin: resolveStep(journey, b.rejoin).id } : {}),
          };
          journey.branches = [...(journey.branches ?? []).filter((x) => !(x.from === branch.from && x.when === branch.when)), branch];
          results.push({ op: op.op, id: journey.id, message: `added branch from ${journey.id}/${branch.from} when "${branch.when}"` });
          changes.push({ action: "update", target: "journey", id: journey.id, name: journey.name, fields: ["branches"] });
          return;
        }
        case "remove_branch": {
          const journey = resolveNamed(product.journeys, op.journey, "journey");
          const from = resolveStep(journey, op.from).id;
          const before = journey.branches?.length ?? 0;
          journey.branches = (journey.branches ?? []).filter((b) => !(b.from === from && norm(b.when) === norm(op.when)));
          if (journey.branches.length === before) throw new ProductOpError(`journey ${journey.id} has no branch from ${from} when "${op.when}"`);
          if (journey.branches.length === 0) delete journey.branches;
          results.push({ op: op.op, id: journey.id, message: `removed branch from ${journey.id}/${from} when "${op.when}"` });
          changes.push({ action: "update", target: "journey", id: journey.id, name: journey.name, fields: ["branches"] });
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProductOpError(`op ${index + 1} of ${ops.length} (${op.op}): ${message}; nothing was changed`, index);
    }
  });
  return { product, results, changes };
}

// ---------- undo ----------

export interface ProductRevertOutcome {
  product: ProductFile;
  changes: MapChange[];
  skipped: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Puts back what one turn changed: every persona / screen / journey that differs
 * between `before` and `after` returns to its `before` state, unless it changed
 * again since (`current` differs from `after`: the later edit wins, listed in
 * `skipped`). References left dangling (a step's screen, a branch's journey, a
 * journey's persona) are dropped.
 */
export function revertProductTurn(current: ProductFile | null, before: ProductFile | null, after: ProductFile | null): ProductRevertOutcome {
  const next = structuredClone(current ?? emptyProduct()) as ProductFile;
  const b = before ?? emptyProduct();
  const a = after ?? emptyProduct();
  const changes: MapChange[] = [];
  const skipped: string[] = [];

  const revert = <T extends { id: string; name: string }>(key: "personas" | "screens" | "journeys", target: string): void => {
    const beforeMap = new Map((b[key] as T[]).map((x) => [x.id, x]));
    const afterMap = new Map((a[key] as T[]).map((x) => [x.id, x]));
    let list = next[key] as unknown as T[];
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    for (const id of ids) {
      const was = beforeMap.get(id);
      const became = afterMap.get(id);
      if (same(was, became)) continue;
      const now = list.find((x) => x.id === id);
      if (!same(now, became)) {
        skipped.push(`${target} ${id}`);
        continue;
      }
      if (was === undefined) {
        list = list.filter((x) => x.id !== id);
        changes.push({ action: "remove", target, id, name: became!.name });
      } else if (now === undefined) {
        const at = (b[key] as T[]).findIndex((x) => x.id === id);
        list.splice(Math.min(at, list.length), 0, structuredClone(was));
        changes.push({ action: "add", target, id, name: was.name });
      } else {
        list = list.map((x) => (x.id === id ? structuredClone(was) : x));
        changes.push({ action: "update", target, id, name: was.name });
      }
    }
    (next as Record<string, unknown>)[key] = list;
  };
  revert<Persona>("personas", "persona");
  revert<Screen>("screens", "screen");
  revert<Journey>("journeys", "journey");
  return { product: dropDangling(next), changes, skipped };
}

/** Removes references to personas, screens, journeys and steps that no longer exist. */
export function dropDangling(product: ProductFile): ProductFile {
  const personas = new Set(product.personas.map((p) => p.id));
  const screens = new Set(product.screens.map((s) => s.id));
  const journeys = new Set(product.journeys.map((j) => j.id));
  for (const j of product.journeys) {
    if (j.persona !== undefined && !personas.has(j.persona)) delete j.persona;
    for (const s of j.steps) if (s.screen !== undefined && !screens.has(s.screen)) delete s.screen;
    if (j.branches !== undefined) {
      const steps = new Set(j.steps.map((s) => s.id));
      j.branches = j.branches.filter(
        (br) =>
          steps.has(br.from) &&
          (br.to === undefined || steps.has(br.to)) &&
          (br.journey === undefined || (journeys.has(br.journey) && br.journey !== j.id)) &&
          (br.rejoin === undefined || steps.has(br.rejoin)),
      );
      if (j.branches.length === 0) delete j.branches;
    }
  }
  return product;
}
