// ui/test/rail.test.ts — the projects in the Standard rail (ui/src/lib/rail.ts): how many tiles
// fit, which projects get one (pinned first with ⌘1…⌘9, then recent; the open one always), stable
// slots while switching, the "+N" overflow and the activity badge.
import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@/lib/contracts";
import {
  MAX_RAIL_TILES,
  pinnedOrder,
  railBadge,
  railCapacity,
  railProjects,
  sortProjectList,
  stableOrder,
  unreadText,
} from "@/lib/rail";

const project = (id: string, pinned = false, lastOpenedAt = "2026-09-26T10:00:00.000Z"): ProjectInfo => ({
  id,
  name: id,
  root: `/r/${id}`,
  kind: "repo",
  lastOpenedAt,
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

  it("keeps the saved order through an empty or single-project first render (list not loaded yet)", () => {
    // Saved: e, c, d (the user's slots). The page opens with no project list, then only the open one.
    const saved = ["e", "c", "d"];
    const empty = railProjects([], null, 10, saved, { complete: false });
    expect(ids(empty)).toEqual([]);
    expect(empty.order).toEqual(saved);
    const single = railProjects([project("d")], "d", 10, saved, { complete: false });
    expect(ids(single)).toEqual(["d"]);
    expect(single.order).toEqual(saved);
    // A project the saved order does not know goes last; the saved ids keep their slots.
    expect(railProjects([project("x")], "x", 10, saved, { complete: false }).order).toEqual([...saved, "x"]);
    // The whole list (sorted by last opened: d, c, e) lands: the tiles keep the saved slots.
    const full = [project("A", true), project("d"), project("c"), project("e")];
    const loaded = railProjects(full, "d", 10, single.order);
    expect(ids(loaded)).toEqual(["A", "e", "c", "d"]);
    expect(loaded.order).toEqual(saved);
    // Once loaded, a saved id the list no longer has (forgotten) drops.
    expect(railProjects(full, "d", 10, ["gone", ...saved]).order).toEqual(saved);
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

  it("keeps the slots of ids that `keep` says are only absent from this render", () => {
    const unknown = (id: string) => id !== "b";
    expect(stableOrder(["a", "b", "c"], [], unknown)).toEqual(["a", "c"]);
    expect(stableOrder(["a", "b", "c"], ["c", "x"], unknown)).toEqual(["a", "x", "c"]);
    expect(stableOrder(["a", "b"], ["y"], () => true)).toEqual(["a", "b", "y"]);
  });
});

describe("pinned order", () => {
  it("keeps the order projects were pinned in; newly pinned go last, unpinned drop", () => {
    expect(pinnedOrder([], ["B", "A"])).toEqual(["B", "A"]);
    // The daemon re-sorted by last opened (A opened last): A stays ⌘2.
    expect(pinnedOrder(["B", "A"], ["A", "B"])).toEqual(["B", "A"]);
    expect(pinnedOrder(["B", "A"], ["C", "A", "B"])).toEqual(["B", "A", "C"]);
    expect(pinnedOrder(["B", "A", "C"], ["C", "B"])).toEqual(["B", "C"]);
    expect(pinnedOrder(["B", "B", "A"], ["A", "B"])).toEqual(["B", "A"]);
  });

  it("sorts pinned by that order, the rest by last opened", () => {
    const list = [
      project("r1", false, "2026-09-26T09:00:00.000Z"),
      project("P2", true, "2026-09-26T11:00:00.000Z"),
      project("r2", false, "2026-09-26T12:00:00.000Z"),
      project("P1", true, "2026-09-26T08:00:00.000Z"),
      project("P3", true, "2026-09-26T10:00:00.000Z"),
    ];
    expect(sortProjectList(list, ["P1", "P2"]).map((p) => p.id)).toEqual(["P1", "P2", "P3", "r2", "r1"]);
    // No saved order: the daemon's (last opened) order.
    expect(sortProjectList(list).map((p) => p.id)).toEqual(["P2", "P3", "P1", "r2", "r1"]);
    // ⌘1…⌘9 follow the same list: opening P2 (newest) does not make it ⌘1.
    const l = railProjects(sortProjectList(list, ["P1", "P2", "P3"]), "P2", 10);
    expect(l.tiles.filter((t) => t.shortcut).map((t) => `${t.project.id} ${t.shortcut}`)).toEqual(["P1 ⌘1", "P2 ⌘2", "P3 ⌘3"]);
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

describe("§20 pin order, reorder and groups", () => {
  it("pinOrderIds follows the daemon's pinOrder; moveId moves one id", async () => {
    const { pinOrderIds, moveId } = await import("@/lib/rail");
    const list = [
      { ...project("a", true), pinOrder: 2 },
      { ...project("b", true), pinOrder: 0 },
      project("c"),
      { ...project("d", true), pinOrder: 1 },
    ];
    expect(pinOrderIds(list)).toEqual(["b", "d", "a"]);
    expect(moveId(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveId(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });

  it("keeps ⌘ numbers global when the rail shows one group", async () => {
    const { railGroupProjects, railGroups, groupInitials } = await import("@/lib/rail");
    const tagged = (id: string, pinned: boolean, tags: string[]) => ({ ...project(id, pinned), tags });
    const list = [tagged("A", true, ["Job"]), tagged("B", true, ["Acme Studio"]), tagged("c", false, ["job"]), tagged("d", false, ["Acme Studio"]), tagged("e", false, ["Solo"])];
    expect(railGroups(list).map((g) => `${g.label}:${g.count}`)).toEqual(["Acme Studio:2", "Job:2"]);
    expect(railGroups([tagged("x", false, ["Solo"])])).toEqual([]);
    const lm = railGroupProjects(list, "acme studio", "e");
    expect(lm.map((p) => p.id)).toEqual(["B", "d", "e"]);
    expect(railGroupProjects(list, "nope", null)).toHaveLength(5);
    const layout = railProjects(lm, "e", 10, [], { complete: false, pinnedIds: ["A", "B"] });
    expect(layout.tiles.map((t) => [t.project.id, t.shortcut])).toEqual([["B", "⌘2"], ["d", null], ["e", null]]);
    expect(groupInitials("Acme Studio")).toBe("AS");
    expect(groupInitials("job")).toBe("Jo");
  });
});

describe("drag to reorder pins", () => {
  it("dropIndex + moveId put the dragged pin where the line shows", async () => {
    const { dropIndex, moveId } = await import("@/lib/rail");
    const ids = ["a", "b", "c", "d"];
    const drop = (dragged: string, target: string, after: boolean) => moveId(ids, dragged, dropIndex(ids, dragged, target, after));
    expect(drop("a", "c", false)).toEqual(["b", "a", "c", "d"]);
    expect(drop("a", "c", true)).toEqual(["b", "c", "a", "d"]);
    expect(drop("d", "a", false)).toEqual(["d", "a", "b", "c"]);
    expect(drop("d", "b", true)).toEqual(["a", "b", "d", "c"]);
    expect(drop("b", "b", true)).toEqual(ids);
  });
});
