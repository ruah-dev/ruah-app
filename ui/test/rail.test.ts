// ui/test/rail.test.ts — the projects in the Standard rail (ui/src/lib/rail.ts): how many tiles
// fit, which projects get one (pinned first with ⌘1…⌘9, then recent; the open one always), stable
// slots while switching, the "+N" overflow and the activity badge.
import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@/lib/contracts";
import { MAX_RAIL_TILES, railBadge, railCapacity, railProjects, stableOrder, unreadText } from "@/lib/rail";

const project = (id: string, pinned = false): ProjectInfo => ({
  id,
  name: id,
  root: `/r/${id}`,
  kind: "repo",
  lastOpenedAt: "2026-09-26T10:00:00.000Z",
  ...(pinned ? { pinned: true } : {}),
});

// The daemon's recent list: pinned first, then most recent first.
const LIST = [project("A", true), project("B", true), project("c"), project("d"), project("e"), project("f")];
const ids = (l: ReturnType<typeof railProjects>) => l.tiles.map((t) => t.project.id);

describe("railCapacity", () => {
  it("counts 40 px tiles with 6 px gaps", () => {
    expect(railCapacity(0)).toBe(0);
    expect(railCapacity(39)).toBe(0);
    expect(railCapacity(40)).toBe(1);
    expect(railCapacity(85)).toBe(1);
    expect(railCapacity(86)).toBe(2);
    expect(railCapacity(360)).toBe(7);
    expect(railCapacity(Number.NaN)).toBe(0);
  });
});

describe("railProjects", () => {
  it("shows every project when they fit: pinned first with ⌘1…, no overflow tile", () => {
    const l = railProjects(LIST, "d", 10);
    expect(ids(l)).toEqual(["A", "B", "c", "d", "e", "f"]);
    expect(l.overflow).toBe(0);
    expect(l.tiles.map((t) => t.shortcut)).toEqual(["⌘1", "⌘2", null, null, null, null]);
    expect(l.tiles.filter((t) => t.current).map((t) => t.project.id)).toEqual(["d"]);
  });

  it("keeps a slot for the +N tile and always shows the open project", () => {
    // 4 slots: 3 tiles + "+N". The open project "d" replaces the least recent tile ("c").
    const l = railProjects(LIST, "d", 4);
    expect(ids(l)).toEqual(["A", "B", "d"]);
    expect(l.overflow).toBe(3);
    // The open project is the most recent one: nothing to swap.
    expect(ids(railProjects(LIST, "c", 4))).toEqual(["A", "B", "c"]);
    // An open pinned project beyond the slots takes the last pinned slot.
    const many = [project("P1", true), project("P2", true), project("P3", true), project("x")];
    expect(ids(railProjects(many, "P3", 3))).toEqual(["P1", "P3"]);
  });

  it("with room for one tile at most, shows the open project only", () => {
    expect(ids(railProjects(LIST, "e", 1))).toEqual(["e"]);
    expect(railProjects(LIST, "e", 1).overflow).toBe(5);
    expect(ids(railProjects(LIST, null, 1))).toEqual([]);
    expect(railProjects(LIST, null, 0).overflow).toBe(LIST.length);
    expect(ids(railProjects([], null, 5))).toEqual([]);
  });

  it(`never shows more than ${MAX_RAIL_TILES} tiles`, () => {
    const lots = Array.from({ length: 15 }, (_, i) => project(`p${i}`));
    const l = railProjects(lots, "p0", 40);
    expect(l.tiles).toHaveLength(MAX_RAIL_TILES - 1);
    expect(l.overflow).toBe(15 - (MAX_RAIL_TILES - 1));
  });

  it("gives ⌘1…⌘9 to the first nine pinned projects only", () => {
    const pinned = Array.from({ length: 11 }, (_, i) => project(`p${i}`, true));
    const l = railProjects(pinned, null, 10);
    expect(l.tiles.map((t) => t.shortcut)).toEqual(["⌘1", "⌘2", "⌘3", "⌘4", "⌘5", "⌘6", "⌘7", "⌘8", "⌘9"]);
  });

  it("keeps recent tiles in their slots while switching (the daemon re-sorts by last opened)", () => {
    const first = railProjects(LIST, "c", 10);
    expect(first.order).toEqual(["c", "d", "e", "f"]);
    // Opening "e" moves it to the top of the daemon's list; its tile stays where it was.
    const reSorted = [project("A", true), project("B", true), project("e"), project("c"), project("d"), project("f")];
    const next = railProjects(reSorted, "e", 10, first.order);
    expect(ids(next)).toEqual(["A", "B", "c", "d", "e", "f"]);
    expect(next.tiles.find((t) => t.current)?.project.id).toBe("e");
  });

  it("lets a newcomer take the slot of the project it pushed out", () => {
    // Four slots (3 tiles + "+N"): A, c, d. Opening "x" (no tile) puts it first in the daemon's
    // list; the least recent tile ("d") goes and "x" takes its slot, "c" stays where it was.
    const before = railProjects([project("A", true), project("c"), project("d"), project("y"), project("x")], "c", 4);
    expect(ids(before)).toEqual(["A", "c", "d"]);
    expect(before.overflow).toBe(2);
    const withX = [project("A", true), project("x"), project("c"), project("d"), project("y")];
    const after = railProjects(withX, "x", 4, before.order);
    expect(ids(after)).toEqual(["A", "c", "x"]);
  });
});

describe("stableOrder", () => {
  it("keeps placed ids, fills freed slots first, appends the rest", () => {
    expect(stableOrder([], ["a", "b"])).toEqual(["a", "b"]);
    expect(stableOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    expect(stableOrder(["a", "b", "c"], ["a", "x", "c"])).toEqual(["a", "x", "c"]);
    expect(stableOrder(["a", "b", "c"], ["c"])).toEqual(["c"]);
    expect(stableOrder(["a", "b"], ["y", "x"])).toEqual(["y", "x"]);
  });
});

describe("railBadge", () => {
  it("is quiet without activity", () => {
    expect(railBadge(undefined)).toEqual({ dot: null, unread: 0, label: "" });
    expect(railBadge({ running: 0, waitingPermission: 0, unread: 0 })).toEqual({ dot: null, unread: 0, label: "" });
  });

  it("puts waiting before working, counts unread and says it in words", () => {
    expect(railBadge({ running: 1, waitingPermission: 0, unread: 2 })).toEqual({
      dot: "running",
      unread: 2,
      label: "Agent working · 2 unread",
    });
    // `running` includes the turns waiting for an answer.
    expect(railBadge({ running: 1, waitingPermission: 1, unread: 0 })).toEqual({
      dot: "waiting",
      unread: 0,
      label: "An agent is waiting for you",
    });
    expect(railBadge({ running: 4, waitingPermission: 1, unread: 0 }).label).toBe("An agent is waiting for you · 3 agents working");
    expect(railBadge({ running: 3, waitingPermission: 3, unread: 1 }).label).toBe("3 agents are waiting for you · 1 unread");
  });

  it("caps the unread pill", () => {
    expect(unreadText(7)).toBe("7");
    expect(unreadText(99)).toBe("99");
    expect(unreadText(100)).toBe("99+");
  });
});
