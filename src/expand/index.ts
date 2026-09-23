// On-demand drill-in below the stored architecture (CONTRACTS.md §1.6).
//
// `architecture.json` stops at packages / modules. Any element with a `path`
// and no stored children can be expanded one level at a time:
//   folder -> sub-folders (`module`) + files (`file`) + import edges between them
//   file   -> symbols (`symbol`: functions, components, classes, types, routes)
//             + calls / uses / renders edges between them
// Results are ephemeral derived data: computed from the working tree, cached in
// memory (file list for a few seconds, per-file parses by mtime), never written
// to architecture.json. Child ids are namespaced under the expanded element:
// `<id>/<folder or file name>` and `<fileId>#<symbol key>`, so any id can be
// resolved again (after a restart too) by expanding its ancestors.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture, ArchEdge, ArchNode } from "../contracts/architecture.js";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import { createResolver, extractSpecifiers, SOURCE_EXT, type Resolver } from "../scan/detectors/imports.js";
import { isTestFile } from "../scan/detectors/entrypoints.js";
import { readManifest } from "../scan/detectors/manifests.js";
import { BAND_GAP, COL_W, MAX_PER_ROW, ROW_H } from "../scan/layout.js";
import { sourceRoot } from "../scan/modules.js";
import type { Language, PackageInfo, ScanContext } from "../scan/types.js";
import { listFiles, type FileList } from "../scan/walk.js";
import { hasOutline, parseSymbols, type SymbolKind, type SymbolOutline } from "./symbols.js";

export const MAX_CHILDREN = 80;
export const MAX_EDGES = 200;
export const MAX_IMPORT_FILES = 1_500;
export const MAX_PEEK_IDS = 200;
const FILE_LIST_TTL_MS = 4_000;
const MAX_PARSE_BYTES = 1024 * 1024;

export interface ExpandedNode extends ArchNode {
  /** The element can be expanded again (folder, or a file with symbols). */
  expandable?: boolean;
  /** Direct children one level further down (sub-folders + files, or symbols). */
  childCount?: number;
  symbol?: { kind: SymbolKind; line: number; endLine: number; exported: boolean; detail?: string };
  test?: boolean;
}

export interface ExpandedEdge extends ArchEdge {
  /** How many imports / references back the edge. */
  weight?: number;
}

export interface Expansion {
  nodeId: string;
  level: "folder" | "file";
  path: string;
  architecture: {
    version: 1;
    name: string;
    layers: string[];
    nodes: ExpandedNode[];
    edges: ExpandedEdge[];
    workflows: [];
  };
  truncated: { children: boolean; edges: boolean; files: boolean };
  total: { children: number; edges: number };
  ms: number;
  /** Expanded elements above this one, outermost first (empty below a stored node). Lets a
   * client rebuild the breadcrumb after a reload. */
  lineage?: string[];
}

export class ExpandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Resolved {
  repoRoot: string;
  rel: string; // repo-relative ("" = the repo itself)
  prefix: string; // prepended to repo-relative paths to get architecture paths
}

interface Located {
  node: ArchNode | ExpandedNode;
  /** Expansions from the stored ancestor down to the one listing `node` (empty for stored nodes). */
  chain: Expansion[];
}

interface ParsedFile {
  mtimeMs: number;
  size: number;
  specifiers?: string[];
  outline?: SymbolOutline;
}

const OTHER_FILES = /\.(json|jsonc|ya?ml|md|mdx|css|scss|sass|less|sql|toml|prisma|graphql|gql|html|proto|sh|env\.example)$|(^|\/)(Dockerfile|Makefile)$/;
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$/;

type FileClass = "source" | "test" | "other" | null;

function classifyFile(f: string): FileClass {
  if (LOCKFILE.test(f)) return null;
  if (SOURCE_EXT.test(f) && !/\.d\.ts$/.test(f)) return isTestFile(f) ? "test" : "source";
  return OTHER_FILES.test(f) ? "other" : null;
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const joinRel = (a: string, b: string): string => (a === "" ? b : `${a}/${b}`);

function guessLanguage(files: string[]): Language {
  const n = { js: 0, python: 0, go: 0, rust: 0 };
  for (const f of files) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(f)) n.js++;
    else if (f.endsWith(".py")) n.python++;
    else if (f.endsWith(".go")) n.go++;
    else if (f.endsWith(".rs")) n.rust++;
  }
  const best = (Object.entries(n) as [Language, number][]).sort((a, b) => b[1] - a[1])[0];
  return best !== undefined && best[1] > 0 ? best[0] : "unknown";
}

const SYMBOL_LAYERS: Record<SymbolKind, string> = {
  route: "routes",
  component: "components",
  hook: "hooks",
  function: "functions",
  method: "functions",
  class: "classes",
  interface: "types",
  type: "types",
  enum: "types",
  const: "values",
};
const SYMBOL_LAYER_ORDER = ["routes", "components", "hooks", "functions", "classes", "types", "values"];
const FOLDER_LAYER_ORDER = ["folders", "files", "tests", "other"];

/** Grid layout per band (same grid as the scanner's layout, src/scan/layout.ts), in the given order. */
function layoutBands(nodes: ExpandedNode[], order: string[]): void {
  let y = 0;
  for (const layer of order) {
    const band = nodes.filter((n) => n.layer === layer);
    band.forEach((n, i) => {
      n.x = (i % MAX_PER_ROW) * COL_W;
      n.y = y + Math.floor(i / MAX_PER_ROW) * ROW_H;
    });
    if (band.length > 0) y += Math.ceil(band.length / MAX_PER_ROW) * ROW_H + BAND_GAP;
  }
}

/** Longest-path rank from sources, cycles broken by visit order: importers before the imported. */
function importRanks(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (state.has(id)) return;
    state.set(id, 1);
    for (const t of out.get(id) ?? []) if (state.get(t) !== 1) visit(t);
    state.set(id, 2);
    order.push(id);
  };
  for (const id of ids) visit(id);
  for (const id of order.reverse()) {
    for (const t of out.get(id) ?? []) {
      if (order.indexOf(t) > order.indexOf(id)) rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1));
    }
  }
  return rank;
}

export class Expander {
  private readonly lists = new Map<string, { fl: FileList; at: number }>();
  private readonly parsed = new Map<string, ParsedFile>();
  private readonly packages = new Map<string, PackageInfo | null>();
  private readonly resolvers = new Map<string, { fl: FileList; resolver: Resolver }>();
  private readonly levels = new Map<string, { fl: FileList; expansion: Expansion }>();

  constructor(
    private readonly root: string,
    private readonly resolvePath?: (rel: string) => { abs: string; root: string } | null,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- paths --------------------------------------------------------------

  private resolve(p: string): Resolved | null {
    const posix = p.replaceAll("\\", "/").replace(/\/+$/, "");
    if (posix === "" || posix.includes("\0") || path.posix.isAbsolute(posix)) return null;
    const norm = path.posix.normalize(posix);
    if (norm === ".." || norm.startsWith("../")) return null;
    if (this.resolvePath === undefined) return { repoRoot: this.root, rel: norm === "." ? "" : norm, prefix: "" };
    const r = this.resolvePath(norm);
    if (r === null) return null;
    const rel = path.relative(r.root, r.abs).split(path.sep).join("/");
    if (rel.startsWith("..")) return null;
    return { repoRoot: r.root, rel, prefix: rel === "" ? `${norm}/` : norm.slice(0, norm.length - rel.length) };
  }

  private fileList(repoRoot: string): FileList {
    const hit = this.lists.get(repoRoot);
    if (hit !== undefined && this.now() - hit.at < FILE_LIST_TTL_MS) return hit.fl;
    const fl = listFiles(repoRoot);
    this.lists.set(repoRoot, { fl, at: this.now() });
    return fl;
  }

  private parse(repoRoot: string, rel: string, want: "specifiers" | "outline"): ParsedFile | null {
    const abs = path.join(repoRoot, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > MAX_PARSE_BYTES) return null;
    let entry = this.parsed.get(abs);
    if (entry === undefined || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = { mtimeMs: st.mtimeMs, size: st.size };
      this.parsed.set(abs, entry);
    }
    if ((want === "specifiers" && entry.specifiers === undefined) || (want === "outline" && entry.outline === undefined)) {
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
      if (want === "specifiers") entry.specifiers = extractSpecifiers(rel, text);
      else entry.outline = parseSymbols(rel, text);
    }
    return entry;
  }

  private packageFor(ctx: ScanContext, dir: string): PackageInfo {
    for (let d = dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
      const key = `${ctx.root}\0${d}`;
      let pkg = this.packages.get(key);
      if (pkg === undefined) {
        pkg = readManifest(ctx, d);
        this.packages.set(key, pkg);
      }
      if (pkg !== null) return pkg;
      if (d === "") break;
    }
    const prefix = dir === "" ? "" : `${dir}/`;
    return {
      dir: "",
      manifest: null,
      name: baseName(ctx.root),
      language: guessLanguage(ctx.fl.files.filter((f) => f.startsWith(prefix)).slice(0, 500)),
      deps: [],
      entryHints: [],
      scripts: {},
    };
  }

  private resolverFor(ctx: ScanContext, dir: string): Resolver {
    const pkg = this.packageFor(ctx, dir);
    const key = `${ctx.root}\0${pkg.dir}`;
    const hit = this.resolvers.get(key);
    if (hit !== undefined && hit.fl === ctx.fl) return hit.resolver;
    const resolver = createResolver(ctx, pkg, sourceRoot(ctx, pkg));
    this.resolvers.set(key, { fl: ctx.fl, resolver });
    return resolver;
  }

  private symbolCount(repoRoot: string, rel: string): number {
    if (!hasOutline(rel)) return 0;
    return this.parse(repoRoot, rel, "outline")?.outline?.symbols.length ?? 0;
  }

  // ---- locating elements ----------------------------------------------------

  /** A stored node, or an expanded element found by expanding its ancestors. */
  locate(arch: Architecture, id: string): Located | null {
    const stored = arch.nodes.find((n) => n.id === id);
    if (stored !== undefined) return { node: stored, chain: [] };
    const hash = id.indexOf("#");
    const candidates: string[] = [];
    if (hash !== -1) candidates.push(id.slice(0, hash));
    else for (let i = id.lastIndexOf("/"); i > 0; i = id.lastIndexOf("/", i - 1)) candidates.push(id.slice(0, i));
    for (const parentId of candidates) {
      const parent = this.locate(arch, parentId);
      if (parent === null) continue;
      let expansion: Expansion;
      try {
        expansion = this.expandLocated(parentId, parent.node);
      } catch {
        continue;
      }
      const node = expansion.architecture.nodes.find((n) => n.id === id);
      if (node !== undefined) return { node, chain: [...parent.chain, expansion] };
    }
    return null;
  }

  /** Expand `nodeId` one level. Throws ExpandError (404 unknown, 422 not expandable). */
  expand(arch: Architecture, nodeId: string): Expansion {
    const located = this.locate(arch, nodeId);
    if (located === null) throw new ExpandError(404, `unknown element: ${nodeId}`);
    return { ...this.expandLocated(nodeId, located.node), lineage: located.chain.map((c) => c.nodeId) };
  }

  /** Direct child counts for many elements (the "12 inside" chips); null = not expandable. */
  peek(arch: Architecture, ids: string[]): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const id of ids.slice(0, MAX_PEEK_IDS)) {
      const located = this.locate(arch, id);
      const p = located?.node.path;
      const r = p === undefined ? null : this.resolve(p);
      if (r === null) {
        out[id] = null;
        continue;
      }
      const fl = this.fileList(r.repoRoot);
      if (fl.fileSet.has(r.rel)) {
        const n = this.symbolCount(r.repoRoot, r.rel);
        out[id] = n > 0 ? n : null;
      } else if (fl.dirs.has(r.rel)) {
        const n = this.listFolder(fl, r.rel).entries.length;
        out[id] = n > 0 ? n : null;
      } else out[id] = null;
    }
    return out;
  }

  private expandLocated(nodeId: string, node: ArchNode | ExpandedNode): Expansion {
    if (node.path === undefined || node.path === "") throw new ExpandError(422, `element ${nodeId} has no path`);
    if ("symbol" in node && node.symbol !== undefined) throw new ExpandError(422, `symbol ${nodeId} has no children`);
    const r = this.resolve(node.path);
    if (r === null) throw new ExpandError(404, `path outside the project: ${node.path}`);
    const fl = this.fileList(r.repoRoot);
    const key = `${nodeId}\0${node.path}`;
    const hit = this.levels.get(key);
    if (hit !== undefined && hit.fl === fl) return hit.expansion;
    const started = this.now();
    let expansion: Expansion;
    if (fl.fileSet.has(r.rel)) expansion = this.expandFile(nodeId, node.path, r);
    else if (fl.dirs.has(r.rel)) expansion = this.expandFolder(nodeId, node.path, r, fl);
    else throw new ExpandError(404, `path not found: ${node.path}`);
    expansion.ms = this.now() - started;
    this.levels.set(key, { fl, expansion });
    return expansion;
  }

  // ---- folder level -----------------------------------------------------------

  /** Direct entries of a folder: sub-folders (single-child chains compacted, "a/b") and files. */
  private listFolder(fl: FileList, rel: string): { entries: { name: string; rel: string; dir: boolean; cls: FileClass; files: string[] }[] } {
    const prefix = rel === "" ? "" : `${rel}/`;
    const dirs = new Map<string, string[]>();
    const files: { name: string; rel: string; dir: false; cls: FileClass; files: string[] }[] = [];
    for (const f of fl.files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const i = rest.indexOf("/");
      if (i === -1) {
        const cls = classifyFile(f);
        if (cls !== null) files.push({ name: rest, rel: f, dir: false, cls, files: [f] });
        continue;
      }
      if (classifyFile(f) === null) continue;
      const name = rest.slice(0, i);
      const list = dirs.get(name) ?? [];
      list.push(f);
      dirs.set(name, list);
    }
    const folders = [...dirs.entries()].map(([name, under]) => {
      // Compact "a/b/c" while a folder holds exactly one sub-folder and no files of its own.
      let n = name;
      let r = joinRel(rel, name);
      for (;;) {
        const inner = new Set<string>();
        let direct = false;
        for (const f of under) {
          const rest = f.slice(r.length + 1);
          const i = rest.indexOf("/");
          if (i === -1) direct = true;
          else inner.add(rest.slice(0, i));
          if (direct || inner.size > 1) break;
        }
        if (direct || inner.size !== 1) break;
        const only = [...inner][0] ?? "";
        n = `${n}/${only}`;
        r = `${r}/${only}`;
      }
      return { name: n, rel: r, dir: true, cls: null as FileClass, files: under };
    });
    return { entries: [...folders, ...files] };
  }

  private expandFolder(nodeId: string, archPath: string, r: Resolved, fl: FileList): Expansion {
    const ctx: ScanContext = { root: r.repoRoot, fl };
    const { entries } = this.listFolder(fl, r.rel);
    const rank = (e: (typeof entries)[number]): number => (e.dir ? 0 : e.cls === "source" ? 1 : e.cls === "test" ? 2 : 3);
    const sorted = [...entries].sort(
      (a, b) => rank(a) - rank(b) || (a.dir && b.dir ? b.files.length - a.files.length : 0) || (a.name < b.name ? -1 : 1),
    );
    const shown = sorted.slice(0, MAX_CHILDREN);
    const arch = (rel: string): string => `${r.prefix}${rel}`;

    // Import edges between the shown children (files anywhere below them count for their folder).
    const childOf = (target: string): string | null => {
      for (const e of shown) if (target === e.rel || (e.dir && target.startsWith(`${e.rel}/`))) return e.rel;
      return null;
    };
    const sources = shown
      .flatMap((e) => e.files)
      .filter((f) => {
        const c = classifyFile(f);
        return c === "source" || c === "test";
      });
    const analysed = sources.slice(0, MAX_IMPORT_FILES);
    const counts = new Map<string, number>();
    const inDegree = new Map<string, number>();
    if (analysed.length > 0) {
      const resolver = this.resolverFor(ctx, r.rel);
      for (const f of analysed) {
        const from = childOf(f);
        if (from === null) continue;
        const specs = this.parse(r.repoRoot, f, "specifiers")?.specifiers ?? [];
        const seen = new Set<string>();
        for (const spec of specs) {
          const target = resolver.resolve(f, spec);
          if (target === null || target === f || seen.has(target)) continue;
          seen.add(target);
          inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
          const to = childOf(target);
          if (to === null || to === from) continue;
          const k = `${from}\0${to}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
    }
    const allEdges = [...counts.entries()]
      .map(([k, n]) => {
        const [from = "", to = ""] = k.split("\0");
        return { from, to, n };
      })
      .sort((a, b) => b.n - a.n || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));
    const keptEdges = allEdges.slice(0, MAX_EDGES);

    const idOf = (rel: string): string => `${nodeId}/${rel.slice(r.rel === "" ? 0 : r.rel.length + 1)}`;
    const ranks = importRanks(shown.map((e) => e.rel), keptEdges);
    const nodes: ExpandedNode[] = shown.map((e) => {
      if (e.dir) {
        const inner = this.listFolder(fl, e.rel).entries.length;
        const src = e.files.filter((f) => classifyFile(f) === "source");
        const top = [...src]
          .sort((a, b) => (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0) || a.split("/").length - b.split("/").length || (a < b ? -1 : 1))
          .slice(0, 8)
          .map(arch);
        return {
          id: idOf(e.rel),
          type: "module",
          name: e.name,
          path: arch(e.rel),
          layer: "folders",
          description: `Folder: ${e.files.length} file${e.files.length === 1 ? "" : "s"}${src.length !== e.files.length ? `, ${src.length} source` : ""}.`,
          ...(top.length > 0 ? { files: top } : {}),
          expandable: inner > 0,
          childCount: inner,
        };
      }
      const symbols = e.cls === "other" ? 0 : this.symbolCount(r.repoRoot, e.rel);
      const imported = inDegree.get(e.rel) ?? 0;
      return {
        id: idOf(e.rel),
        type: "file",
        name: e.name,
        path: arch(e.rel),
        layer: e.cls === "source" ? "files" : e.cls === "test" ? "tests" : "other",
        files: [arch(e.rel)],
        description: `${e.cls === "test" ? "Test file" : "Source file"}${symbols > 0 ? `, ${symbols} symbol${symbols === 1 ? "" : "s"}` : ""}${imported > 0 ? `, imported by ${imported} file${imported === 1 ? "" : "s"} here` : ""}.`,
        expandable: symbols > 0,
        childCount: symbols,
        ...(e.cls === "test" ? { test: true } : {}),
      };
    });
    // Importers first inside each band, so arrows mostly run left-to-right / downwards.
    const relOf = new Map(shown.map((e) => [idOf(e.rel), e.rel]));
    nodes.sort((a, b) => {
      const la = FOLDER_LAYER_ORDER.indexOf(a.layer ?? "");
      const lb = FOLDER_LAYER_ORDER.indexOf(b.layer ?? "");
      if (la !== lb) return la - lb;
      const ra = ranks.get(relOf.get(a.id) ?? "") ?? 0;
      const rb = ranks.get(relOf.get(b.id) ?? "") ?? 0;
      return ra - rb || (a.name < b.name ? -1 : 1);
    });
    layoutBands(nodes, FOLDER_LAYER_ORDER);
    const edges: ExpandedEdge[] = keptEdges.map((e) => ({
      from: idOf(e.from),
      to: idOf(e.to),
      label: "imports",
      kind: "sync",
      source: "scan",
      weight: e.n,
    }));
    const layers = FOLDER_LAYER_ORDER.filter((l) => nodes.some((n) => n.layer === l));
    return {
      nodeId,
      level: "folder",
      path: archPath,
      architecture: { version: 1, name: baseName(archPath), layers, nodes, edges, workflows: [] },
      truncated: { children: entries.length > shown.length, edges: allEdges.length > keptEdges.length, files: sources.length > analysed.length },
      total: { children: entries.length, edges: allEdges.length },
      ms: 0,
    };
  }

  // ---- file level ---------------------------------------------------------------

  private expandFile(nodeId: string, archPath: string, r: Resolved): Expansion {
    if (!hasOutline(r.rel)) throw new ExpandError(422, `no symbol outline for ${archPath}`);
    const outline = this.parse(r.repoRoot, r.rel, "outline")?.outline;
    if (outline === undefined) throw new ExpandError(422, `cannot read ${archPath}`);
    const idOf = (key: string): string => `${nodeId}#${key}`;
    const nodes: ExpandedNode[] = outline.symbols.map((s) => {
      const what = s.kind === "const" ? "value" : s.kind;
      return {
        id: idOf(s.key),
        type: "symbol",
        name: s.name,
        path: archPath,
        files: [archPath],
        layer: SYMBOL_LAYERS[s.kind],
        tech: [s.detail ?? `${s.exported ? "export " : ""}${what}`],
        description: `${s.exported ? "Exported " : ""}${what} ${s.name}${s.detail !== undefined ? ` (${s.detail})` : ""}, lines ${s.line}–${s.endLine} of ${archPath}.`,
        symbol: {
          kind: s.kind,
          line: s.line,
          endLine: s.endLine,
          exported: s.exported,
          ...(s.detail !== undefined ? { detail: s.detail } : {}),
        },
        expandable: false,
        childCount: 0,
      };
    });
    layoutBands(nodes, SYMBOL_LAYER_ORDER);
    const edges: ExpandedEdge[] = outline.edges.slice(0, MAX_EDGES).map((e) => ({
      from: idOf(e.from),
      to: idOf(e.to),
      label: e.label,
      kind: "sync",
      source: "scan",
    }));
    const layers = SYMBOL_LAYER_ORDER.filter((l) => nodes.some((n) => n.layer === l));
    return {
      nodeId,
      level: "file",
      path: archPath,
      architecture: { version: 1, name: baseName(archPath), layers, nodes, edges, workflows: [] },
      truncated: { children: outline.truncated, edges: outline.edges.length > MAX_EDGES, files: false },
      total: { children: outline.symbols.length, edges: outline.edges.length },
      ms: 0,
    };
  }
}

// One expander per open project store (the store is replaced on a project switch).
const expanders = new WeakMap<ArchitectureStore, Expander>();

export function expanderFor(store: ArchitectureStore): Expander {
  let e = expanders.get(store);
  if (e === undefined) {
    e = new Expander(store.root, store.resolvePath?.bind(store));
    expanders.set(store, e);
  }
  return e;
}

/** Whether an id is shaped like an expanded element (`<id>/<name>` or `<id>#<symbol>`). */
export function isExpandedId(id: string): boolean {
  return id.includes("/") || id.includes("#");
}
