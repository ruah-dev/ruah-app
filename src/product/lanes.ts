// src/product/lanes.ts — which journey lane a step's `touches` entry belongs in
// (docs/JOURNEYS.md §5.1 "journey lanes", CONTRACTS §23.7). Pure, no I/O: the
// draw.io journey pages and the storyboard use it, and the viewer's Journeys mode
// mirrors it, so the rule below is the contract. Keep the two in sync.
//
// Lanes, top to bottom: Customer (the step card), Screen (the step's screen),
// Frontend, Backend, Data & external. Only the last three hold touches.
//
// laneOf(ref, architecture), first rule that applies:
//   1. An architecture workflow id → "backend" (a request path through the system).
//   2. A symbol ("<file id>#<name>"):
//        - an HTTP route name ("GET /transfers", "POST /x", any verb or ALL/USE, then "/") → "backend"
//        - a React hook name ("use" + capital letter) → "frontend"
//        - anything else → the lane of the file part (rules 3–5).
//   3. A stored element, by its type's kind (src/export/kinds.ts kindOf):
//        - frontend, mobile, user, actor                                → "frontend"
//        - database/datastore, cache, storage, warehouse, search, approval,
//          queue, topic, stream, webhook, scheduler, decision, event,
//          external, timer                                              → "data"
//        - service, function, container, cluster, worker, gateway,
//          loadbalancer, cdn, dns, firewall, auth, secret, monitoring,
//          analytics, config, ml, step, api                             → "backend"
//        - module, file, component and unknown types: the lane of the nearest
//          ancestor (parent chain) that has one of the kinds above; none → "frontend".
//   4. An expanded folder or file ("<element id>/<rel path>"): the lane of the
//      stored element with the longest id prefix (rule 3); none → rule 5.
//   5. Nothing resolves (broken link, or no architecture): by the text of the ref:
//        - a UI file (.tsx .jsx .vue .svelte .astro .html .css .scss) → "frontend"
//        - a data-looking name (db, database, postgres, mysql, sqlite, redis, mongo,
//          queue, kafka, sqs, s3, bucket, cache, stripe/…: see DATA_WORDS) → "data"
//        - otherwise → "backend".
import type { ArchNode, Architecture } from "../contracts/architecture.js";
import { kindOf } from "../export/kinds.js";

export type Lane = "customer" | "screen" | "frontend" | "backend" | "data";
export type CodeLane = Extract<Lane, "frontend" | "backend" | "data">;

/** The lanes top to bottom, with their labels. */
export const LANES: readonly { id: Lane; label: string }[] = [
  { id: "customer", label: "Customer" },
  { id: "screen", label: "Screen" },
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "data", label: "Data & external" },
];

export const LANE_LABEL: Record<Lane, string> = Object.fromEntries(LANES.map((l) => [l.id, l.label])) as Record<Lane, string>;

const FRONTEND_KINDS = new Set(["frontend", "mobile", "user", "actor"]);
const DATA_KINDS = new Set([
  "database", "cache", "storage", "warehouse", "search", "approval",
  "queue", "topic", "stream", "webhook", "scheduler", "decision", "event",
  "external", "timer",
]);
const BACKEND_KINDS = new Set([
  "service", "function", "container", "cluster", "worker",
  "gateway", "loadbalancer", "cdn", "dns", "firewall",
  "auth", "secret", "monitoring", "analytics", "config", "ml", "step",
]);

const ROUTE_NAME = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL|USE|ANY)\s+\//i;
const HOOK_NAME = /^use[A-Z0-9]/;
const UI_FILE = /\.(?:tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less)$/i;
const DATA_WORDS = /(?:^|[^a-z0-9])(?:db|database|datastore|postgres|postgresql|pg|mysql|mariadb|sqlite|redis|mongo|mongodb|dynamo|dynamodb|ledger-db|queue|kafka|sqs|sns|rabbitmq|pubsub|s3|bucket|cache|elasticsearch|stripe|twilio|sendgrid)(?:$|[^a-z0-9])/i;

/** Is a symbol name an HTTP route handler ("GET /users")? */
export function isRouteName(name: string): boolean {
  return ROUTE_NAME.test(name.trim());
}

/** Lane of a stored element by its own type alone; undefined for modules, files and unknown types. */
function ownLane(node: ArchNode): CodeLane | undefined {
  const t = node.type.toLowerCase();
  if (t === "api") return "backend";
  const kind = kindOf(node.type);
  if (FRONTEND_KINDS.has(kind)) return "frontend";
  if (DATA_KINDS.has(kind)) return "data";
  if (BACKEND_KINDS.has(kind)) return "backend";
  return undefined;
}

function textLane(ref: string): CodeLane {
  const file = ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
  if (UI_FILE.test(file)) return "frontend";
  if (DATA_WORDS.test(file)) return "data";
  return "backend";
}

/** Rule 3: the element's own kind, else its nearest deciding ancestor's, else "frontend". */
function elementLane(node: ArchNode, byId: ReadonlyMap<string, ArchNode>): CodeLane {
  const seen = new Set<string>();
  for (let cur: ArchNode | undefined = node; cur !== undefined && !seen.has(cur.id); cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined) {
    seen.add(cur.id);
    const lane = ownLane(cur);
    if (lane !== undefined) return lane;
  }
  return "frontend";
}

/** What a touches entry points at, as far as the stored architecture tells (no file system). */
export interface TouchInfo {
  ref: string;
  /** element: a stored element; workflow: an architecture workflow; expanded: a folder/file/symbol under a stored element; unknown: nothing matches. */
  kind: "element" | "workflow" | "expanded" | "unknown";
  /** Display name: element or workflow name, the symbol or file name for expanded refs, the raw ref otherwise. */
  name: string;
  /** Element type (stored), "symbol" / "route" / "file" (expanded), "workflow", or undefined. */
  type?: string;
  /** Repo-relative path when known. */
  path?: string;
  /** The stored element the ref sits in (itself for kind "element"). */
  owner?: ArchNode;
  lane: CodeLane;
}

/** The stored element whose id is the longest prefix of an expanded ref ("<id>/…" or "<id>#…"). */
function ownerOf(ref: string, arch: Architecture): ArchNode | undefined {
  let best: ArchNode | undefined;
  for (const n of arch.nodes) {
    if ((ref.startsWith(`${n.id}/`) || ref.startsWith(`${n.id}#`)) && (best === undefined || n.id.length > best.id.length)) best = n;
  }
  return best;
}

/** Resolves a touches entry against the architecture (null = no map) and assigns its lane. */
export function describeTouch(ref: string, arch: Architecture | null): TouchInfo {
  const hash = ref.indexOf("#");
  const symbol = hash === -1 ? undefined : ref.slice(hash + 1);
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const symbolLane = (): CodeLane | undefined => (symbol === undefined ? undefined : isRouteName(symbol) ? "backend" : HOOK_NAME.test(symbol) ? "frontend" : undefined);
  const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1) || p;

  if (arch !== null) {
    const byId = new Map(arch.nodes.map((n) => [n.id, n]));
    const node = byId.get(ref);
    if (node !== undefined) {
      return { ref, kind: "element", name: node.name, type: node.type, ...(node.path !== undefined ? { path: node.path } : {}), owner: node, lane: elementLane(node, byId) };
    }
    const workflow = arch.workflows.find((w) => w.id === ref);
    if (workflow !== undefined) return { ref, kind: "workflow", name: workflow.name, type: "workflow", lane: "backend" };
    const owner = ownerOf(ref, arch);
    if (owner !== undefined) {
      // "<owner>/<rel>[#symbol]": the path is the owner's path joined with <rel>.
      const rel = filePart.length > owner.id.length ? filePart.slice(owner.id.length + 1) : "";
      const path = rel === "" ? owner.path : owner.path !== undefined && owner.path !== "" && owner.path !== "." ? `${owner.path}/${rel}` : rel;
      return {
        ref,
        kind: "expanded",
        name: symbol ?? baseName(rel === "" ? owner.name : rel),
        type: symbol !== undefined ? (isRouteName(symbol) ? "route" : "symbol") : "file",
        ...(path !== undefined ? { path } : {}),
        owner,
        lane: symbolLane() ?? elementLane(owner, byId),
      };
    }
  }
  return {
    ref,
    kind: "unknown",
    name: symbol ?? ref,
    ...(symbol !== undefined ? { type: isRouteName(symbol) ? "route" : "symbol", path: filePart } : {}),
    lane: symbolLane() ?? textLane(ref),
  };
}

/** The lane a touches entry belongs in (rules at the top of this file). */
export function laneOf(ref: string, arch: Architecture | null): CodeLane {
  return describeTouch(ref, arch).lane;
}
