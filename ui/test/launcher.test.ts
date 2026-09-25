// ui/test/launcher.test.ts — the ⌘K launcher's ranking (ui/src/lib/launcher.ts): fuzzy scores,
// group order with and without a query, de-duplication of targets, limits, "always" rows.
import { describe, expect, it } from "vitest";
import {
  flattenRanked,
  fuzzyScore,
  moveActive,
  rankLauncher,
  recencyBoost,
  scoreItem,
  type LauncherItem,
} from "@/lib/launcher";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const item = (id: string, group: LauncherItem["group"], label: string, extra: Partial<LauncherItem> = {}): LauncherItem => ({
  id,
  group,
  label,
  ...extra,
});

describe("fuzzyScore", () => {
  it("ranks exact > prefix > word start > substring > subsequence", () => {
    const exact = fuzzyScore("api", "api")!;
    const prefix = fuzzyScore("api", "api-gateway")!;
    const word = fuzzyScore("api", "payments api")!;
    const inner = fuzzyScore("api", "rapid")!;
    const subseq = fuzzyScore("api", "a place in")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it("returns null when the letters are not all there in order", () => {
    expect(fuzzyScore("xyz", "payments")).toBeNull();
    expect(fuzzyScore("tsp", "stop")).toBeNull();
  });

  it("is case-insensitive on the text (queries are lowercased by scoreItem)", () => {
    expect(scoreItem({ label: "LiquidMoneyApi" }, "LIQUID")).not.toBeNull();
  });
});

describe("scoreItem", () => {
  it("needs every word to match somewhere (label, sub or keywords)", () => {
    const chat = { label: "checkout refactor", sub: "chat · liquidmoneystore", keywords: ["Claude"] };
    expect(scoreItem(chat, "checkout liquid")).not.toBeNull();
    expect(scoreItem(chat, "checkout claude")).not.toBeNull();
    expect(scoreItem(chat, "checkout cursor")).toBeNull();
  });

  it("weighs the label over the sub line and keywords", () => {
    const byLabel = scoreItem({ label: "worker", sub: "k8s" }, "worker")!;
    const bySub = scoreItem({ label: "k8s", sub: "worker" }, "worker")!;
    const byKeyword = scoreItem({ label: "k8s", keywords: ["worker"] }, "worker")!;
    expect(byLabel).toBeGreaterThan(bySub);
    expect(bySub).toBeGreaterThan(byKeyword);
  });
});

describe("recencyBoost", () => {
  it("fades with age and is zero without a time", () => {
    expect(recencyBoost(undefined, NOW)).toBe(0);
    expect(recencyBoost(NOW, NOW)).toBeCloseTo(60);
    expect(recencyBoost(NOW - 12 * 3_600_000, NOW)).toBeCloseTo(30);
    expect(recencyBoost(NOW - 7 * 86_400_000, NOW)).toBeLessThan(5);
  });
});

describe("rankLauncher", () => {
  const items: LauncherItem[] = [
    item("a1", "Actions", "Sync cloud"),
    item("p1", "Projects", "liquidmoneystore", { target: "project:1", recentAt: NOW - 3_600_000 }),
    item("p2", "Projects", "acme-infra", { target: "project:2" }),
    item("r1", "Recent", "liquidmoneystore", { target: "project:1", recentAt: NOW - 3_600_000 }),
    item("c1", "Chats", "checkout refactor", { target: "chat:1", sub: "liquidmoneystore" }),
    item("n1", "Needs you", "LiquidMoneyApi", { sub: "Claude wants to run pnpm migrate" }),
    item("e1", "Elements", "payments", { queryOnly: true }),
    item("e2", "Elements", "api / payments", { queryOnly: true }),
    item("ask", "Actions", "Ask the agent", { always: true }),
  ];

  it("without a query: fixed group order, big lists hidden, Actions last", () => {
    const groups = rankLauncher(items.filter((i) => !i.always), "", { now: NOW });
    expect(groups.map((g) => g.group)).toEqual(["Needs you", "Recent", "Projects", "Chats", "Actions"]);
    expect(groups.some((g) => g.group === "Elements")).toBe(false);
  });

  it("lists a target once, in the first group that shows it (recents first)", () => {
    const groups = rankLauncher(items, "", { now: NOW });
    const projects = groups.find((g) => g.group === "Projects")!;
    expect(projects.items.map((i) => i.id)).toEqual(["p2"]);
    expect(groups.find((g) => g.group === "Recent")!.items.map((i) => i.id)).toEqual(["r1"]);
  });

  it("with a query: only matches, best group first, `always` rows at the end of Actions", () => {
    const groups = rankLauncher(items, "payments", { now: NOW });
    expect(groups[0]!.group).toBe("Elements");
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["e1", "e2"]);
    const last = groups[groups.length - 1]!;
    expect(last.group).toBe("Actions");
    expect(last.items.map((i) => i.id)).toEqual(["ask"]);
  });

  it("puts a prefix match of a recent project above a weaker chat match", () => {
    const flat = flattenRanked(rankLauncher(items, "liquid", { now: NOW }));
    expect(flat[0]!.target).toBe("project:1");
    expect(flat.filter((i) => i.target === "project:1")).toHaveLength(1);
    expect(flat.map((i) => i.id)).toContain("c1");
  });

  it("keeps an `always` row even when nothing else matches", () => {
    const groups = rankLauncher(items, "zzzz", { now: NOW });
    expect(groups).toEqual([{ group: "Actions", items: [items[items.length - 1]] }]);
  });

  it("caps rows per group", () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`c${i}`, "Chats", `chat ${i}`));
    expect(rankLauncher(many, "", { now: NOW })[0]!.items).toHaveLength(4);
    expect(rankLauncher(many, "chat", { now: NOW })[0]!.items).toHaveLength(8);
    expect(rankLauncher(many, "chat", { now: NOW, limits: { Chats: 3 } })[0]!.items).toHaveLength(3);
  });

  it("does not match letters scattered along a sub line (paths), so an action named like the query wins", () => {
    const rows = [
      item("el", "Elements", "acme-prod-db", { sub: "infra/terraform/modules/postgres/main.tf", queryOnly: true }),
      item("open", "Actions", "Open folder…"),
    ];
    const groups = rankLauncher(rows, "open fold", { now: NOW });
    expect(groups.map((g) => g.group)).toEqual(["Actions"]);
    expect(scoreItem({ label: "k8s", sub: "infra/k8s/prod/worker.yaml" }, "prod")).not.toBeNull();
  });

  it("orders equally good matches by recency", () => {
    const rows = [
      item("old", "Chats", "deploy fix", { recentAt: NOW - 30 * 86_400_000 }),
      item("new", "Chats", "deploy fix", { recentAt: NOW - 60_000 }),
    ];
    expect(flattenRanked(rankLauncher(rows, "deploy", { now: NOW })).map((i) => i.id)).toEqual(["new", "old"]);
  });
});

describe("moveActive", () => {
  it("wraps around both ends", () => {
    expect(moveActive(3, 2, 1)).toBe(0);
    expect(moveActive(3, 0, -1)).toBe(2);
    expect(moveActive(0, 0, 1)).toBe(0);
  });
});
