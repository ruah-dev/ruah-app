// src/mcp/read.ts — the read side of the map tools: compact, token-cheap text
// views of the architecture for an agent (ruah_get_architecture,
// ruah_get_element, ruah_find_elements). Pure functions over an Architecture.
import type { Architecture, ArchEdge, ArchNode } from "../contracts/architecture.js";
import { resolveElement } from "./ops.js";

const MAX_ELEMENTS = 300;
const MAX_LINKS = 400;

const one = (s: string): string => s.replace(/\s+/g, " ").trim();

function edgeText(e: ArchEdge, names: Map<string, string>): string {
  const tags = [e.label !== undefined ? `[${one(e.label)}]` : "", e.kind !== undefined ? `(${e.kind})` : "", e.source === "agent" ? "{agent}" : ""]
    .filter((t) => t !== "")
    .join(" ");
  return `${e.from} -> ${e.to}${tags !== "" ? ` ${tags}` : ""}   # ${names.get(e.from) ?? e.from} → ${names.get(e.to) ?? e.to}`;
}

function nodeLine(n: ArchNode, childCount: number): string {
  const cols = [n.id, one(n.name), n.type, n.layer ?? "-", n.parent ?? "-", n.path ?? "-"];
  const extra = [childCount > 0 ? `${childCount} inside` : "", n.origin === "agent" ? "agent-made" : ""].filter((s) => s !== "");
  return `- ${cols.join(" · ")}${extra.length > 0 ? `  [${extra.join(", ")}]` : ""}`;
}

/**
 * Compact summary. `level`: undefined = every element; null / "" = the top
 * level only; an element id = that element's direct children (and the links
 * between elements shown).
 */
export function summarizeArchitecture(arch: Architecture, level?: string | null): string {
  const children = new Map<string, number>();
  for (const n of arch.nodes) if (n.parent !== undefined) children.set(n.parent, (children.get(n.parent) ?? 0) + 1);
  let scope = arch.nodes;
  let heading = "all levels";
  if (level !== undefined) {
    if (level === null || level === "") {
      scope = arch.nodes.filter((n) => n.parent === undefined);
      heading = "top level";
    } else {
      const parent = resolveElement(arch, level, "level");
      scope = arch.nodes.filter((n) => n.parent === parent.id);
      heading = `inside ${parent.id} (${one(parent.name)})`;
    }
  }
  const shown = new Set(scope.map((n) => n.id));
  const names = new Map(arch.nodes.map((n) => [n.id, one(n.name)]));
  const links = arch.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
  const lines: string[] = [];
  lines.push(`architecture "${one(arch.name)}": ${arch.nodes.length} elements, ${arch.edges.length} links, ${arch.workflows.length} workflows. Showing ${heading}.`);
  if (arch.layers !== undefined && arch.layers.length > 0) lines.push(`layers: ${arch.layers.join(", ")}`);
  lines.push(`elements (${scope.length}; id · name · type · layer · parent · path):`);
  for (const n of scope.slice(0, MAX_ELEMENTS)) lines.push(nodeLine(n, children.get(n.id) ?? 0));
  if (scope.length > MAX_ELEMENTS) lines.push(`- … ${scope.length - MAX_ELEMENTS} more: pass level=<element id> to see one level at a time`);
  lines.push(`links (${links.length}; from -> to [label] (kind)):`);
  for (const e of links.slice(0, MAX_LINKS)) lines.push(`- ${edgeText(e, names)}`);
  if (links.length > MAX_LINKS) lines.push(`- … ${links.length - MAX_LINKS} more`);
  if (arch.workflows.length > 0 && (level === undefined || level === null || level === "")) {
    lines.push(`workflows (${arch.workflows.length}):`);
    for (const w of arch.workflows) lines.push(`- ${w.id}: ${one(w.name)} — ${w.steps.join(" → ")}`);
  }
  return lines.join("\n");
}

/** Everything about one element: fields, parent, children, links both ways, workflows. */
export function describeElement(arch: Architecture, ref: string): string {
  const node = resolveElement(arch, ref);
  const names = new Map(arch.nodes.map((n) => [n.id, one(n.name)]));
  const parent = node.parent !== undefined ? arch.nodes.find((n) => n.id === node.parent) : undefined;
  const children = arch.nodes.filter((n) => n.parent === node.id);
  const brief = (n: ArchNode): { id: string; name: string; type: string } => ({ id: n.id, name: n.name, type: n.type });
  const link = (e: ArchEdge): Record<string, unknown> => ({
    from: e.from,
    to: e.to,
    name: `${names.get(e.from) ?? e.from} → ${names.get(e.to) ?? e.to}`,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.source !== undefined ? { source: e.source } : {}),
  });
  const { x: _x, y: _y, ...fields } = node;
  const result = {
    element: fields,
    parent: parent !== undefined ? brief(parent) : null,
    children: children.map(brief),
    incoming: arch.edges.filter((e) => e.to === node.id).map(link),
    outgoing: arch.edges.filter((e) => e.from === node.id).map(link),
    workflows: arch.workflows
      .filter((w) => w.steps.includes(node.id))
      .map((w) => ({ id: w.id, name: w.name, step: w.steps.indexOf(node.id) + 1, of: w.steps.length })),
  };
  return JSON.stringify(result, null, 2);
}

/** Elements whose id, name, path, type, tech or description match all words of `query`. */
export function findElements(arch: Architecture, query: string, options: { type?: string | undefined; limit?: number | undefined } = {}): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const type = options.type?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const scored: { node: ArchNode; score: number }[] = [];
  for (const n of arch.nodes) {
    if (type !== undefined && type !== "" && n.type !== type) continue;
    const id = n.id.toLowerCase();
    const name = n.name.toLowerCase();
    const hay = [id, name, n.path ?? "", n.type, (n.tech ?? []).join(" "), n.description ?? "", (n.files ?? []).join(" ")].join("\n").toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    for (const w of words) {
      if (id === w || name === w) score += 10;
      else if (name.startsWith(w) || id.startsWith(w)) score += 5;
      else if (name.includes(w) || id.includes(w)) score += 3;
      else if ((n.path ?? "").toLowerCase().includes(w)) score += 2;
      else score += 1;
    }
    scored.push({ node: n, score });
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  if (scored.length === 0) return `no element matches "${query}"${type !== undefined && type !== "" ? ` with type ${type}` : ""}`;
  const children = new Map<string, number>();
  for (const n of arch.nodes) if (n.parent !== undefined) children.set(n.parent, (children.get(n.parent) ?? 0) + 1);
  const lines = [`${scored.length} match(es) (id · name · type · layer · parent · path):`];
  for (const { node } of scored.slice(0, limit)) lines.push(nodeLine(node, children.get(node.id) ?? 0));
  if (scored.length > limit) lines.push(`- … ${scored.length - limit} more`);
  return lines.join("\n");
}
