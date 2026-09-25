import { describe, expect, it } from "vitest";
import type { Architecture, ArchNode } from "../src/contracts/architecture.js";
import { BAND_GAP, COL_W, layoutArchitecture, MAX_PER_ROW, ROW_H } from "../src/scan/layout.js";

const node = (id: string, layer: string, xy?: { x: number; y: number }): ArchNode => ({ id, type: "service", name: id, layer, ...(xy ?? {}) });

function overlaps(a: ArchNode, b: ArchNode): boolean {
  return Math.abs((a.x ?? 0) - (b.x ?? 0)) < COL_W && Math.abs((a.y ?? 0) - (b.y ?? 0)) < ROW_H;
}

describe("layoutArchitecture", () => {
  it("lays a fresh map out band by band", () => {
    const arch: Architecture = {
      version: 1,
      name: "x",
      layers: ["a", "b"],
      nodes: [node("a1", "a"), ...Array.from({ length: 7 }, (_, i) => node(`b${i}`, "b"))],
      edges: [],
      workflows: [],
    };
    const out = layoutArchitecture(arch);
    const by = new Map(out.nodes.map((n) => [n.id, n]));
    expect(by.get("a1")).toMatchObject({ x: 0, y: 0 });
    expect(by.get("b0")).toMatchObject({ x: 0, y: ROW_H + BAND_GAP });
    expect(by.get(`b${MAX_PER_ROW}`)).toMatchObject({ x: 0, y: 2 * ROW_H + BAND_GAP });
  });

  // Regression: a map made before IaC scanning, re-scanned: the new "infra"
  // band was laid out as if the map were fresh and landed on the kept
  // "packages" band (both at y 340), so the two lanes overlapped on the canvas.
  it("never puts new nodes on kept ones (a new IaC lane on an old map)", () => {
    const arch: Architecture = {
      version: 1,
      name: "x",
      layers: ["apps", "services", "infra", "packages", "data"],
      nodes: [
        node("web", "apps", { x: 0, y: 0 }),
        node("api", "services", { x: 0, y: 170 }),
        ...Array.from({ length: 5 }, (_, i) => node(`pkg${i}`, "packages", { x: i * COL_W, y: 340 })),
        node("db", "data", { x: 0, y: 510 }),
        ...Array.from({ length: 8 }, (_, i) => node(`tf${i}`, "infra")),
        node("worker", "services"),
      ],
      edges: [],
      workflows: [],
    };
    const out = layoutArchitecture(arch);
    for (const a of out.nodes) {
      for (const b of out.nodes) if (a !== b) expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
    }
    const by = new Map(out.nodes.map((n) => [n.id, n]));
    // Kept positions are untouched.
    expect(by.get("pkg2")).toMatchObject({ x: 2 * COL_W, y: 340 });
    // A new member of an existing lane extends it on the same row.
    expect(by.get("worker")).toMatchObject({ x: COL_W, y: 170 });
    // The new lane sits below everything the level had.
    const infra = out.nodes.filter((n) => n.layer === "infra");
    expect(Math.min(...infra.map((n) => n.y ?? 0))).toBeGreaterThanOrEqual(510 + ROW_H + BAND_GAP);
  });

  it("lays out each drill level on its own", () => {
    const arch: Architecture = {
      version: 1,
      name: "x",
      layers: ["a"],
      nodes: [node("p", "a", { x: 0, y: 0 }), { ...node("c1", "a"), parent: "p" }, { ...node("c2", "a"), parent: "p" }],
      edges: [],
      workflows: [],
    };
    const by = new Map(layoutArchitecture(arch).nodes.map((n) => [n.id, n]));
    expect(by.get("c1")).toMatchObject({ x: 0, y: 0 });
    expect(by.get("c2")).toMatchObject({ x: COL_W, y: 0 });
  });
});
