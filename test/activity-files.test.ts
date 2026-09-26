// Regression (§13.2 / §13.4): a turn whose edit was denied, or that was cancelled before the
// edit ran, was reported as "1 file edited" (bell, Home counts, "While you were away") and as
// "Agents finished 1 turn", although the file on disk was unchanged. The diff of a proposed
// edit is streamed with its permission request, so only completed tool calls count.
import { describe, expect, it } from "vitest";
import type { ActivityEvent, StreamEvent, TurnRecord } from "../src/contracts/ws.js";
import { editedFiles } from "../src/serve/activity.js";
import { summarizeSince } from "../src/resume/resume.js";

function turn(events: StreamEvent[]): TurnRecord {
  return { turnId: "t1", text: "Edit the readme", contextPack: "", events, startedAt: "2026-09-26T10:00:00.000Z" };
}

const proposed = (id: string, file: string): StreamEvent[] => [
  { kind: "tool_call", toolCall: { toolCallId: id, title: `Edit ${file}`, kind: "edit", status: "pending", locations: [{ path: file }] } },
  { kind: "diff", toolCallId: id, path: file, oldText: "a", newText: "b" },
];

describe("editedFiles", () => {
  it("lists a file only when its edit completed", () => {
    const events: StreamEvent[] = [
      ...proposed("ok", "src/done.ts"),
      { kind: "tool_call", toolCall: { toolCallId: "ok", title: "Edit src/done.ts", kind: "edit", status: "in_progress", locations: [{ path: "src/done.ts" }] } },
      { kind: "tool_result", toolCall: { toolCallId: "ok", title: "Edit src/done.ts", kind: "edit", status: "completed", locations: [{ path: "src/done.ts" }] } },
      // Denied: the agent reports the tool call failed.
      ...proposed("denied", "README.md"),
      { kind: "tool_result", toolCall: { toolCallId: "denied", title: "Edit README.md", kind: "edit", status: "failed", locations: [{ path: "README.md" }] } },
      // Cancelled turn: the permission never got an answer, the call stays pending.
      ...proposed("never", "docs/guide.md"),
      // A read of another file never counts.
      { kind: "tool_result", toolCall: { toolCallId: "read", title: "Read x.ts", kind: "read", status: "completed", locations: [{ path: "x.ts" }] } },
    ];
    expect(editedFiles(turn(events))).toEqual(["src/done.ts"]);
  });

  it("counts a completed diff-only edit and moves / deletes", () => {
    const events: StreamEvent[] = [
      ...proposed("w", "new.ts"),
      { kind: "tool_result", toolCall: { toolCallId: "w", title: "Write", kind: "edit", status: "completed", locations: [] } },
      { kind: "tool_result", toolCall: { toolCallId: "rm", title: "Delete old.ts", kind: "delete", status: "completed", locations: [{ path: "old.ts" }] } },
    ];
    expect(editedFiles(turn(events))).toEqual(["new.ts", "old.ts"]);
  });

  it("is empty for a turn whose only edit was denied", () => {
    expect(editedFiles(turn(proposed("x", "README.md")))).toEqual([]);
  });
});

describe("summarizeSince", () => {
  const base = { projectId: "p", projectName: "p", chatId: null, summary: "", background: false };
  it("does not call a cancelled turn finished", () => {
    const events: ActivityEvent[] = [
      { ...base, id: "1", kind: "turn.finished", at: "2026-09-26T10:01:00.000Z", stopReason: "end_turn", files: ["a.ts"] },
      { ...base, id: "2", kind: "turn.finished", at: "2026-09-26T10:02:00.000Z", stopReason: "cancelled" },
      { ...base, id: "3", kind: "turn.finished", at: "2026-09-26T10:03:00.000Z", stopReason: "error" },
    ];
    const since = summarizeSince(events, null);
    expect(since.turnsFinished).toBe(1);
    expect(since.turnsFailed).toBe(2);
    expect(since.files).toEqual(["a.ts"]);
  });
});
