// Multi-repo systems in the viewer's pure map logic: the top level is one node per repo
// plus shared infra with the cross-repo edges, drilling into a repo shows its own map,
// namespaced ids (`repo:node`) survive diagram ids, breadcrumbs (ancestry) and search;
// evidence strings open the code panel at the right line.
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildSystemArchitecture } from "../../src/system/index.js";
import type { Architecture } from "../src/lib/contracts";
import { ancestry, homeDiagramId, indexArchitecture, levelDiagramId, parseDiagramId, toGraph } from "../src/lib/architecture";
import { searchNodes } from "../src/components/editor/canvas/view-model";
import { parseEvidence } from "../src/lib/system";

const arch = buildSystemArchitecture(join(import.meta.dirname, "..", "..", "test", "fixtures", "system")).architecture as unknown as Architecture;

describe("system map in the viewer", () => {
  test("top level: repos + shared infra with cross-repo edges; a repo drills into its own map", () => {
    const top = toGraph(arch, null);
    expect(top.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["web", "invoices-api", "notify-worker", "infra", "postgres", "kafka"]));
    expect(top.nodes.some((n) => n.id.includes(":"))).toBe(false);
    expect(top.edges.some((e) => e.from === "invoices-api" && e.to === "notify-worker")).toBe(true);
    const repo = toGraph(arch, "invoices-api");
    expect(repo.id).toBe("arch:invoices-api");
    expect(repo.nodes.map((n) => n.id)).toContain("invoices-api:acme-invoices-api");
    expect(repo.nodes.every((n) => n.id.startsWith("invoices-api:"))).toBe(true);
  });

  test("namespaced ids: diagram ids round-trip, breadcrumbs, home diagram, search", () => {
    const id = "invoices-api:acme-invoices-api";
    expect(parseDiagramId(levelDiagramId(id))).toEqual({ mode: "architecture", parentId: id });
    const index = indexArchitecture(arch);
    expect(ancestry(index, id).map((n) => n.id)).toEqual(["invoices-api", id]);
    expect(homeDiagramId(arch, id, index)).toBe("arch:invoices-api");
    const level = toGraph(arch, "invoices-api");
    expect(searchNodes(level.nodes, "acme-invoices")[0]).toBe(id);
  });

  test("evidence → path + line range", () => {
    expect(parseEvidence("web/src/api.js:4")).toEqual({ path: "web/src/api.js", range: [4, 4] });
    expect(parseEvidence("infra/k8s/a.yaml:3-9")).toEqual({ path: "infra/k8s/a.yaml", range: [3, 9] });
    expect(parseEvidence("README.md")).toEqual({ path: "README.md", range: null });
  });
});
