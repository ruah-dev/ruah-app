// ui/test/activity.test.ts — the viewer's activity store (CONTRACTS §13.2) and the desktop
// notification decision (§13.3).
import { describe, expect, it } from "vitest";
import type { ActivityEvent, ProjectActivity } from "@/lib/contracts";
import { activityState, clearUnreadLocally, handleActivityMessage, shouldNotify } from "@/lib/activity";

const project = (patch: Partial<ProjectActivity> = {}): ProjectActivity => ({
  projectId: "aaaaaaaaaaaa",
  projectName: "billing",
  running: 0,
  waitingPermission: 0,
  unread: 0,
  chats: {},
  ...patch,
});

const event = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "e1",
  kind: "turn.finished",
  projectId: "aaaaaaaaaaaa",
  projectName: "billing",
  chatId: "c1",
  summary: 'Finished "x"',
  at: "2026-09-24T12:00:00.000Z",
  background: false,
  stopReason: "end_turn",
  ...patch,
});

const ctx = { currentProjectId: "aaaaaaaaaaaa", activeChatId: "c1" };

describe("activity store", () => {
  it("snapshot, events and cleared markers keep per-project counts", () => {
    handleActivityMessage(
      {
        type: "activity.snapshot",
        projects: [project({ unread: 2, chats: { c1: 2 } })],
        recent: [],
        settings: { backgroundAgents: true, notifications: "off" },
        maxBackgroundTurns: 3,
      },
      ctx,
    );
    expect(activityState()).toMatchObject({ supported: true, maxBackgroundTurns: 3, projects: { aaaaaaaaaaaa: { unread: 2 } } });
    handleActivityMessage({ type: "activity", event: event({ kind: "turn.started" }), project: project({ running: 1, unread: 2, chats: { c1: 2 } }) }, ctx);
    expect(activityState().projects.aaaaaaaaaaaa?.running).toBe(1);
    expect(activityState().recent.map((e) => e.kind)).toEqual(["turn.started"]);
    clearUnreadLocally("aaaaaaaaaaaa", "c1");
    expect(activityState().projects.aaaaaaaaaaaa).toMatchObject({ unread: 0, running: 1 });
    handleActivityMessage({ type: "activity.project", project: project() }, ctx);
    expect(activityState().projects.aaaaaaaaaaaa).toBeUndefined(); // quiet projects are dropped
    expect(handleActivityMessage({ type: "chats", projectId: "x", chats: [], activeChatId: null }, ctx)).toBe(false);
  });
});

describe("shouldNotify", () => {
  it("background mode: finished turns and permission requests away from view only", () => {
    const here = { ...ctx, focused: true };
    expect(shouldNotify(event(), "background", here)).toBe(false);
    expect(shouldNotify(event({ background: true }), "background", here)).toBe(true);
    expect(shouldNotify(event(), "background", { ...here, focused: false })).toBe(true);
    expect(shouldNotify(event({ projectId: "bbbbbbbbbbbb" }), "background", here)).toBe(true);
    expect(shouldNotify(event({ kind: "permission.requested", background: true }), "background", here)).toBe(true);
    expect(shouldNotify(event({ kind: "turn.started", background: true }), "background", here)).toBe(false);
    expect(shouldNotify(event(), "always", here)).toBe(true);
    expect(shouldNotify(event({ background: true }), "off", here)).toBe(false);
  });
});
