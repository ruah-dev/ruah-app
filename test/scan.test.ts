// `archmap scan` (PLAN.md Phase 2): fixture repos under test/fixtures/scan/
// → node/edge counts, CONTRACTS.md §1.2 validation, determinism, and
// hand-edit preservation on re-scan.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import { validateArchitecture } from "../src/contracts/validate.js";
import { parseToml, tomlGet } from "../src/scan/mini-toml.js";
import { parseYaml, yamlGet, yamlStrings } from "../src/scan/mini-yaml.js";
import { applyDescriptions } from "../src/scan/describe.js";
import { scanRepo } from "../src/scan/index.js";
import { mergeWithExisting } from "../src/scan/merge.js";
import { main } from "../src/cli.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "scan");
const fixture = (name: string): string => join(FIXTURES, name);

function ids(arch: Architecture, parent?: string): string[] {
  return arch.nodes.filter((n) => n.parent === parent).map((n) => n.id).sort();
}

function edgeSet(arch: Architecture): string[] {
  return arch.edges.map((e) => `${e.from} -> ${e.to} [${e.label ?? ""}]`).sort();
}

function node(arch: Architecture, id: string) {
  const n = arch.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`missing node ${id}`);
  return n;
}

function expectValid(arch: Architecture, root: string): void {
  const r = validateArchitecture(arch, root);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  expect(r.warnings).toEqual([]);
  for (const n of arch.nodes) {
    expect(typeof n.x).toBe("number");
    expect(typeof n.y).toBe("number");
  }
}

describe("scanRepo: pnpm monorepo", () => {
  const root = fixture("pnpm-mono");
  const arch = scanRepo(root);

  test("one node per workspace package, children per source dir, infra from deps", () => {
    expectValid(arch, root);
    expect(ids(arch)).toEqual(["api", "postgres", "shared", "stripe", "ui", "web"]);
    expect(ids(arch, "web")).toEqual(["web.components", "web.routes"]);
    expect(ids(arch, "api")).toEqual(["api.db", "api.routes"]);
    expect(arch.nodes).toHaveLength(10);
    expect(arch.layers).toEqual(["apps", "ui", "services", "packages", "data", "external"]);
  });

  test("types, tech, layers, descriptions, files", () => {
    expect(node(arch, "web")).toMatchObject({ type: "frontend", layer: "apps", path: "apps/web" });
    expect(node(arch, "web").tech).toEqual(["TypeScript", "React 19", "Vite"]);
    expect(node(arch, "api")).toMatchObject({ type: "service", tech: ["TypeScript", "Express 4"] });
    expect(node(arch, "ui")).toMatchObject({ type: "module", layer: "packages", description: "Shared React components." });
    // README fallback: badges skipped, hard-wrapped paragraph joined.
    expect(node(arch, "shared").description).toBe("Types and helpers shared by the web app and the API.");
    expect(node(arch, "api").files?.[0]).toBe("apps/api/src/index.ts");
    expect(node(arch, "api").files).toContain("apps/api/package.json");
    expect(node(arch, "api.routes").description).toBe("HTTP route handlers.");
    expect(node(arch, "postgres")).toMatchObject({ type: "datastore", layer: "data" });
    expect(node(arch, "stripe")).toMatchObject({ type: "external", layer: "external" });
  });

  test("edges from workspace deps, NodeNext .js imports and client libraries", () => {
    expect(edgeSet(arch)).toEqual([
      "api -> postgres [sql]",
      "api -> shared [depends on]",
      "api -> stripe [API]",
      "api.routes -> api.db [imports]",
      "web -> shared [depends on]",
      "web -> ui [depends on]",
      "web.routes -> web.components [imports]",
    ]);
  });

  test("negated workspace globs and ignored dirs are skipped", () => {
    expect(arch.nodes.some((n) => n.path === "packages/ignored")).toBe(false);
    const tmp = mkdtempSync(join(tmpdir(), "archmap-scan-"));
    cpSync(root, tmp, { recursive: true });
    for (const junk of ["node_modules/left-pad", "apps/web/dist", "apps/api/build", ".git-not/x", "vendor/lib"]) {
      mkdirSync(join(tmp, junk), { recursive: true });
      writeFileSync(join(tmp, junk, "package.json"), JSON.stringify({ name: `junk-${junk}` }));
      writeFileSync(join(tmp, junk, "index.ts"), 'import "../../apps/api/src/index.js";\n');
    }
    const again = scanRepo(tmp, { name: "pnpm-mono" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(scanRepo(root, { name: "pnpm-mono" })));
  });
});

describe("scanRepo: single-package Vite app", () => {
  const root = fixture("vite-app");
  const arch = scanRepo(root);

  test("entry node + module per src dir + drill-down children", () => {
    expectValid(arch, root);
    expect(ids(arch)).toEqual(["components", "lib", "routes", "vite-app"]);
    expect(ids(arch, "components")).toEqual(["components.layout", "components.ui"]);
    expect(node(arch, "vite-app")).toMatchObject({
      type: "frontend",
      layer: "entry",
      path: "src",
      tech: ["JavaScript", "React 19", "Vite"],
      description: "A small Vite + React app.",
    });
    expect(node(arch, "vite-app").files?.slice(0, 2)).toEqual(["src/main.jsx", "src/App.jsx"]);
    expect(node(arch, "components")).toMatchObject({ type: "module", layer: "ui", path: "src/components" });
    // Test files never count as representative files or import sources.
    expect(arch.nodes.flatMap((n) => n.files ?? []).some((f) => f.includes(".test."))).toBe(false);
    // Root .gitignore is honoured without git.
    expect(arch.nodes.some((n) => n.path === "generated")).toBe(false);
  });

  test("import edges via relative paths, jsconfig aliases, dynamic imports", () => {
    expect(edgeSet(arch)).toEqual([
      "components -> lib [imports]",
      "components.layout -> components.ui [imports]",
      "routes -> components [imports]",
      "routes -> lib [imports]",
      "vite-app -> components [imports]",
      "vite-app -> lib [imports]",
      "vite-app -> routes [imports]",
    ]);
  });

  test("deterministic: same bytes on every run, generatedAt only when asked", () => {
    const a = JSON.stringify(scanRepo(root));
    const b = JSON.stringify(scanRepo(root, { useGit: false }));
    expect(a).toBe(b);
    expect(arch.generatedAt).toBeUndefined();
    const now = new Date("2026-09-22T10:00:00.123Z");
    expect(scanRepo(root, { now }).generatedAt).toBe("2026-09-22T10:00:00Z");
  });
});

describe("scanRepo: docker-compose stack", () => {
  const root = fixture("compose-stack");
  const arch = scanRepo(root);

  test("compose services map onto build-context packages and image kinds", () => {
    expectValid(arch, root);
    expect(ids(arch)).toEqual(["api", "cache", "db", "worker"]);
    expect(node(arch, "db")).toMatchObject({ type: "datastore", tech: ["Postgres 16"], layer: "data" });
    expect(node(arch, "cache")).toMatchObject({ type: "queue", tech: ["Redis 7"], files: ["docker-compose.yml"] });
    expect(node(arch, "api")).toMatchObject({ type: "service", path: "api" });
    expect(node(arch, "api").tech).toContain("Docker");
    expect(node(arch, "worker").type).toBe("service");
  });

  test("depends_on (list and map forms) + client libraries collapse into one edge each", () => {
    expect(edgeSet(arch)).toEqual(["api -> cache [cache]", "api -> db [sql]", "worker -> cache [cache]"]);
    expect(arch.edges.find((e) => e.to === "db")?.kind).toBe("data");
    expect(arch.edges.find((e) => e.to === "cache")?.kind).toBe("async");
  });
});

describe("scanRepo: python project", () => {
  const root = fixture("python-proj");
  const arch = scanRepo(root);

  test("pyproject manifest, package modules, absolute and relative imports", () => {
    expectValid(arch, root);
    expect(ids(arch)).toEqual(["api", "core", "db", "inventory", "postgres"]);
    expect(node(arch, "inventory")).toMatchObject({
      type: "service",
      layer: "entry",
      path: "inventory",
      tech: ["Python", "FastAPI", "SQLAlchemy"],
      description: "Inventory service: stock levels, pricing and reservations.",
    });
    expect(node(arch, "inventory").files).toContain("pyproject.toml");
    expect(edgeSet(arch)).toEqual([
      "api -> core [imports]",
      "api -> db [imports]",
      "core -> db [imports]",
      "inventory -> api [imports]",
      "inventory -> postgres [sql]",
    ]);
  });
});

describe("hand-edit preservation", () => {
  test("re-scan keeps descriptions, notes, positions, hand-added nodes/edges and workflows", () => {
    const root = fixture("vite-app");
    const first = scanRepo(root);
    const edited: Architecture = {
      ...first,
      nodes: [
        ...first.nodes.map((n) =>
          n.id === "lib"
            ? { ...n, description: "Hand-written.", notes: "Keep me.", x: 999, y: 555 }
            : n,
        ),
        { id: "stripe-api", type: "external", name: "Stripe", layer: "payments", description: "Payments." },
        { id: "old-module", type: "module", name: "old", path: "src/old", parent: "components" },
      ],
      edges: [
        ...first.edges,
        { from: "lib", to: "stripe-api", label: "charge", kind: "sync" },
        { from: "old-module", to: "lib", label: "imports" },
      ],
      workflows: [
        { id: "checkout", name: "Checkout", steps: ["routes", "lib", "stripe-api"] },
        { id: "stale", name: "Stale", steps: ["old-module", "lib"] },
      ],
    };
    const again = scanRepo(root, { previous: edited });
    expectValid(again, root);
    expect(node(again, "lib")).toMatchObject({ description: "Hand-written.", notes: "Keep me.", x: 999, y: 555 });
    // Scanned fields still refresh.
    expect(node(again, "lib").files).toEqual(node(first, "lib").files);
    expect(node(again, "stripe-api")).toMatchObject({ type: "external", layer: "payments" });
    expect(again.layers).toContain("payments");
    expect(again.nodes.some((n) => n.id === "old-module")).toBe(false);
    expect(edgeSet(again)).toContain("lib -> stripe-api [charge]");
    expect(edgeSet(again).some((e) => e.startsWith("old-module"))).toBe(false);
    expect(again.workflows.map((w) => w.id)).toEqual(["checkout"]);
    // Untouched nodes are identical to a fresh scan.
    expect(node(again, "routes")).toEqual(node(first, "routes"));
  });
});

describe("CLI", () => {
  test("scan --out writes a valid file, merging hand edits on the second run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archmap-scan-cli-"));
    const out = join(dir, "arch.json");
    const errWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["scan", fixture("compose-stack"), "--out", out])).toBe(0);
      const written = JSON.parse(readFileSync(out, "utf8")) as Architecture;
      expect(validateArchitecture(written, fixture("compose-stack")).ok).toBe(true);
      expect(written.generatedBy).toMatch(/^archmap scan /);
      expect(lines.join("")).toMatch(/4 nodes \(4 top-level\), 3 edges, 2 layers \[apps, data\]/);

      written.nodes = written.nodes.map((n) => (n.id === "db" ? { ...n, description: "Main DB." } : n));
      writeFileSync(out, JSON.stringify(written));
      expect(await main(["scan", "--describe", fixture("compose-stack"), "--out", out])).toBe(0);
      const merged = JSON.parse(readFileSync(out, "utf8")) as Architecture;
      expect(merged.nodes.find((n) => n.id === "db")?.description).toBe("Main DB.");
      expect(lines.join("")).toMatch(/--describe needs the agent bridge/);

      expect(await main(["scan"])).toBe(2);
      expect(await main(["scan", join(dir, "missing")])).toBe(2);
    } finally {
      process.stderr.write = errWrite;
    }
  });
});

describe("mini parsers and describe helper", () => {
  test("YAML subset", () => {
    const y = parseYaml(
      "a:\n  - x # c\n  - 'y'\nb: [1, \"two\"]\nc:\n  d: e:f\n  g: |\n    line1\n    line2\nh:\n- k: v\n  m: n\n",
    );
    expect(yamlStrings(yamlGet(y, "a"))).toEqual(["x", "y"]);
    expect(yamlGet(y, "b")).toEqual(["1", "two"]);
    expect(yamlGet(yamlGet(y, "c"), "d")).toBe("e:f");
    expect(yamlGet(yamlGet(y, "c"), "g")).toBe("line1\nline2");
    expect(yamlGet(y, "h")).toEqual([{ k: "v", m: "n" }]);
  });

  test("TOML subset", () => {
    const t = parseToml(
      '[package]\nname = "x" # c\n[workspace]\nmembers = [\n  "crates/*",\n  \'tools/a\',\n]\n[dependencies]\nfoo = { path = "../foo", version = "1" }\n[[bin]]\nname = "b1"\n[[bin]]\nname = "b2"\n',
    );
    expect(tomlGet(t, "package", "name")).toBe("x");
    expect(tomlGet(t, "workspace", "members")).toEqual(["crates/*", "tools/a"]);
    expect(tomlGet(t, "dependencies", "foo", "path")).toBe("../foo");
    expect(tomlGet(t, "bin")).toEqual([{ name: "b1" }, { name: "b2" }]);
  });

  test("applyDescriptions only fills known ids", () => {
    const arch = scanRepo(fixture("compose-stack"));
    const r = applyDescriptions(arch, { db: "Primary store.", nope: "x", api: 3 });
    expect(r.described).toBe(1);
    expect(r.architecture.nodes.find((n) => n.id === "db")?.description).toBe("Primary store.");
  });
});

describe("re-scan keeps the user's edges", () => {
  test("keeps manual and suggested edges, lets an edited edge replace the scanned one, drops stale scan edges", () => {
    const scanned: Architecture = {
      version: 1, name: "r", layers: [], workflows: [],
      nodes: [{ id: "a", type: "module", name: "a", path: "a" }, { id: "b", type: "module", name: "b", path: "b" }, { id: "c", type: "module", name: "c", path: "c" }],
      edges: [{ from: "a", to: "b", label: "imports", source: "scan" }],
    };
    const existing: Architecture = {
      ...scanned,
      edges: [
        { from: "a", to: "b", label: "calls billing", source: "manual" },  // edited scan edge
        { from: "b", to: "c", label: "publishes", source: "manual" },       // drawn by hand
        { from: "c", to: "a", source: "suggested", evidence: ["c/x.ts:3"] }, // accepted suggestion
        { from: "c", to: "b", source: "scan" },                             // import that no longer exists
        { from: "a", to: "gone", source: "manual" },                        // end no longer exists
      ],
    };
    const merged = mergeWithExisting(scanned, existing);
    const keys = merged.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ""}:${e.source ?? ""}`).sort();
    expect(keys).toEqual(["a>b:calls billing:manual", "b>c:publishes:manual", "c>a::suggested"]);
  });
});

describe("re-scan keeps pinned levels", () => {
  test("an existing node whose path still exists survives; one whose path is gone is dropped", () => {
    const root = mkdtempSync(join(tmpdir(), "ruah-pin-"));
    mkdirSync(join(root, "src", "billing"), { recursive: true });
    writeFileSync(join(root, "src", "billing", "index.ts"), "export const x = 1;\n");
    const scanned: Architecture = { version: 1, name: "r", layers: [], workflows: [], nodes: [{ id: "src", type: "module", name: "src", path: "src" }], edges: [] };
    const existing: Architecture = {
      ...scanned,
      nodes: [
        ...scanned.nodes,
        { id: "src/billing", type: "module", name: "billing", path: "src/billing", parent: "src" }, // pinned from drill-in
        { id: "src/gone", type: "module", name: "gone", path: "src/gone", parent: "src" },          // folder deleted since
        { id: "outside", type: "module", name: "outside", path: "../etc" },                          // never outside root
      ],
      edges: [{ from: "src/billing", to: "src", source: "manual" }],
    };
    const merged = mergeWithExisting(scanned, existing, root);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["src", "src/billing"]);
    expect(merged.edges).toEqual([{ from: "src/billing", to: "src", source: "manual" }]);
  });
});
