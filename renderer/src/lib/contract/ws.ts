import { z } from "zod";
import { ArchitectureSchema } from "./architecture.js";

// CONTRACTS.md §2.1 — field for field. Open unions use z.string() with the
// known literals documented; receivers ignore unknown type/kind values.
export const AgentStateSchema = z.enum(["starting", "idle", "busy", "error", "stopped"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const StopReasonSchema = z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "error"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const ModeStateSchema = z.object({
  currentModeId: z.string(),
  available: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })),
});
export type ModeState = z.infer<typeof ModeStateSchema>;

export const ToolCallViewSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  locations: z.array(z.object({ path: z.string(), line: z.number().optional() })),
  command: z.string().optional(),
  output: z.string().optional(),
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;

export const PlanEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const PermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

export const StreamEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("thought"), text: z.string() }),
  z.object({ kind: z.literal("tool_call"), toolCall: ToolCallViewSchema }),
  z.object({ kind: z.literal("tool_result"), toolCall: ToolCallViewSchema }),
  z.object({
    kind: z.literal("diff"),
    toolCallId: z.string(),
    path: z.string(),
    oldText: z.string().nullable(),
    newText: z.string(),
  }),
  z.object({ kind: z.literal("plan"), entries: z.array(PlanEntrySchema) }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ErrorCodeSchema = z.enum([
  "bad_message",
  "unknown_node",
  "busy",
  "no_turn",
  "agent_spawn_failed",
  "agent_exited",
  "agent_protocol",
  "agent_request_failed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ---------- viewer -> daemon ----------
export const ClientMessageSchema = z.union([
  z.object({ type: z.literal("hello"), protocol: z.literal(1), client: z.string() }),
  z.object({ type: z.literal("architecture.get") }),
  z.object({ type: z.literal("focus.set"), nodeId: z.string().nullable() }),
  z.object({ type: z.literal("prompt"), turnId: z.string(), nodeId: z.string(), text: z.string() }),
  z.union([
    z.object({ type: z.literal("permission.response"), requestId: z.string(), optionId: z.string() }),
    z.object({ type: z.literal("permission.response"), requestId: z.string(), cancelled: z.literal(true) }),
  ]),
  z.object({ type: z.literal("cancel"), turnId: z.string() }),
  z.object({ type: z.literal("session.reset") }),
  z.object({ type: z.literal("mode.set"), modeId: z.string() }),
  z.object({ type: z.literal("architecture.save"), architecture: ArchitectureSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- daemon -> viewer ----------
export const ServerMessageSchema = z.union([
  z.object({
    type: z.literal("architecture"),
    reason: z.enum(["initial", "changed", "saved"]),
    revision: z.number(),
    root: z.string(),
    path: z.string(),
    architecture: ArchitectureSchema,
  }),
  z.object({ type: z.literal("architecture.error"), path: z.string(), message: z.string() }),
  z.object({
    type: z.literal("agent.status"),
    state: AgentStateSchema,
    agent: z.object({ name: z.string(), version: z.string() }).optional(),
    sessionId: z.string().optional(),
    modes: ModeStateSchema.optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn.started"),
    turnId: z.string(),
    nodeId: z.string(),
    contextPack: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("stream"), turnId: z.string(), event: StreamEventSchema }),
  z.object({
    type: z.literal("permission.request"),
    turnId: z.string(),
    requestId: z.string(),
    toolCall: ToolCallViewSchema,
    options: z.array(PermissionOptionSchema),
  }),
  z.object({
    type: z.literal("permission.resolved"),
    turnId: z.string(),
    requestId: z.string(),
    optionId: z.string().optional(),
    cancelled: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("turn.finished"),
    turnId: z.string(),
    stopReason: StopReasonSchema,
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    turnId: z.string().optional(),
    requestId: z.string().optional(),
    fatal: z.boolean().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
