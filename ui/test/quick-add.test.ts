// Regression: clicking an element kind in the Edit palette put the new element at a fixed spot
// (stored 32,32) — on top of the level's first element, which the daemon lays out at 0,0 — and
// saved it there. It now goes to the right of everything on that level.
import { describe, expect, it } from "vitest";
import { addNode, quickAddPosition } from "@/lib/architecture-edit";
import { NODE_W, ORIGIN, ROOT_DIAGRAM_ID } from "@/lib/architecture";
import type { Architecture } from "@/lib/contracts";

const arch: Architecture = {
  version: 1,
  name: "site",
  nodes: [
    { id: "site", type: "module", name: "site", layer: "entry", x: 0, y: 0 },
    { id: "api", type: "service", name: "api", x: 260, y: 120 },
    { id: "db", type: "datastore", name: "db", parent: "api", x: 0, y: 0 },
  ],
  edges: [],
  workflows: [],
};

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < 64;

describe("palette quick add", () => {
  it("lands right of the level's elements, never on one", () => {
    const at = quickAddPosition(arch, null);
    expect(at).toEqual({ x: ORIGIN + 260 + NODE_W + 48, y: ORIGIN + 0 });
    const next = addNode(arch, ROOT_DIAGRAM_ID, { id: "service-x", label: "New service", subtitle: "", kind: "service", x: at.x, y: at.y });
    const created = next?.nodes.find((n) => n.id === "service-x");
    expect(created).toMatchObject({ x: 260 + NODE_W + 48, y: 0 });
    for (const n of arch.nodes.filter((m) => m.parent === undefined)) expect(overlaps({ x: created!.x!, y: created!.y! }, { x: n.x!, y: n.y! })).toBe(false);
  });

  it("uses only the level it is added to; an empty level starts near its corner", () => {
    expect(quickAddPosition(arch, "api")).toEqual({ x: ORIGIN + NODE_W + 48, y: ORIGIN });
    expect(quickAddPosition(arch, "site")).toEqual({ x: ORIGIN + 32, y: ORIGIN + 32 });
  });
});
