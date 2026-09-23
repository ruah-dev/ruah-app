// src/export/drawio.ts — architecture.json → an uncompressed draw.io
// (diagrams.net) file. Pure and deterministic: the same architecture and
// extras always give byte-identical output (no clock, stable ids, sorted).
//
// Pages (one <diagram> each, CONTRACTS.md §2.3 "GET /api/export/drawio"):
//   Overview        top level + title block + legend (same projection as the viewer's toGraph)
//   <a> / <b>       one per element that has children (drill level, breadcrumb name)
//   Workflow: <w>   one per workflow, steps left → right
//   Specifications  tables: every element's technical specs, every link, every workflow
// Every element and link is a draw.io UserObject (<object>) carrying the specs
// as custom properties (Edit Data / hover), a `tooltip`, and — for elements
// with children — a `link` to their drill page (data:page/id,<pageId>).
import { createHash } from "node:crypto";
import type { ArchEdge, ArchNode, Architecture, Workflow } from "../contracts/architecture.js";
import type { CloudResource, WorkItem } from "../contracts/integrations.js";
import { layoutArchitecture } from "../scan/layout.js";

export interface DrawioOptions {
  /** Cloud resources with `linkedNodeId` applied (src/integrations/linking.ts). */
  cloud?: readonly CloudResource[];
  /** Work items with `linkedNodeIds`. */
  issues?: readonly WorkItem[];
  /** Shown on the Specifications page (e.g. "cloud resources unavailable: …"). */
  notes?: readonly string[];
  /** Basename of the project root, shown in the Overview title block. */
  rootName?: string;
  /** `agent` attribute of <mxfile>, e.g. "ruah 0.1.0". */
  agent?: string;
}

// ---- geometry (matches the viewer: ui/src/lib/architecture.ts) ------------------

export const NODE_W = 220;
export const NODE_H = 64;
const ORIGIN = 48;
const GROUP_PAD = 24;
const TITLE_H = 120;
const FLOW_GAP_X = 280;
const FLOW_GAP_Y = 150;
const FLOW_WRAP = Number.POSITIVE_INFINITY; // workflows read left → right on one row
const FILES_LIMIT = 12;

// ---- palette (ui/src/styles.css --node-*, readable on draw.io's white canvas) --------

type Token = "service" | "frontend" | "data" | "queue" | "gateway" | "external" | "file" | "step";

export const PALETTE: Record<Token, { stroke: string; fill: string; label: string }> = {
  service: { stroke: "#00bea8", fill: "#e0f7f4", label: "service / compute" },
  frontend: { stroke: "#9773e4", fill: "#efe9fc", label: "frontend / client" },
  data: { stroke: "#67994f", fill: "#e9f2e4", label: "datastore" },
  queue: { stroke: "#d09430", fill: "#fbf0de", label: "queue / messaging" },
  gateway: { stroke: "#dc5850", fill: "#fbe6e4", label: "gateway / edge" },
  external: { stroke: "#5b6b88", fill: "#e8ebf1", label: "external" },
  file: { stroke: "#8c8578", fill: "#f3f1ec", label: "module / file" },
  step: { stroke: "#c2a7f7", fill: "#f7f3fe", label: "step / platform" },
};
const TEXT = "#1f2328";
const MUTED = "#6b6558";
const FRAME_STROKE = "#d9d5cc";
const FRAME_FILL = "#faf9f6";
const EDGE = "#5b6b88";
const SUGGESTED = "#9773e4";
const DEPLOY = "#8c8578";

// Kind → token, as ui/src/components/explorer/kinds.ts; aliases as ui/src/lib/architecture.ts kindFor.
const KIND_TOKEN: Record<string, Token> = {
  service: "service", function: "service", container: "service", cluster: "service", worker: "service",
  database: "data", cache: "data", storage: "data", warehouse: "data", search: "data", approval: "data",
  queue: "queue", topic: "queue", stream: "queue", webhook: "queue", scheduler: "queue", decision: "queue", event: "queue",
  gateway: "gateway", loadbalancer: "gateway", cdn: "gateway", dns: "gateway", firewall: "gateway",
  auth: "step", secret: "step", monitoring: "step", analytics: "step", config: "step", ml: "step", step: "step",
  frontend: "frontend", mobile: "frontend", user: "frontend", actor: "frontend",
  external: "external", timer: "external",
  module: "file", file: "file", api: "file",
};
const TYPE_ALIASES: Record<string, string> = {
  datastore: "database", db: "database", sql: "database", bucket: "storage", blob: "storage", "object-store": "storage",
  bus: "queue", broker: "queue", "third-party": "external", thirdparty: "external", saas: "external", vendor: "external",
  web: "frontend", ui: "frontend", client: "frontend", spa: "frontend", site: "frontend",
  proxy: "gateway", ingress: "gateway", edge: "gateway", "load-balancer": "loadbalancer",
  lambda: "function", serverless: "function", job: "worker", daemon: "service", server: "service", backend: "service",
  microservice: "service", package: "module", library: "module", lib: "module", entry: "module", app: "module",
  component: "module", person: "actor", role: "actor",
};
const FLOW_KINDS = new Set(["step", "decision", "event", "timer", "approval"]);
const CYLINDER_KINDS = new Set(["database", "cache", "warehouse"]);

export function kindOf(type: string): string {
  const t = type.toLowerCase();
  const alias = TYPE_ALIASES[t];
  if (alias !== undefined) return alias;
  return KIND_TOKEN[t] !== undefined ? t : "module";
}

function tokenOf(type: string): Token {
  return KIND_TOKEN[kindOf(type)] ?? "file";
}

// ---- escaping ---------------------------------------------------------------------

// XML 1.0 forbids C0 controls other than tab/newline/CR, lone surrogates, U+FFFE/U+FFFF.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape for an XML attribute value (newlines kept as character references). */
export function xmlAttr(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

/** Escape text shown in an html=1 label (then xmlAttr-escaped again when written). */
function html(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>");
}

/** draw.io renders `tooltip` as sanitized HTML: escape each line, first line bold. */
function tooltipHtml(lines: readonly string[]): string {
  return lines.map((l, i) => (i === 0 ? `<b>${html(l)}</b>` : html(truncate(l, 400)))).join("<br>");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function hash6(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 6);
}

/** Stable XML-safe id: `prefix` + the raw id with anything but [A-Za-z0-9_-] replaced, plus a hash when replaced. */
function safeId(prefix: string, raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === raw ? `${prefix}${cleaned}` : `${prefix}${cleaned}-${hash6(raw)}`;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- styles ------------------------------------------------------------------------

function style(entries: Record<string, string | number>): string {
  return `${Object.entries(entries).map(([k, v]) => `${k}=${v}`).join(";")};`;
}

function nodeStyle(type: string): string {
  const kind = kindOf(type);
  const p = PALETTE[tokenOf(type)];
  const base = {
    html: 1, whiteSpace: "wrap", fillColor: p.fill, strokeColor: p.stroke, strokeWidth: 1.5, fontColor: TEXT,
    fontSize: 12, align: "left", verticalAlign: "middle", spacingLeft: 12, spacingRight: 8,
  };
  if (CYLINDER_KINDS.has(kind)) return style({ shape: "cylinder3", boundedLbl: 1, backgroundOutline: 1, size: 7, ...base });
  return style({ rounded: 1, arcSize: 14, ...base });
}

function edgeStyle(edge: Pick<ArchEdge, "kind" | "source">): string {
  const kind = edge.kind ?? "sync";
  const suggested = edge.source === "suggested";
  const dashed = kind === "async" || kind === "event";
  const deploy = kind === "deploy";
  return style({
    edgeStyle: "orthogonalEdgeStyle", rounded: 1, orthogonalLoop: 1, jettySize: "auto", html: 1,
    endArrow: deploy ? "open" : "block", endFill: deploy ? 0 : 1, endSize: 6,
    strokeColor: suggested ? SUGGESTED : deploy ? DEPLOY : kind === "data" ? PALETTE.data.stroke : EDGE,
    strokeWidth: 1.25,
    ...(suggested ? { dashed: 1, dashPattern: "1 4" } : dashed ? { dashed: 1, dashPattern: "6 4" } : deploy ? { dashed: 1, dashPattern: "2 3" } : {}),
    fontColor: TEXT, fontSize: 10, labelBackgroundColor: "#ffffff",
  });
}

const TEXT_STYLE = (extra: Record<string, string | number> = {}): string =>
  style({ text: "", html: 1, whiteSpace: "wrap", align: "left", verticalAlign: "top", fontColor: TEXT, fontSize: 12, strokeColor: "none", fillColor: "none", ...extra });

// ---- XML builder ----------------------------------------------------------------------

type Attrs = Record<string, string | number | undefined>;

function attrs(a: Attrs): string {
  return Object.entries(a)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .map(([k, v]) => ` ${k}="${xmlAttr(String(v))}"`)
    .join("");
}

interface Geometry { x: number; y: number; w: number; h: number }

const r = (n: number): number => Math.round(n * 100) / 100;

function geometryXml(g: Geometry, alternate = false): string {
  const alt = alternate ? `<mxRectangle width="${r(g.w)}" height="${r(g.h)}" as="alternateBounds"/>` : "";
  const open = `<mxGeometry x="${r(g.x)}" y="${r(g.y)}" width="${r(g.w)}" height="${r(g.h)}" as="geometry"`;
  return alt === "" ? `${open}/>` : `${open}>${alt}</mxGeometry>`;
}

class Page {
  readonly cells: string[] = [];
  constructor(readonly id: string, readonly name: string) {}

  vertex(id: string, parent: string, value: string, cellStyle: string, g: Geometry, extra: { object?: Attrs; alternate?: boolean } = {}): void {
    const cell = (inner: string): string => `<mxCell${inner} style="${xmlAttr(cellStyle)}" vertex="1" parent="${xmlAttr(parent)}">${geometryXml(g, extra.alternate)}</mxCell>`;
    if (extra.object !== undefined) {
      this.cells.push(`<object${attrs({ label: value, ...extra.object, id })}>${cell("")}</object>`);
    } else {
      this.cells.push(cell(attrs({ id, value })));
    }
  }

  edge(id: string, parent: string, value: string, cellStyle: string, ends: { source?: string; target?: string; from?: Point; to?: Point; via?: readonly Point[] }, object?: Attrs): void {
    const points =
      (ends.from !== undefined ? `<mxPoint x="${ends.from[0]}" y="${ends.from[1]}" as="sourcePoint"/>` : "") +
      (ends.to !== undefined ? `<mxPoint x="${ends.to[0]}" y="${ends.to[1]}" as="targetPoint"/>` : "") +
      (ends.via !== undefined && ends.via.length > 0 ? `<Array as="points">${ends.via.map(([x, y]) => `<mxPoint x="${r(x)}" y="${r(y)}"/>`).join("")}</Array>` : "");
    const geometry = points === "" ? `<mxGeometry relative="1" as="geometry"/>` : `<mxGeometry relative="1" as="geometry">${points}</mxGeometry>`;
    const link = attrs({ source: ends.source, target: ends.target });
    const cell = (inner: string): string => `<mxCell${inner} style="${xmlAttr(cellStyle)}" edge="1" parent="${xmlAttr(parent)}"${link}>${geometry}</mxCell>`;
    if (object !== undefined) this.cells.push(`<object${attrs({ label: value, ...object, id })}>${cell("")}</object>`);
    else this.cells.push(cell(attrs({ id, value })));
  }

  xml(): string {
    return (
      `  <diagram${attrs({ id: this.id, name: this.name })}>\n` +
      `    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="1169" pageHeight="827" background="#ffffff" math="0" shadow="0">\n` +
      `      <root>\n        <mxCell id="0"/>\n        <mxCell id="1" parent="0"/>\n` +
      this.cells.map((c) => `        ${c}\n`).join("") +
      `      </root>\n    </mxGraphModel>\n  </diagram>\n`
    );
  }
}

// ---- model ----------------------------------------------------------------------------

interface Model {
  arch: Architecture;
  byId: Map<string, ArchNode>;
  children: Map<string | null, ArchNode[]>;
  workflowOnly: Set<string>;
  levelPage: Map<string, string>; // node id with children → page id
  flowPage: Map<string, string>; // workflow id → page id
  cloud: Map<string, CloudResource[]>;
  issues: Map<string, WorkItem[]>;
  incoming: Map<string, ArchEdge[]>;
  outgoing: Map<string, ArchEdge[]>;
}

const OVERVIEW_ID = "overview";
const SPECS_ID = "specifications";

function buildModel(arch: Architecture, opts: DrawioOptions): Model {
  const byId = new Map<string, ArchNode>();
  const children = new Map<string | null, ArchNode[]>();
  for (const n of arch.nodes) {
    byId.set(n.id, n);
    const key = n.parent !== undefined && n.parent !== "" ? n.parent : null;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => byString(a.id, b.id));
  const inWorkflow = new Set(arch.workflows.flatMap((w) => w.steps));
  const workflowOnly = new Set(
    arch.nodes.filter((n) => FLOW_KINDS.has(kindOf(n.type)) && inWorkflow.has(n.id) && !children.has(n.id)).map((n) => n.id),
  );
  const levelPage = new Map<string, string>();
  for (const n of arch.nodes) if (children.has(n.id)) levelPage.set(n.id, safeId("level-", n.id));
  const flowPage = new Map<string, string>();
  for (const w of arch.workflows) flowPage.set(w.id, safeId("flow-", w.id));

  const cloud = new Map<string, CloudResource[]>();
  for (const res of opts.cloud ?? []) {
    if (res.linkedNodeId === undefined || !byId.has(res.linkedNodeId)) continue;
    const list = cloud.get(res.linkedNodeId) ?? [];
    list.push(res);
    cloud.set(res.linkedNodeId, list);
  }
  for (const list of cloud.values()) list.sort((a, b) => byString(`${a.provider}\u0000${a.service}\u0000${a.name}\u0000${a.id}`, `${b.provider}\u0000${b.service}\u0000${b.name}\u0000${b.id}`));
  const issues = new Map<string, WorkItem[]>();
  for (const item of opts.issues ?? []) {
    for (const nodeId of new Set(item.linkedNodeIds)) {
      if (!byId.has(nodeId)) continue;
      const list = issues.get(nodeId) ?? [];
      list.push(item);
      issues.set(nodeId, list);
    }
  }
  for (const list of issues.values()) list.sort((a, b) => byString(`${a.provider}\u0000${a.id}`, `${b.provider}\u0000${b.id}`));

  const incoming = new Map<string, ArchEdge[]>();
  const outgoing = new Map<string, ArchEdge[]>();
  for (const e of sortedEdges(arch.edges)) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }
  return { arch, byId, children, workflowOnly, levelPage, flowPage, cloud, issues, incoming, outgoing };
}

function sortedEdges(edges: readonly ArchEdge[]): ArchEdge[] {
  return [...edges].sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to) || byString(a.label ?? "", b.label ?? ""));
}

function edgeKey(e: ArchEdge): string {
  return `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
}

function ancestry(model: Model, id: string): ArchNode[] {
  const out: ArchNode[] = [];
  const seen = new Set<string>();
  let cur = model.byId.get(id);
  while (cur !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent !== undefined ? model.byId.get(cur.parent) : undefined;
  }
  return out;
}

/** Page the element is drawn on: its drill level, the first workflow for workflow-only steps. */
function homePage(model: Model, node: ArchNode): string {
  if (model.workflowOnly.has(node.id)) {
    const wf = model.arch.workflows.find((w) => w.steps.includes(node.id));
    if (wf !== undefined) return model.flowPage.get(wf.id) ?? OVERVIEW_ID;
  }
  return node.parent !== undefined ? (model.levelPage.get(node.parent) ?? OVERVIEW_ID) : OVERVIEW_ID;
}

// ---- per-element text -------------------------------------------------------------------

function cloudLine(r: CloudResource): string {
  const where = [r.region, r.status].filter((v): v is string => v !== undefined && v !== "").join(", ");
  return `${r.provider}/${r.service} ${r.name}${where !== "" ? ` (${where})` : ""}${r.linkSource !== undefined ? ` [${r.linkSource}]` : ""}`;
}

function issueLine(i: WorkItem): string {
  return `${i.id} ${i.title !== i.id ? `${i.title} ` : ""}[${i.status}]${i.url !== "" ? ` ${i.url}` : ""}`;
}

function nameOf(model: Model, id: string): string {
  return model.byId.get(id)?.name ?? id;
}

function edgeLine(model: Model, e: ArchEdge, dir: "in" | "out"): string {
  const other = dir === "out" ? e.to : e.from;
  const meta = [e.kind, e.source !== undefined && e.source !== "manual" ? e.source : undefined].filter(Boolean).join(", ");
  return `${dir === "out" ? "→" : "←"} ${nameOf(model, other)}${e.label !== undefined ? ` “${e.label}”` : ""}${meta !== "" ? ` (${meta})` : ""}`;
}

function nodeProperties(model: Model, n: ArchNode): Attrs {
  const cloud = model.cloud.get(n.id) ?? [];
  const issues = model.issues.get(n.id) ?? [];
  const inc = model.incoming.get(n.id) ?? [];
  const out = model.outgoing.get(n.id) ?? [];
  return {
    ruahId: n.id,
    type: n.type,
    layer: n.layer ?? "",
    parent: n.parent ?? "",
    repo: n.repo ?? "",
    path: n.path ?? "",
    tech: (n.tech ?? []).join(", "),
    files: (n.files ?? []).join("\n"),
    description: n.description ?? "",
    notes: n.notes ?? "",
    links: [...out.map((e) => edgeLine(model, e, "out")), ...inc.map((e) => edgeLine(model, e, "in"))].join("\n"),
    cloud: cloud.map(cloudLine).join("\n"),
    issues: issues.map(issueLine).join("\n"),
  };
}

function nodeTooltip(model: Model, n: ArchNode): string {
  const lines = [`${n.name} (${n.type})`];
  if (n.description !== undefined && n.description !== "") lines.push(n.description);
  if (n.path !== undefined) lines.push(`path: ${n.path}`);
  if (n.tech?.length) lines.push(`tech: ${n.tech.join(", ")}`);
  if (n.layer !== undefined) lines.push(`layer: ${n.layer}`);
  if (n.repo !== undefined) lines.push(`repo: ${n.repo}`);
  const cloud = model.cloud.get(n.id) ?? [];
  if (cloud.length > 0) lines.push(`cloud: ${cloud.map(cloudLine).join("; ")}`);
  const issues = model.issues.get(n.id) ?? [];
  if (issues.length > 0) lines.push(`issues: ${issues.map((i) => `${i.id} [${i.status}]`).join(", ")}`);
  const kids = model.children.get(n.id)?.length ?? 0;
  if (kids > 0) lines.push(`${kids} element${kids === 1 ? "" : "s"} inside — click to open`);
  return tooltipHtml(lines);
}

function nodeLabel(model: Model, n: ArchNode, prefix = ""): string {
  const sub = n.tech?.length ? n.tech.slice(0, 2).join(" · ") : (n.path ?? "");
  const kids = model.children.get(n.id)?.length ?? 0;
  const meta = [kindOf(n.type) === "database" ? "datastore" : kindOf(n.type), sub].filter((s) => s !== "").join(" · ");
  const badges = [
    kids > 0 ? `▸ ${kids} inside` : "",
    (model.cloud.get(n.id)?.length ?? 0) > 0 ? `☁ ${model.cloud.get(n.id)?.length}` : "",
    (model.issues.get(n.id)?.length ?? 0) > 0 ? `◉ ${model.issues.get(n.id)?.length}` : "",
  ].filter((s) => s !== "").join("  ");
  return (
    `<b>${html(prefix + truncate(n.name, 48))}</b>` +
    `<br><font style="font-size:10px" color="${MUTED}">${html(truncate(meta, 60))}</font>` +
    (badges !== "" ? `<br><font style="font-size:9px" color="${MUTED}">${html(badges)}</font>` : "")
  );
}

function edgeProperties(model: Model, e: ArchEdge): Attrs {
  return {
    from: e.from,
    to: e.to,
    kind: e.kind ?? "",
    source: e.source ?? "manual",
    evidence: (e.evidence ?? []).join("\n"),
    tooltip: tooltipHtml([
      `${nameOf(model, e.from)} → ${nameOf(model, e.to)}${e.label !== undefined ? `: ${e.label}` : ""}`,
      `kind: ${e.kind ?? "sync"} · source: ${e.source ?? "manual"}`,
      ...(e.evidence?.length ? [`evidence: ${e.evidence.join(", ")}`] : []),
    ]),
  };
}

// ---- edge routing ------------------------------------------------------------------------
//
// draw.io's orthogonal connector does not avoid obstacles and stacks every
// connector on the side centre. Deterministic fix-up: pick exit/entry sides by
// the dominant axis, spread the ports on each side (ordered by the far end to
// avoid crossings), and send connectors whose default Z route would cross
// another element through a lane beside the column (right) or row (below).

type Point = [number, number];
type Side = "top" | "bottom" | "left" | "right";
export interface Route { style: string; points: Point[] }

function portPoint(b: Geometry, side: Side, f: number): Point {
  switch (side) {
    case "top": return [b.x + b.w * f, b.y];
    case "bottom": return [b.x + b.w * f, b.y + b.h];
    case "left": return [b.x, b.y + b.h * f];
    case "right": return [b.x + b.w, b.y + b.h * f];
  }
}

function crosses(path: readonly Point[], boxes: readonly Geometry[]): boolean {
  for (let i = 0; i + 1 < path.length; i += 1) {
    const [x1, y1] = path[i] as Point;
    const [x2, y2] = path[i + 1] as Point;
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6));
    for (let k = 0; k <= steps; k += 1) {
      const px = x1 + ((x2 - x1) * k) / steps;
      const py = y1 + ((y2 - y1) * k) / steps;
      if (boxes.some((b) => px > b.x - 4 && px < b.x + b.w + 4 && py > b.y - 4 && py < b.y + b.h + 4)) return true;
    }
  }
  return false;
}

interface Plan { s: Geometry; t: Geometry; exit: Side; entry: Side; lane: "none" | "right" | "below"; fs: number; ft: number; span: number }

function plan(e: Pick<ArchEdge, "from" | "to">, boxes: ReadonlyMap<string, Geometry>): Plan | undefined {
  const s = boxes.get(e.from);
  const t = boxes.get(e.to);
  if (s === undefined || t === undefined || e.from === e.to) return undefined;
  const others = [...boxes.entries()].filter(([id]) => id !== e.from && id !== e.to).map(([, b]) => b);
  const [scx, scy] = [s.x + s.w / 2, s.y + s.h / 2];
  const [tcx, tcy] = [t.x + t.w / 2, t.y + t.h / 2];
  if (Math.abs(tcy - scy) >= Math.abs(tcx - scx) * 0.5) {
    const down = tcy >= scy;
    const exit: Side = down ? "bottom" : "top";
    const entry: Side = down ? "top" : "bottom";
    const sy = portPoint(s, exit, 0.5)[1];
    const ty = portPoint(t, entry, 0.5)[1];
    const mid = (sy + ty) / 2;
    return crosses([[scx, sy], [scx, mid], [tcx, mid], [tcx, ty]], others)
      ? { s, t, exit, entry, lane: "right", fs: 0.5, ft: 0.5, span: Math.abs(tcy - scy) }
      : { s, t, exit, entry, lane: "none", fs: 0.5, ft: 0.5, span: 0 };
  }
  const right = tcx >= scx;
  const exit: Side = right ? "right" : "left";
  const entry: Side = right ? "left" : "right";
  const sx = portPoint(s, exit, 0.5)[0];
  const tx = portPoint(t, entry, 0.5)[0];
  const mid = (sx + tx) / 2;
  return crosses([[sx, scy], [mid, scy], [mid, tcy], [tx, tcy]], others)
    ? { s, t, exit, entry, lane: "below", fs: 0.5, ft: 0.5, span: Math.abs(tcx - scx) }
    : { s, t, exit, entry, lane: "none", fs: 0.5, ft: 0.5, span: 0 };
}

/** One route per edge (same order): port style (exitX/…/entryY) and lane waypoints, absolute coordinates. */
export function routeEdges(edges: readonly Pick<ArchEdge, "from" | "to">[], boxes: ReadonlyMap<string, Geometry>): Route[] {
  const plans = edges.map((e) => plan(e, boxes));
  // Spread ports: every (element, side) gets its endpoints evenly, ordered along the side by the far end.
  const ports = new Map<string, { p: Plan; end: "s" | "t"; key: number; order: number }[]>();
  const along = (side: Side, other: Geometry): number => (side === "top" || side === "bottom" ? other.x + other.w / 2 : other.y + other.h / 2);
  plans.forEach((p, i) => {
    const e = edges[i];
    if (p === undefined || e === undefined) return;
    for (const [node, side, end, other] of [[e.from, p.exit, "s", p.t], [e.to, p.entry, "t", p.s]] as const) {
      const k = `${node}\u0000${side}`;
      ports.set(k, [...(ports.get(k) ?? []), { p, end, key: along(side, other), order: i }]);
    }
  });
  for (const list of ports.values()) {
    list.sort((a, b) => a.key - b.key || a.order - b.order);
    list.forEach((port, i) => {
      const f = r((i + 1) / (list.length + 1));
      if (port.end === "s") port.p.fs = f;
      else port.p.ft = f;
    });
  }
  // Lanes: shorter spans closer to the elements.
  const laneIndex = new Map<number, number>();
  const counters = { right: 0, below: 0 };
  plans
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: Plan; i: number } => x.p !== undefined && x.p.lane !== "none")
    .sort((a, b) => a.p.span - b.p.span || a.i - b.i)
    .forEach(({ p, i }) => {
      const kind = p.lane === "right" ? "right" : "below";
      laneIndex.set(i, counters[kind]);
      counters[kind] += 1;
    });
  const all = [...boxes.values()];
  const ratio = (side: Side, f: number): Point => (side === "top" ? [f, 0] : side === "bottom" ? [f, 1] : side === "left" ? [0, f] : [1, f]);
  return plans.map((p, i) => {
    if (p === undefined) return { style: "", points: [] };
    const [ex, ey] = ratio(p.exit, p.fs);
    const [nx, ny] = ratio(p.entry, p.ft);
    const style = `exitX=${ex};exitY=${ey};exitDx=0;exitDy=0;entryX=${nx};entryY=${ny};entryDx=0;entryDy=0;`;
    const sp = portPoint(p.s, p.exit, p.fs);
    const tp = portPoint(p.t, p.entry, p.ft);
    const lane = laneIndex.get(i) ?? 0;
    // Short jogs out of / into the gap next to the element, staggered per lane.
    const jog = 12 + (lane % 4) * 5;
    if (p.lane === "right") {
      // Out through the natural (top/bottom) port, across to a lane right of everything in the span, back in likewise.
      const lo = Math.min(p.s.y, p.t.y);
      const hi = Math.max(p.s.y + p.s.h, p.t.y + p.t.h);
      const x = Math.max(...all.filter((b) => b.y < hi && b.y + b.h > lo).map((b) => b.x + b.w)) + 36 + lane * 16;
      const sy = p.exit === "bottom" ? sp[1] + jog : sp[1] - jog;
      const ty = p.entry === "top" ? tp[1] - jog : tp[1] + jog;
      return { style, points: [[sp[0], sy], [x, sy], [x, ty], [tp[0], ty]] };
    }
    if (p.lane === "below") {
      // In the gap under the rows the two ends occupy (not under everything in the x span).
      const lo = Math.min(p.s.x, p.t.x);
      const hi = Math.max(p.s.x + p.s.w, p.t.x + p.t.w);
      const top = Math.min(p.s.y, p.t.y);
      const bottom = Math.max(p.s.y + p.s.h, p.t.y + p.t.h);
      const rowBottom = Math.max(...all.filter((b) => b.x < hi && b.x + b.w > lo && b.y < bottom && b.y + b.h > top).map((b) => b.y + b.h));
      const y = rowBottom + 16 + lane * 8;
      const sx = p.exit === "right" ? sp[0] + jog : sp[0] - jog;
      const tx = p.entry === "left" ? tp[0] - jog : tp[0] + jog;
      return { style, points: [[sx, sp[1]], [sx, y], [tx, y], [tx, tp[1]]] };
    }
    return { style, points: [] };
  });
}

// ---- diagram pages ---------------------------------------------------------------------

interface Placed { node: ArchNode; x: number; y: number }

/** Draws nodes (grouped in layer containers) and the edges between them. Returns the bounding box. */
function drawNodes(page: Page, model: Model, placed: Placed[], edges: ArchEdge[], opts: { layers: boolean; prefix?: (n: ArchNode) => string }): Geometry {
  const cellId = (id: string): string => safeId("n-", id);
  const frames = new Map<string, { id: string; g: Geometry }>();
  if (opts.layers) {
    const byLayer = new Map<string, Placed[]>();
    for (const p of placed) {
      if (p.node.layer === undefined || p.node.layer === "") continue;
      byLayer.set(p.node.layer, [...(byLayer.get(p.node.layer) ?? []), p]);
    }
    const order = [...(model.arch.layers ?? [])];
    for (const layer of [...byLayer.keys()].sort(byString)) if (!order.includes(layer)) order.push(layer);
    for (const layer of order) {
      const members = byLayer.get(layer);
      if (members === undefined || members.length === 0) continue;
      const minX = Math.min(...members.map((m) => m.x));
      const minY = Math.min(...members.map((m) => m.y));
      const maxX = Math.max(...members.map((m) => m.x + NODE_W));
      const maxY = Math.max(...members.map((m) => m.y + NODE_H));
      const id = safeId("layer-", layer);
      const g = { x: minX - GROUP_PAD, y: minY - GROUP_PAD, w: maxX - minX + GROUP_PAD * 2, h: maxY - minY + GROUP_PAD * 2 };
      frames.set(layer, { id, g });
      page.vertex(id, "1", html(layer), style({
        rounded: 1, arcSize: 3, html: 1, whiteSpace: "wrap", container: 1, collapsible: 0, recursiveResize: 0,
        fillColor: FRAME_FILL, strokeColor: FRAME_STROKE, fontColor: MUTED, fontSize: 11, fontStyle: 1,
        align: "left", verticalAlign: "top", spacingLeft: 8, spacingTop: 1,
      }), g, { object: { ruahLayer: layer, tooltip: html(`layer: ${layer} (${members.length} element${members.length === 1 ? "" : "s"})`) } });
    }
  }
  for (const p of placed) {
    const n = p.node;
    const frame = n.layer !== undefined ? frames.get(n.layer) : undefined;
    const g = frame !== undefined ? { x: p.x - frame.g.x, y: p.y - frame.g.y, w: NODE_W, h: NODE_H } : { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
    const drill = model.levelPage.get(n.id);
    page.vertex(cellId(n.id), frame?.id ?? "1", nodeLabel(model, n, opts.prefix?.(n) ?? ""), nodeStyle(n.type), g, {
      object: { ...nodeProperties(model, n), tooltip: nodeTooltip(model, n), link: drill !== undefined ? `data:page/id,${drill}` : undefined },
    });
  }
  const used = new Set<string>();
  const nodeBoxes = new Map(placed.map((p) => [p.node.id, { x: p.x, y: p.y, w: NODE_W, h: NODE_H }]));
  const routes = routeEdges(edges, nodeBoxes);
  edges.forEach((e, i) => {
    let id = safeId("e-", `${e.from}->${e.to}${e.label !== undefined ? `:${e.label}` : ""}`);
    if (used.has(id)) id = `${id}-${hash6(edgeKey(e))}`;
    used.add(id);
    const route = routes[i];
    page.edge(id, "1", e.label !== undefined ? html(e.label) : "", edgeStyle(e) + (route?.style ?? ""), {
      source: cellId(e.from), target: cellId(e.to), ...(route !== undefined ? { via: route.points } : {}),
    }, edgeProperties(model, e));
  });
  const lanes = routes.flatMap((rt) => rt.points.map(([x, y]) => ({ x, y, w: 1, h: 1 })));
  const boxes = [...frames.values()].map((f) => f.g).concat(placed.map((p) => ({ x: p.x, y: p.y, w: NODE_W, h: NODE_H })), lanes);
  if (boxes.length === 0) return { x: ORIGIN, y: ORIGIN, w: 0, h: 0 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  return { x: minX, y: minY, w: Math.max(...boxes.map((b) => b.x + b.w)) - minX, h: Math.max(...boxes.map((b) => b.y + b.h)) - minY };
}

/** Nodes of one drill level, shifted so the top-left node sits at (ORIGIN, top + ORIGIN). */
function placeLevel(model: Model, parentId: string | null, top: number): Placed[] {
  const level = (model.children.get(parentId) ?? []).filter((n) => !model.workflowOnly.has(n.id));
  if (level.length === 0) return [];
  const minX = Math.min(...level.map((n) => n.x ?? 0));
  const minY = Math.min(...level.map((n) => n.y ?? 0));
  return level.map((node) => ({ node, x: (node.x ?? 0) - minX + ORIGIN, y: (node.y ?? 0) - minY + ORIGIN + top }));
}

function levelEdges(model: Model, placed: Placed[]): ArchEdge[] {
  const visible = new Set(placed.map((p) => p.node.id));
  return sortedEdges(model.arch.edges.filter((e) => visible.has(e.from) && visible.has(e.to)));
}

function titleBlock(page: Page, id: string, heading: string, lines: string[], width: number, links: { text: string; page: string }[] = []): void {
  const body = lines.filter((l) => l !== "").map(html).join("<br>");
  page.vertex(id, "1", `<b style="font-size:18px">${html(heading)}</b>${body !== "" ? `<br><font color="${MUTED}" style="font-size:11px">${body}</font>` : ""}`,
    TEXT_STYLE(), { x: ORIGIN - GROUP_PAD, y: 16, w: Math.max(width, 480), h: 72 });
  links.forEach((l, i) => {
    page.vertex(`${id}-link-${i}`, "1", `<u>${html(l.text)}</u>`, TEXT_STYLE({ fontColor: EDGE, fontSize: 11 }),
      { x: ORIGIN - GROUP_PAD + i * 190, y: 88, w: 180, h: 20 }, { object: { link: `data:page/id,${l.page}` } });
  });
}

function legend(page: Page, x: number, y: number, tokens: Token[]): void {
  const rows = tokens.length + 5;
  const h = 36 + rows * 24 + 8;
  page.vertex("legend", "1", "<b>Legend</b>", style({
    rounded: 1, arcSize: 4, html: 1, whiteSpace: "wrap", container: 1, collapsible: 0, fillColor: "#ffffff", strokeColor: FRAME_STROKE,
    fontColor: TEXT, fontSize: 12, align: "left", verticalAlign: "top", spacingLeft: 10, spacingTop: 6,
  }), { x, y, w: 230, h });
  let row = 0;
  const rowY = (): number => 36 + row * 24;
  for (const t of tokens) {
    const p = PALETTE[t];
    page.vertex(`legend-${t}`, "legend", "", style({ rounded: 1, arcSize: 20, fillColor: p.fill, strokeColor: p.stroke, strokeWidth: 1.5 }), { x: 12, y: rowY(), w: 32, h: 16 });
    page.vertex(`legend-${t}-label`, "legend", html(p.label), TEXT_STYLE({ fontSize: 11, verticalAlign: "middle" }), { x: 52, y: rowY() - 2, w: 170, h: 20 });
    row += 1;
  }
  const edgeRows: [string, Pick<ArchEdge, "kind" | "source">][] = [
    ["sync call", { kind: "sync" }],
    ["async / event", { kind: "async" }],
    ["data flow", { kind: "data" }],
    ["deploys", { kind: "deploy" }],
    ["suggested by the agent", { kind: "sync", source: "suggested" }],
  ];
  edgeRows.forEach(([label, e], i) => {
    page.edge(`legend-edge-${i}`, "legend", "", edgeStyle(e), { from: [12, rowY() + 8], to: [44, rowY() + 8] });
    page.vertex(`legend-edge-${i}-label`, "legend", html(label), TEXT_STYLE({ fontSize: 11, verticalAlign: "middle" }), { x: 52, y: rowY() - 2, w: 170, h: 20 });
    row += 1;
  });
}

function overviewPage(model: Model, opts: DrawioOptions): Page {
  const page = new Page(OVERVIEW_ID, "Overview");
  const arch = model.arch;
  const placed = placeLevel(model, null, TITLE_H);
  const box = drawNodes(page, model, placed, levelEdges(model, placed), { layers: true });
  const facts = [
    `${arch.nodes.length} element${arch.nodes.length === 1 ? "" : "s"}`,
    `${arch.edges.length} link${arch.edges.length === 1 ? "" : "s"}`,
    ...(arch.layers?.length ? [`${arch.layers.length} layers`] : []),
    ...(arch.workflows.length ? [`${arch.workflows.length} workflow${arch.workflows.length === 1 ? "" : "s"}`] : []),
    ...(new Set(arch.nodes.map((n) => n.repo).filter(Boolean)).size > 0 ? [`${new Set(arch.nodes.map((n) => n.repo).filter(Boolean)).size} repos`] : []),
  ].join(" · ");
  titleBlock(page, "title", arch.name, [
    [opts.rootName !== undefined ? `root: ${opts.rootName}` : "", arch.generatedAt !== undefined ? `generated ${arch.generatedAt}` : "", arch.generatedBy ?? ""].filter((s) => s !== "").join(" · "),
    facts,
  ], box.w, [{ text: "Specifications →", page: SPECS_ID }]);
  const used = new Set(arch.nodes.map((n) => tokenOf(n.type)));
  const tokens = (Object.keys(PALETTE) as Token[]).filter((t) => used.has(t));
  legend(page, placed.length > 0 ? box.x + box.w + 60 : ORIGIN, TITLE_H + ORIGIN - GROUP_PAD, tokens.length > 0 ? tokens : ["service"]);
  return page;
}

function levelPageName(model: Model, id: string): string {
  return ancestry(model, id).map((n) => n.name).join(" / ");
}

function levelPage(model: Model, node: ArchNode, name: string): Page {
  const page = new Page(model.levelPage.get(node.id) ?? safeId("level-", node.id), name);
  const placed = placeLevel(model, node.id, TITLE_H);
  const box = drawNodes(page, model, placed, levelEdges(model, placed), { layers: true });
  const up = node.parent !== undefined ? model.levelPage.get(node.parent) : undefined;
  titleBlock(page, "title", name, [
    [node.type, node.path ?? "", node.tech?.join(", ") ?? "", node.repo !== undefined ? `repo ${node.repo}` : ""].filter((s) => s !== "").join(" · "),
    truncate(node.description ?? "", 240),
  ], box.w, [
    { text: `← ${up !== undefined ? nameOf(model, node.parent ?? "") : "Overview"}`, page: up ?? OVERVIEW_ID },
    { text: "Specifications →", page: SPECS_ID },
  ]);
  return page;
}

function workflowPage(model: Model, wf: Workflow, name: string): Page {
  const page = new Page(model.flowPage.get(wf.id) ?? safeId("flow-", wf.id), name);
  const placed: Placed[] = [];
  const seen = new Set<string>();
  wf.steps.forEach((stepId, i) => {
    const node = model.byId.get(stepId);
    if (node === undefined || seen.has(stepId)) return;
    seen.add(stepId);
    placed.push({ node, x: ORIGIN + (i % FLOW_WRAP) * FLOW_GAP_X, y: TITLE_H + ORIGIN + Math.floor(i / FLOW_WRAP) * FLOW_GAP_Y });
  });
  const edges: ArchEdge[] = [];
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < wf.steps.length; i += 1) {
    const from = wf.steps[i] ?? "";
    const to = wf.steps[i + 1] ?? "";
    if (from === to || pairs.has(`${from}\u0000${to}`) || !seen.has(from) || !seen.has(to)) continue;
    pairs.add(`${from}\u0000${to}`);
    edges.push({ from, to, label: String(edges.length + 1), kind: "sync", source: "workflow" });
  }
  const order = new Map<string, number>();
  wf.steps.forEach((s, i) => { if (!order.has(s)) order.set(s, i + 1); });
  const box = drawNodes(page, model, placed, edges, { layers: false, prefix: (n) => `${order.get(n.id) ?? ""}. ` });
  titleBlock(page, "title", name, [`${wf.steps.length} steps · id ${wf.id}`, truncate(wf.description ?? "", 240)], box.w, [
    { text: "← Overview", page: OVERVIEW_ID },
    { text: "Specifications →", page: SPECS_ID },
  ]);
  return page;
}

// ---- specifications page ----------------------------------------------------------------

interface Column { title: string; width: number }

const CHAR_W = 5.6; // average glyph width of 10px Helvetica
const LINE_H = 13;

function cellHeight(text: string, width: number): number {
  const perLine = Math.max(8, Math.floor((width - 10) / CHAR_W));
  const lines = text.split("\n").reduce((sum, para) => sum + Math.max(1, Math.ceil(para.length / perLine)), 0);
  return lines * LINE_H + 12;
}

interface TableCell { text: string; link?: string }

function table(page: Page, id: string, x: number, y: number, columns: Column[], rows: TableCell[][]): number {
  const width = columns.reduce((s, c) => s + c.width, 0);
  const header: TableCell[] = columns.map((c) => ({ text: c.title }));
  const all = [header, ...rows];
  const heights = all.map((row) => Math.max(26, ...row.map((cell, i) => cellHeight(cell.text, columns[i]?.width ?? 100))));
  const total = heights.reduce((s, h) => s + h, 0);
  page.vertex(id, "1", "", style({
    shape: "table", startSize: 0, container: 1, collapsible: 0, childLayout: "tableLayout", fixedRows: 1, rowLines: 1,
    columnLines: 1, fontSize: 10, strokeColor: FRAME_STROKE, fillColor: "#ffffff", html: 1, whiteSpace: "wrap",
  }), { x, y, w: width, h: total });
  let rowY = 0;
  all.forEach((row, ri) => {
    const rowId = `${id}-r${ri}`;
    const h = heights[ri] ?? 26;
    page.vertex(rowId, id, "", style({
      shape: "tableRow", horizontal: 0, startSize: 0, swimlaneHead: 0, swimlaneBody: 0, strokeColor: "inherit", top: 0, left: 0,
      bottom: 0, right: 0, collapsible: 0, dropTarget: 0, fillColor: ri === 0 ? "#f3f1ec" : ri % 2 === 0 ? "#faf9f6" : "none",
      points: "[[0,0.5],[1,0.5]]", portConstraint: "eastwest", fontSize: 10, html: 1,
    }), { x: 0, y: rowY, w: width, h });
    let cellX = 0;
    row.forEach((cell, ci) => {
      const w = columns[ci]?.width ?? 100;
      const cellStyle = style({
        shape: "partialRectangle", html: 1, whiteSpace: "wrap", connectable: 0, strokeColor: "inherit", overflow: "hidden",
        fillColor: "none", top: 0, left: 0, bottom: 0, right: 0, pointerEvents: 1, fontSize: 10, fontColor: TEXT,
        align: "left", verticalAlign: "top", spacingLeft: 4, spacingRight: 4, spacingTop: 2, ...(ri === 0 ? { fontStyle: 1 } : {}),
      });
      const value = cell.link !== undefined ? `<u>${html(cell.text)}</u>` : html(cell.text);
      page.vertex(`${rowId}-c${ci}`, rowId, value, cellStyle, { x: cellX, y: 0, w, h }, {
        alternate: true, ...(cell.link !== undefined ? { object: { link: `data:page/id,${cell.link}` } } : {}),
      });
      cellX += w;
    });
    rowY += h;
  });
  return total;
}

const ELEMENT_COLUMNS: Column[] = [
  { title: "id", width: 150 }, { title: "name", width: 150 }, { title: "type", width: 80 }, { title: "layer", width: 90 },
  { title: "parent", width: 130 }, { title: "repo", width: 90 }, { title: "path", width: 170 }, { title: "tech", width: 150 },
  { title: "files", width: 260 }, { title: "description", width: 280 }, { title: "notes", width: 300 },
  { title: "links (out → / in ←)", width: 300 }, { title: "cloud resources", width: 260 }, { title: "issues", width: 280 },
];

function specOrder(model: Model): ArchNode[] {
  const out: ArchNode[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null): void => {
    for (const n of model.children.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      visit(n.id);
    }
  };
  visit(null);
  // Nodes whose parent is missing (invalid files) still get a row.
  for (const n of [...model.arch.nodes].sort((a, b) => byString(a.id, b.id))) if (!seen.has(n.id)) out.push(n);
  return out;
}

function specificationsPage(model: Model, opts: DrawioOptions): Page {
  const page = new Page(SPECS_ID, "Specifications");
  const arch = model.arch;
  const notes = [...(opts.notes ?? [])];
  const cloudTotal = [...model.cloud.values()].reduce((s, l) => s + l.length, 0);
  const issueTotal = new Set((opts.issues ?? []).filter((i) => i.linkedNodeIds.some((id) => model.byId.has(id))).map((i) => `${i.provider}:${i.id}`)).size;
  titleBlock(page, "title", `${arch.name} — technical specifications`, [
    `${arch.nodes.length} elements · ${arch.edges.length} links · ${arch.workflows.length} workflows · ${cloudTotal} linked cloud resources · ${issueTotal} linked issues`,
    ...notes.map((n) => `note: ${n}`),
  ], 1200, [{ text: "← Overview", page: OVERVIEW_ID }]);
  const top = TITLE_H + 16 + Math.max(0, notes.length - 1) * 14;
  const rows: TableCell[][] = specOrder(model).map((n) => {
    const p = nodeProperties(model, n);
    const files = n.files ?? [];
    const shownFiles = files.slice(0, FILES_LIMIT).join("\n") + (files.length > FILES_LIMIT ? `\n… +${files.length - FILES_LIMIT} more` : "");
    return [
      { text: n.id },
      { text: n.name, link: model.levelPage.get(n.id) ?? homePage(model, n) },
      { text: n.type },
      { text: n.layer ?? "" },
      { text: n.parent !== undefined ? `${nameOf(model, n.parent)} (${n.parent})` : "" },
      { text: n.repo ?? "" },
      { text: n.path ?? "" },
      { text: String(p.tech ?? "") },
      { text: shownFiles },
      { text: n.description ?? "" },
      { text: truncate(n.notes ?? "", 1500) },
      { text: String(p.links ?? "") },
      { text: String(p.cloud ?? "") },
      { text: String(p.issues ?? "") },
    ];
  });
  let y = top;
  page.vertex("elements-heading", "1", "<b>Elements</b>", TEXT_STYLE({ fontSize: 13 }), { x: ORIGIN - GROUP_PAD, y, w: 400, h: 22 });
  y += 26;
  y += table(page, "elements", ORIGIN - GROUP_PAD, y, ELEMENT_COLUMNS, rows) + 40;

  const linkColumns: Column[] = [
    { title: "from", width: 200 }, { title: "to", width: 200 }, { title: "label", width: 200 }, { title: "kind", width: 80 },
    { title: "provenance", width: 90 }, { title: "evidence", width: 420 },
  ];
  const linkRows: TableCell[][] = sortedEdges(arch.edges).map((e) => [
    { text: `${nameOf(model, e.from)} (${e.from})` },
    { text: `${nameOf(model, e.to)} (${e.to})` },
    { text: e.label ?? "" },
    { text: e.kind ?? "sync" },
    { text: e.source ?? "manual" },
    { text: (e.evidence ?? []).join("\n") },
  ]);
  page.vertex("links-heading", "1", "<b>Links</b>", TEXT_STYLE({ fontSize: 13 }), { x: ORIGIN - GROUP_PAD, y, w: 400, h: 22 });
  y += 26;
  y += table(page, "links", ORIGIN - GROUP_PAD, y, linkColumns, linkRows.length > 0 ? linkRows : [[{ text: "(none)" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }]]) + 40;

  if (arch.workflows.length > 0) {
    const flowColumns: Column[] = [{ title: "id", width: 160 }, { title: "name", width: 200 }, { title: "description", width: 320 }, { title: "steps", width: 510 }];
    const flowRows: TableCell[][] = [...arch.workflows].sort((a, b) => byString(a.id, b.id)).map((w) => [
      { text: w.id },
      { text: w.name, link: model.flowPage.get(w.id) ?? OVERVIEW_ID },
      { text: w.description ?? "" },
      { text: w.steps.map((s, i) => `${i + 1}. ${nameOf(model, s)} (${s})`).join("\n") },
    ]);
    page.vertex("workflows-heading", "1", "<b>Workflows</b>", TEXT_STYLE({ fontSize: 13 }), { x: ORIGIN - GROUP_PAD, y, w: 400, h: 22 });
    y += 26;
    table(page, "workflows", ORIGIN - GROUP_PAD, y, flowColumns, flowRows);
  }
  return page;
}

// ---- entry point ---------------------------------------------------------------------------

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name.trim() === "" ? "untitled" : name;
  for (let i = 2; used.has(candidate); i += 1) candidate = `${name} (${i})`;
  used.add(candidate);
  return candidate;
}

/** The architecture as an uncompressed `.drawio` document (UTF-8 XML string). */
export function toDrawio(input: Architecture, opts: DrawioOptions = {}): string {
  const needsLayout = input.nodes.some((n) => n.x === undefined || n.y === undefined);
  const arch = needsLayout ? layoutArchitecture(input) : input;
  const model = buildModel(arch, opts);
  const names = new Set<string>(["Overview", "Specifications"]);
  const pages: Page[] = [overviewPage(model, opts)];
  // Drill pages depth-first (a parent's page precedes its children's), children sorted by id.
  const visit = (parent: string | null): void => {
    for (const n of model.children.get(parent) ?? []) {
      if (!model.levelPage.has(n.id)) continue;
      pages.push(levelPage(model, n, uniqueName(levelPageName(model, n.id), names)));
      visit(n.id);
    }
  };
  visit(null);
  for (const wf of [...arch.workflows].sort((a, b) => byString(a.id, b.id))) {
    pages.push(workflowPage(model, wf, uniqueName(`Workflow: ${wf.name}`, names)));
  }
  pages.push(specificationsPage(model, opts));
  const head = `<mxfile${attrs({
    host: "ruah",
    agent: opts.agent ?? "ruah",
    modified: arch.generatedAt,
    version: "24.7.17",
    type: "device",
    compressed: "false",
  })}>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${head}${pages.map((p) => p.xml()).join("")}</mxfile>\n`;
}

/** A filesystem-safe `<name>.drawio` for Content-Disposition / --out defaults. */
export function drawioFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  return `${base === "" ? "architecture" : base}.drawio`;
}
