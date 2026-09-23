import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArchIndex } from "../src/context/graph.js";
import { buildContextPack, buildPromptBlocks } from "../src/context/pack.js";
import type { Architecture } from "../src/contracts/architecture.js";

const ROOT = "/Users/petre/code/acme-platform";
const arch = JSON.parse(
  readFileSync(join(import.meta.dirname, "golden", "architecture.json"), "utf8"),
) as Architecture;
const index = new ArchIndex(arch, ROOT);
const GOLDEN = readFileSync(join(import.meta.dirname, "golden", "context-api.txt"), "utf8");

test("§3.4 golden: byte-for-byte for node api with the example user text", () => {
  const pack = buildContextPack(index, "api", ROOT, "there might be a bug in how invoices are validated");
  expect(pack).toBe(GOLDEN);
});

test("GET /api/context form (no user text) matches the golden up to the prompt paragraph", () => {
  const pack = buildContextPack(index, "api", ROOT);
  expect(pack + "\n\nthere might be a bug in how invoices are validated").toBe(GOLDEN);
});

test("§3.4 golden byte-for-byte without any user text argument", () => {
  const pack = buildContextPack(index, "api", ROOT);
  expect(pack).toBe(GOLDEN.replace(/\n\nthere might be a bug in how invoices are validated$/, ""));
});

test("node with no edges, no files, no workflows: only node/path/description lines", () => {
  const bare: Architecture = {
    version: 1,
    name: "tiny",
    nodes: [{ id: "solo", type: "module", name: "Solo", path: "src", description: "A lone module." }],
    edges: [],
    workflows: [],
  };
  const idx = new ArchIndex(bare, "/repo");
  const pack = buildContextPack(idx, "solo", "/repo");
  expect(pack).toBe(
    [
      "[ruah context]",
      "node: Solo (module) id=solo",
      "path: src",
      "description: A lone module.",
      "[/ruah context]",
      "",
      "The user selected the node above on an architecture diagram of the repository at /repo. Treat that node as the scope of the request. Open the listed path and files first; search elsewhere only if they do not answer the question. If you change files outside this node, say so explicitly.",
    ].join("\n"),
  );
});

test("notes truncated at 600 chars with ellipsis", () => {
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [{ id: "n", type: "module", name: "N", notes: "x".repeat(601) }],
    edges: [],
    workflows: [],
  };
  const idx = new ArchIndex(a, "/r");
  const pack = buildContextPack(idx, "n", "/r");
  expect(pack).toContain("notes: " + "x".repeat(600) + "…");
  expect(pack).not.toContain("x".repeat(601));
});

test("description truncated at 400 chars with ellipsis", () => {
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [{ id: "n", type: "module", name: "N", description: "y".repeat(401) }],
    edges: [],
    workflows: [],
  };
  const idx = new ArchIndex(a, "/r");
  const pack = buildContextPack(idx, "n", "/r");
  expect(pack).toContain("description: " + "y".repeat(400) + "…");
});

test("15 files -> 12 listed plus '- +3 more'", () => {
  const files = Array.from({ length: 15 }, (_, i) => `f/${i}.ts`);
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [{ id: "n", type: "module", name: "N", files }],
    edges: [],
    workflows: [],
  };
  const idx = new ArchIndex(a, "/r");
  const pack = buildContextPack(idx, "n", "/r");
  for (let i = 0; i < 12; i++) expect(pack).toContain(`- f/${i}.ts`);
  expect(pack).toContain("- +3 more");
  expect(pack).not.toContain("- f/12.ts");
});

test("workflow first-step and last-step forms", () => {
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [
      { id: "a", type: "step", name: "First" },
      { id: "b", type: "step", name: "Mid" },
      { id: "c", type: "step", name: "End" },
    ],
    edges: [],
    workflows: [{ id: "wf", name: "Pipeline", steps: ["a", "b", "c"] }],
  };
  const idx = new ArchIndex(a, "/r");
  expect(buildContextPack(idx, "a", "/r")).toContain("workflows:\n- Pipeline: step 1 of 3 (THIS -> Mid)");
  expect(buildContextPack(idx, "b", "/r")).toContain("workflows:\n- Pipeline: step 2 of 3 (First -> THIS -> End)");
  expect(buildContextPack(idx, "c", "/r")).toContain("workflows:\n- Pipeline: step 3 of 3 (Mid -> THIS)");
});

test("description newline and whitespace collapsing", () => {
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [{ id: "n", type: "module", name: "N", description: "line one\nline  two\tthree" }],
    edges: [],
    workflows: [],
  };
  const idx = new ArchIndex(a, "/r");
  const pack = buildContextPack(idx, "n", "/r");
  expect(pack).toContain("description: line one line two three");
});

test("user text with no trailing newline", () => {
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [{ id: "n", type: "module", name: "N" }],
    edges: [],
    workflows: [],
  };
  const idx = new ArchIndex(a, "/r");
  const pack = buildContextPack(idx, "n", "/r", "hello world");
  expect(pack.endsWith("hello world")).toBe(true);
  expect(pack.endsWith("hello world\n")).toBe(false);
});

test("neighbors: unique, incoming before outgoing, max 12", () => {
  const a: Architecture = {
    version: 1,
    name: "t",
    nodes: [
      { id: "self", type: "service", name: "Self" },
      { id: "in1", type: "service", name: "In1" },
      { id: "out1", type: "service", name: "Out1" },
      { id: "dup", type: "service", name: "Dup" },
    ],
    edges: [
      { from: "in1", to: "self" },
      { from: "self", to: "dup" },
      { from: "dup", to: "self" },
      { from: "self", to: "in1" },
    ],
    workflows: [],
  };
  const idx = new ArchIndex(a, "/r");
  const pack = buildContextPack(idx, "self", "/r");
  expect(pack).toContain("neighbors: In1, Dup");
});

test("buildPromptBlocks: one resource_link per file, file:// URIs, text block last", () => {
  const blocks = buildPromptBlocks(
    GOLDEN,
    arch.nodes.find((n) => n.id === "api")?.files ?? [],
    ROOT,
    true,
  );
  expect(blocks).toHaveLength(5);
  expect(blocks[4]).toEqual({ type: "text", text: GOLDEN });
  expect(blocks[0]).toEqual({
    type: "resource_link",
    uri: "file:///Users/petre/code/acme-platform/services/invoices-api/src/app.ts",
    name: "services/invoices-api/src/app.ts",
  });
});

test("buildPromptBlocks with links=false yields only the text block", () => {
  const blocks = buildPromptBlocks("pack", ["a.ts"], "/r", false);
  expect(blocks).toEqual([{ type: "text", text: "pack" }]);
});

test("buildPromptBlocks caps links at 12", () => {
  const files = Array.from({ length: 15 }, (_, i) => `f/${i}.ts`);
  const blocks = buildPromptBlocks("pack", files, "/r", true);
  expect(blocks).toHaveLength(13);
});
