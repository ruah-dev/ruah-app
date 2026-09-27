// Journeys (CONTRACTS §23, docs/JOURNEYS.md §5): pure helpers for the Journeys page and the Map's
// business overlay — resolving a step's touched code, sorting it into lanes, laying out the
// screen-flow graph, per-element journey coverage and the product-health gaps. No React, no I/O.
import type { Architecture, ArchNode, Evidence, Journey, JourneyStep, ProductFile, Screen } from "./contracts";

// ---------------------------------------------------------------------------
// touches

/** Weakest → strongest (docs/research: evidence_strength); strength = index. */
export const EVIDENCE_KINDS = [
  "opinion",
  "thematic",
  "stated_preference",
  "past_behavior",
  "past_behavior_pattern",
  "commitment",
  "observed_behavior",
  "launch_data",
] as const;

export const EVIDENCE_LABELS: Record<string, string> = {
  opinion: "Opinion",
  thematic: "Trend or competitor",
  stated_preference: "Said they would",
  past_behavior: "Did it (one story)",
  past_behavior_pattern: "Did it (a pattern)",
  commitment: "Committed (time, money)",
  observed_behavior: "Observed / measured",
  launch_data: "After launch data",
};

export function evidenceStrength(e: Pick<Evidence, "kind">): number | undefined {
  if (e.kind === undefined) return undefined;
  const i = (EVIDENCE_KINDS as readonly string[]).indexOf(e.kind);
  return i < 0 ? undefined : i;
}

export type Lane = "frontend" | "backend" | "data";

export const LANES: readonly { id: Lane; label: string }[] = [
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "data", label: "Data & external" },
];

export interface TouchView {
  ref: string;
  /** The stored element the ref is, or lives in (expanded ids: the element they were expanded from). */
  element: ArchNode | undefined;
  /** What to show: element name, or the file / symbol part of an expanded id. */
  label: string;
  /** Element type (or "file" / "symbol" for expanded ids, "workflow" for workflows). */
  type: string;
  lane: Lane;
  broken: boolean;
  workflow?: { id: string; name: string; steps: string[] };
}

const FRONTEND_TYPES = new Set(["frontend", "mobile", "user", "actor"]);
const DATA_TYPES = new Set(["datastore", "database", "cache", "storage", "warehouse", "search", "queue", "topic", "stream", "external"]);

/** The nearest stored element that is the ref, or that an expanded ref (`<id>/…`, `<id>#…`) lives in. */
export function ownerOf(ref: string, arch: Architecture | null): ArchNode | undefined {
  if (arch === null) return undefined;
  const exact = arch.nodes.find((n) => n.id === ref);
  if (exact !== undefined) return exact;
  let best: ArchNode | undefined;
  for (const n of arch.nodes) {
    if ((ref.startsWith(`${n.id}/`) || ref.startsWith(`${n.id}#`)) && (best === undefined || n.id.length > best.id.length)) best = n;
  }
  return best;
}

/**
 * Which lane a touched element belongs in: its own type, else the first typed ancestor
 * (a module inside the web app is frontend code). Frontend: frontend / mobile types;
 * Data & external: datastores, queues, externals; everything else (services, gateways,
 * modules of a service, workflows) is backend. Mirrors src/product/lanes.ts.
 */
export function laneOfElement(node: ArchNode | undefined, arch: Architecture | null): Lane {
  const byId = new Map((arch?.nodes ?? []).map((n) => [n.id, n]));
  for (let cur = node, guard = 0; cur !== undefined && guard < 64; cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined, guard += 1) {
    if (FRONTEND_TYPES.has(cur.type)) return "frontend";
    if (DATA_TYPES.has(cur.type)) return "data";
    if (cur.type === "service" || cur.type === "gateway" || cur.type === "worker" || cur.type === "function") return "backend";
  }
  return "backend";
}

export function resolveTouch(ref: string, arch: Architecture | null, broken: ReadonlySet<string>): TouchView {
  const workflow = arch?.workflows.find((w) => w.id === ref);
  if (workflow !== undefined) {
    return { ref, element: undefined, label: workflow.name, type: "workflow", lane: "backend", broken: false, workflow: { id: workflow.id, name: workflow.name, steps: workflow.steps } };
  }
  const element = ownerOf(ref, arch);
  if (element !== undefined && element.id === ref) {
    return { ref, element, label: element.name, type: element.type, lane: laneOfElement(element, arch), broken: broken.has(ref) };
  }
  const hash = ref.indexOf("#");
  const symbol = hash >= 0 ? ref.slice(hash + 1) : undefined;
  const filePart = (hash >= 0 ? ref.slice(0, hash) : ref).split("/").pop() ?? ref;
  const label = symbol !== undefined ? `${symbol}${filePart !== "" ? ` · ${filePart}` : ""}` : filePart || ref;
  const type = symbol !== undefined ? "symbol" : element !== undefined ? "file" : "unknown";
  return { ref, element, label, type, lane: laneOfElement(element, arch), broken: broken.has(ref) || element === undefined };
}

/** "journey <j>: step <s>: broken link: <ref>" warnings of one step, as a set of refs. */
export function brokenTouches(warnings: readonly string[], journeyId: string, stepId: string): Set<string> {
  const prefix = `journey ${journeyId}: step ${stepId}: broken link: `;
  return new Set(warnings.filter((w) => w.startsWith(prefix)).map((w) => w.slice(prefix.length)));
}

// ---------------------------------------------------------------------------
// line view: one column per step, touches sorted into lanes

export interface StepColumn {
  step: JourneyStep;
  index: number;
  screen: Screen | undefined;
  lanes: Record<Lane, TouchView[]>;
  branches: Journey["branches"];
}

export function journeyColumns(product: ProductFile, journey: Journey, arch: Architecture | null, warnings: readonly string[]): StepColumn[] {
  return journey.steps.map((step, index) => {
    const broken = brokenTouches(warnings, journey.id, step.id);
    const lanes: Record<Lane, TouchView[]> = { frontend: [], backend: [], data: [] };
    for (const ref of step.touches ?? []) {
      const t = resolveTouch(ref, arch, broken);
      lanes[t.lane].push(t);
    }
    return {
      step,
      index,
      screen: step.screen !== undefined ? product.screens.find((s) => s.id === step.screen) : undefined,
      lanes,
      branches: (journey.branches ?? []).filter((b) => b.from === step.id),
    };
  });
}

// ---------------------------------------------------------------------------
// flow map: screens as nodes, steps as arrows between them, every journey at once

export interface FlowNode {
  id: string; // screen id, or "entry:<journeyId>" for a journey that starts without a screen
  screen: Screen | undefined;
  label: string;
  sub: string;
  x: number;
  y: number;
  /** In no journey: drawn dimmed, apart from the rest. */
  orphan: boolean;
  journeys: string[];
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  journey: string;
  step: string;
  label: string;
  /** Branch (dashed) instead of the main line. */
  branch: boolean;
  /** Parallel edges between the same two screens: 0, 1, 2 … (curved apart). */
  lane: number;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

export const FLOW_NODE_W = 184;
export const FLOW_NODE_H = 56;
const FLOW_GAP_X = 190;
const FLOW_GAP_Y = 44;
const FLOW_PAD = 32;
/** Room above the first row: arrows that go back (to an earlier column) are routed over the boxes. */
export const FLOW_PAD_TOP = 88;

/**
 * Lays out the screen-flow graph: columns by the shortest number of steps from any journey's
 * first screen (breadth first), rows in first-seen order; screens no journey visits go last,
 * in a column of their own. Consecutive steps on the same screen add no arrow.
 */
export function flowGraph(product: ProductFile, options: { journeys?: readonly string[] } = {}): FlowGraph {
  const journeys = product.journeys.filter((j) => options.journeys === undefined || options.journeys.includes(j.id));
  const edges: FlowEdge[] = [];
  const nodeJourneys = new Map<string, Set<string>>();
  const touch = (id: string, journey: string) => {
    let set = nodeJourneys.get(id);
    if (set === undefined) nodeJourneys.set(id, (set = new Set()));
    set.add(journey);
  };
  const pairCount = new Map<string, number>();
  const addEdge = (from: string, to: string, journey: Journey, step: JourneyStep, label: string, branch: boolean) => {
    if (from === to) return;
    const key = [from, to].sort().join("\u0000");
    const lane = pairCount.get(key) ?? 0;
    pairCount.set(key, lane + 1);
    edges.push({ id: `${journey.id}/${step.id}/${edges.length}`, from, to, journey: journey.id, step: step.id, label, branch, lane });
  };
  for (const journey of journeys) {
    let prev: string | undefined;
    for (const step of journey.steps) {
      // Steps without a screen stay on the previous screen (an action there), except the first.
      const at = step.screen ?? prev ?? `entry:${journey.id}`;
      touch(at, journey.id);
      if (prev !== undefined) addEdge(prev, at, journey, step, step.action, false);
      prev = at;
    }
    for (const b of journey.branches ?? []) {
      const fromStep = journey.steps.find((s) => s.id === b.from);
      if (fromStep === undefined) continue;
      const from = screenAt(journey, b.from) ?? `entry:${journey.id}`;
      if (b.to !== undefined) {
        const to = screenAt(journey, b.to);
        if (to !== undefined) addEdge(from, to, journey, fromStep, b.when, true);
      } else if (b.journey !== undefined) {
        const alt = product.journeys.find((j) => j.id === b.journey);
        const first = alt?.steps[0];
        if (alt !== undefined && first !== undefined) {
          const to = first.screen ?? `entry:${alt.id}`;
          touch(to, journey.id);
          addEdge(from, to, journey, fromStep, b.when, true);
        }
      }
    }
  }

  // Columns: the longest path over the main-line arrows (branches and arrows that close a cycle
  // ignored), so every journey reads left to right and a screen sits right of all screens before it.
  const starts: string[] = [];
  for (const j of journeys) {
    const start = j.steps[0]?.screen ?? `entry:${j.id}`;
    if (!starts.includes(start)) starts.push(start);
  }
  const all = [...new Set([...starts, ...nodeJourneys.keys()])];
  const out = new Map<string, string[]>();
  for (const e of edges) if (!e.branch) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  // Drop back edges (depth-first from the starts, in journey order).
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const dag = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) continue; // closes a cycle
      dag.set(id, [...(dag.get(id) ?? []), next]);
      if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of [...starts, ...all]) if (!state.has(id)) visit(id);
  const indegree = new Map(all.map((id) => [id, 0]));
  for (const targets of dag.values()) for (const t of targets) indegree.set(t, (indegree.get(t) ?? 0) + 1);
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue = all.filter((id) => (indegree.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dag.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1));
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  for (const id of all) {
    if (!depth.has(id)) {
      depth.set(id, 0);
      order.push(id);
    }
  }
  const visited = new Set(order);
  const orphans = options.journeys === undefined ? product.screens.filter((s) => !visited.has(s.id)).map((s) => s.id) : [];
  const maxDepth = Math.max(0, ...[...depth.values()]);
  const rows = new Map<number, number>();
  const nodes: FlowNode[] = [];
  const place = (id: string, col: number, orphan: boolean) => {
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const screen = product.screens.find((s) => s.id === id);
    const journey = id.startsWith("entry:") ? product.journeys.find((j) => `entry:${j.id}` === id) : undefined;
    nodes.push({
      id,
      screen,
      label: screen?.name ?? (journey !== undefined ? `Start: ${journey.name}` : id),
      sub: screen?.route ?? (journey !== undefined ? "no screen yet" : ""),
      x: FLOW_PAD + col * (FLOW_NODE_W + FLOW_GAP_X),
      y: FLOW_PAD_TOP + row * (FLOW_NODE_H + FLOW_GAP_Y),
      orphan,
      journeys: [...(nodeJourneys.get(id) ?? [])],
    });
  };
  for (const id of order) place(id, depth.get(id) ?? 0, false);
  const orphanCol = order.length > 0 ? maxDepth + 1 : 0;
  for (const id of orphans) place(id, orphanCol, true);
  const width = Math.max(...nodes.map((n) => n.x + FLOW_NODE_W), 0) + FLOW_PAD;
  const height = Math.max(...nodes.map((n) => n.y + FLOW_NODE_H), 0) + FLOW_PAD;
  return { nodes, edges, width, height };
}

function screenAt(journey: Journey, stepId: string): string | undefined {
  let at: string | undefined;
  for (const s of journey.steps) {
    at = s.screen ?? at;
    if (s.id === stepId) return at;
  }
  return undefined;
}

/** A stable colour slot (0–7) per journey, in file order. */
export function journeyColorIndex(product: ProductFile, journeyId: string): number {
  const i = product.journeys.findIndex((j) => j.id === journeyId);
  return (i < 0 ? 0 : i) % 8;
}

// ---------------------------------------------------------------------------
// business overlay: how many journeys each stored element serves

export interface Coverage {
  journeys: number;
  core: number;
  steps: number;
}

/**
 * Journeys per stored element: a step covers the element it touches, every element that
 * element sits in (a module's service), the elements of a touched workflow, and the element
 * its screen belongs to.
 */
export function journeyCoverage(product: ProductFile | null, arch: Architecture | null): Map<string, Coverage> {
  const result = new Map<string, Coverage>();
  if (product === null || arch === null) return result;
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  for (const journey of product.journeys) {
    const covered = new Map<string, number>();
    const cover = (id: string | undefined) => {
      for (let cur = id !== undefined ? byId.get(id) : undefined, guard = 0; cur !== undefined && guard < 64; cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined, guard += 1) {
        covered.set(cur.id, (covered.get(cur.id) ?? 0) + 1);
      }
    };
    for (const step of journey.steps) {
      const here = new Set<string>();
      for (const ref of step.touches ?? []) {
        const wf = arch.workflows.find((w) => w.id === ref);
        if (wf !== undefined) wf.steps.forEach((s) => here.add(s));
        else {
          const owner = ownerOf(ref, arch);
          if (owner !== undefined) here.add(owner.id);
        }
      }
      const screen = step.screen !== undefined ? product.screens.find((s) => s.id === step.screen) : undefined;
      if (screen?.node !== undefined) here.add(screen.node);
      here.forEach(cover);
    }
    for (const [id, steps] of covered) {
      const c = result.get(id) ?? { journeys: 0, core: 0, steps: 0 };
      c.journeys += 1;
      if (journey.priority === "core") c.core += 1;
      c.steps += steps;
      result.set(id, c);
    }
  }
  return result;
}

/**
 * Coverage for the elements on one canvas level: stored elements from `journeyCoverage`,
 * drilled-in folders / files / symbols (expanded ids) from the steps that touch them directly.
 */
export function levelCoverage(product: ProductFile | null, arch: Architecture | null, ids: readonly string[], stored: ReadonlyMap<string, Coverage>): Map<string, Coverage> {
  const out = new Map<string, Coverage>();
  for (const id of ids) {
    const known = stored.get(id);
    if (known !== undefined) {
      out.set(id, known);
      continue;
    }
    if (arch?.nodes.some((n) => n.id === id)) continue;
    const hits = stepsForElement(product, arch, id);
    if (hits.length === 0) continue;
    const journeys = new Map(hits.map((h) => [h.journey.id, h.journey]));
    out.set(id, { journeys: journeys.size, core: [...journeys.values()].filter((j) => j.priority === "core").length, steps: hits.length });
  }
  return out;
}

/** Journey steps that touch `elementId` (or anything inside it, or through its screens). */
export function stepsForElement(product: ProductFile | null, arch: Architecture | null, elementId: string): { journey: Journey; step: JourneyStep; index: number }[] {
  if (product === null || arch === null) return [];
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const inside = (id: string | undefined): boolean => {
    for (let cur = id !== undefined ? byId.get(id) : undefined, guard = 0; cur !== undefined && guard < 64; cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined, guard += 1) {
      if (cur.id === elementId) return true;
    }
    return false;
  };
  const hits: { journey: Journey; step: JourneyStep; index: number }[] = [];
  for (const journey of product.journeys) {
    journey.steps.forEach((step, index) => {
      const viaTouch = (step.touches ?? []).some((ref) => {
        const wf = arch.workflows.find((w) => w.id === ref);
        if (wf !== undefined) return wf.steps.includes(elementId);
        return ref === elementId || ref.startsWith(`${elementId}/`) || ref.startsWith(`${elementId}#`) || inside(ownerOf(ref, arch)?.id);
      });
      const screen = step.screen !== undefined ? product.screens.find((s) => s.id === step.screen) : undefined;
      if (viaTouch || inside(screen?.node)) hits.push({ journey, step, index });
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// product health (JOURNEYS.md §5.4)

export type GapKind = "broken_link" | "drifted" | "missing_why" | "no_signal" | "no_evidence" | "weak_evidence" | "open_question" | "unmapped_screen" | "not_reviewed" | "agent_draft";

export interface Gap {
  kind: GapKind;
  severity: "high" | "medium" | "low";
  title: string;
  detail?: string;
  journey?: string;
  step?: string;
  screen?: string;
}

export const GAP_LABELS: Record<GapKind, string> = {
  broken_link: "Broken links",
  drifted: "Code changed since review",
  missing_why: "Missing why",
  no_signal: "No success signal",
  no_evidence: "No evidence",
  weak_evidence: "Weak evidence",
  open_question: "Open questions",
  unmapped_screen: "Screens in no journey",
  not_reviewed: "Not reviewed",
  agent_draft: "Agent drafts to review",
};

function strongest(journey: Journey): number | undefined {
  let best: number | undefined;
  for (const s of journey.steps) for (const e of s.evidence ?? []) {
    if (e.stance === "contradicts") continue;
    const v = evidenceStrength(e);
    if (v !== undefined && (best === undefined || v > best)) best = v;
  }
  return best;
}

/** GET /api/product/drift: a reviewed journey whose code changed since (CONTRACTS §23.9). */
export interface JourneyDrift {
  journey: string;
  reviewedAt: string;
  commit: { sha: string; date: string; subject: string } | null;
  uncommitted: number;
  paths: string[];
}

export function productGaps(product: ProductFile | null, warnings: readonly string[], drift: readonly JourneyDrift[] = []): Gap[] {
  if (product === null) return [];
  const gaps: Gap[] = [];
  for (const d of drift) {
    const j = product.journeys.find((x) => x.id === d.journey);
    if (j === undefined) continue;
    const what = d.commit !== null ? `“${d.commit.subject}”` : `${d.uncommitted} uncommitted change${d.uncommitted === 1 ? "" : "s"}`;
    gaps.push({ kind: "drifted", severity: "high", title: `${j.name}: its code changed since the review (${what})`, detail: d.paths.join(", "), journey: j.id });
  }
  for (const w of warnings) {
    const m = /^journey ([^:]+): step ([^:]+): broken link: (.+)$/.exec(w);
    if (m !== null) gaps.push({ kind: "broken_link", severity: "high", title: `${m[3]} no longer exists`, detail: w, journey: m[1]!, step: m[2]! });
    const s = /^screen ([^:]+): path does not exist on disk: (.+)$/.exec(w);
    if (s !== null) gaps.push({ kind: "broken_link", severity: "medium", title: `Screen file ${s[2]} is gone`, detail: w, screen: s[1]! });
  }
  const used = new Set<string>();
  for (const j of product.journeys) {
    const core = j.priority === "core";
    for (const s of j.steps) {
      if (s.screen !== undefined) used.add(s.screen);
      if (s.question !== undefined && s.question.trim() !== "") gaps.push({ kind: "open_question", severity: "medium", title: s.question, journey: j.id, step: s.id });
      if (core && (s.why === undefined || s.why.trim() === "")) gaps.push({ kind: "missing_why", severity: "medium", title: `${j.name}: “${s.action}” has no why`, journey: j.id, step: s.id });
      if ((s.evidence ?? []).some((e) => e.stance === "contradicts")) gaps.push({ kind: "weak_evidence", severity: "high", title: `${j.name}: evidence contradicts “${s.action}”`, journey: j.id, step: s.id });
      if (s.origin === "agent") gaps.push({ kind: "agent_draft", severity: "low", title: `${j.name}: “${s.action}” was drafted by an agent`, journey: j.id, step: s.id });
    }
    if (core && (j.why === undefined || j.why.trim() === "")) gaps.push({ kind: "missing_why", severity: "medium", title: `${j.name} has no why`, journey: j.id });
    if (core && j.signal === undefined && !j.steps.some((s) => s.signal !== undefined && s.signal.trim() !== "")) {
      gaps.push({ kind: "no_signal", severity: "medium", title: `${j.name} has no success signal`, journey: j.id });
    }
    if (core) {
      const best = strongest(j);
      if (best === undefined && !j.steps.some((s) => (s.evidence ?? []).length > 0)) gaps.push({ kind: "no_evidence", severity: "medium", title: `${j.name} rests on no evidence`, journey: j.id });
      else if (best !== undefined && best <= 2) gaps.push({ kind: "weak_evidence", severity: "medium", title: `${j.name}: the best evidence is “${EVIDENCE_LABELS[EVIDENCE_KINDS[best]!]}”`, journey: j.id });
      if (j.reviewedAt === undefined) gaps.push({ kind: "not_reviewed", severity: "low", title: `${j.name} was never marked reviewed`, journey: j.id });
    }
    if (j.origin === "agent") gaps.push({ kind: "agent_draft", severity: "low", title: `${j.name} was drafted by an agent`, journey: j.id });
  }
  for (const s of product.screens) {
    if (!used.has(s.id)) gaps.push({ kind: "unmapped_screen", severity: "low", title: `${s.name}${s.route !== undefined ? ` (${s.route})` : ""} is in no journey`, screen: s.id });
  }
  const order: Record<Gap["severity"], number> = { high: 0, medium: 1, low: 2 };
  return gaps.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Gaps that need a person (everything but the "low" nudges). */
export function attentionCount(gaps: readonly Gap[]): number {
  return gaps.filter((g) => g.severity !== "low").length;
}

// ---------------------------------------------------------------------------
// screens ↔ preview URLs

/** "/accounts/:id", "/files/*rest", "/docs/[slug]" → a regex for pathnames. */
export function routePattern(route: string): RegExp {
  const parts = route
    .replace(/\/+$/, "")
    .split("/")
    .filter((p) => p !== "")
    .map((seg) => {
      if (/^:[^/]+\*$/.test(seg) || /^\*/.test(seg) || /^\[\.\.\./.test(seg)) return "(?:/.*)?";
      if (/^:/.test(seg) || /^\[[^\]]+\]$/.test(seg) || /^\$/.test(seg)) return "/[^/]+";
      return `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    });
  return new RegExp(`^${parts.join("") || "/"}/?$`);
}

/** The screen whose route matches a preview URL's path (the most specific: fewest parameters). */
export function screenForUrl(product: ProductFile | null, url: string | null | undefined): Screen | undefined {
  if (!product || !url) return undefined;
  let pathname: string;
  try {
    pathname = new URL(url, "http://x").pathname;
  } catch {
    return undefined;
  }
  const hits = product.screens.filter((s) => s.route !== undefined && routePattern(s.route).test(pathname));
  const params = (s: Screen) => (s.route?.match(/[:*[$]/g) ?? []).length;
  return hits.sort((a, b) => params(a) - params(b))[0];
}

// ---------------------------------------------------------------------------
// editing helpers

export function slugId(text: string, taken: ReadonlySet<string>, fallback: string): string {
  let root = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 48)
    .replace(/[-._]+$/, "");
  if (root === "") root = fallback;
  let id = root;
  for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  return id;
}

/** Removes references to personas, screens, journeys and steps that no longer exist (mirrors the daemon). */
export function dropDangling(product: ProductFile): void {
  const personas = new Set(product.personas.map((p) => p.id));
  const screens = new Set(product.screens.map((s) => s.id));
  const journeys = new Set(product.journeys.map((j) => j.id));
  for (const j of product.journeys) {
    if (j.persona !== undefined && !personas.has(j.persona)) delete j.persona;
    for (const s of j.steps) if (s.screen !== undefined && !screens.has(s.screen)) delete s.screen;
    if (j.branches !== undefined) {
      const steps = new Set(j.steps.map((s) => s.id));
      j.branches = j.branches.filter(
        (b) =>
          steps.has(b.from) &&
          (b.to === undefined || steps.has(b.to)) &&
          (b.journey === undefined || (journeys.has(b.journey) && b.journey !== j.id)) &&
          (b.rejoin === undefined || steps.has(b.rejoin)),
      );
      if (j.branches.length === 0) delete j.branches;
    }
  }
}

/** Journeys grouped by persona (personas in file order, then "No persona"); core first inside a group. */
export function journeysByPersona(product: ProductFile): { persona: ProductFile["personas"][number] | null; journeys: Journey[] }[] {
  const rank = (j: Journey) => (j.priority === "core" ? 0 : j.priority === "secondary" ? 1 : j.priority === "edge" ? 3 : 2);
  const sorted = (list: Journey[]) => [...list].sort((a, b) => rank(a) - rank(b));
  const groups = product.personas.map((p) => ({ persona: p, journeys: sorted(product.journeys.filter((j) => j.persona === p.id)) }));
  const none = product.journeys.filter((j) => j.persona === undefined || !product.personas.some((p) => p.id === j.persona));
  return [...groups, ...(none.length > 0 ? [{ persona: null, journeys: sorted(none) }] : [])];
}
