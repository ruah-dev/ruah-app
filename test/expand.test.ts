// On-demand drill-in (CONTRACTS.md §1.6): folder / file / symbol levels,
// namespaced ids that resolve again from scratch, caps, multi-repo paths, the
// context pack for expanded ids and the HTTP endpoints.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import { buildContextPack } from "../src/context/pack.js";
import { resolveNodeScope } from "../src/expand/context.js";
import { handleExpandRequest } from "../src/expand/http.js";
import { Expander, MAX_CHILDREN } from "../src/expand/index.js";
import { parseSymbols } from "../src/expand/symbols.js";
import { createArchitectureStore, type ArchitectureStore } from "../src/serve/architecture-store.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ruah-expand-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const APP_TSX = `import { useState } from "react";
import { formatName } from "../lib/format";

export type Props = { name: string };

export interface Theme {
  dark: boolean;
}

export function useGreeting(name: string) {
  const [n] = useState(name);
  return formatName(n);
}

function Badge({ label }: { label: string }) {
  return <span>{label}</span>;
}

export const Header = ({ name }: Props) => {
  const text = useGreeting(name);
  // "Badge" in a comment { must not count
  return <h1>Don't <Badge label={text} /></h1>;
};

export default class Store {
  items: string[] = [];
}
`;

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "web", dependencies: { react: "19" } }),
  "src/index.ts": `export * from "./components/App";\n`,
  "src/components/App.tsx": APP_TSX,
  "src/components/Button.tsx": `import { formatName } from "../lib/format";\nexport const Button = () => formatName("x");\n`,
  "src/components/App.test.tsx": `import { Header } from "./App";\n`,
  "src/lib/format.ts": `export function formatName(n: string): string {\n  return n.trim();\n}\n`,
  "src/deep/only/one/leaf.ts": `export const leaf = 1;\n`,
  "src/server/routes.ts": `import express from "express";\nconst app = express();\n\napp.get("/users", (req, res) => {\n  res.json([]);\n});\n\napp.post("/users/:id", handler);\n\nfunction handler(req: unknown, res: unknown) {\n  return res;\n}\n`,
  "src/README.md": "# hi\n",
  "src/logo.png": "\u0000binary",
};

const ARCH: Architecture = {
  version: 1,
  name: "web",
  nodes: [
    { id: "web", type: "frontend", name: "web", path: "src" },
    { id: "db", type: "datastore", name: "db" },
  ],
  edges: [{ from: "web", to: "db", label: "sql" }],
  workflows: [],
};

describe("symbol outline", () => {
  test("TS/TSX: functions, hooks, components, classes, types, ranges and edges", () => {
    const o = parseSymbols("src/components/App.tsx", APP_TSX);
    const by = new Map(o.symbols.map((s) => [s.name, s]));
    expect(o.symbols.map((s) => `${s.name}:${s.kind}`)).toEqual([
      "Props:type",
      "Theme:interface",
      "useGreeting:hook",
      "Badge:component",
      "Header:component",
      "Store:class",
    ]);
    expect(by.get("Theme")).toMatchObject({ line: 6, endLine: 8, exported: true });
    expect(by.get("useGreeting")).toMatchObject({ line: 10, endLine: 13, exported: true });
    expect(by.get("Badge")).toMatchObject({ line: 15, endLine: 17, exported: false });
    expect(by.get("Header")).toMatchObject({ line: 19, endLine: 23 });
    expect(by.get("Store")).toMatchObject({ line: 25, endLine: 27, exported: true });
    const edges = o.edges.map((e) => `${e.from} -${e.label}-> ${e.to}`).sort();
    expect(edges).toEqual(["Header -calls-> useGreeting", "Header -renders-> Badge", "Header -uses-> Props"]);
  });

  test("route handlers (express) and Python / Go basics", () => {
    const r = parseSymbols("src/server/routes.ts", FILES["src/server/routes.ts"] ?? "");
    expect(r.symbols.map((s) => `${s.name}:${s.kind}:${s.line}-${s.endLine}`)).toEqual([
      "GET /users:route:4-6",
      "POST /users/:id:route:8-8",
      "handler:function:10-12",
    ]);
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["POST /users/:id->handler"]);

    const py = parseSymbols(
      "app/main.py",
      `import x\n\n@app.get("/items")\nasync def list_items():\n    return helper()\n\n\ndef helper():\n    """doc { not a brace"""\n    return 1\n\nclass _Private:\n    pass\n`,
    );
    expect(py.symbols.map((s) => `${s.name}:${s.kind}:${s.line}-${s.endLine}:${s.exported}`)).toEqual([
      "list_items:route:4-5:true",
      "helper:function:8-10:true",
      "_Private:class:12-13:false",
    ]);
    expect(py.symbols[0]?.detail).toBe("GET /items");

    const go = parseSymbols(
      "svc/main.go",
      `package main\n\ntype Server struct {\n\tdb string\n}\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\n\nfunc helper() {}\n`,
    );
    expect(go.symbols.map((s) => `${s.name}:${s.kind}:${s.line}-${s.endLine}:${s.exported}`)).toEqual([
      "Server:class:3-5:true",
      "Server.Start:method:7-9:true",
      "helper:function:11-11:false",
    ]);
  });

  test("duplicate names get unique keys", () => {
    const o = parseSymbols("a.ts", "export function f() {}\nexport function f() {}\n");
    expect(o.symbols.map((s) => s.key)).toEqual(["f", "f~2"]);
  });
});

describe("Expander", () => {
  let root: string;
  beforeAll(() => {
    root = repo(FILES);
  });

  test("folder level: sub-folders (compacted), files, tests, other; import edges; layout", () => {
    const ex = new Expander(root);
    const e = ex.expand(ARCH, "web");
    expect(e.level).toBe("folder");
    const nodes = e.architecture.nodes;
    expect(nodes.map((n) => `${n.id}|${n.type}|${n.layer}`).sort()).toEqual([
      "web/README.md|file|other",
      "web/components|module|folders",
      "web/deep/only/one|module|folders",
      "web/index.ts|file|files",
      "web/lib|module|folders",
      "web/server|module|folders",
    ]);
    const components = nodes.find((n) => n.id === "web/components");
    expect(components).toMatchObject({ path: "src/components", expandable: true, childCount: 3 });
    expect(nodes.find((n) => n.id === "web/deep/only/one")).toMatchObject({ name: "deep/only/one", path: "src/deep/only/one" });
    expect(nodes.every((n) => typeof n.x === "number" && typeof n.y === "number")).toBe(true);
    expect(e.architecture.edges.map((x) => `${x.from}->${x.to}:${x.weight}`).sort()).toEqual([
      "web/components->web/lib:2",
      "web/index.ts->web/components:1",
    ]);
    expect(e.architecture.edges.every((x) => x.source === "scan" && x.label === "imports")).toBe(true);
    expect(e.architecture.layers).toEqual(["folders", "files", "other"]);
  });

  test("file level: symbols with lines; ids namespaced with #", () => {
    const ex = new Expander(root);
    const folder = ex.expand(ARCH, "web/components");
    const app = folder.architecture.nodes.find((n) => n.name === "App.tsx");
    expect(app).toMatchObject({ id: "web/components/App.tsx", type: "file", expandable: true, childCount: 6 });
    expect(folder.architecture.nodes.find((n) => n.name === "App.test.tsx")).toMatchObject({ layer: "tests", test: true });
    const file = ex.expand(ARCH, "web/components/App.tsx");
    expect(file.level).toBe("file");
    expect(file.lineage).toEqual(["web", "web/components"]);
    const header = file.architecture.nodes.find((n) => n.name === "Header");
    expect(header).toMatchObject({
      id: "web/components/App.tsx#Header",
      type: "symbol",
      path: "src/components/App.tsx",
      layer: "components",
      symbol: { kind: "component", line: 19, endLine: 23, exported: true },
    });
    expect(file.architecture.edges.length).toBe(3);
  });

  test("any id resolves from a cold cache; unknown and non-expandable ids fail", () => {
    const ex = new Expander(root);
    const located = ex.locate(ARCH, "web/components/App.tsx#useGreeting");
    expect(located?.node).toMatchObject({ name: "useGreeting" });
    expect(located?.chain.map((c) => c.nodeId)).toEqual(["web", "web/components", "web/components/App.tsx"]);
    expect(ex.locate(ARCH, "web/nope")).toBeNull();
    expect(() => ex.expand(ARCH, "db")).toThrow(/no path/);
    expect(() => ex.expand(ARCH, "web/README.md")).toThrow(/no symbol outline/);
    expect(() => ex.expand(ARCH, "web/components/App.tsx#Header")).toThrow(/no children/);
    expect(() => ex.expand(ARCH, "missing")).toThrow(/unknown element/);
  });

  test("peek counts children without expanding", () => {
    const ex = new Expander(root);
    expect(ex.peek(ARCH, ["web", "db", "web/components/App.tsx", "web/README.md"])).toEqual({
      web: 6,
      db: null,
      "web/components/App.tsx": 6,
      "web/README.md": null,
    });
  });

  test("caps children per level and flags truncation", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_CHILDREN + 15; i++) many[`pkg/f${String(i).padStart(3, "0")}.ts`] = `export const v${i} = ${i};\n`;
    const r = repo(many);
    const arch: Architecture = { version: 1, name: "x", nodes: [{ id: "p", type: "module", name: "p", path: "pkg" }], edges: [], workflows: [] };
    const e = new Expander(r).expand(arch, "p");
    expect(e.architecture.nodes.length).toBe(MAX_CHILDREN);
    expect(e.truncated.children).toBe(true);
    expect(e.total.children).toBe(MAX_CHILDREN + 15);
  });

  test("files change: a new file shows up after the file-list TTL", () => {
    const r = repo({ "a/one.ts": "export const one = 1;\n" });
    const arch: Architecture = { version: 1, name: "x", nodes: [{ id: "a", type: "module", name: "a", path: "a" }], edges: [], workflows: [] };
    let now = 0;
    const ex = new Expander(r, undefined, () => now);
    expect(ex.expand(arch, "a").architecture.nodes.length).toBe(1);
    writeFileSync(join(r, "a/two.ts"), "export const two = 2;\n");
    expect(ex.expand(arch, "a").architecture.nodes.length).toBe(1); // cached
    now = 10_000;
    expect(ex.expand(arch, "a").architecture.nodes.map((n) => n.name)).toEqual(["one.ts", "two.ts"]);
  });

  test("multi-repo systems: <repoId>/<path> resolves through resolvePath", () => {
    const sysRoot = repo({ "ruah.system.json": "{}" });
    const apiRoot = repo({ "src/routes/users.ts": `export function list() {}\n`, "src/app.ts": `import { list } from "./routes/users";\n` });
    const resolvePath = (rel: string): { abs: string; root: string } | null => {
      const [repoId, ...rest] = rel.split("/");
      return repoId === "api" ? { abs: join(apiRoot, ...rest), root: apiRoot } : null;
    };
    const arch: Architecture = {
      version: 1,
      name: "sys",
      nodes: [{ id: "api", type: "service", name: "api", path: "api", repo: "api" }],
      edges: [],
      workflows: [],
    };
    const ex = new Expander(sysRoot, resolvePath);
    const top = ex.expand(arch, "api");
    expect(top.architecture.nodes.map((n) => `${n.id}|${n.path}`)).toEqual(["api/src|api/src"]);
    const src = ex.expand(arch, "api/src");
    expect(src.architecture.nodes.map((n) => `${n.id}|${n.path}`).sort()).toEqual(["api/src/app.ts|api/src/app.ts", "api/src/routes|api/src/routes"]);
    expect(src.architecture.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["api/src/app.ts->api/src/routes"]);
    const sym = ex.expand(arch, "api/src/routes/users.ts").architecture.nodes[0];
    expect(sym).toMatchObject({ id: "api/src/routes/users.ts#list", path: "api/src/routes/users.ts" });
  });
});

describe("context pack for expanded ids", () => {
  test("folders, files and symbols get a pack with parent, siblings, edges and the file", () => {
    const root = repo(FILES);
    writeFileSync(join(root, "architecture.json"), JSON.stringify(ARCH));
    const store = createArchitectureStore(join(root, "architecture.json"), { watch: false });
    return store.load().then(() => {
      const arch = store.current();
      if (arch === null) throw new Error("not loaded");
      const folder = resolveNodeScope(store, arch, "web/components");
      expect(folder).not.toBeNull();
      const folderPack = buildContextPack(folder!.index, "web/components", root);
      expect(folderPack).toContain("node: components (module) id=web/components");
      expect(folderPack).toContain("path: src/components");
      expect(folderPack).toContain("parent: web (frontend) path=src");
      expect(folderPack).toContain("- THIS -> lib (module) path=src/lib [imports] [sync]");

      const sym = resolveNodeScope(store, arch, "web/components/App.tsx#Header");
      const pack = buildContextPack(sym!.index, "web/components/App.tsx#Header", root, "why?");
      expect(pack).toContain("node: Header (symbol) id=web/components/App.tsx#Header");
      expect(pack).toContain("path: src/components/App.tsx");
      expect(pack).toContain("lines 19–23 of src/components/App.tsx");
      expect(pack).toContain("parent: App.tsx (file) path=src/components/App.tsx");
      expect(pack).toContain("- THIS -> Badge (symbol) path=src/components/App.tsx [renders] [sync]");
      expect(pack.endsWith("why?")).toBe(true);

      expect(resolveNodeScope(store, arch, "web")?.node.id).toBe("web");
      expect(resolveNodeScope(store, arch, "nope")).toBeNull();
      expect(resolveNodeScope(store, arch, "web/nope.ts")).toBeNull();
    });
  });
});

describe("HTTP", () => {
  let server: http.Server;
  let base: string;
  let store: ArchitectureStore;
  beforeAll(async () => {
    const root = repo(FILES);
    writeFileSync(join(root, "architecture.json"), JSON.stringify(ARCH));
    store = createArchitectureStore(join(root, "architecture.json"), { watch: false });
    await store.load();
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const originOk = (o: string | undefined): boolean => o === undefined || o.startsWith("http://localhost");
      if (!handleExpandRequest(req, res, url, store, originOk)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test("GET /api/expand/:id, peek, errors and the Origin rule", async () => {
    const ok = await fetch(`${base}/api/expand/${encodeURIComponent("web/components/App.tsx")}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { level: string; architecture: { nodes: unknown[] } };
    expect(body.level).toBe("file");
    expect(body.architecture.nodes.length).toBe(6);

    const peek = await fetch(`${base}/api/expand-peek?id=web&id=db`);
    expect(await peek.json()).toEqual({ counts: { web: 6, db: null } });

    expect((await fetch(`${base}/api/expand/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/expand/db`)).status).toBe(422);
    expect((await fetch(`${base}/api/expand/web`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/expand/web`, { headers: { origin: "http://localhost:4177" } })).status).toBe(200);
    expect((await fetch(`${base}/api/expand/web`, { method: "POST" })).status).toBe(405);
  });
});
