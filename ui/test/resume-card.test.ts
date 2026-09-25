// ui/test/resume-card.test.ts — when the "Where you left off" card shows (ui/src/lib/resume-card.ts)
// and what it lists.
import { describe, expect, it } from "vitest";
import type { ActivityEvent, ResumeInfo } from "@/lib/contracts";
import { awayItems, hasNews, shouldShowResumeCard, sinceLabel } from "@/lib/resume-card";

const LEFT = "2026-09-23T10:00:00.000Z";

function resume(patch: Partial<ResumeInfo> = {}, since: Partial<ResumeInfo["since"]> = {}): ResumeInfo {
  return {
    project: { id: "p1", name: "shop", root: "/r/shop", kind: "repo", lastOpenedAt: LEFT },
    lastViewedAt: LEFT,
    lastChat: { id: "c1", title: "checkout refactor", agentId: "claude", updatedAt: LEFT, turnCount: 3, lastPrompt: null, lastReply: null },
    lastFocus: { nodeId: "api", name: "api / payments" },
    since: {
      from: LEFT,
      turnsFinished: 0,
      turnsFailed: 0,
      permissionsRequested: 0,
      files: [],
      filesTotal: 0,
      mapChanges: 0,
      events: [],
      ...since,
    },
    unread: 0,
    git: { available: true, branch: "feat/checkout", head: "abc1234", upstream: "origin/feat/checkout", ahead: 2, behind: 0, dirty: 3, dirtyPaths: [], lastCommit: null },
    ruah: { initialized: false },
    view: null,
    attention: 0,
    ...patch,
  };
}

const finished: ActivityEvent = {
  id: "e1",
  kind: "turn.finished",
  projectId: "p1",
  projectName: "shop",
  chatId: "c1",
  summary: 'Finished "Add Stripe webhooks" · 6 files edited',
  at: "2026-09-24T09:00:00.000Z",
  background: true,
  stopReason: "end_turn",
};

const base = { projectId: "p1", dismissedFor: null, switching: false };

describe("hasNews", () => {
  it("is false for a quiet project even with a dirty tree", () => {
    expect(hasNews(resume())).toBe(false);
  });
  it("counts finished / failed turns, permissions, map changes, edited files, unread and waiting", () => {
    expect(hasNews(resume({}, { turnsFinished: 1 }))).toBe(true);
    expect(hasNews(resume({}, { turnsFailed: 1 }))).toBe(true);
    expect(hasNews(resume({}, { permissionsRequested: 1 }))).toBe(true);
    expect(hasNews(resume({}, { mapChanges: 2 }))).toBe(true);
    expect(hasNews(resume({}, { filesTotal: 4 }))).toBe(true);
    expect(hasNews(resume({ unread: 1 }))).toBe(true);
    expect(hasNews(resume({ live: { running: 0, waitingPermission: 1 } }))).toBe(true);
  });
});

describe("shouldShowResumeCard", () => {
  const news = resume({}, { turnsFinished: 1, events: [finished] });

  it("shows when entering a project with news", () => {
    expect(shouldShowResumeCard({ ...base, resume: news })).toBe(true);
  });
  it("never on the first open of a project (never viewed before)", () => {
    expect(shouldShowResumeCard({ ...base, resume: { ...news, lastViewedAt: null } })).toBe(false);
  });
  it("not without news", () => {
    expect(shouldShowResumeCard({ ...base, resume: resume() })).toBe(false);
  });
  it("not again once dismissed for this visit, but again on a later visit", () => {
    expect(shouldShowResumeCard({ ...base, resume: news, dismissedFor: LEFT })).toBe(false);
    const later = { ...news, lastViewedAt: "2026-09-25T08:00:00.000Z" };
    expect(shouldShowResumeCard({ ...base, resume: later, dismissedFor: LEFT })).toBe(true);
  });
  it("not while a switch paints, for another project, or when turned off", () => {
    expect(shouldShowResumeCard({ ...base, resume: news, switching: true })).toBe(false);
    expect(shouldShowResumeCard({ ...base, resume: news, projectId: "p2" })).toBe(false);
    expect(shouldShowResumeCard({ ...base, resume: null })).toBe(false);
    expect(shouldShowResumeCard({ ...base, resume: news, enabled: false })).toBe(false);
  });
});

describe("awayItems", () => {
  it("lists waiting permissions first, then the finished turn with its title", () => {
    const items = awayItems(
      resume({ live: { running: 1, waitingPermission: 1 } }, { turnsFinished: 1, filesTotal: 6, mapChanges: 2, events: [finished] }),
    );
    expect(items.map((i) => i.key)).toEqual(["perm", "done", "running"]);
    expect(items[1]!.strong).toBe("Add Stripe webhooks");
    expect(items[1]!.text).toContain("6 files");
    expect(items[1]!.text).toContain("2 changes on the map");
  });
  it("mentions running ruah tasks and caps the list", () => {
    const r = resume(
      { ruah: { initialized: true, tasks: [{ name: "api-webhooks", status: "in-progress" }] } },
      { turnsFailed: 2, permissionsRequested: 1 },
    );
    expect(awayItems(r).map((i) => i.key)).toEqual(["perm", "failed", "tasks"]);
    expect(awayItems(r, 1)).toHaveLength(1);
  });
});

describe("sinceLabel", () => {
  const now = Date.parse("2026-09-25T10:00:00.000Z");
  it("reads coarsely", () => {
    expect(sinceLabel(LEFT, now)).toBe("2 days ago");
    expect(sinceLabel("2026-09-24T10:00:00.000Z", now)).toBe("yesterday");
    expect(sinceLabel("2026-09-25T07:00:00.000Z", now)).toBe("3 h ago");
    expect(sinceLabel(null, now)).toBe("");
  });
});
