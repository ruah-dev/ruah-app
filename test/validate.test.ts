import { expect, test } from "vitest";
import { validateArchitecture } from "../src/contracts/validate.js";
import type { Architecture } from "../src/contracts/architecture.js";

const EXAMPLE: Architecture = {
  version: 1,
  name: "acme-platform",
  generatedBy: "ruah app scan 0.1.0",
  generatedAt: "2026-09-16T10:00:00Z",
  layers: ["clients", "edge", "services", "data", "third-party"],
  nodes: [
    { id: "web", type: "frontend", name: "web-app", layer: "clients",
      path: "apps/web", tech: ["React 19", "TanStack Router"],
      description: "Customer-facing dashboard. Renders invoices, billing and org settings.",
      files: ["apps/web/src/routes/invoices.tsx", "apps/web/src/lib/api-client.ts"] },
    { id: "gateway", type: "gateway", name: "api-gateway", layer: "edge",
      path: "infra/gateway", tech: ["Envoy"],
      description: "Terminates TLS, validates JWTs and routes /v1/* to services." },
    { id: "api", type: "service", name: "invoices-api", layer: "services",
      path: "services/invoices-api", tech: ["Node 22", "Express", "Zod"],
      description: "Core business service. Handles invoice CRUD, validation and emits domain events.",
      notes: "Validation lives in routes/, not in the service layer. Known flaky: currency enum.",
      files: [
        "services/invoices-api/src/app.ts",
        "services/invoices-api/src/routes/invoices/invoices.routes.ts",
        "services/invoices-api/src/routes/invoices/invoices.service.ts",
        "services/invoices-api/src/repositories/invoices.repo.ts",
      ] },
    { id: "api-routes", type: "module", name: "routes", parent: "api",
      path: "services/invoices-api/src/routes",
      description: "Express routers and Zod request schemas." },
    { id: "api-repo", type: "module", name: "repositories", parent: "api",
      path: "services/invoices-api/src/repositories",
      description: "SQL access. Only place that writes invoices." },
    { id: "db", type: "datastore", name: "postgres", layer: "data",
      tech: ["Postgres 16"], description: "Primary relational store." },
    { id: "bus", type: "queue", name: "events-bus", layer: "data",
      tech: ["SQS"], description: "Durable pub/sub for invoice.* topics." },
    { id: "stripe", type: "external", name: "Stripe", layer: "third-party",
      description: "Payment provider." },
    { id: "w-validate", type: "step", name: "Validate", description: "Zod schema check." },
    { id: "w-persist", type: "step", name: "Insert row" },
  ],
  edges: [
    { from: "web", to: "gateway", label: "REST", kind: "sync" },
    { from: "gateway", to: "api", label: "/v1/invoices", kind: "sync" },
    { from: "api", to: "db", label: "sql", kind: "data" },
    { from: "api", to: "bus", label: "invoice.created", kind: "event" },
    { from: "api", to: "stripe", label: "charge", kind: "sync" },
    { from: "api-routes", to: "api-repo", label: "calls", kind: "sync" },
  ],
  workflows: [
    { id: "create-invoice", name: "Create invoice", description: "POST /v1/invoices end to end",
      steps: ["web", "gateway", "api", "w-validate", "w-persist", "db", "bus"] },
  ],
};

function clone(): Architecture {
  return structuredClone(EXAMPLE);
}

test("§1.4 example validates with zero errors", () => {
  const r = validateArchitecture(EXAMPLE);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.warnings).toEqual([]);
});

test("rule 1: version must be 1", () => {
  const a = clone() as unknown as Record<string, unknown>;
  a.version = 2;
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("version"))).toBe(true);
});

test("rule 2a: duplicate node ids rejected", () => {
  const a = clone();
  a.nodes.push({ ...a.nodes[0]!, id: "api" });
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("duplicate node id"))).toBe(true);
});

test("rule 2b: edge referencing unknown node rejected", () => {
  const a = clone();
  a.edges.push({ from: "web", to: "nope" });
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("unknown node: nope"))).toBe(true);
});

test("rule 2c: parent referencing unknown node rejected", () => {
  const a = clone();
  a.nodes[3]!.parent = "ghost";
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("parent references unknown"))).toBe(true);
});

test("rule 2d: workflow step referencing unknown node rejected", () => {
  const a = clone();
  a.workflows[0]!.steps.push("ghost");
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("step references unknown"))).toBe(true);
});

test("rule 3: parent cycle rejected", () => {
  const a = clone();
  a.nodes[0]!.parent = "api-routes"; // web -> api-routes -> api -> ... cycle back
  a.nodes[3]!.parent = "web";
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("cycle"))).toBe(true);
});

test("rule 4: unknown layer rejected when layers present", () => {
  const a = clone();
  a.nodes[0]!.layer = "nope";
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes('layer "nope"'))).toBe(true);
});

test("rule 5: path escaping the repo rejected", () => {
  const a = clone();
  a.nodes[0]!.path = "../outside";
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("path escapes repo"))).toBe(true);
});

test("rule 5b: absolute path rejected", () => {
  const a = clone();
  a.nodes[0]!.files = ["/etc/passwd"];
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("file escapes repo"))).toBe(true);
});

test("rule 6a: self-edge rejected", () => {
  const a = clone();
  a.edges.push({ from: "api", to: "api" });
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("self-edge"))).toBe(true);
});

test("rule 6b: duplicate (from,to,label) rejected", () => {
  const a = clone();
  a.edges.push({ from: "web", to: "gateway", label: "REST" });
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("duplicate edge"))).toBe(true);
});

test("rule 7: workflow with fewer than 2 steps rejected", () => {
  const a = clone();
  a.workflows.push({ id: "tiny", name: "Tiny", steps: ["web"] });
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("needs >= 2 steps"))).toBe(true);
});

test("warning: description over 400 chars", () => {
  const a = clone();
  a.nodes[0]!.description = "x".repeat(401);
  const r = validateArchitecture(a);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.warnings.some((w) => w.includes("description over 400"))).toBe(true);
});

test("warning: files over 20", () => {
  const a = clone();
  a.nodes[0]!.files = Array.from({ length: 21 }, (_, i) => `apps/web/src/f${i}.ts`);
  const r = validateArchitecture(a);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.warnings.some((w) => w.includes("files over 20"))).toBe(true);
});

test("warning: path does not exist on disk (root given)", () => {
  const a = clone();
  a.nodes[0]!.path = "apps/web";
  const r = validateArchitecture(a, import.meta.dirname);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.warnings.some((w) => w.includes("does not exist on disk"))).toBe(true);
});

test("id pattern enforced", () => {
  const a = clone();
  a.nodes[0]!.id = "Bad Id";
  const r = validateArchitecture(a);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.includes("id must match"))).toBe(true);
});
