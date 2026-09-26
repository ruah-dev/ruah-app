// ui/test/recent-chats.test.ts — the open project's recent chats as the shell shows them
// (ui/src/lib/recent-chats.ts): status per chat from the activity feed and the live turn, which
// chats the strip shows and how many fit.
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/lib/contracts";
import { chatStatesFromFeed, chatStatuses, liveChatState, stripCapacity, stripChats } from "@/lib/recent-chats";

let seq = 0;
function ev(kind: string, chatId: string | null, patch: Partial<ActivityEvent> = {}): ActivityEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    kind,
    projectId: "p1",
    projectName: "shop",
    chatId,
    summary: kind,
    at: new Date(Date.UTC(2026, 8, 26, 10, 0, seq)).toISOString(),
    background: false,
    ...patch,
  };
}

// Oldest first, as the activity store keeps it.
const FEED: ActivityEvent[] = [
  ev("turn.started", "run", { turnId: "t1" }),
  ev("turn.started", "done", { turnId: "t2" }),
  ev("turn.finished", "done", { turnId: "t2", stopReason: "end_turn" }),
  ev("turn.started", "wait", { turnId: "t3" }),
  ev("permission.requested", "wait", { turnId: "t3", requestId: "r1" }),
  ev("turn.started", "answered", { turnId: "t4" }),
  ev("permission.requested", "answered", { turnId: "t4", requestId: "r2" }),
  ev("permission.answered", "answered", { turnId: "t4", requestId: "r2" }),
  ev("turn.started", "failed", { turnId: "t5" }),
  ev("agent.error", "failed", { turnId: "t5", error: "boom" }),
  ev("turn.finished", "refused", { turnId: "t6", stopReason: "refusal" }),
  ev("turn.finished", "stopped", { turnId: "t7", stopReason: "cancelled" }),
  ev("map.changed", "done", { mapChanges: 2 }),
  ev("turn.started", "other-project", { projectId: "p2" }),
  ev("turn.started", null),
];

describe("chatStatesFromFeed", () => {
  it("keeps the last known state per chat of the project", () => {
    const states = chatStatesFromFeed(FEED, "p1");
    expect(Object.fromEntries(states)).toEqual({
      run: "running",
      done: "done",
      wait: "waiting",
      answered: "running",
      failed: "failed",
      refused: "failed",
      stopped: "stopped",
    });
    expect(chatStatesFromFeed(FEED, "p2").get("other-project")).toBe("running");
  });

  it("drops the waiting state once the permission is answered or its turn ends", () => {
    const answered = [
      ev("permission.requested", "c", { turnId: "t9", requestId: "r9" }),
      ev("permission.answered", "c", { turnId: "t9", requestId: "r9" }),
    ];
    expect(chatStatesFromFeed(answered, "p1").get("c")).toBe("running");
    const cancelled = [
      ev("permission.requested", "c", { turnId: "t9", requestId: "r9" }),
      ev("turn.finished", "c", { turnId: "t9", stopReason: "cancelled" }),
    ];
    expect(chatStatesFromFeed(cancelled, "p1").get("c")).toBe("stopped");
  });
});

describe("liveChatState", () => {
  it("reads the chat in front from its last turn", () => {
    expect(liveChatState([])).toBeNull();
    expect(liveChatState([{ stopReason: "end_turn" }, {}])).toBe("running");
    expect(liveChatState([{ permission: { requestId: "r" } }])).toBe("waiting");
    expect(liveChatState([{ stopReason: "end_turn" }])).toBe("done");
    expect(liveChatState([{ stopReason: "max_tokens" }])).toBe("done");
    expect(liveChatState([{ stopReason: "error" }])).toBe("failed");
    expect(liveChatState([{ stopReason: "cancelled" }])).toBe("stopped");
  });
});

describe("chatStatuses", () => {
  it("prefers the live turn for the chat in front, adds unread, idles the rest", () => {
    const out = chatStatuses({
      chatIds: ["run", "done", "quiet"],
      projectId: "p1",
      events: FEED,
      activity: { chats: { done: 2 } },
      activeChatId: "run",
      activeTurns: [{ stopReason: "end_turn" }],
    });
    expect(Object.fromEntries(out)).toEqual({
      run: { state: "done", unread: 0 },
      done: { state: "done", unread: 2 },
      quiet: { state: "idle", unread: 0 },
    });
    // No turn loaded yet for the chat in front: the feed says.
    const early = chatStatuses({
      chatIds: ["wait"],
      projectId: "p1",
      events: FEED,
      activity: undefined,
      activeChatId: "wait",
      activeTurns: [],
    });
    expect(early.get("wait")).toEqual({ state: "waiting", unread: 0 });
  });
});

describe("stripChats", () => {
  const chat = (id: string, minute: number) => ({ id, updatedAt: new Date(Date.UTC(2026, 8, 26, 10, minute)).toISOString() });
  const CHATS = [chat("a", 1), chat("b", 5), chat("c", 3), chat("d", 4), chat("e", 2)];

  it("shows the most recently updated chats first", () => {
    expect(stripChats(CHATS, "b", 3).map((c) => c.id)).toEqual(["b", "d", "c"]);
    expect(stripChats(CHATS, null, 10).map((c) => c.id)).toEqual(["b", "d", "c", "e", "a"]);
    expect(stripChats(CHATS, "b", 0)).toEqual([]);
  });

  it("always includes the chat in front (it takes the last place)", () => {
    expect(stripChats(CHATS, "a", 3).map((c) => c.id)).toEqual(["b", "d", "a"]);
    expect(stripChats(CHATS, "gone", 2).map((c) => c.id)).toEqual(["b", "d"]);
  });
});

describe("stripCapacity", () => {
  it("fits 1…5 chips (at least 100 px each, with gaps and padding)", () => {
    expect(stripCapacity(0)).toBe(3);
    expect(stripCapacity(Number.NaN)).toBe(3);
    expect(stripCapacity(100)).toBe(1);
    // The agent panel at its default width (1440 px window): three.
    expect(stripCapacity(419)).toBe(3);
    expect(stripCapacity(520)).toBe(4);
    // Five chips of 100 px + four 4 px gaps + 16 px padding = 532 px.
    expect(stripCapacity(531)).toBe(4);
    expect(stripCapacity(532)).toBe(5);
    expect(stripCapacity(2000)).toBe(5);
  });
});
