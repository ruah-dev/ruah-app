// Prompts typed while the agent works (like Claude Code's queue): stacked per chat, shown above
// the composer, editable and removable, and sent one at a time when the running turn ends.
// Memory only — a queued prompt holds attachment ids that were already uploaded.
import { useSyncExternalStore } from "react";
import type { AttachmentMeta, StopReason } from "@/lib/contracts";

export interface QueuedPrompt {
  id: string;
  /** Element the prompt was scoped to when it was typed. */
  nodeId: string | null;
  text: string;
  attachments: AttachmentMeta[];
}

const EMPTY: readonly QueuedPrompt[] = Object.freeze([]);
const queues = new Map<string, readonly QueuedPrompt[]>();
/** Chats whose queue waits for the user (they stopped the agent, or a turn failed). */
const paused = new Set<string>();
const listeners = new Set<() => void>();
let seq = 0;

/** One queue per chat; a chat that has no id yet (a new chat) queues under its project. */
export function queueKey(projectId: string | null | undefined, chatId: string | null | undefined): string {
  return `${projectId ?? "none"}:${chatId ?? "new"}`;
}

function emit() {
  for (const fn of listeners) fn();
}

function put(key: string, next: readonly QueuedPrompt[]) {
  if (next.length === 0) {
    queues.delete(key);
    paused.delete(key);
  } else queues.set(key, next);
  emit();
}

export function queuedPrompts(key: string): readonly QueuedPrompt[] {
  return queues.get(key) ?? EMPTY;
}

export function enqueuePrompt(key: string, prompt: Omit<QueuedPrompt, "id">): string {
  const id = `q${++seq}`;
  put(key, [...queuedPrompts(key), { ...prompt, id }]);
  return id;
}

export function editQueuedPrompt(key: string, id: string, text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return removeQueuedPrompt(key, id);
  put(key, queuedPrompts(key).map((p) => (p.id === id ? { ...p, text: trimmed } : p)));
}

export function removeQueuedPrompt(key: string, id: string) {
  put(key, queuedPrompts(key).filter((p) => p.id !== id));
}

export function clearQueue(key: string) {
  put(key, EMPTY);
}

/**
 * A new chat gets its id after its first prompt: prompts queued before that move to it, ahead
 * of any queued under the id already.
 */
export function adoptNewChatQueue(projectId: string | null | undefined, chatId: string) {
  const from = queueKey(projectId, null);
  const moved = queues.get(from);
  if (moved === undefined) return;
  const to = queueKey(projectId, chatId);
  const wasPaused = paused.has(from);
  queues.delete(from);
  paused.delete(from);
  if (wasPaused) paused.add(to);
  put(to, [...moved, ...queuedPrompts(to)]);
}

/** Takes the next prompt off the queue (undefined when it is empty). */
export function takeNextPrompt(key: string): QueuedPrompt | undefined {
  const [head, ...rest] = queuedPrompts(key);
  if (head !== undefined) put(key, rest);
  return head;
}

export function isQueuePaused(key: string): boolean {
  return paused.has(key);
}

export function setQueuePaused(key: string, value: boolean) {
  if (value === paused.has(key)) return;
  if (value) paused.add(key);
  else paused.delete(key);
  emit();
}

/**
 * Whether a turn that ended this way lets the queue go on by itself. Only a clean finish does:
 * after a stop the user decides, and after an error the next prompt would likely fail the same way.
 */
export function continuesQueue(stopReason: StopReason | undefined): boolean {
  return stopReason === undefined || stopReason === "end_turn";
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePromptQueue(key: string): { items: readonly QueuedPrompt[]; paused: boolean } {
  const items = useSyncExternalStore(subscribe, () => queuedPrompts(key), () => EMPTY);
  const isPaused = useSyncExternalStore(subscribe, () => paused.has(key), () => false);
  return { items, paused: isPaused };
}
