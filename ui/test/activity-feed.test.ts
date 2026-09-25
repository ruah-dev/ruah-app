// ui/test/activity-feed.test.ts — the shell's views of the activity feed (ui/src/lib/activity-feed.ts):
// bell count, pending permission requests, "Needs you", the feed list.
import { describe, expect, it } from "vitest";
import type { ActivityEvent, ProjectActivity } from "@/lib/contracts";
import { attentionCount, eventTone, feedEvents, needsYou, pendingPermissions } from "@/lib/activity-feed";

let n = 0;
const ev = (kind: ActivityEvent["kind"], extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++n}`,
  kind,
  projectId: "p1",
  projectName: "shop",
  chatId: "c1",
  summary: kind,
  at: `2026-09-25T10:${String(n).padStart(2, "0")}:00.000Z`,
  background: true,
  ...extra,
});

const project = (id: string, extra: Partial<ProjectActivity> = {}): ProjectActivity => ({
  projectId: id,
  projectName: id,
  running: 0,
  waitingPermission: 0,
  unread: 0,
  chats: {},
  ...extra,
});

describe("attentionCount", () => {
  it("adds unread and waiting over every project", () => {
    expect(attentionCount({ a: project("a", { unread: 2 }), b: project("b", { waitingPermission: 1, running: 3 }) })).toBe(3);
    expect(attentionCount({})).toBe(0);
  });
});

describe("pendingPermissions", () => {
  it("drops answered requests and requests of finished turns, newest first", () => {
    const a = ev("permission.requested", { requestId: "r1", turnId: "t1" });
    const b = ev("permission.requested", { requestId: "r2", turnId: "t2" });
    const c = ev("permission.requested", { requestId: "r3", turnId: "t3" });
    const events = [a, b, c, ev("permission.answered", { requestId: "r1" }), ev("turn.finished", { turnId: "t2", stopReason: "cancelled" })];
    expect(pendingPermissions(events).map((e) => e.requestId)).toEqual(["r3"]);
  });
});

describe("needsYou", () => {
  it("lists waiting permissions, then unread finished background turns (one per chat)", () => {
    const perm = ev("permission.requested", { requestId: "r9", turnId: "t9", projectId: "p2", chatId: "c9" });
    const done1 = ev("turn.finished", { turnId: "t1", stopReason: "end_turn", chatId: "c1" });
    const done2 = ev("turn.finished", { turnId: "t2", stopReason: "end_turn", chatId: "c1" });
    const seen = ev("turn.finished", { turnId: "t3", stopReason: "end_turn", chatId: "c2" });
    const front = ev("turn.finished", { turnId: "t4", stopReason: "end_turn", chatId: "c3", background: false });
    const projects = { p1: project("p1", { unread: 2, chats: { c1: 1, c3: 1 } }), p2: project("p2", { waitingPermission: 1 }) };
    const out = needsYou([perm, done1, done2, seen, front], projects);
    expect(out.map((e) => e.id)).toEqual([perm.id, done2.id]);
  });
});

describe("feedEvents / eventTone", () => {
  it("lists newest first without turn.started and answered noise", () => {
    const events = [ev("turn.started"), ev("turn.finished", { stopReason: "end_turn" }), ev("permission.answered"), ev("agent.error")];
    expect(feedEvents(events).map((e) => e.kind)).toEqual(["agent.error", "turn.finished"]);
  });
  it("colours by outcome", () => {
    expect(eventTone(ev("turn.finished", { stopReason: "end_turn" }))).toBe("ok");
    expect(eventTone(ev("turn.finished", { stopReason: "error" }))).toBe("bad");
    expect(eventTone(ev("permission.requested"))).toBe("warn");
  });
});
