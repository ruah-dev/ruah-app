// CONTRACTS.md §23.5 — product edits by coding agents: the operations the
// ruah_product_apply tool applies (POST /api/product/ops). Personas, screens and
// journeys are referenced by id or by their exact (case-insensitive) name when
// unique; steps by id or by their 1-based position ("2").
import { z } from "zod";
import { EvidenceSchema, type ProductFile } from "./product.js";
import type { MapChange } from "./map.js";

const Str = z.string();
const StrList = z.array(z.string());

export const StepInputSchema = z.object({
  id: Str.optional(),
  screen: Str.optional(),
  action: Str,
  sees: Str.optional(),
  why: Str.optional(),
  signal: Str.optional(),
  touches: StrList.optional(),
  evidence: z.array(EvidenceSchema).optional(),
  question: Str.optional(),
});

export const StepPatchSchema = z.object({
  screen: Str.nullable().optional(),
  action: Str.optional(),
  sees: Str.nullable().optional(),
  why: Str.nullable().optional(),
  signal: Str.nullable().optional(),
  touches: StrList.nullable().optional(),
  question: Str.nullable().optional(),
});

export const BranchInputSchema = z.object({
  from: Str,
  when: Str,
  to: Str.optional(),
  journey: Str.optional(),
  rejoin: Str.optional(),
});

export const ProductOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_persona"), id: Str.optional(), name: Str, description: Str.optional(), goals: StrList.optional() }),
  z.object({
    op: z.literal("update_persona"),
    id: Str,
    patch: z.object({ name: Str.optional(), description: Str.nullable().optional(), goals: StrList.nullable().optional() }),
  }),
  z.object({ op: z.literal("remove_persona"), id: Str }),
  z.object({ op: z.literal("add_screen"), id: Str.optional(), name: Str, route: Str.optional(), path: Str.optional(), node: Str.optional() }),
  z.object({
    op: z.literal("update_screen"),
    id: Str,
    patch: z.object({ name: Str.optional(), route: Str.nullable().optional(), path: Str.nullable().optional(), node: Str.nullable().optional() }),
  }),
  z.object({ op: z.literal("remove_screen"), id: Str }),
  z.object({
    op: z.literal("add_journey"),
    id: Str.optional(),
    name: Str,
    persona: Str.optional(),
    goal: Str,
    why: Str.optional(),
    priority: Str.optional(),
    signal: Str.optional(),
    steps: z.array(StepInputSchema).min(1),
  }),
  z.object({
    op: z.literal("update_journey"),
    id: Str,
    patch: z.object({
      name: Str.optional(),
      persona: Str.nullable().optional(),
      goal: Str.optional(),
      why: Str.nullable().optional(),
      priority: Str.nullable().optional(),
      signal: Str.nullable().optional(),
    }),
  }),
  z.object({ op: z.literal("remove_journey"), id: Str }),
  // after: step to insert behind; null = first; absent = last
  z.object({ op: z.literal("add_step"), journey: Str, after: Str.nullable().optional(), step: StepInputSchema }),
  z.object({ op: z.literal("update_step"), journey: Str, id: Str, patch: StepPatchSchema }),
  z.object({ op: z.literal("remove_step"), journey: Str, id: Str }),
  z.object({ op: z.literal("move_step"), journey: Str, id: Str, after: Str.nullable() }),
  z.object({ op: z.literal("add_evidence"), journey: Str, step: Str, evidence: EvidenceSchema }),
  z.object({ op: z.literal("add_branch"), journey: Str, branch: BranchInputSchema }),
  z.object({ op: z.literal("remove_branch"), journey: Str, from: Str, when: Str }),
]);
export type ProductOp = z.infer<typeof ProductOpSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;

export const ProductOpsRequestSchema = z.object({ ops: z.array(ProductOpSchema).min(1).max(200) });

export interface ProductOpResult {
  op: string;
  id?: string;
  message: string;
}

export interface ProductOpsResponse {
  ok: true;
  revision: number;
  results: ProductOpResult[];
  changes: MapChange[];
  warnings: string[];
}

export interface ProductRead {
  revision: number;
  product: ProductFile | null;
  warnings: string[];
}
