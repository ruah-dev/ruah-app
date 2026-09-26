// ui/test/home.test.ts — the Home page's cards (ui/src/lib/home.ts): what each says, how they rank
// (a waiting permission first, quiet last), the filters (All · Pinned · tags) and tag parsing.
import { describe, expect, it } from "vitest";
import type { ProjectInfo, ProjectOverview } from "@/lib/contracts";
import { gitFoot, greeting, groupOf, homeCard, homeFilters, homeSummary, leftOffLine, matchesFilter, parseTags, sortCards, tagCounts, tagKey } from "@/lib/home";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const project = (id: string, over: Partial<ProjectInfo> = {}): ProjectInfo => ({ id, name: id, root: `/r/${id}`, kind: "repo", lastOpenedAt: "2026-09-26T10:00:00.000Z", ...over });

function overview(id: string, over: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    project: project(id),
    current: false,
    exists: true,
    lastViewedAt: "2026-09-26T09:00:00.000Z",
    lastChat: { id: "c1", title: "Fix the ledger", agentId: "claude", updatedAt: "2026-09-26T11:00:00.000Z", turnCount: 2, lastPrompt: "Why does the ledger drift?", lastReply: "Because…" },
    since: { from: "2026-09-26T09:00:00.000Z", turnsFinished: 0, turnsFailed: 0, permissionsRequested: 0, filesTotal: 0, mapChanges: 0 },
    lastEvent: null,
    unread: 0,
    live: { running: 0, waitingPermission: 0 },
    permissions: [],
    git: { available: true, branch: "main", head: "abc1234", upstream: "origin/main", ahead: 0, behind: 0, dirty: 0, dirtyPaths: [], lastCommit: null },
    cloud: null,
    preview: null,
    ...over,
  };
}

const agentName = (id: string) => ({ claude: "Claude Code", cursor: "Cursor" })[id] ?? id;

describe("homeCard", () => {
  it("says what needs you, most urgent first", () => {
    const waiting = homeCard(
      overview("w", {
        live: { running: 1, waitingPermission: 1 },
        permissions: [{ requestId: "r1", turnId: "t", chatId: "c1", title: "Run pnpm migrate", options: [] }],
      }),
      { agentName, now: NOW },
    );
    expect(waiting).toMatchObject({ status: "permission", pill: "Needs you", tone: "warn", headline: "Claude Code wants to: Run pnpm migrate", attention: true });

    const failed = homeCard(
      overview("f", { since: { ...overview("x").since, turnsFailed: 1 }, lastEvent: { id: "e", kind: "turn.finished", projectId: "f", projectName: "f", chatId: "c1", summary: "Failed “Add tests”: boom", at: "2026-09-26T11:00:00.000Z", background: true, stopReason: "error", error: "boom" } }),
      { agentName, now: NOW },
    );
    expect(failed).toMatchObject({ status: "failed", tone: "bad", headline: "Failed “Add tests”: boom" });

    const down = homeCard(overview("d", { cloud: { inScope: 4, healthy: 3, degraded: 0, down: 1, deploying: 0, unhealthy: ["worker"], syncedAt: null } }), { now: NOW });
    expect(down).toMatchObject({ status: "cloud-down", headline: "1 down in the cloud: worker" });

    const crashed = homeCard(overview("p", { preview: { state: "crashed", url: null, exitCode: 1 } }), { now: NOW });
    expect(crashed.status).toBe("preview-crashed");
    expect(crashed.headline).toContain("exit 1");

    const done = homeCard(
      overview("o", { unread: 1, since: { ...overview("x").since, turnsFinished: 1 }, lastEvent: { id: "e", kind: "turn.finished", projectId: "o", projectName: "o", chatId: "c1", agentId: "cursor", summary: "Finished “fix flaky test” · 2 files edited", at: "2026-09-26T11:00:00.000Z", background: true, stopReason: "end_turn" } }),
      { agentName, now: NOW },
    );
    expect(done).toMatchObject({ status: "done", pill: "Done", headline: "Cursor: Finished “fix flaky test” · 2 files edited" });

    const running = homeCard(overview("r", { live: { running: 1, waitingPermission: 0 } }), { agentName, now: NOW });
    expect(running).toMatchObject({ status: "running", tone: "ai", headline: "Claude Code is working on “Fix the ledger”", attention: false });

    const dirty = homeCard(overview("g", { git: { ...(overview("x").git as Extract<ProjectOverview["git"], { available: true }>), dirty: 3, ahead: 2 } }), { now: NOW });
    expect(dirty).toMatchObject({ status: "changes", headline: "3 uncommitted changes · 2 commits not pushed", foot: "main ↑2 · 3 uncommitted" });

    const quiet = homeCard(overview("q"), { now: NOW });
    expect(quiet).toMatchObject({ status: "quiet", headline: null, leftOff: "You asked “Why does the ledger drift?” · 1h ago", foot: "main · clean" });

    const sorted = sortCards([quiet, dirty, running, done, crashed, down, failed, waiting]).map((c) => c.id);
    expect(sorted).toEqual(["w", "f", "d", "p", "o", "r", "g", "q"]);
  });

  it("uses the live activity feed over the snapshot and ignores the open project's own news", () => {
    const o = overview("a", { current: true, since: { ...overview("x").since, turnsFinished: 3 } });
    expect(homeCard(o, { now: NOW }).status).toBe("quiet");
    const waiting = homeCard(overview("b"), { now: NOW, activity: { projectId: "b", projectName: "b", running: 1, waitingPermission: 1, unread: 0, chats: {} } });
    expect(waiting.status).toBe("permission");
    expect(waiting.headline).toBe("1 permission request waiting");
  });

  it("breaks ties by pin order, then recency", () => {
    const a = homeCard(overview("a", { project: project("a", { lastOpenedAt: "2026-09-26T11:00:00.000Z" }) }), { now: NOW });
    const b = homeCard(overview("b", { project: project("b", { pinned: true, pinOrder: 1 }) }), { now: NOW });
    const c = homeCard(overview("c", { project: project("c", { pinned: true, pinOrder: 0 }) }), { now: NOW });
    expect(sortCards([a, b, c]).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

  it("formats git and where you left off", () => {
    expect(gitFoot({ available: false, reason: "not a git repository" })).toBe("no git");
    expect(gitFoot({ available: true, branch: null, head: "abc", upstream: null, ahead: null, behind: null, dirty: 0, dirtyPaths: [], lastCommit: null })).toBe("detached abc · clean");
    expect(gitFoot({ available: true, branch: "dev", head: null, upstream: null, ahead: null, behind: 2, dirty: 1, dirtyPaths: [], lastCommit: null })).toBe("dev ↓2 · 1 uncommitted");
    expect(leftOffLine({ lastChat: null })).toBe("No chats yet — open it to start one");
    expect(leftOffLine({ lastChat: { id: "c", title: "Plan", agentId: "x", updatedAt: "2026-09-24T12:00:00.000Z", turnCount: 0, lastPrompt: null, lastReply: null } }, NOW)).toBe("“Plan” · 2d ago");
  });
});

describe("filters and tags", () => {
  const list = [
    project("a", { pinned: true, pinOrder: 0, tags: ["Freelance", "Acme Studio"] }),
    project("b", { tags: ["freelance"] }),
    project("c", { tags: ["Job"] }),
    project("d", { tags: ["Freelance"] }),
    project("e"),
  ];
  it("All · Pinned · tags by use, case-insensitive, majority spelling", () => {
    expect(homeFilters(list).map((f) => `${f.label}:${f.count}`)).toEqual(["All:5", "Pinned:1", "Freelance:3", "Acme Studio:1", "Job:1"]);
    expect(tagCounts([project("x")])).toEqual([]);
    expect(list.filter((p) => matchesFilter(p, tagKey("FREELANCE"))).map((p) => p.id)).toEqual(["a", "b", "d"]);
    expect(list.filter((p) => matchesFilter(p, "pinned")).map((p) => p.id)).toEqual(["a"]);
    expect(list.filter((p) => matchesFilter(p, "all"))).toHaveLength(5);
    expect(groupOf(list[0]!)).toBe("Freelance");
    expect(groupOf(list[4]!)).toBeNull();
  });
  it("parses the tag field", () => {
    expect(parseTags(" Freelance ,acme  studio,, freelance, Job")).toEqual(["Freelance", "acme studio", "Job"]);
    expect(parseTags("a,b,c,d,e,f,g")).toHaveLength(6);
  });
  it("greets and summarizes", () => {
    expect(greeting(new Date(2026, 8, 26, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 8, 26, 15))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 8, 26, 21))).toBe("Good evening");
    const cards = [homeCard(overview("w", { live: { running: 1, waitingPermission: 1 } })), homeCard(overview("r", { live: { running: 1, waitingPermission: 0 } })), homeCard(overview("q"))];
    expect(homeSummary(cards)).toBe("1 needs you · 1 working · 1 quiet");
    expect(homeSummary([])).toBe("No projects yet");
  });
});
