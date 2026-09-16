import { z } from "zod";

// CONTRACTS.md §1.1 — field for field. Open unions use z.string(); the known
// literals are documented in comments (§1 preamble: receivers ignore unknown
// type/kind values instead of rejecting).
export const NodeTypeSchema = z.string(); // known: service | module | datastore | external | step | frontend | gateway | queue | file
export const ArchNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  name: z.string(),
  description: z.string().optional(), // 1–2 sentences, <= 400 chars
  notes: z.string().optional(), // user-authored markdown, any length
  tech: z.array(z.string()).optional(),
  path: z.string().optional(),
  files: z.array(z.string()).optional(), // <= 20 entries, most relevant first
  layer: z.string().optional(),
  parent: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const ArchEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(), // <= 40 chars
  kind: z.string().optional(), // known: sync | async | event | data
});
export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()), // >= 2 entries (§1.2 rule 7)
});
export const ArchitectureSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  generatedBy: z.string().optional(),
  generatedAt: z.string().optional(), // ISO 8601 UTC
  layers: z.array(z.string()).optional(),
  nodes: z.array(ArchNodeSchema),
  edges: z.array(ArchEdgeSchema),
  workflows: z.array(WorkflowSchema),
});
export type NodeType = string;
export type ArchNode = z.infer<typeof ArchNodeSchema>;
export type ArchEdge = z.infer<typeof ArchEdgeSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Architecture = z.infer<typeof ArchitectureSchema>;
