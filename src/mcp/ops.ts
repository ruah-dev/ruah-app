// src/mcp/ops.ts — map operations (CONTRACTS §1.7): the pure core behind the
// ruah_* MCP tools and POST /api/arch/ops. applyOps() applies a batch to a
// copy of the architecture, all or nothing: the first op that fails aborts
// the batch with an OpError whose message tells the agent what to fix
// (unknown element with suggestions, ambiguous name, would-be orphans, …),
// and the result must pass validateArchitecture (§1.2) before anyone saves
// it. Elements can be referenced by id or, when unique, by name. Agent-made
// elements get `origin: "agent"`, agent-made links `source: "agent"`, so
// re-scans keep them and the viewer can mark them.
import type { Architecture, ArchEdge, ArchNode, Workflow } from "../contracts/architecture.js";
import type { ArchOp, ElementPatch, MapChange, OpResult } from "../contracts/map.js";
import { ID_PATTERN, validateArchitecture } from "../contracts/validate.js";
import { typeColumn } from "../serve/layout.js";

export const KNOWN_TYPES = ["service", "module", "datastore", "external", "frontend", "gateway", "queue", "file", "step"] as const;
const DESCRIPTION_MAX = 400;
const LABEL_MAX = 40;
const COL_W = 260;
const ROW_H = 110;

export class OpError extends Error {
  constructor(
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
    this.name = "OpError";
  }
}

export interface ApplyOptions {
  /** Provenance written on new elements / links: "agent" (map tools) or "user". */
  origin?: "agent" | "user";
  /** Repo root: warns about paths of changed elements that do not exist (yet). */
  root?: string | null;
}

export interface ApplyOutcome {
  architecture: Architecture;
  results: OpResult[];
  changes: MapChange[];
  /** Non-fatal notes (validation warnings, e.g. a path that does not exist yet). */
  warnings: string[];
}

// ---------- references ----------

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Resolves an element reference: id, then case-insensitive id, then a unique (case-insensitive) name. */
export function resolveElement(arch: Architecture, ref: string, what = "element"): ArchNode {
  const exact = arch.nodes.find((n) => n.id === ref);
  if (exact !== undefined) return exact;
  const key = norm(ref);
  const byId = arch.nodes.find((n) => n.id.toLowerCase() === key);
  if (byId !== undefined) return byId;
  const byName = arch.nodes.filter((n) => norm(n.name) === key);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  if (byName.length > 1) {
    const list = byName.slice(0, 6).map((n) => `${n.id}${n.parent !== undefined ? ` (in ${n.parent})` : ""}`).join(", ");
    throw new OpError(`${what} "${ref}" is ambiguous: ${byName.length} elements are named that (${list}) — use the id`);
  }
  const close = arch.nodes
    .filter((n) => n.id.toLowerCase().includes(key) || norm(n.name).includes(key) || (key.length >= 3 && key.includes(norm(n.name))))
    .slice(0, 5)
    .map((n) => `${n.id} (${n.name})`);
  throw new OpError(
    `unknown ${what} "${ref}"${close.length > 0 ? ` — did you mean ${close.join(", ")}?` : " — call ruah_find_elements or ruah_get_architecture to see the ids"}`,
  );
}

function resolveWorkflow(arch: Architecture, ref: string): Workflow {
  const found = arch.workflows.find((w) => w.id === ref) ?? arch.workflows.find((w) => norm(w.name) === norm(ref));
  if (found === undefined) {
    const ids = arch.workflows.map((w) => w.id).slice(0, 10).join(", ");
    throw new OpError(`unknown workflow "${ref}"${ids.length > 0 ? ` (workflows: ${ids})` : " (the map has no workflows)"}`);
  }
  return found;
}

// ---------- ids ----------

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 56);
  return slug.length > 0 ? slug : "element";
}

/** The repo namespace of a system id ("invoices-api:routes" → "invoices-api:"), else "". */
function namespaceOf(id: string | undefined): string {
  if (id === undefined) return "";
  const i = id.indexOf(":");
  return i > 0 ? id.slice(0, i + 1) : "";
}

function uniqueId(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new OpError(`cannot find a free id for ${base}`);
}

// ---------- field checks ----------

function cleanRel(p: string): string {
  return p.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function checkText(field: string, value: string | undefined, max?: number): void {
  if (value === undefined) return;
  if (max !== undefined && value.length > max) throw new OpError(`${field} is ${value.length} chars; keep it to ${max} or fewer`);
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new OpError("name must not be empty");
  if (trimmed.length > 120) throw new OpError("name is over 120 chars");
  return trimmed;
}

function checkType(type: string): string {
  const t = type.trim().toLowerCase();
  if (t.length === 0) throw new OpError(`type must not be empty (known types: ${KNOWN_TYPES.join(", ")})`);
  return t;
}

function ensureLayer(arch: Architecture, layer: string): void {
  if (arch.layers === undefined) {
    // A map without a layers list takes any layer; start one so the viewer groups it.
    const used = [...new Set(arch.nodes.map((n) => n.layer).filter((l): l is string => l !== undefined))];
    arch.layers = used.includes(layer) ? used : [...used, layer];
    return;
  }
  if (!arch.layers.includes(layer)) arch.layers.push(layer);
}

const nameOf = (arch: Architecture, id: string): string => arch.nodes.find((n) => n.id === id)?.name ?? id;
const levelOf = (arch: Architecture, id: string): string | null => arch.nodes.find((n) => n.id === id)?.parent ?? null;
const linkName = (arch: Architecture, e: { from: string; to: string }): string => `${nameOf(arch, e.from)} → ${nameOf(arch, e.to)}`;

// ---------- apply ----------

/**
 * Applies `ops` in order to a copy of `base`. Throws OpError (with the index
 * of the failing op) and leaves `base` untouched when any op or the final
 * validation fails.
 */
export function applyOps(base: Architecture, ops: readonly ArchOp[], options: ApplyOptions = {}): ApplyOutcome {
  const origin = options.origin ?? "agent";
  const arch = structuredClone(base) as Architecture;
  const results: OpResult[] = [];
  const changes: MapChange[] = [];
  const added = new Set<string>();

  ops.forEach((op, index) => {
    try {
      results.push(applyOne(arch, op, origin, changes, added));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpError(ops.length > 1 ? `op ${index + 1} of ${ops.length} (${op.op}): ${message}; nothing was changed` : `${message}; nothing was changed`, index);
    }
  });

  placeNewElements(arch, added);
  const checked = validateArchitecture(arch, options.root ?? null);
  if (!checked.ok) throw new OpError(`the map would be invalid: ${checked.errors.slice(0, 5).join("; ")}; nothing was changed`);
  // Only warnings about what this batch touched (the rest of the map is not the agent's concern here).
  const touched = new Set(changes.filter((c) => c.target === "element").map((c) => c.id));
  const warnings = checked.warnings.filter((w) => [...touched].some((id) => w.startsWith(`node ${id}:`)));
  return { architecture: arch, results, changes, warnings };
}

function applyOne(arch: Architecture, op: ArchOp, origin: "agent" | "user", changes: MapChange[], added: Set<string>): OpResult {
  switch (op.op) {
    case "add_element": {
      const name = checkName(op.name);
      const type = checkType(op.type);
      checkText("description", op.description, DESCRIPTION_MAX);
      const parent = op.parent !== undefined && op.parent.trim() !== "" ? resolveElement(arch, op.parent, "parent") : undefined;
      const taken = new Set(arch.nodes.map((n) => n.id));
      let id: string;
      if (op.id !== undefined && op.id.trim() !== "") {
        id = op.id.trim();
        if (!ID_PATTERN.test(id)) throw new OpError(`id "${id}" is not valid: lowercase letters, digits, "." "_" "-", up to 64 chars (systems may prefix "<repo>:")`);
        if (taken.has(id)) throw new OpError(`an element with id "${id}" already exists — use ruah_update_element to change it`);
      } else {
        id = uniqueId(taken, `${namespaceOf(parent?.id)}${slugify(name)}`);
      }
      const node: ArchNode = { id, type, name };
      if (op.description !== undefined && op.description.trim() !== "") node.description = op.description.trim();
      if (op.notes !== undefined && op.notes.trim() !== "") node.notes = op.notes;
      if (op.tech !== undefined && op.tech.length > 0) node.tech = op.tech.map((t) => t.trim()).filter((t) => t.length > 0);
      if (op.path !== undefined && op.path.trim() !== "") node.path = cleanRel(op.path);
      if (op.files !== undefined && op.files.length > 0) node.files = op.files.map(cleanRel).filter((f) => f.length > 0).slice(0, 20);
      if (op.layer !== undefined && op.layer.trim() !== "") {
        node.layer = op.layer.trim();
        ensureLayer(arch, node.layer);
      }
      if (parent !== undefined) {
        node.parent = parent.id;
        if (parent.repo !== undefined) node.repo = parent.repo;
      }
      if (op.x !== undefined && op.y !== undefined) {
        node.x = op.x;
        node.y = op.y;
      }
      node.origin = origin;
      arch.nodes.push(node);
      added.add(id);
      changes.push({ action: "add", target: "element", id, name, level: node.parent ?? null });
      return { op: op.op, id, message: `added ${type} "${name}" (id ${id}${node.parent !== undefined ? `, inside ${node.parent}` : ", top level"})` };
    }
    case "update_element": {
      const node = resolveElement(arch, op.id);
      if ((op.patch as Record<string, unknown>).id !== undefined) throw new OpError("the id of an element cannot change — remove it and add a new one");
      const fields = patchElement(arch, node, op.patch);
      if (fields.length === 0) return { op: op.op, id: node.id, message: `"${node.name}" already had those values` };
      const onlyMoved = fields.every((f) => f === "x" || f === "y");
      changes.push({
        action: onlyMoved ? "move" : "update",
        target: "element",
        id: node.id,
        name: node.name,
        level: node.parent ?? null,
        fields,
      });
      return { op: op.op, id: node.id, message: `updated "${node.name}": ${fields.join(", ")}` };
    }
    case "remove_element": {
      const node = resolveElement(arch, op.id);
      const doomed = new Set<string>([node.id]);
      // Descendants, breadth-first.
      let frontier = [node.id];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const n of arch.nodes) {
          if (n.parent !== undefined && frontier.includes(n.parent) && !doomed.has(n.id)) {
            doomed.add(n.id);
            next.push(n.id);
          }
        }
        frontier = next;
      }
      if (doomed.size > 1 && op.recursive !== true) {
        const kids = arch.nodes.filter((n) => n.parent === node.id).map((n) => n.id);
        throw new OpError(
          `"${node.name}" has ${doomed.size - 1} element(s) inside (${kids.slice(0, 6).join(", ")}${kids.length > 6 ? ", …" : ""}); pass recursive: true to remove them too`,
        );
      }
      const removedEdges = arch.edges.filter((e) => doomed.has(e.from) || doomed.has(e.to));
      arch.edges = arch.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to));
      arch.nodes = arch.nodes.filter((n) => !doomed.has(n.id));
      const touchedWorkflows: string[] = [];
      arch.workflows = arch.workflows.flatMap((w) => {
        if (!w.steps.some((s) => doomed.has(s))) return [w];
        touchedWorkflows.push(w.id);
        const steps = w.steps.filter((s) => !doomed.has(s));
        return steps.length >= 2 ? [{ ...w, steps }] : [];
      });
      changes.push({ action: "remove", target: "element", id: node.id, name: node.name, level: node.parent ?? null });
      const extra = [
        doomed.size > 1 ? `${doomed.size - 1} inside` : "",
        removedEdges.length > 0 ? `${removedEdges.length} link(s)` : "",
        touchedWorkflows.length > 0 ? `steps of workflow(s) ${touchedWorkflows.join(", ")}` : "",
      ].filter((s) => s !== "");
      return { op: op.op, id: node.id, message: `removed "${node.name}"${extra.length > 0 ? ` with ${extra.join(", ")}` : ""}` };
    }
    case "connect": {
      const from = resolveElement(arch, op.from, "from element");
      const to = resolveElement(arch, op.to, "to element");
      if (from.id === to.id) throw new OpError("an element cannot link to itself");
      const label = op.label?.trim() || undefined;
      checkText("label", label, LABEL_MAX);
      const kind = op.kind?.trim() || undefined;
      const existing = arch.edges.find((e) => e.from === from.id && e.to === to.id && (e.label ?? "") === (label ?? ""));
      if (existing !== undefined) {
        if (kind === undefined || existing.kind === kind) {
          return { op: op.op, message: `"${from.name}" → "${to.name}"${label !== undefined ? ` [${label}]` : ""} already exists` };
        }
        existing.kind = kind;
        changes.push({ action: "update", target: "link", id: `${from.id}->${to.id}`, name: linkName(arch, existing), level: from.parent ?? null, fields: ["kind"], from: from.id, to: to.id, ...(label !== undefined ? { label } : {}) });
        return { op: op.op, message: `changed the kind of "${from.name}" → "${to.name}" to ${kind}` };
      }
      const edge: ArchEdge = { from: from.id, to: to.id };
      if (label !== undefined) edge.label = label;
      if (kind !== undefined) edge.kind = kind;
      edge.source = origin === "agent" ? "agent" : "manual";
      arch.edges.push(edge);
      changes.push({ action: "connect", target: "link", id: `${from.id}->${to.id}`, name: linkName(arch, edge), level: from.parent ?? null, from: from.id, to: to.id, ...(label !== undefined ? { label } : {}) });
      const crossLevel = (from.parent ?? null) !== (to.parent ?? null);
      return {
        op: op.op,
        message: `linked "${from.name}" → "${to.name}"${label !== undefined ? ` [${label}]` : ""}${crossLevel ? " (the two are on different levels: the link shows where both are visible)" : ""}`,
      };
    }
    case "disconnect": {
      const from = resolveElement(arch, op.from, "from element");
      const to = resolveElement(arch, op.to, "to element");
      const label = op.label?.trim() || undefined;
      const match = (e: ArchEdge): boolean => e.from === from.id && e.to === to.id && (label === undefined || (e.label ?? "") === label);
      const gone = arch.edges.filter(match);
      if (gone.length === 0) {
        const reverse = arch.edges.some((e) => e.from === to.id && e.to === from.id);
        throw new OpError(`there is no link from "${from.name}" to "${to.name}"${label !== undefined ? ` labelled "${label}"` : ""}${reverse ? " (there is one the other way round)" : ""}`);
      }
      arch.edges = arch.edges.filter((e) => !match(e));
      for (const e of gone) {
        changes.push({ action: "disconnect", target: "link", id: `${e.from}->${e.to}`, name: linkName(arch, e), level: from.parent ?? null, from: e.from, to: e.to, ...(e.label !== undefined ? { label: e.label } : {}) });
      }
      return { op: op.op, message: `removed ${gone.length} link(s) "${from.name}" → "${to.name}"` };
    }
    case "add_workflow": {
      const name = checkName(op.name);
      const steps = op.steps.map((s) => resolveElement(arch, s, "step").id);
      if (steps.length < 2) throw new OpError("a workflow needs at least 2 steps");
      const taken = new Set(arch.workflows.map((w) => w.id));
      let id: string;
      if (op.id !== undefined && op.id.trim() !== "") {
        id = op.id.trim();
        if (!ID_PATTERN.test(id)) throw new OpError(`workflow id "${id}" is not valid`);
        if (taken.has(id)) throw new OpError(`a workflow with id "${id}" already exists — use ruah_update_workflow`);
      } else {
        id = uniqueId(taken, slugify(name));
      }
      const wf: Workflow = { id, name, steps };
      if (op.description !== undefined && op.description.trim() !== "") wf.description = op.description.trim();
      arch.workflows.push(wf);
      changes.push({ action: "add_workflow", target: "workflow", id, name, level: null });
      return { op: op.op, id, message: `added workflow "${name}" (id ${id}, ${steps.length} steps)` };
    }
    case "update_workflow": {
      const wf = resolveWorkflow(arch, op.id);
      const fields: string[] = [];
      if (op.name !== undefined && checkName(op.name) !== wf.name) {
        wf.name = checkName(op.name);
        fields.push("name");
      }
      if (op.description !== undefined) {
        const next = op.description === null || op.description.trim() === "" ? undefined : op.description.trim();
        if (next !== wf.description) {
          if (next === undefined) delete wf.description;
          else wf.description = next;
          fields.push("description");
        }
      }
      if (op.steps !== undefined) {
        const steps = op.steps.map((s) => resolveElement(arch, s, "step").id);
        if (steps.length < 2) throw new OpError("a workflow needs at least 2 steps");
        if (steps.join("\u0000") !== wf.steps.join("\u0000")) {
          wf.steps = steps;
          fields.push("steps");
        }
      }
      if (fields.length > 0) changes.push({ action: "update_workflow", target: "workflow", id: wf.id, name: wf.name, level: null, fields });
      return { op: op.op, id: wf.id, message: fields.length > 0 ? `updated workflow "${wf.name}": ${fields.join(", ")}` : `workflow "${wf.name}" already had those values` };
    }
    case "remove_workflow": {
      const wf = resolveWorkflow(arch, op.id);
      arch.workflows = arch.workflows.filter((w) => w !== wf);
      changes.push({ action: "remove_workflow", target: "workflow", id: wf.id, name: wf.name, level: null });
      return { op: op.op, id: wf.id, message: `removed workflow "${wf.name}"` };
    }
    case "set_layout_hint": {
      const node = resolveElement(arch, op.id);
      if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) throw new OpError("x and y must be finite numbers");
      if (node.x === op.x && node.y === op.y) return { op: op.op, id: node.id, message: `"${node.name}" is already there` };
      node.x = Math.round(op.x);
      node.y = Math.round(op.y);
      changes.push({ action: "move", target: "element", id: node.id, name: node.name, level: node.parent ?? null, fields: ["x", "y"] });
      return { op: op.op, id: node.id, message: `moved "${node.name}" to ${node.x}, ${node.y}` };
    }
  }
}

/** Applies a patch; returns the names of the fields that actually changed. */
function patchElement(arch: Architecture, node: ArchNode, patch: ElementPatch): string[] {
  const fields: string[] = [];
  const setOpt = <K extends "layer" | "path" | "description" | "notes">(key: K, value: string | null | undefined, clean: (v: string) => string = (v) => v.trim()): void => {
    if (value === undefined) return;
    const next = value === null || value.trim() === "" ? undefined : clean(value);
    if (next === node[key]) return;
    if (next === undefined) delete node[key];
    else node[key] = next;
    fields.push(key);
  };
  if (patch.name !== undefined) {
    const name = checkName(patch.name);
    if (name !== node.name) {
      node.name = name;
      fields.push("name");
    }
  }
  if (patch.type !== undefined) {
    const type = checkType(patch.type);
    if (type !== node.type) {
      node.type = type;
      fields.push("type");
    }
  }
  if (patch.description !== undefined && patch.description !== null) checkText("description", patch.description.trim(), DESCRIPTION_MAX);
  setOpt("description", patch.description);
  setOpt("notes", patch.notes, (v) => v);
  setOpt("path", patch.path, cleanRel);
  if (patch.layer !== undefined && patch.layer !== null && patch.layer.trim() !== "") ensureLayer(arch, patch.layer.trim());
  setOpt("layer", patch.layer);
  if (patch.parent !== undefined) {
    const parent = patch.parent === null || patch.parent.trim() === "" ? undefined : resolveElement(arch, patch.parent, "parent").id;
    if (parent === node.id) throw new OpError("an element cannot be its own parent");
    if (parent !== node.parent) {
      if (parent === undefined) delete node.parent;
      else node.parent = parent;
      fields.push("parent");
    }
  }
  const setList = (key: "tech" | "files", value: string[] | null | undefined, clean: (v: string) => string): void => {
    if (value === undefined) return;
    const next = value === null ? [] : value.map(clean).filter((v) => v.length > 0);
    const limited = key === "files" ? next.slice(0, 20) : next;
    const prev = node[key] ?? [];
    if (limited.join("\u0000") === prev.join("\u0000")) return;
    if (limited.length === 0) delete node[key];
    else node[key] = limited;
    fields.push(key);
  };
  setList("tech", patch.tech, (v) => v.trim());
  setList("files", patch.files, cleanRel);
  if (patch.x !== undefined && patch.x !== node.x) {
    node.x = Math.round(patch.x);
    fields.push("x");
  }
  if (patch.y !== undefined && patch.y !== node.y) {
    node.y = Math.round(patch.y);
    fields.push("y");
  }
  return fields;
}

// ---------- placement ----------

/**
 * Gives new elements without coordinates a free spot on their level: next to
 * the first element they link to (left of it for clients/externals, right for
 * datastores/queues), else in their type's column below the level's elements.
 */
function placeNewElements(arch: Architecture, added: ReadonlySet<string>): void {
  for (const id of added) {
    const node = arch.nodes.find((n) => n.id === id);
    if (node === undefined || (node.x !== undefined && node.y !== undefined)) continue;
    const level = arch.nodes.filter((n) => n !== node && (n.parent ?? null) === (node.parent ?? null) && n.x !== undefined && n.y !== undefined);
    const neighbourIds = arch.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []));
    const anchor = neighbourIds.map((nid) => level.find((n) => n.id === nid)).find((n): n is ArchNode => n !== undefined);
    let target: { x: number; y: number };
    if (anchor !== undefined) {
      const dir = typeColumn(node.type) < typeColumn(anchor.type) ? -1 : 1;
      target = { x: (anchor.x ?? 0) + dir * COL_W, y: anchor.y ?? 0 };
    } else if (level.length > 0) {
      const minX = Math.min(...level.map((n) => n.x ?? 0));
      const maxY = Math.max(...level.map((n) => n.y ?? 0));
      target = { x: minX + typeColumn(node.type) * COL_W, y: maxY + ROW_H };
    } else {
      target = { x: typeColumn(node.type) * COL_W, y: 0 };
    }
    const spot = freeSpot(level, target);
    node.x = spot.x;
    node.y = spot.y;
  }
}

function freeSpot(level: readonly ArchNode[], target: { x: number; y: number }): { x: number; y: number } {
  const taken = (x: number, y: number): boolean =>
    level.some((n) => Math.abs((n.x ?? 0) - x) < COL_W - 20 && Math.abs((n.y ?? 0) - y) < ROW_H - 10);
  for (let step = 0; step < 40; step += 1) {
    const offset = step === 0 ? 0 : Math.ceil(step / 2) * (step % 2 === 1 ? 1 : -1) * ROW_H;
    const y = target.y + offset;
    if (!taken(target.x, y)) return { x: target.x, y };
  }
  return { x: target.x, y: target.y + 40 * ROW_H };
}

// ---------- per-turn undo ----------

const edgeKey = (e: ArchEdge): string => `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface RevertOutcome {
  architecture: Architecture;
  changes: MapChange[];
  /** Elements the user changed after the turn: left as they are now. */
  skipped: string[];
}

/**
 * Three-way revert of one turn's map changes: every element, link and
 * workflow that differs between `before` (the snapshot taken before the
 * turn's first op) and `after` (the state after its last op) is put back to
 * its `before` state — unless it changed again since (`current` no longer
 * equals `after` for it), in which case the later edit wins and it is listed
 * in `skipped`. Links and workflow steps left pointing at elements that are
 * gone are dropped so the result stays valid.
 */
export function revertTurn(current: Architecture, before: Architecture, after: Architecture): RevertOutcome {
  const next = structuredClone(current) as Architecture;
  const changes: MapChange[] = [];
  const skipped: string[] = [];

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  // Positions are laid out by the store; compare elements without x/y unless the turn moved them.
  const strip = (n: ArchNode | undefined): unknown => (n === undefined ? undefined : { ...n, x: undefined, y: undefined });
  const nodeIds = new Set([...beforeNodes.keys(), ...afterNodes.keys()]);
  for (const id of nodeIds) {
    const b = beforeNodes.get(id);
    const a = afterNodes.get(id);
    if (same(strip(b), strip(a)) && (b?.x === a?.x && b?.y === a?.y)) continue;
    const idx = next.nodes.findIndex((n) => n.id === id);
    const cur = idx >= 0 ? next.nodes[idx] : undefined;
    if (!same(strip(cur), strip(a))) {
      skipped.push(a?.name ?? b?.name ?? id);
      continue;
    }
    if (b === undefined) {
      next.nodes.splice(idx, 1);
      changes.push({ action: "remove", target: "element", id, name: a?.name ?? id, level: a?.parent ?? null });
    } else if (cur === undefined) {
      next.nodes.push(structuredClone(b));
      changes.push({ action: "add", target: "element", id, name: b.name, level: b.parent ?? null });
    } else {
      next.nodes[idx] = structuredClone(b);
      changes.push({ action: "update", target: "element", id, name: b.name, level: b.parent ?? null });
    }
  }

  const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  for (const key of new Set([...beforeEdges.keys(), ...afterEdges.keys()])) {
    const b = beforeEdges.get(key);
    const a = afterEdges.get(key);
    if (same(b, a)) continue;
    const idx = next.edges.findIndex((e) => edgeKey(e) === key);
    const cur = idx >= 0 ? next.edges[idx] : undefined;
    const ref = (a ?? b) as ArchEdge;
    if (!same(cur, a)) {
      skipped.push(linkName(next, ref));
      continue;
    }
    if (b === undefined) {
      next.edges.splice(idx, 1);
      changes.push({ action: "disconnect", target: "link", id: `${ref.from}->${ref.to}`, name: linkName(next, ref), level: levelOf(next, ref.from), from: ref.from, to: ref.to });
    } else if (cur === undefined) {
      next.edges.push(structuredClone(b));
      changes.push({ action: "connect", target: "link", id: `${b.from}->${b.to}`, name: linkName(next, b), level: levelOf(next, b.from), from: b.from, to: b.to });
    } else {
      next.edges[idx] = structuredClone(b);
      changes.push({ action: "update", target: "link", id: `${b.from}->${b.to}`, name: linkName(next, b), level: levelOf(next, b.from), from: b.from, to: b.to });
    }
  }

  const beforeWf = new Map(before.workflows.map((w) => [w.id, w]));
  const afterWf = new Map(after.workflows.map((w) => [w.id, w]));
  for (const id of new Set([...beforeWf.keys(), ...afterWf.keys()])) {
    const b = beforeWf.get(id);
    const a = afterWf.get(id);
    if (same(b, a)) continue;
    const idx = next.workflows.findIndex((w) => w.id === id);
    const cur = idx >= 0 ? next.workflows[idx] : undefined;
    if (!same(cur, a)) {
      skipped.push((a ?? b)?.name ?? id);
      continue;
    }
    if (b === undefined) next.workflows.splice(idx, 1);
    else if (cur === undefined) next.workflows.push(structuredClone(b));
    else next.workflows[idx] = structuredClone(b);
    changes.push({ action: b === undefined ? "remove_workflow" : cur === undefined ? "add_workflow" : "update_workflow", target: "workflow", id, name: (b ?? a)?.name ?? id, level: null });
  }

  // Layers the turn added and nothing uses any more.
  if (next.layers !== undefined) {
    const added = new Set((after.layers ?? []).filter((l) => !(before.layers ?? []).includes(l)));
    const used = new Set(next.nodes.map((n) => n.layer));
    next.layers = next.layers.filter((l) => !added.has(l) || used.has(l));
    if (before.layers === undefined && next.layers.length === 0 && !next.nodes.some((n) => n.layer !== undefined)) delete next.layers;
  }

  // Keep it valid: drop dangling references (e.g. a link the user drew to an element being removed).
  const ids = new Set(next.nodes.map((n) => n.id));
  next.edges = next.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const n of next.nodes) if (n.parent !== undefined && !ids.has(n.parent)) delete n.parent;
  next.workflows = next.workflows.flatMap((w) => {
    const steps = w.steps.filter((s) => ids.has(s));
    return steps.length >= 2 ? [{ ...w, steps }] : [];
  });
  return { architecture: next, changes, skipped };
}
