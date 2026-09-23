// CONTRACTS.md §1.7 — map edits by coding agents: the operations the ruah_*
// MCP tools apply (POST /api/arch/ops), who made a change (`by` on the
// `architecture` broadcast) and the per-change summary the viewer shows in
// the chat turn and uses for its "Show" toast.
import { z } from "zod";

/** Who caused an `architecture` broadcast with reason "saved". */
export const MapActorSchema = z.object({
  kind: z.string(), // known: agent | user | scan
  agentId: z.string().optional(), // kind "agent": the agent whose tool call made the change
  turnId: z.string().optional(), // the turn it happened in (agent ops; a user's per-turn undo)
  undo: z.boolean().optional(), // true: the user undid that turn's map changes
});
export type MapActor = z.infer<typeof MapActorSchema>;

/** One element-level change, in op order. */
export const MapChangeSchema = z.object({
  action: z.string(), // known: add | update | remove | connect | disconnect | move | add_workflow | update_workflow | remove_workflow
  target: z.string(), // known: element | link | workflow
  id: z.string(), // element id, workflow id, or "<from>-><to>" for links
  name: z.string(), // display text: element name, "A → B", workflow name
  level: z.string().nullable().optional(), // parent id of the element (links: of `from`); null = top level
  fields: z.array(z.string()).optional(), // update: the fields that changed
  from: z.string().optional(),
  to: z.string().optional(),
  label: z.string().optional(),
});
export type MapChange = z.infer<typeof MapChangeSchema>;

const Str = z.string();
const StrList = z.array(z.string());

/** Fields an element can be created with (id optional: slug of the name). */
export const ElementFieldsSchema = z.object({
  name: Str,
  type: Str,
  layer: Str.optional(),
  parent: Str.optional(),
  path: Str.optional(),
  tech: StrList.optional(),
  description: Str.optional(),
  notes: Str.optional(),
  files: StrList.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

/** Patch: null clears an optional field. `id` cannot change. */
export const ElementPatchSchema = z.object({
  name: Str.optional(),
  type: Str.optional(),
  layer: Str.nullable().optional(),
  parent: Str.nullable().optional(),
  path: Str.nullable().optional(),
  tech: StrList.nullable().optional(),
  description: Str.nullable().optional(),
  notes: Str.nullable().optional(),
  files: StrList.nullable().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type ElementPatch = z.infer<typeof ElementPatchSchema>;

export const ArchOpSchema = z.discriminatedUnion("op", [
  ElementFieldsSchema.extend({ op: z.literal("add_element"), id: Str.optional() }),
  z.object({ op: z.literal("update_element"), id: Str, patch: ElementPatchSchema }),
  z.object({ op: z.literal("remove_element"), id: Str, recursive: z.boolean().optional() }),
  z.object({ op: z.literal("connect"), from: Str, to: Str, label: Str.optional(), kind: Str.optional() }),
  z.object({ op: z.literal("disconnect"), from: Str, to: Str, label: Str.optional() }),
  z.object({ op: z.literal("add_workflow"), id: Str.optional(), name: Str, description: Str.optional(), steps: StrList }),
  z.object({
    op: z.literal("update_workflow"),
    id: Str,
    name: Str.optional(),
    description: Str.nullable().optional(),
    steps: StrList.optional(),
  }),
  z.object({ op: z.literal("remove_workflow"), id: Str }),
  z.object({ op: z.literal("set_layout_hint"), id: Str, x: z.number(), y: z.number() }),
]);
export type ArchOp = z.infer<typeof ArchOpSchema>;

/** Body of POST /api/arch/ops. At most 200 ops per call (one atomic save). */
export const ArchOpsRequestSchema = z.object({ ops: z.array(ArchOpSchema).min(1).max(200) });

export interface OpResult {
  op: ArchOp["op"];
  /** The element / workflow id the op resolved to (links: undefined). */
  id?: string;
  message: string;
}

/** 200 answer of POST /api/arch/ops. */
export interface ArchOpsResponse {
  ok: true;
  revision: number;
  results: OpResult[];
  changes: MapChange[];
  warnings: string[];
}
