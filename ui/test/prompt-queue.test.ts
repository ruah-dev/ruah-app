// The composer used to be disabled while the agent worked. Prompts typed meanwhile are now
// queued per chat (lib/prompt-queue.ts) and sent one at a time when a turn finishes cleanly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptNewChatQueue,
  clearQueue,
  continuesQueue,
  editQueuedPrompt,
  enqueuePrompt,
  isQueuePaused,
  queueKey,
  queuedPrompts,
  removeQueuedPrompt,
  setQueuePaused,
  takeNextPrompt,
} from "../src/lib/prompt-queue";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const prompt = (text: string) => ({ nodeId: null, text, attachments: [] });

describe("prompt queue", () => {
  const key = queueKey("p1", "c1");
  beforeEach(() => {
    clearQueue(key);
    clearQueue(queueKey("p1", null));
    clearQueue(queueKey("p1", "c2"));
  });

  it("keeps one queue per chat and hands prompts out in order", () => {
    enqueuePrompt(key, prompt("first"));
    enqueuePrompt(key, prompt("second"));
    enqueuePrompt(queueKey("p1", "c2"), prompt("other chat"));
    expect(takeNextPrompt(key)?.text).toBe("first");
    expect(takeNextPrompt(key)?.text).toBe("second");
    expect(takeNextPrompt(key)).toBeUndefined();
    expect(queuedPrompts(queueKey("p1", "c2")).map((p) => p.text)).toEqual(["other chat"]);
  });

  it("edits in place, and an edit to nothing removes the prompt", () => {
    const a = enqueuePrompt(key, prompt("a"));
    const b = enqueuePrompt(key, prompt("b"));
    editQueuedPrompt(key, a, "  a2 ");
    expect(queuedPrompts(key).map((p) => p.text)).toEqual(["a2", "b"]);
    editQueuedPrompt(key, b, "   ");
    removeQueuedPrompt(key, a);
    expect(queuedPrompts(key)).toEqual([]);
  });

  it("an emptied queue is no longer paused", () => {
    const id = enqueuePrompt(key, prompt("x"));
    setQueuePaused(key, true);
    expect(isQueuePaused(key)).toBe(true);
    removeQueuedPrompt(key, id);
    expect(isQueuePaused(key)).toBe(false);
  });

  it("goes on by itself only after a clean finish", () => {
    expect(continuesQueue("end_turn")).toBe(true);
    for (const reason of ["cancelled", "error", "refusal", "max_tokens", "max_turn_requests"] as const)
      expect(continuesQueue(reason)).toBe(false);
  });

  it("prompts queued before a new chat has an id move to that chat, first", () => {
    enqueuePrompt(queueKey("p1", null), prompt("early"));
    enqueuePrompt(queueKey("p1", "c2"), prompt("later"));
    adoptNewChatQueue("p1", "c2");
    expect(queuedPrompts(queueKey("p1", null))).toEqual([]);
    expect(queuedPrompts(queueKey("p1", "c2")).map((p) => p.text)).toEqual(["early", "later"]);
  });

  it("the composer stays usable while the agent works and AgentPanel queues", () => {
    const composer = read("components/agent/Composer.tsx");
    expect(composer).toMatch(/const inputDisabled = !!reason;/);
    const panel = read("components/agent/AgentPanel.tsx");
    expect(panel).toMatch(/if \(running\) \{\s*enqueuePrompt\(qKey/);
    expect(panel).toMatch(/<QueuedPrompts\b/);
  });
});
