// Adapted from t3code apps/server/src/provider/acp/AcpRuntimeModel.ts and the
// handleSessionUpdate / assistant-segment logic of AcpSessionRuntime.ts (MIT,
// eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/acp-normalize.ts — ACP `session/update` → archmap StreamEvent[]
// (CONTRACTS.md §2.1, §2.5). Effect-TS stripped; state lives in a plain
// TurnNormalizer per turn. Tool calls are upserted by toolCallId and every
// emitted tool_call / tool_result carries the full merged view.
import path from "node:path";
import type {
  PlanEntry as AcpPlanEntry,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ModeState, ModelState, PlanEntry, StreamEvent, ToolCallView } from "../contracts/ws.js";

export const OUTPUT_MAX_CHARS = 4096;
const TRUNCATION_SUFFIX = " …[truncated]";

type ToolStatus = ToolCallView["status"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// t3code sessionUpdateIsReplay
export function sessionUpdateIsReplay(params: SessionNotification): boolean {
  const meta = params._meta;
  return isRecord(meta) && meta.isReplay === true;
}

// t3code parseSessionModeState, reshaped to the WS ModeState.
export function parseModeState(modes: SessionModeState | null | undefined): ModeState | undefined {
  if (!modes) return undefined;
  const currentModeId = modes.currentModeId.trim();
  if (!currentModeId) return undefined;
  const available: ModeState["available"] = [];
  for (const mode of modes.availableModes) {
    const id = mode.id.trim();
    const name = mode.name.trim();
    if (!id || !name) continue;
    const description = mode.description?.trim() || undefined;
    available.push(description !== undefined ? { id, name, description } : { id, name });
  }
  if (available.length === 0) return undefined;
  return { currentModeId, available };
}

// t3code updateModeState: only accept mode ids the agent advertised.
export function applyModeChange(modes: ModeState | undefined, nextModeId: string): ModeState | undefined {
  const normalized = nextModeId.trim();
  if (modes === undefined || !normalized) return modes;
  return modes.available.some((mode) => mode.id === normalized) ? { ...modes, currentModeId: normalized } : modes;
}

// ---------- models / config-option modes (archmap's own; not from t3code) ----------

/**
 * How the agent lets the client switch a model or mode: a session config
 * option (session/set_config_option) or the dedicated method
 * (session/set_mode; the unstable session/set_model).
 */
export type Selector = { kind: "config"; configId: string } | { kind: "legacy" };

function modelEntry(id: unknown, name: unknown, description: unknown): ModelState["available"][number] | undefined {
  if (typeof id !== "string" || !id.trim()) return undefined;
  const trimmedId = id.trim();
  const label = typeof name === "string" && name.trim() ? name.trim() : trimmedId;
  const text = typeof description === "string" && description.trim() ? description.trim() : undefined;
  return text !== undefined ? { id: trimmedId, name: label, description: text } : { id: trimmedId, name: label };
}

/**
 * A select config option by semantic category ("model", "mode"), else by id
 * (same word). Grouped option lists are flattened.
 */
function parseSelectConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption> | null | undefined,
  category: string,
): { configId: string; currentId: string; available: ModelState["available"] } | undefined {
  if (!configOptions) return undefined;
  const selects = configOptions.filter((option) => option.type === "select");
  const option = selects.find((o) => o.category === category) ?? selects.find((o) => o.id === category);
  if (option === undefined || option.type !== "select") return undefined;
  const available: ModelState["available"] = [];
  for (const item of option.options) {
    const values = "group" in item ? item.options : [item];
    for (const value of values) {
      const entry = modelEntry(value.value, value.name, value.description);
      if (entry !== undefined && !available.some((a) => a.id === entry.id)) available.push(entry);
    }
  }
  const currentId = option.currentValue.trim();
  if (!currentId || available.length === 0) return undefined;
  return { configId: option.id, currentId, available };
}

/** The model selector among session config options (category "model"). */
export function parseModelConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption> | null | undefined,
): { configId: string; state: ModelState } | undefined {
  const parsed = parseSelectConfigOption(configOptions, "model");
  return parsed && { configId: parsed.configId, state: { currentModelId: parsed.currentId, available: parsed.available } };
}

/** Modes offered only as a config option (category "mode"), e.g. OpenCode. */
export function parseModeConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption> | null | undefined,
): { configId: string; state: ModeState } | undefined {
  const parsed = parseSelectConfigOption(configOptions, "mode");
  return parsed && { configId: parsed.configId, state: { currentModeId: parsed.currentId, available: parsed.available } };
}

/**
 * The pre-config-options (unstable) `models` field of session/new:
 * `{ currentModelId, availableModels: [{ modelId, name, description? }] }`.
 * The 1.x schema no longer types it, so it is read defensively.
 */
export function parseLegacyModels(raw: unknown): ModelState | undefined {
  if (!isRecord(raw) || typeof raw.currentModelId !== "string" || !Array.isArray(raw.availableModels)) return undefined;
  const available: ModelState["available"] = [];
  for (const model of raw.availableModels) {
    if (!isRecord(model)) continue;
    const entry = modelEntry(model.modelId, model.name, model.description);
    if (entry !== undefined) available.push(entry);
  }
  const currentModelId = raw.currentModelId.trim();
  if (!currentModelId || available.length === 0) return undefined;
  return { currentModelId, available };
}

export function sameSelectState(a: ModelState | ModeState | undefined, b: ModelState | ModeState | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeToolCallStatus(raw: unknown): ToolStatus | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) parts.push(entry.trim());
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

// t3code extractToolCallCommand
export function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const direct = normalizeCommandValue(rawInput.command);
    if (direct) return direct;
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) return `${executable} ${args}`;
    if (executable) return executable;
  }
  return extractCommandFromTitle(title);
}

// CONTRACTS §2.1: output is capped at 4096 chars with " …[truncated]". (t3code
// keeps the tail of live terminals; the contract keeps the head.)
export function capOutput(text: string): string {
  return text.length <= OUTPUT_MAX_CHARS ? text : `${text.slice(0, OUTPUT_MAX_CHARS)}${TRUNCATION_SUFFIX}`;
}

// t3code extractTextContentFromToolCallContent: trimmed text entries joined by "\n".
function extractOutputText(content: readonly ToolCallContent[]): string | undefined {
  const chunks: string[] = [];
  for (const entry of content) {
    if (entry.type !== "content" || entry.content.type !== "text") continue;
    const text = entry.content.text.trim();
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? capOutput(chunks.join("\n")) : undefined;
}

/** Repo-relative when inside root, else absolute (CONTRACTS §2.1 ToolCallView.locations). */
export function relativizePath(root: string, p: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(root, p);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return p;
  return rel.split(path.sep).join("/");
}

function mapLocations(root: string, locations: readonly ToolCallLocation[]): ToolCallView["locations"] {
  return locations.map((loc) => {
    const p = relativizePath(root, loc.path);
    return typeof loc.line === "number" ? { path: p, line: loc.line } : { path: p };
  });
}

/** Partial view parsed from one tool_call / tool_call_update (t3code makeToolCallState). */
interface ToolCallPatch {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolStatus;
  locations?: ToolCallView["locations"];
  command?: string;
  output?: string;
  rawCommand?: string;
}

function parseToolCallPatch(root: string, update: ToolCallUpdate): ToolCallPatch | undefined {
  const toolCallId = update.toolCallId.trim();
  if (!toolCallId) return undefined;
  const patch: ToolCallPatch = { toolCallId };
  const title = update.title?.trim() || undefined;
  if (title) patch.title = title;
  const kind = typeof update.kind === "string" && update.kind.trim() ? update.kind.trim() : undefined;
  if (kind) patch.kind = kind;
  const status = normalizeToolCallStatus(update.status);
  if (status) patch.status = status;
  if (update.locations) patch.locations = mapLocations(root, update.locations);
  const command = extractToolCallCommand(update.rawInput, title);
  if (command) patch.rawCommand = command;
  if (update.content) {
    const output = extractOutputText(update.content);
    if (output !== undefined) patch.output = output;
  }
  return patch;
}

// t3code mergeToolCallState: later fields win, absent fields keep the previous value.
function mergeToolCall(previous: ToolCallView | undefined, patch: ToolCallPatch): ToolCallView {
  const kind = patch.kind ?? previous?.kind ?? "other";
  const view: ToolCallView = {
    toolCallId: patch.toolCallId,
    title: patch.title ?? previous?.title ?? "Tool",
    kind,
    status: patch.status ?? previous?.status ?? "pending",
    locations: patch.locations ?? previous?.locations ?? [],
  };
  const command = patch.rawCommand ?? previous?.command;
  if (command !== undefined && kind === "execute") view.command = command;
  const output = patch.output ?? previous?.output;
  if (output !== undefined) view.output = output;
  return view;
}

function isTerminal(status: ToolStatus): boolean {
  return status === "completed" || status === "failed";
}

function sameView(a: ToolCallView, b: ToolCallView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mapPlanEntry(entry: AcpPlanEntry, index: number): PlanEntry {
  const content = entry.content.trim();
  return {
    content: content.length > 0 ? content : `Step ${index + 1}`,
    priority: entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium",
    status: entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending",
  };
}

/**
 * Per-turn normalization state: tool-call map (upsert by toolCallId, deleted once
 * completed/failed), last emitted view per tool (skips no-op re-emits, a trimmed
 * form of t3code decideToolCallUpdateEmission), emitted diff signatures, and the
 * assistant text segment flag (t3code ensure/closeActiveAssistantSegment).
 */
export class TurnNormalizer {
  private readonly toolCalls = new Map<string, ToolCallView>();
  private readonly lastEmitted = new Map<string, ToolCallView>();
  private readonly emittedDiffs = new Set<string>();
  private segmentOpen = false;

  constructor(private readonly root: string) {}

  /** Merged view for a permission request's toolCall (t3code parsePermissionRequest, fallback status pending). Does not mutate state. */
  permissionView(update: ToolCallUpdate): ToolCallView {
    const patch = parseToolCallPatch(this.root, update) ?? { toolCallId: update.toolCallId };
    const previous = this.toolCalls.get(patch.toolCallId);
    return mergeToolCall(previous, { ...patch, status: patch.status ?? previous?.status ?? "pending" });
  }

  normalize(update: SessionUpdate): StreamEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text" || update.content.text.length === 0) return [];
        // Whitespace-only chunks are dropped only when no text segment is open, so
        // paragraph breaks inside a segment survive (t3code handleSessionUpdate).
        if (update.content.text.trim().length === 0 && !this.segmentOpen) return [];
        this.segmentOpen = true;
        return [{ kind: "text", text: update.content.text }];
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text" || update.content.text.trim().length === 0) return [];
        return [{ kind: "thought", text: update.content.text }];
      }
      case "plan": {
        return [{ kind: "plan", entries: update.entries.map(mapPlanEntry) }];
      }
      case "tool_call":
      case "tool_call_update":
        return this.toolCallEvents(update, update.sessionUpdate === "tool_call");
      default:
        // user_message_chunk, available_commands_update, config_option_update,
        // usage_update, session_info_update, current_mode_update (handled by the
        // bridge) and unknown kinds: nothing to stream (CONTRACTS §2.5 "ignored").
        return [];
    }
  }

  private toolCallEvents(update: ToolCallUpdate, isNew: boolean): StreamEvent[] {
    const patch = parseToolCallPatch(this.root, update);
    if (patch === undefined) return [];
    if (isNew && patch.status === undefined) patch.status = "pending";
    // A tool call closes the current assistant text segment (CONTRACTS §2.2 rule 7).
    this.segmentOpen = false;
    const merged = mergeToolCall(this.toolCalls.get(patch.toolCallId), patch);
    const events: StreamEvent[] = [];

    const previous = this.lastEmitted.get(merged.toolCallId);
    if (isTerminal(merged.status)) {
      this.toolCalls.delete(merged.toolCallId);
      this.lastEmitted.delete(merged.toolCallId);
      events.push({ kind: "tool_result", toolCall: merged });
    } else {
      this.toolCalls.set(merged.toolCallId, merged);
      if (previous === undefined || !sameView(previous, merged)) {
        this.lastEmitted.set(merged.toolCallId, merged);
        events.push({ kind: "tool_call", toolCall: merged });
      }
    }

    // Rule 9: diffs are emitted in addition to the tool event that carried them,
    // once per distinct (toolCallId, path, oldText, newText).
    for (const entry of update.content ?? []) {
      if (entry.type !== "diff") continue;
      const diffPath = relativizePath(this.root, entry.path);
      const oldText = entry.oldText ?? null;
      const signature = JSON.stringify([merged.toolCallId, diffPath, oldText, entry.newText]);
      if (this.emittedDiffs.has(signature)) continue;
      this.emittedDiffs.add(signature);
      events.push({ kind: "diff", toolCallId: merged.toolCallId, path: diffPath, oldText, newText: entry.newText });
    }
    return events;
  }
}
