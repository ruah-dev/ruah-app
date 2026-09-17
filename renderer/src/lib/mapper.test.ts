import { describe, expect, it } from "vitest";
import type { Architecture } from "./contract/index.js";
import { toGraph, workflowGraph } from "./mapper.js";
import { toRepoTree } from "./repoTree.js";

// CONTRACTS.md §1.4 example, trimmed to the fields the mapper reads.
const ARCH: Architecture = {
  version: 1,
  name: "acme-platform",
  layers: ["clients", "edge", "services", "data"],
  nodes: [
    { id: "web", type: "frontend", name: "web-app", layer: "clients", path: "apps/web",
      tech: ["React 19", "TanStack Router"], files: ["apps/web/src/routes/invoices.tsx"] },
    { id: "gateway", type: "gateway", name: "api-gateway", layer: "edge", path: "infra/gateway" },
    { id: "api", type: "service", name: "invoices-api", layer: "services",
      path: "services/invoices-api", tech: ["Node 22", "Express", "Zod"],
      files: ["services/invoices-api/src/app.ts", "services/invoices-api/src/repositories/invoices.repo.ts"] },
    { id: "api-routes", type: "module", name: "routes", parent: "api", path: "services/invoices-api/src/routes" },
    { id: "db", type: "datastore", name: "postgres", layer: "data", tech: ["Postgres 16"] },
    { id: "bus", type: "queue", name: "events-bus", layer: "data" },
  ],
  edges: [
    { from: "web", to: "gateway", label: "REST", kind: "sync" },
    { from: "api", to: "db", label: "sql", kind: "data" },
    { from: "api", to: "bus", label: "invoice.created", kind: "event" },
    { from: "api-routes", to: "db", label: "hidden below" },
  ],
  workflows: [
    { id: "create-invoice", name: "Create invoice", steps: ["web", "gateway", "api", "db"] },
  ],
};

describe("toGraph", () => {
  it("shows only root-level nodes at the root", () => {
    const graph = toGraph(ARCH, null);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["api", "bus", "db", "gateway", "web"]);
  });

  it("maps datastore -> database and unknown types -> module", () => {
    const graph = toGraph(ARCH, null);
    const db = graph.nodes.find((n) => n.id === "db");
    expect(db?.kind).toBe("database");
    const typed: Architecture = { ...ARCH, nodes: [{ id: "x", type: "weird", name: "w" }] };
    expect(toGraph(typed, null).nodes[0]?.kind).toBe("module");
  });

  it("derives drill from children and subtitle from tech or path", () => {
    const graph = toGraph(ARCH, null);
    const api = graph.nodes.find((n) => n.id === "api");
    expect(api?.drill).toBe(true);
    expect(api?.subtitle).toBe("Node 22 · Express");
    const db = graph.nodes.find((n) => n.id === "db");
    expect(db?.drill).toBe(false);
    const gateway = graph.nodes.find((n) => n.id === "gateway");
    expect(gateway?.subtitle).toBe("infra/gateway");
  });

  it("shows child nodes only inside their parent", () => {
    const inner = toGraph(ARCH, "api");
    expect(inner.nodes.map((n) => n.id)).toEqual(["api-routes"]);
  });

  it("includes only edges whose both ends are visible", () => {
    const root = toGraph(ARCH, null);
    expect(root.edges).toHaveLength(3);
    const inner = toGraph(ARCH, "api");
    expect(inner.edges).toHaveLength(0);
  });

  it("animates async and event edges only", () => {
    const root = toGraph(ARCH, null);
    const sync = root.edges.find((e) => e.label === "REST");
    const event = root.edges.find((e) => e.label === "invoice.created");
    expect(sync?.animated ?? false).toBe(false);
    expect(event?.animated ?? false).toBe(true);
  });

  it("builds one group per layer with a padded bounding box", () => {
    const graph = toGraph(ARCH, null);
    const data = graph.groups?.find((g) => g.id === "data");
    expect(data).toBeDefined();
    expect(data!.w).toBeGreaterThan(0);
    expect(graph.groups?.some((g) => g.id === "clients")).toBe(true);
  });
});

describe("workflowGraph", () => {
  it("lays steps left to right with sequential animated edges", () => {
    const graph = workflowGraph(ARCH, "create-invoice");
    expect(graph.nodes.map((n) => n.id)).toEqual(["web", "gateway", "api", "db"]);
    expect(graph.edges).toEqual([
      { from: "web", to: "gateway", animated: true },
      { from: "gateway", to: "api", animated: true },
      { from: "api", to: "db", animated: true },
    ]);
    expect(graph.nodes[0]!.x).toBe(0);
    expect(graph.nodes[1]!.x).toBe(260);
  });
});

describe("toRepoTree", () => {
  it("builds a sorted tree with node ids on leaves", () => {
    const tree = toRepoTree(ARCH);
    const apps = tree.find((n) => n.name === "apps");
    expect(apps?.kind).toBe("dir");
    const invoices = apps?.children
      ?.find((c) => c.name === "web")
      ?.children?.find((c) => c.name === "src")
      ?.children?.find((c) => c.name === "routes")
      ?.children?.find((c) => c.name === "invoices.tsx");
    expect(invoices?.nodeId).toBe("web");
    const services = tree.find((n) => n.name === "services");
    const appTs = services?.children
      ?.find((c) => c.name === "invoices-api")
      ?.children?.find((c) => c.name === "src")
      ?.children?.find((c) => c.name === "app.ts");
    expect(appTs?.nodeId).toBe("api");
  });

  it("places dirs before files and sorts alphabetically", () => {
    const tree = toRepoTree(ARCH);
    const names = tree.map((n) => n.name);
    expect(names).toEqual(["apps", "infra", "services"]);
  });
});
