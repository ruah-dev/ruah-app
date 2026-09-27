// src/product/screens-merge.ts — scanned screens into product.json (docs/JOURNEYS.md §3.2,
// CONTRACTS.md §23.4).
//
// Rules:
// 1. `source: "scan"` screens are replaced by this scan's. A scanned screen whose node and
//    route match a previously scanned one keeps that screen's id (journeys keep pointing at
//    it even when the id derivation would now pick another) and its `shot`.
// 2. Screens with any other source (user, agent, absent) are never touched. A scanned screen
//    whose node and route a kept screen already describes is dropped; one whose id a kept
//    screen holds gets a -2, -3… suffix.
// 3. A previously scanned screen the scan no longer finds is dropped, unless a journey step
//    references it: then it stays as it was, with a warning.
// 4. Personas and journeys are copied as they are. No existing file and no screens: no file.
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyProduct, type ProductFile, type Screen, validateProduct } from "../contracts/product.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";

export interface ScreensMergeResult {
  /** null: nothing to write (no file yet and the scan found no screens). */
  product: ProductFile | null;
  warnings: string[];
}

const ID_MAX = 64;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const key = (s: Screen): string => `${s.node ?? ""}\u0000${s.route ?? ""}`;

export function mergeScannedScreens(existing: ProductFile | null, scanned: Screen[]): ScreensMergeResult {
  if (existing === null && scanned.length === 0) return { product: null, warnings: [] };
  const base = existing ?? emptyProduct();
  const warnings: string[] = [];

  const kept = base.screens.filter((s) => s.source !== "scan");
  const oldScan = base.screens.filter((s) => s.source === "scan");
  const keptKeys = new Set(kept.filter((s) => s.route !== undefined).map(key));
  const oldByKey = new Map<string, Screen>();
  for (const s of oldScan) if (!oldByKey.has(key(s))) oldByKey.set(key(s), s);

  const fresh = scanned.filter((s) => s.route === undefined || !keptKeys.has(key(s)));
  const referenced = new Set<string>();
  for (const j of base.journeys) for (const step of j.steps) if (step.screen !== undefined) referenced.add(step.screen);

  // Ids already spoken for: hand-made screens, then matched old scan ids.
  const used = new Set(kept.map((s) => s.id));
  const matched = new Map<Screen, Screen>(); // fresh → old
  const matchedOld = new Set<Screen>();
  for (const s of fresh) {
    const old = oldByKey.get(key(s));
    if (old === undefined || matchedOld.has(old) || used.has(old.id)) continue;
    matched.set(s, old);
    matchedOld.add(old);
    used.add(old.id);
  }
  // Vanished but referenced by a journey: kept as it was.
  const vanished = oldScan.filter((s) => !matchedOld.has(s) && referenced.has(s.id) && !used.has(s.id));
  for (const s of vanished) {
    used.add(s.id);
    warnings.push(`screen ${s.route ?? s.id} no longer found in ${s.node ?? "the code"}`);
  }

  const take = (id: string): string => {
    let out = id;
    for (let n = 2; used.has(out); n++) out = `${id.slice(0, ID_MAX - 1 - String(n).length)}-${n}`;
    used.add(out);
    return out;
  };
  const next: Screen[] = fresh.map((s) => {
    const old = matched.get(s);
    const out: Screen = { ...s, id: old !== undefined ? old.id : take(s.id), source: "scan" };
    if (old?.shot !== undefined && out.shot === undefined) out.shot = old.shot;
    return out;
  });

  const scannedSorted = [...next, ...vanished].sort(
    (a, b) => cmp(a.route ?? "", b.route ?? "") || cmp(a.path ?? "", b.path ?? "") || cmp(a.id, b.id),
  );
  const product: ProductFile = { ...base, screens: [...kept, ...scannedSorted] };
  return { product, warnings };
}

export interface ScannedProductPlan {
  /** Product to write; null when there is nothing to write (see `reason`). */
  product: ProductFile | null;
  /** The serialized file; equal to what is on disk when `unchanged`. */
  text: string | null;
  unchanged: boolean;
  warnings: string[];
  /** Why nothing is written: "no screens" | "invalid existing file" | "merge failed validation". */
  reason?: string;
}

/**
 * Reads `file` (product.json), merges the scanned screens into it and validates the result.
 * An existing file that does not parse or validate is never overwritten (the user may be
 * mid-edit): the plan carries a warning and no product.
 */
export function planScannedProduct(file: string, scanned: Screen[]): ScannedProductPlan {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { product: null, text: null, unchanged: false, warnings: [`cannot read ${file}: ${(err as Error).message}; screens not updated`], reason: "invalid existing file" };
    }
  }
  let existing: ProductFile | null = null;
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { product: null, text: null, unchanged: false, warnings: [`${file} is not valid JSON (${(err as Error).message}); screens not updated`], reason: "invalid existing file" };
    }
    const checked = validateProduct(parsed);
    if (!checked.ok) {
      return { product: null, text: null, unchanged: false, warnings: [`${file} is invalid (${checked.errors[0] ?? ""}); screens not updated`], reason: "invalid existing file" };
    }
    existing = checked.value;
  }
  const merged = mergeScannedScreens(existing, scanned);
  if (merged.product === null) return { product: null, text: null, unchanged: false, warnings: merged.warnings, reason: "no screens" };
  const checked = validateProduct(merged.product);
  if (!checked.ok) {
    return {
      product: null,
      text: null,
      unchanged: false,
      warnings: [...merged.warnings, `scanned screens failed validation (${checked.errors[0] ?? ""}); ${file} not updated`],
      reason: "merge failed validation",
    };
  }
  const text = `${JSON.stringify(checked.value, null, 2)}\n`;
  return { product: checked.value, text, unchanged: text === raw, warnings: merged.warnings };
}

export interface ScannedProductWrite {
  written: boolean;
  file: string;
  screens: number; // screens in the file after the merge (0 when nothing was written)
  warnings: string[];
}

/** planScannedProduct + an atomic write when the content changed. Never throws on a bad existing file. */
export function writeScannedProduct(file: string, scanned: Screen[]): ScannedProductWrite {
  const abs = path.resolve(file);
  const plan = planScannedProduct(abs, scanned);
  if (plan.product === null || plan.text === null) return { written: false, file: abs, screens: 0, warnings: plan.warnings };
  if (!plan.unchanged) atomicWriteFileSync(abs, plan.text);
  return { written: !plan.unchanged, file: abs, screens: plan.product.screens.length, warnings: plan.warnings };
}

/**
 * A system's screens (CONTRACTS §23, docs/MULTI-REPO.md): each repo's screens namespaced
 * like the system map — ids and nodes `<repoId>:<id>`, paths `<repoId>/<rel>`.
 */
export function namespaceScreens(repoId: string, screens: Screen[]): Screen[] {
  return screens.map((s) => ({
    ...s,
    id: `${repoId}:${s.id}`,
    ...(s.path !== undefined ? { path: `${repoId}/${s.path}` } : {}),
    ...(s.node !== undefined ? { node: `${repoId}:${s.node}` } : {}),
  }));
}
