// Viewer map logic (pure modules under ui/src): edge routing avoids cards, filters / hops /
// collapsed groups, search, keyboard neighbour, expansion merge into toGraph, and "Pin to map"
// output that the daemon's validator accepts.
import { describe, expect, test } from "vitest";
import { validateArchitecture } from "../../src/contracts/validate.js";
import type { Architecture } from "../src/lib/contracts";
import type { DiagramEdge, DiagramNode } from "../src/data/graphs";
import { routeEdges } from "../src/components/editor/canvas/routing";
import { buildViewModel, NO_FILTERS, searchNodes, groupNodeId } from "../src/components/editor/canvas/view-model";
import { fitCamera, lodFor, nearestInDirection, neighbourhood, type Box } from "../src/components/editor/canvas/geometry";
import { mergeExpansions, type Expansion, type ExpansionState } from "../src/lib/expand";
import { toGraph } from "../src/lib/architecture";
import { pinExpansion } from "../src/lib/pin";

const node = (id: string, x: number, y: number, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  label: id,
  kind: "service",
  x,
  y,
  ...extra,
});

/** Points of an "M x y L x y Q …" path, including curve control points. */
function points(d: string): { x: number; y: number }[] {
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i]!, y: nums[i + 1]! });
  return out;
}

describe("routing", () => {
  test("a same-row edge detours around the card in between", () => {
    const boxes = new Map<string, Box>([
      ["a", { x: 0, y: 0, w: 200, h: 64 }],
      ["mid", { x: 260, y: 0, w: 200, h: 64 }],
      ["b", { x: 520, y: 0, w: 200, h: 64 }],
    ]);
    const [r] = routeEdges(boxes, [{ from: "a", to: "b" }]);
    expect(r).toBeTruthy();
    const mid = boxes.get("mid")!;
    // No segment passes through the middle card: every point of the route is outside it, and
    // the route leaves the row (goes above or below it).
    const pts = points(r!.d);
    expect(pts.some((p) => p.y < 0 || p.y > 64)).toBe(true);
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      const crosses =
        Math.max(p.x, q.x) > mid.x + 2 && Math.min(p.x, q.x) < mid.x + mid.w - 2 && Math.max(p.y, q.y) > mid.y + 2 && Math.min(p.y, q.y) < mid.y + mid.h - 2;
      expect(crosses).toBe(false);
    }
  });

  test("adjacent cards get a straight link; ports spread on a shared side", () => {
    const boxes = new Map<string, Box>([
      ["a", { x: 0, y: 0, w: 200, h: 64 }],
      ["b", { x: 260, y: 0, w: 200, h: 64 }],
      ["c", { x: 260, y: 110, w: 200, h: 64 }],
    ]);
    const [ab, ac] = routeEdges(boxes, [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]);
    const start = (d: string) => points(d)[0]!;
    expect(start(ab!.d).x).toBe(200);
    expect(start(ac!.d).x).toBe(200);
    expect(start(ab!.d).y).toBeLessThan(start(ac!.d).y); // ordered by where the other end is
  });
});

describe("view model", () => {
  const nodes = [
    node("web", 0, 0, { layer: "apps", kind: "frontend" }),
    node("api", 260, 0, { layer: "apps" }),
    node("db", 0, 110, { layer: "data", kind: "database" }),
    node("cache", 260, 110, { layer: "data", kind: "cache" }),
    node("far", 520, 110, { layer: "data" }),
  ];
  const edges: DiagramEdge[] = [
    { from: "web", to: "api" },
    { from: "api", to: "db", label: "sql" },
    { from: "api", to: "cache" },
    { from: "db", to: "far" },
  ];

  test("kind filters and n-hop focus", () => {
    const f = buildViewModel(nodes, edges, [], { ...NO_FILTERS, hiddenKinds: new Set(["cache"]) }, null);
    expect(f.nodes.map((n) => n.id)).toEqual(["web", "api", "db", "far"]);
    expect(f.hidden).toBe(1);
    const one = buildViewModel(nodes, edges, [], { ...NO_FILTERS, hops: 1 }, "web");
    expect(one.nodes.map((n) => n.id).sort()).toEqual(["api", "web"]);
    const two = buildViewModel(nodes, edges, [], { ...NO_FILTERS, hops: 2 }, "web");
    expect(two.nodes.map((n) => n.id).sort()).toEqual(["api", "cache", "db", "web"]);
    expect(neighbourhood(edges, "far", 1)).toEqual(new Set(["far", "db"]));
  });

  test("a collapsed layer folds into one card with merged edges", () => {
    const vm = buildViewModel(nodes, edges, [], { ...NO_FILTERS, collapsedLayers: new Set(["data"]) }, null);
    const group = groupNodeId("data");
    expect(vm.nodes.map((n) => n.id).sort()).toEqual([group, "api", "web"].sort());
    expect(vm.nodes.find((n) => n.id === group)?.childCount).toBe(3);
    const merged = vm.edges.find((e) => e.from === "api" && e.to === group);
    expect(merged?.weight).toBe(2);
    expect(merged?.label).toBe("2 links");
    expect(vm.edges.some((e) => e.from === group && e.to === group)).toBe(false);
  });

  test("search ranks exact and prefix matches first", () => {
    const n = [node("a", 0, 0, { label: "payments-api" }), node("b", 0, 0, { label: "api" }), node("c", 0, 0, { label: "x", path: "services/api" })];
    expect(searchNodes(n, "api")).toEqual(["b", "a", "c"]);
    expect(searchNodes(n, "  ")).toEqual([]);
  });

  test("arrow keys pick the nearest element in that direction", () => {
    expect(nearestInDirection(nodes, "web", "right")).toBe("api");
    expect(nearestInDirection(nodes, "web", "down")).toBe("db");
    expect(nearestInDirection(nodes, "web", "left")).toBeNull();
  });

  test("fit and level of detail", () => {
    const cam = fitCamera({ x: 0, y: 0, w: 1000, h: 500 }, 1100, 700, { pad: 50, maxK: 1 });
    expect(cam.k).toBe(1);
    expect(fitCamera({ x: 0, y: 0, w: 10_000, h: 5_000 }, 1100, 700, { pad: 50 }).k).toBeCloseTo(0.1, 2);
    expect([lodFor(1), lodFor(0.35), lodFor(0.1)]).toEqual(["full", "compact", "tiny"]);
  });
});

const ARCH: Architecture = {
  version: 1,
  name: "web",
  layers: ["apps"],
  nodes: [
    { id: "web", type: "frontend", name: "web", path: "src", layer: "apps", x: 0, y: 0 },
    { id: "db", type: "datastore", name: "db", layer: "apps", x: 260, y: 0 },
  ],
  edges: [{ from: "web", to: "db" }],
  workflows: [],
};

const EXP: Expansion = {
  nodeId: "web",
  level: "folder",
  path: "src",
  architecture: {
    version: 1,
    name: "src",
    layers: ["folders", "files"],
    nodes: [
      { id: "web/components", type: "module", name: "components", path: "src/components", layer: "folders", expandable: true, childCount: 3, x: 0, y: 0, files: ["src/components/App.tsx"] },
      { id: "web/main/java", type: "module", name: "main/java", path: "src/main/java", layer: "folders", expandable: true, childCount: 1, x: 260, y: 0 },
      { id: "web/index.ts", type: "file", name: "index.ts", path: "src/index.ts", layer: "files", expandable: true, childCount: 2, x: 0, y: 170 },
    ],
    edges: [{ from: "web/index.ts", to: "web/components", label: "imports", kind: "sync", source: "scan", weight: 2 }],
    workflows: [],
  },
  truncated: { children: false, edges: false, files: false },
  total: { children: 3, edges: 1 },
  ms: 1,
};

function stateWith(entries: [string, Expansion][], peeks: [string, number | null][] = []): ExpansionState {
  return {
    scope: "p",
    origin: "http://x",
    entries: new Map(entries.map(([id, e]) => [id, { status: "ok" as const, expansion: e, at: 0 }])),
    peeks: new Map(peeks),
    positions: new Map([["web/components", { x: 40, y: 8 }]]),
    version: entries.length + peeks.length + 1,
  };
}

describe("expansions in the map", () => {
  test("peeks make a stored leaf drillable; a loaded expansion becomes its level", () => {
    const peeked = mergeExpansions(ARCH, stateWith([], [["web", 3]]));
    const top = toGraph(peeked, null);
    expect(top.nodes.find((n) => n.id === "web")).toMatchObject({ drill: "arch:web", childCount: 3 });
    expect(top.nodes.find((n) => n.id === "db")?.drill).toBeUndefined();

    const merged = mergeExpansions(ARCH, stateWith([["web", EXP]]));
    const level = toGraph(merged, "web");
    expect(level.nodes.map((n) => n.id)).toEqual(["web/components", "web/main/java", "web/index.ts"]);
    expect(level.nodes[0]).toMatchObject({ ephemeral: true, drill: "arch:web/components", childCount: 3, subtitle: "3 items" });
    expect(level.nodes[0]!.x).toBe(40 + 48); // moved locally (+ ORIGIN)
    expect(level.edges).toEqual([expect.objectContaining({ from: "web/index.ts", to: "web/components", weight: 2 })]);
    expect(merged.nodes.length).toBe(5);
  });

  test("an element with stored children ignores its expansion (pinned)", () => {
    const pinned: Architecture = { ...ARCH, nodes: [...ARCH.nodes, { id: "web.x", type: "module", name: "x", parent: "web" }] };
    const merged = mergeExpansions(pinned, stateWith([["web", EXP]]));
    expect(merged.nodes.map((n) => n.id)).toEqual(["web", "db", "web.x"]);
  });

  test("Pin to map writes valid stored nodes and scan edges", () => {
    const r = pinExpansion(ARCH, EXP, new Map([["web/components", { x: 40, y: 8 }]]));
    if ("error" in r) throw new Error(r.error);
    const added = r.arch.nodes.filter((n) => n.parent === "web");
    expect(added.map((n) => n.id)).toEqual(["web.components", "web.main.java", "web.index.ts"]);
    expect(added[0]).toMatchObject({ x: 40, y: 8, layer: "folders", path: "src/components" });
    expect(r.arch.edges.at(-1)).toEqual({ from: "web.index.ts", to: "web.components", label: "imports", kind: "sync", source: "scan" });
    expect(r.arch.layers).toEqual(["apps", "folders", "files"]);
    const v = validateArchitecture(r.arch, "/nonexistent-root");
    expect(v.ok).toBe(true);

    expect(pinExpansion(r.arch, EXP)).toEqual({ error: "This element already has stored children." });
    expect("error" in pinExpansion(ARCH, { ...EXP, nodeId: "web/components" })).toBe(true);
    expect("error" in pinExpansion(ARCH, { ...EXP, level: "file" })).toBe(true);
  });

  test("pinned ids keep a system namespace", () => {
    const sys: Architecture = { ...ARCH, nodes: [{ id: "api:web", type: "module", name: "web", path: "api/src", repo: "api" }], edges: [] };
    const r = pinExpansion(sys, { ...EXP, nodeId: "api:web" });
    if ("error" in r) throw new Error(r.error);
    expect(r.arch.nodes.filter((n) => n.parent === "api:web").map((n) => `${n.id}|${n.repo}`)).toEqual([
      "api:web.components|api",
      "api:web.main.java|api",
      "api:web.index.ts|api",
    ]);
  });
});
