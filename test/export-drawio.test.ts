// draw.io export: src/export/drawio.ts (toDrawio), src/export/http.ts
// (GET /api/export/drawio), src/export/run-export.ts (ruah app export drawio).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import type { CloudResource, WorkItem } from "../src/contracts/integrations.js";
import type { IntegrationsApi } from "../src/integrations/index.js";
import { CloudCacheStore } from "../src/integrations/store.js";
import { drawioFileName, routeEdges, toDrawio } from "../src/export/drawio.js";
import { runExport } from "../src/export/run-export.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { ChatStore } from "../src/projects/chat-store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- a strict little XML parser (no deps): throws on anything malformed ----------

interface XNode { name: string; attrs: Record<string, string>; children: XNode[] }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(raw: string): string {
  if (/[<]/.test(raw)) throw new Error(`raw '<' in text/attribute: ${raw.slice(0, 60)}`);
  return raw.replace(/&([^;\s]*);?/g, (m, body: string) => {
    if (!m.endsWith(";")) throw new Error(`unterminated entity near ${raw.slice(0, 60)}`);
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const e = ENTITIES[body];
    if (e === undefined) throw new Error(`unknown entity &${body};`);
    return e;
  });
}

function parseXml(xml: string): XNode {
  let i = 0;
  if (xml.startsWith("<?xml")) i = xml.indexOf("?>") + 2;
  const root: XNode = { name: "#doc", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const NAME = /[A-Za-z_][\w.:-]*/y;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = lt === -1 ? xml.slice(i) : xml.slice(i, lt);
    if (text.trim() !== "") {
      if (stack.length === 1) throw new Error("text outside the root element");
      decode(text);
    }
    if (lt === -1) break;
    i = lt + 1;
    if (xml[i] === "/") {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(xml);
      if (m === null) throw new Error(`bad closing tag at ${i}`);
      const top = stack.pop();
      if (top === undefined || top.name !== m[0]) throw new Error(`mismatched </${m[0]}> (open: ${top?.name})`);
      i = NAME.lastIndex;
      if (xml[i] !== ">") throw new Error(`bad closing tag end at ${i}`);
      i += 1;
      continue;
    }
    NAME.lastIndex = i;
    const m = NAME.exec(xml);
    if (m === null) throw new Error(`bad tag at ${i}: ${xml.slice(i, i + 20)}`);
    const node: XNode = { name: m[0], attrs: {}, children: [] };
    i = NAME.lastIndex;
    for (;;) {
      const ws = /\s*/y;
      ws.lastIndex = i;
      ws.exec(xml);
      const hadSpace = ws.lastIndex > i;
      i = ws.lastIndex;
      if (xml.startsWith("/>", i)) { i += 2; (stack.at(-1) as XNode).children.push(node); break; }
      if (xml[i] === ">") { i += 1; (stack.at(-1) as XNode).children.push(node); stack.push(node); break; }
      if (!hadSpace) throw new Error(`missing space before attribute in <${node.name}>`);
      NAME.lastIndex = i;
      const a = NAME.exec(xml);
      if (a === null || xml[NAME.lastIndex] !== "=" || xml[NAME.lastIndex + 1] !== '"') throw new Error(`bad attribute in <${node.name}> at ${i}`);
      const start = NAME.lastIndex + 2;
      const end = xml.indexOf('"', start);
      if (end === -1) throw new Error("unterminated attribute");
      if (a[0] in node.attrs) throw new Error(`duplicate attribute ${a[0]} in <${node.name}>`);
      node.attrs[a[0]] = decode(xml.slice(start, end));
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack.at(-1)?.name}>`);
  if (root.children.length !== 1) throw new Error("expected exactly one root element");
  return root.children[0] as XNode;
}

function all(node: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  const walk = (n: XNode): void => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Cell id → { cell, object? } for one <diagram>. */
function cells(diagram: XNode): Map<string, { cell: XNode; object?: XNode }> {
  const map = new Map<string, { cell: XNode; object?: XNode }>();
  const rootNode = all(diagram, "root")[0] as XNode;
  for (const c of rootNode.children) {
    if (c.name === "object") {
      const id = c.attrs.id as string;
      if (map.has(id)) throw new Error(`duplicate id ${id}`);
      map.set(id, { cell: c.children[0] as XNode, object: c });
    } else if (c.name === "mxCell") {
      const id = c.attrs.id as string;
      if (map.has(id)) throw new Error(`duplicate id ${id}`);
      map.set(id, { cell: c });
    }
  }
  return map;
}

// ---- fixtures -------------------------------------------------------------------

const NASTY = `Evil <b>"name"</b> & 'quotes'\nsecond line`;

function fixture(): Architecture {
  return {
    version: 1,
    name: "acme <platform>",
    generatedBy: "ruah app scan 0.1.0",
    generatedAt: "2026-09-23T10:00:00Z",
    layers: ["frontend", "services", "data"],
    nodes: [
      { id: "web", type: "frontend", name: "Web", tech: ["React 19", "Vite"], path: "web", layer: "frontend", x: 0, y: 0 },
      {
        id: "api", type: "service", name: "API", layer: "services", path: "api", tech: ["Node 22", "Express"],
        files: Array.from({ length: 15 }, (_, i) => `api/src/f${i}.ts`), description: "Invoices API.", notes: "## Notes\nuses **pg**", x: 0, y: 170,
      },
      { id: "db", type: "datastore", name: "Postgres", layer: "data", tech: ["Postgres 16"], x: 0, y: 340 },
      { id: "bus", type: "queue", name: "Kafka", layer: "data", x: 260, y: 340 },
      { id: "api.routes", type: "module", name: "routes", parent: "api", path: "api/src/routes", x: 0, y: 0 },
      { id: "api.store", type: "module", name: NASTY, parent: "api", path: "api/src/store", description: `bad\u0001chars & <tags>\nline2`, x: 260, y: 0 },
      { id: "api.routes.inv", type: "file", name: "invoices.ts", parent: "api.routes", path: "api/src/routes/invoices.ts", x: 0, y: 0 },
      { id: "step-a", type: "step", name: "Submit", x: 0, y: 0 },
      { id: "step-b", type: "step", name: "Charge", x: 0, y: 0 },
    ],
    edges: [
      { from: "web", to: "api", label: "HTTP", kind: "sync", source: "scan", evidence: ["web/src/api.ts:12"] },
      { from: "api", to: "db", label: "sql", kind: "data" },
      { from: "api", to: "bus", label: "invoice.created", kind: "event", source: "suggested", evidence: ["api/src/pub.ts:3"] },
      { from: "api.routes", to: "api.store", label: `a<b & "c"` },
      { from: "step-a", to: "step-b" },
    ],
    workflows: [{ id: "checkout", name: "Checkout", description: "Pay an invoice", steps: ["step-a", "web", "step-b"] }],
  };
}

const CLOUD: CloudResource[] = [
  { id: "do:app:1", provider: "digitalocean", type: "app", service: "apps", name: "api", region: "fra1", status: "active", linkedNodeId: "api", linkSource: "name" },
  { id: "do:db:1", provider: "digitalocean", type: "database", service: "databases", name: "unrelated", linkedNodeId: "missing-node" },
];
const ISSUES: WorkItem[] = [
  { id: "PLAT-7", provider: "jira", title: "Fix <retry> & backoff", status: "In Progress", url: "https://acme.atlassian.net/browse/PLAT-7", updatedAt: "2026-09-20T00:00:00Z", linkedNodeIds: ["api", "db"] },
];

// ---- toDrawio ------------------------------------------------------------------------

describe("toDrawio", () => {
  const xml = toDrawio(fixture(), { cloud: CLOUD, issues: ISSUES, notes: ["cloud as of yesterday"], rootName: "platform", agent: "ruah test" });
  const doc = parseXml(xml);
  const diagrams = all(doc, "diagram");
  const byName = new Map(diagrams.map((d) => [d.attrs.name, d]));

  it("is a well-formed, uncompressed mxfile", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<mxfile ')).toBe(true);
    expect(doc.name).toBe("mxfile");
    expect(doc.attrs.compressed).toBe("false");
    expect(doc.attrs.agent).toBe("ruah test");
    for (const d of diagrams) {
      expect(d.children.map((c) => c.name)).toEqual(["mxGraphModel"]);
      const map = cells(d);
      expect(map.get("0")?.cell.attrs.parent).toBeUndefined();
      expect(map.get("1")?.cell.attrs.parent).toBe("0");
      // every parent / edge end refers to a cell on the same page
      for (const [id, { cell }] of map) {
        if (id === "0" || id === "1") continue;
        expect(map.has(cell.attrs.parent as string), `${d.attrs.name}: parent of ${id}`).toBe(true);
        if (cell.attrs.edge === "1") {
          for (const end of ["source", "target"]) if (cell.attrs[end] !== undefined) expect(map.has(cell.attrs[end] as string)).toBe(true);
        }
        expect(all(cell, "mxGeometry").length).toBeGreaterThan(0);
      }
    }
  });

  it("has Overview, one page per drill level (breadcrumb names), one per workflow, and Specifications", () => {
    expect(diagrams.map((d) => d.attrs.name)).toEqual(["Overview", "API", "API / routes", "Workflow: Checkout", "Specifications"]);
    expect(new Set(diagrams.map((d) => d.attrs.id)).size).toBe(diagrams.length);
    // Overview: top level only; workflow-only steps are not drawn on architecture levels.
    const overview = cells(byName.get("Overview") as XNode);
    const ruahIds = [...overview.values()].map((c) => c.object?.attrs.ruahId).filter(Boolean);
    expect(ruahIds.sort()).toEqual(["api", "bus", "db", "web"]);
    // Title block, legend, layer containers.
    const values = [...overview.values()].map((c) => c.object?.attrs.label ?? c.cell.attrs.value ?? "");
    expect(values.some((v) => v.includes("acme &lt;platform&gt;") && v.includes("root: platform") && v.includes("generated 2026-09-23T10:00:00Z"))).toBe(true);
    expect(values.some((v) => v.includes("9 elements · 5 links · 3 layers · 1 workflow"))).toBe(true);
    expect(overview.has("legend")).toBe(true);
    const frame = overview.get("layer-services");
    expect(frame?.cell.attrs.style).toContain("container=1");
    expect(overview.get("n-api")?.cell.attrs.parent).toBe("layer-services");
    // Workflow page: steps in order, left → right, numbered.
    const flow = cells(byName.get("Workflow: Checkout") as XNode);
    const steps = ["step-a", "web", "step-b"].map((id) => flow.get(`n-${id}`));
    const xs = steps.map((s) => Number(all(s?.cell as XNode, "mxGeometry")[0]?.attrs.x));
    expect(xs[0]).toBeLessThan(xs[1] as number);
    expect(xs[1]).toBeLessThan(xs[2] as number);
    expect(steps[0]?.object?.attrs.label).toContain("1. Submit");
  });

  it("makes every element a UserObject carrying its specs, tooltip and drill link", () => {
    const overview = cells(byName.get("Overview") as XNode);
    const api = overview.get("n-api")?.object?.attrs ?? {};
    const drillPage = byName.get("API")?.attrs.id;
    expect(api).toMatchObject({
      ruahId: "api", type: "service", layer: "services", path: "api", tech: "Node 22, Express",
      description: "Invoices API.", notes: "## Notes\nuses **pg**", repo: "", link: `data:page/id,${drillPage}`,
    });
    expect(api.files?.split("\n")).toHaveLength(15);
    expect(api.cloud).toBe("digitalocean/apps api (fra1, active) [name]");
    expect(api.issues).toBe("PLAT-7 Fix <retry> & backoff [In Progress] https://acme.atlassian.net/browse/PLAT-7");
    expect(api.links).toContain("→ Postgres “sql” (data)");
    expect(api.links).toContain("← Web “HTTP” (sync, scan)");
    expect(api.tooltip).toContain("<b>API (service)</b>");
    expect(api.tooltip).toContain("2 elements inside — click to open");
    // no link on leaves
    expect(overview.get("n-db")?.object?.attrs.link).toBeUndefined();
    expect(overview.get("n-db")?.cell.attrs.style).toContain("shape=cylinder3");
    // Nested drill page links deeper and back up.
    const apiPage = cells(byName.get("API") as XNode);
    const routes = [...apiPage.values()].find((c) => c.object?.attrs.ruahId === "api.routes");
    expect(routes?.object?.attrs.link).toBe(`data:page/id,${byName.get("API / routes")?.attrs.id}`);
    const back = [...apiPage.values()].find((c) => c.object?.attrs.label?.includes("← Overview"));
    expect(back?.object?.attrs.link).toBe("data:page/id,overview");
  });

  it("styles links by kind and provenance and keeps evidence", () => {
    const overview = [...cells(byName.get("Overview") as XNode).values()].filter((c) => c.cell.attrs.edge === "1" && c.object?.attrs.from !== undefined);
    const find = (from: string, to: string) => overview.find((c) => c.object?.attrs.from === from && c.object.attrs.to === to);
    const http = find("web", "api");
    expect(http?.cell.attrs.style).toContain("edgeStyle=orthogonalEdgeStyle");
    expect(http?.cell.attrs.style).not.toContain("dashed=1");
    expect(http?.object?.attrs).toMatchObject({ kind: "sync", source: "scan", evidence: "web/src/api.ts:12", label: "HTTP" });
    const event = find("api", "bus");
    expect(event?.cell.attrs.style).toContain("dashed=1;dashPattern=1 4"); // suggested: dotted
    expect(event?.cell.attrs.style).toContain("strokeColor=#9773e4"); // lavender
    expect(find("api", "db")?.object?.attrs.source).toBe("manual");
  });

  it("escapes names, labels and attributes (<>&\"' and newlines) and drops invalid XML characters", () => {
    expect(xml).not.toMatch(/[\u0001]/);
    const specs = cells(byName.get("Specifications") as XNode);
    const apiPage = cells(byName.get("API") as XNode);
    const store = [...apiPage.values()].find((c) => c.object?.attrs.ruahId === "api.store");
    // label is HTML (html=1): the name is HTML-escaped inside it, newline → <br>
    expect(store?.object?.attrs.label).toContain("Evil &lt;b&gt;&quot;name&quot;&lt;/b&gt; &amp; 'quotes'<br>second line");
    // properties are plain text, decoded exactly (control char removed)
    expect(store?.object?.attrs.description).toBe("badchars & <tags>\nline2");
    const edge = [...apiPage.values()].find((c) => c.object?.attrs.from === "api.routes");
    expect(edge?.object?.attrs.label).toBe("a&lt;b &amp; &quot;c&quot;");
    const specText = [...specs.values()].map((c) => c.object?.attrs.label ?? c.cell.attrs.value ?? "").join("\n");
    expect(specText).toContain("Evil &lt;b&gt;");
  });

  it("Specifications lists every element with all specs, links, cloud, issues and notes", () => {
    const specs = cells(byName.get("Specifications") as XNode);
    const rows = [...specs.keys()].filter((k) => /^elements-r\d+$/.test(k));
    expect(rows).toHaveLength(1 + fixture().nodes.length);
    const header = [...specs.entries()].filter(([k]) => k.startsWith("elements-r0-c")).map(([, c]) => c.cell.attrs.value);
    expect(header).toEqual(["id", "name", "type", "layer", "parent", "repo", "path", "tech", "files", "description", "notes", "links (out → / in ←)", "cloud resources", "issues"]);
    const rowOf = (id: string): string[] => {
      const r = rows.find((k) => specs.get(`${k}-c0`)?.cell.attrs.value === id) as string;
      return Array.from({ length: 14 }, (_, i) => {
        const c = specs.get(`${r}-c${i}`);
        return c?.object?.attrs.label ?? c?.cell.attrs.value ?? "";
      });
    };
    const api = rowOf("api");
    expect(api[1]).toBe("<u>API</u>"); // links to its drill page
    expect(api[8]?.split("<br>")).toHaveLength(13); // first 12 files + "… +3 more"
    expect(api[8]).toContain("… +3 more");
    expect(api[12]).toContain("digitalocean/apps api (fra1, active)");
    expect(api[13]).toContain("PLAT-7 Fix &lt;retry&gt; &amp; backoff [In Progress]");
    expect(rowOf("db")[13]).toContain("PLAT-7");
    expect(rowOf("api.routes.inv")[4]).toBe("routes (api.routes)");
    const title = specs.get("title")?.cell.attrs.value ?? "";
    expect(title).toContain("1 linked cloud resources · 1 linked issues");
    expect(title).toContain("note: cloud as of yesterday");
    // links + workflows tables
    expect([...specs.keys()].filter((k) => /^links-r\d+$/.test(k))).toHaveLength(1 + fixture().edges.length);
    expect(specs.get("workflows-r1-c3")?.cell.attrs.value).toBe("1. Submit (step-a)<br>2. Web (web)<br>3. Charge (step-b)");
  });

  it("is deterministic and independent of input order", () => {
    const a = fixture();
    const b: Architecture = { ...fixture(), nodes: [...fixture().nodes].reverse(), edges: [...fixture().edges].reverse() };
    const opts = { cloud: CLOUD, issues: ISSUES, rootName: "platform" };
    expect(toDrawio(a, opts)).toBe(toDrawio(a, opts));
    expect(toDrawio(b, opts)).toBe(toDrawio(a, opts));
    expect(xml).not.toMatch(/NaN|undefined/);
  });

  it("lays out architectures without positions and handles an empty one", () => {
    const arch = fixture();
    const noPos: Architecture = { ...arch, nodes: arch.nodes.map(({ x: _x, y: _y, ...n }) => n) };
    const out = parseXml(toDrawio(noPos));
    const geoms = all(out, "mxGeometry").filter((g) => g.attrs.x !== undefined);
    expect(geoms.every((g) => Number.isFinite(Number(g.attrs.x)) && Number.isFinite(Number(g.attrs.y)))).toBe(true);
    const empty = parseXml(toDrawio({ version: 1, name: "", nodes: [], edges: [], workflows: [] }));
    expect(all(empty, "diagram").map((d) => d.attrs.name)).toEqual(["Overview", "Specifications"]);
  });

  it("routes links around elements instead of through them", () => {
    const boxes = new Map([
      ["a", { x: 0, y: 0, w: 220, h: 64 }],
      ["b", { x: 0, y: 110, w: 220, h: 64 }],
      ["c", { x: 0, y: 220, w: 220, h: 64 }],
    ]);
    const [ab, ac] = routeEdges([{ from: "a", to: "b" }, { from: "a", to: "c" }], boxes);
    expect(ab?.points).toEqual([]);
    expect(ab?.style).toContain("exitY=1;");
    expect(ac?.points.length).toBe(4); // lane to the right of b
    expect(Math.min(...(ac?.points ?? []).slice(1, 3).map(([x]) => x))).toBeGreaterThan(220);
  });

  it("builds safe download names", () => {
    expect(drawioFileName("acme <platform>")).toBe("acme-platform.drawio");
    expect(drawioFileName("../..")).toBe("architecture.drawio");
    expect(drawioFileName("Café app")).toBe("Cafe-app.drawio");
  });
});

// ---- endpoint ----------------------------------------------------------------------------

async function serve(arch: Architecture | null, integrations?: IntegrationsApi) {
  const home = tempDir("ruah-home-");
  let store = null;
  if (arch !== null) {
    const repo = tempDir("ruah-repo-");
    writeFileSync(path.join(repo, "architecture.json"), JSON.stringify(arch));
    store = createArchitectureStore(path.join(repo, "architecture.json"), { watch: false });
    await store.load();
  }
  const hub = new SessionHub(store, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", chats: new ChatStore(home) });
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, ...(integrations !== undefined ? { integrations } : {}) });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  return server.url;
}

function fakeIntegrations(fail: boolean): IntegrationsApi {
  const no = (): Promise<never> => Promise.reject(new Error("not used"));
  return {
    list: no, connect: no, disconnect: no, cloudSync: no, cloudLink: no, workLink: no, workCreate: no,
    ruahStatus: no, ruahTask: no, ruahTaskAction: no, ruahWorkflows: no, ruahWorkflowRun: no,
    cloudResources: () => (fail ? Promise.reject(new Error("doctl exploded")) : Promise.resolve({ resources: CLOUD, syncedAt: "2026-09-22T00:00:00Z", errors: [] })),
    workItems: () => Promise.resolve({ items: ISSUES, ...(fail ? { errors: [{ provider: "jira", message: "401" }] } : {}) }),
  };
}

describe("GET /api/export/drawio", () => {
  it("answers 409 without an open project", async () => {
    const url = await serve(null);
    const res = await fetch(`${url}/api/export/drawio`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no project open" });
  });

  it("downloads the open project with cloud resources and issues", async () => {
    const url = await serve(fixture(), fakeIntegrations(false));
    const res = await fetch(`${url}/api/export/drawio`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.jgraph.mxfile; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="acme-platform.drawio"');
    const body = await res.text();
    const doc = parseXml(body);
    expect(all(doc, "diagram")).toHaveLength(5);
    expect(body).toContain("digitalocean/apps api (fra1, active)");
    expect(body).toContain("PLAT-7");
    expect(body).toContain("cloud resources as of the last sync (2026-09-22T00:00:00Z)");
    expect((await fetch(`${url}/api/export/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/export/drawio`, { method: "POST" })).status).toBe(405);
  });

  it("still exports when integrations fail, with a note", async () => {
    const url = await serve(fixture(), fakeIntegrations(true));
    const res = await fetch(`${url}/api/export/drawio`);
    expect(res.status).toBe(200);
    const body = await res.text();
    parseXml(body);
    expect(body).toContain("note: cloud resources unavailable: doctl exploded");
    expect(body).toContain("note: issues from jira unavailable");
  });
});

// ---- CLI ------------------------------------------------------------------------------------

describe("ruah app export drawio", () => {
  it("writes the file with cached cloud resources and local issue links", async () => {
    const home = tempDir("ruah-home-");
    const repo = tempDir("ruah-repo-");
    const arch = fixture();
    writeFileSync(path.join(repo, "architecture.json"), JSON.stringify(arch));
    mkdirSync(path.join(repo, ".ruah"));
    writeFileSync(path.join(repo, ".ruah", "links.json"), JSON.stringify({ version: 1, links: [{ nodeId: "api", provider: "github", itemId: "acme/api#42" }] }));
    new CloudCacheStore(home).write(repo, {
      version: 1, syncedAt: "2026-09-21T00:00:00Z", errors: [], manualLinks: {},
      resources: [{ id: "arn:aws:lambda:x", provider: "aws", type: "function", service: "lambda", name: "Postgres", region: "eu-west-1" }],
    });
    const out = path.join(tempDir("ruah-out-"), "nested", "arch.drawio");
    const previous = process.env.RUAH_HOME;
    process.env.RUAH_HOME = home;
    cleanups.push(() => {
      if (previous === undefined) delete process.env.RUAH_HOME;
      else process.env.RUAH_HOME = previous;
    });
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let code: number;
    try {
      code = await runExport(["drawio", repo, "--out", out], "0.0.0-test");
      expect(await runExport(["pdf", repo], "0.0.0-test")).toBe(2);
      expect(await runExport(["drawio", path.join(repo, "missing")], "0.0.0-test")).toBe(2);
    } finally {
      process.stderr.write = stderr;
    }
    expect(code).toBe(0);
    const xml = readFileSync(out, "utf8");
    const doc = parseXml(xml);
    expect(all(doc, "diagram").map((d) => d.attrs.name)).toContain("Specifications");
    expect(xml).toContain("aws/lambda Postgres (eu-west-1) [name]"); // linked by name to the db element
    expect(xml).toContain("acme/api#42 [not fetched] https://github.com/acme/api/issues/42");
    expect(xml).toContain("cloud resources from the cached sync of 2026-09-21T00:00:00Z");
  });

  it("built binary: --out - prints the whole file even when it is larger than a pipe buffer", () => {
    const repo = tempDir("ruah-repo-");
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      id: `svc-${i}`, type: i % 3 === 0 ? "datastore" : "service", name: `Service ${i}`, description: "x".repeat(300),
      files: Array.from({ length: 12 }, (_, f) => `svc-${i}/src/file-${f}.ts`),
    }));
    const edges = nodes.slice(1).map((n, i) => ({ from: `svc-${i}`, to: n.id, label: "calls" }));
    writeFileSync(path.join(repo, "architecture.json"), JSON.stringify({ version: 1, name: "big", nodes, edges, workflows: [] }));
    const res = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "export", "drawio", repo, "--out", "-"], {
      encoding: "utf8", env: { ...process.env, RUAH_HOME: tempDir("ruah-home-") }, maxBuffer: 64 * 1024 * 1024,
    });
    expect(res.status).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(256 * 1024);
    const doc = parseXml(res.stdout);
    expect(all(doc, "diagram").map((d) => d.attrs.name)).toEqual(["Overview", "Specifications"]);
  });
});
