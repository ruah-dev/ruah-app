// A cheap per-project summary of product.json for Home cards (CONTRACTS §23.9): how many journeys,
// open questions, and gaps that need a person (core journeys without a why / signal / evidence,
// links into the map that no longer resolve). Cached by the files' mtimes; never throws.
import * as fs from "node:fs";
import * as path from "node:path";
import { PRODUCT_FILE, ProductFileSchema, type ProductFile } from "../contracts/product.js";

export interface ProductSummary {
  journeys: number;
  questions: number;
  /** Needs a person: open questions, missing whys / signals / evidence on core journeys, broken links. */
  gaps: number;
  broken: number;
}

const cache = new Map<string, { key: string; value: ProductSummary | null }>();

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** null: no (valid) product.json. */
export function productSummary(root: string): ProductSummary | null {
  const productPath = path.join(root, PRODUCT_FILE);
  const archPath = path.join(root, "architecture.json");
  const key = `${mtime(productPath)}:${mtime(archPath)}`;
  const hit = cache.get(root);
  if (hit !== undefined && hit.key === key) return hit.value;
  const value = compute(productPath, archPath);
  cache.set(root, { key, value });
  return value;
}

function compute(productPath: string, archPath: string): ProductSummary | null {
  let product: ProductFile;
  try {
    const parsed = ProductFileSchema.safeParse(JSON.parse(fs.readFileSync(productPath, "utf8")));
    if (!parsed.success) return null;
    product = parsed.data;
  } catch {
    return null;
  }
  let ids: Set<string> | null = null;
  try {
    const arch = JSON.parse(fs.readFileSync(archPath, "utf8")) as { nodes?: { id?: unknown }[]; workflows?: { id?: unknown }[] };
    ids = new Set([...(arch.nodes ?? []), ...(arch.workflows ?? [])].map((n) => String(n.id)));
  } catch {
    ids = null;
  }
  let questions = 0;
  let gaps = 0;
  let broken = 0;
  for (const j of product.journeys) {
    const core = j.priority === "core";
    for (const s of j.steps) {
      if (s.question !== undefined && s.question.trim() !== "") questions += 1;
      if (core && (s.why === undefined || s.why.trim() === "")) gaps += 1;
      if (ids !== null) {
        for (const ref of s.touches ?? []) {
          // Expanded ids (<element>/<path>, <file>#<symbol>) count while their element exists.
          const owner = ids.has(ref) || [...ids].some((id) => ref.startsWith(`${id}/`) || ref.startsWith(`${id}#`));
          if (!owner) broken += 1;
        }
      }
    }
    if (core && (j.why === undefined || j.why.trim() === "")) gaps += 1;
    if (core && j.signal === undefined && !j.steps.some((s) => s.signal !== undefined)) gaps += 1;
    if (core && !j.steps.some((s) => (s.evidence ?? []).length > 0)) gaps += 1;
  }
  return { journeys: product.journeys.length, questions, gaps: gaps + questions + broken, broken };
}
