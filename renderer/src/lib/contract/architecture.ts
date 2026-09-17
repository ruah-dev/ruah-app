import { z } from "zod";

// CONTRACTS.md §1.1 — field for field. Open unions use z.string(); receivers
// ignore unknown type/kind values instead of rejecting.
export const ArchNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string().optional(),
  notes: z.string().optional(),
  tech: z.array(z.string()).optional(),
  path: z.string().optional(),
  files: z.array(z.string()).optional(),
  layer: z.string().optional(),
  parent: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const ArchEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  kind: z.string().optional(),
});
export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()),
});
export const ArchitectureSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  generatedBy: z.string().optional(),
  generatedAt: z.string().optional(),
  layers: z.array(z.string()).optional(),
  nodes: z.array(ArchNodeSchema),
  edges: z.array(ArchEdgeSchema),
  workflows: z.array(WorkflowSchema),
});
export type ArchNode = z.infer<typeof ArchNodeSchema>;
export type ArchEdge = z.infer<typeof ArchEdgeSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Architecture = z.infer<typeof ArchitectureSchema>;
