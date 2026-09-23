// ui/test/switching.test.ts — pure navigation helpers (ui/src/lib/switching.ts): MRU order for
// the ⌘J switcher, cycling, date groups for chat lists, filtering, ⌘[ / ⌘] neighbours, LRU.
import { describe, expect, it } from "vitest";
import {
  cycleIndex,
  dateGroupOf,
  groupByDate,
  lruSet,
  matchesChat,
  neighborChat,
  pruneMru,
  touchMru,
  type MruChat,
} from "@/lib/switching";

const entry = (chatId: string, projectId = "p1"): MruChat => ({
  chatId,
  projectId,
  projectName: projectId,
  projectRoot: `/r/${projectId}`,
  title: chatId,
  agentId: "claude",
  at: 0,
});

describe("MRU chats", () => {
  it("moves a visited chat to the front, dedupes, caps and prunes", () => {
    let list: MruChat[] = [];
    for (const id of ["a", "b", "c"]) list = touchMru(list, entry(id));
    expect(list.map((e) => e.chatId)).toEqual(["c", "b", "a"]);
    list = touchMru(list, entry("a", "p2"));
    expect(list.map((e) => e.chatId)).toEqual(["a", "c", "b"]);
    expect(list[0]?.projectId).toBe("p2");
    expect(touchMru(list, entry("d"), 2).map((e) => e.chatId)).toEqual(["d", "a"]);
    expect(pruneMru(list, new Set(["c"])).map((e) => e.chatId)).toEqual(["a", "b"]);
  });

  it("cycles like app switching (wraps both ways)", () => {
    expect(cycleIndex(4, 1, 1)).toBe(2);
    expect(cycleIndex(4, 3, 1)).toBe(0);
    expect(cycleIndex(4, 0, -1)).toBe(3);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
});

describe("date groups", () => {
  // Local-time calendar days: a fixed "now" at noon keeps the test independent of the time zone.
  const now = new Date(2026, 8, 23, 12, 0, 0).getTime();
  const at = (days: number, hour = 9) => new Date(2026, 8, 23 - days, hour, 0, 0).getTime();

  it("buckets by calendar day relative to now", () => {
    expect(dateGroupOf(at(0, 0), now)).toBe("Today");
    expect(dateGroupOf(at(1, 23), now)).toBe("Yesterday");
    expect(dateGroupOf(at(1, 0), now)).toBe("Yesterday");
    expect(dateGroupOf(at(2), now)).toBe("Last 7 days");
    expect(dateGroupOf(at(6), now)).toBe("Last 7 days");
    expect(dateGroupOf(at(7), now)).toBe("Older");
    expect(dateGroupOf("not a date", now)).toBe("Older");
  });

  it("keeps order inside groups and drops empty groups", () => {
    const chats = [
      { id: "t1", at: at(0, 11) },
      { id: "t2", at: at(0, 8) },
      { id: "o1", at: at(40) },
      { id: "w1", at: at(3) },
    ];
    const groups = groupByDate(chats, (c) => c.at, now);
    expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
      ["Today", ["t1", "t2"]],
      ["Last 7 days", ["w1"]],
      ["Older", ["o1"]],
    ]);
  });
});

describe("filter and neighbours", () => {
  const names: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
  const agentName = (id: string) => names[id] ?? id;

  it("matches every word against the title or the agent name", () => {
    const chat = { title: "Why is the invoice API slow?", agentId: "claude" };
    expect(matchesChat(chat, "", agentName)).toBe(true);
    expect(matchesChat(chat, "invoice", agentName)).toBe(true);
    expect(matchesChat(chat, "INV claude", agentName)).toBe(true);
    expect(matchesChat(chat, "code slow", agentName)).toBe(true);
    expect(matchesChat(chat, "codex", agentName)).toBe(false);
  });

  it("finds the previous / next chat in list order without wrapping", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(neighborChat(list, "b", 1)?.id).toBe("c");
    expect(neighborChat(list, "b", -1)?.id).toBe("a");
    expect(neighborChat(list, "c", 1)).toBeNull();
    expect(neighborChat(list, "a", -1)).toBeNull();
    expect(neighborChat(list, null, 1)?.id).toBe("a");
    expect(neighborChat([], "a", 1)).toBeNull();
  });

  it("LRU evicts the least recently set key", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    lruSet(m, "a", 3, 2);
    lruSet(m, "c", 4, 2);
    expect([...m.keys()]).toEqual(["a", "c"]);
  });
});
