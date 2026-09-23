// Module tree for one package (PLAN.md Phase 2; ASSUMPTIONS.md 22).
//
// Turns a package's source root (`src/`, a Python package dir, or the package
// dir itself) into `module` nodes, one per top-level directory, optionally with
// a second level of child nodes (via `parent`) for drill-down. Import edges are
// drawn between siblings at the deepest level where the two files' module
// chains diverge. Also ranks files by how often they are imported, which picks
// each node's representative `files`.
import type { ArchEdge, ArchNode } from "../contracts/architecture.js";
import { createResolver, extractSpecifiers, SOURCE_EXT } from "./detectors/imports.js";
import { isTestFile } from "./detectors/entrypoints.js";
import { readmeLine } from "./detectors/manifests.js";
import type { PackageInfo, ScanContext } from "./types.js";
import { joinRel, readText } from "./walk.js";

export const MAX_MODULES_PER_LEVEL = 16;
export const MAX_IMPORT_FILES_PER_PACKAGE = 2_000;
export const MAX_EDGES_PER_LEVEL = 60;
export const MAX_FILES_PER_NODE = 8;

const NON_MODULE_DIRS = new Set([
  "test", "tests", "__tests__", "__mocks__", "e2e", "testing", "testUtils", "test-utils", "fixtures",
  "docs", "doc", "examples", "example", "public", "static", "assets", "__generated__", "generated",
  "__snapshots__", "__screenshots__", "stories", "storybook",
]);

type Role = "ui" | "services" | "data" | "lib";

const ROLES: Record<string, { role: Role; text: string }> = {
  components: { role: "ui", text: "UI components." },
  ui: { role: "ui", text: "Low-level UI primitives." },
  routes: { role: "ui", text: "Route definitions and their page components." },
  pages: { role: "ui", text: "Page components." },
  app: { role: "ui", text: "Application shell and routes." },
  views: { role: "ui", text: "View components." },
  screens: { role: "ui", text: "Screen components." },
  layouts: { role: "ui", text: "Layout components." },
  features: { role: "ui", text: "Feature modules." },
  widgets: { role: "ui", text: "Widgets." },
  hooks: { role: "ui", text: "React hooks." },
  styles: { role: "ui", text: "Stylesheets and theme." },
  theme: { role: "ui", text: "Theme tokens." },
  i18n: { role: "ui", text: "Translations." },
  locales: { role: "ui", text: "Translations." },
  api: { role: "services", text: "API layer." },
  server: { role: "services", text: "Server-side code." },
  services: { role: "services", text: "Service layer." },
  service: { role: "services", text: "Service layer." },
  handlers: { role: "services", text: "Request handlers." },
  controllers: { role: "services", text: "Request controllers." },
  middleware: { role: "services", text: "Request middleware." },
  rpc: { role: "services", text: "RPC layer." },
  http: { role: "services", text: "HTTP layer." },
  workers: { role: "services", text: "Background workers." },
  jobs: { role: "services", text: "Background jobs." },
  cli: { role: "services", text: "Command-line interface." },
  commands: { role: "services", text: "Command implementations." },
  auth: { role: "services", text: "Authentication and authorization." },
  cmd: { role: "services", text: "Executable entrypoints." },
  data: { role: "data", text: "Data definitions and data-access helpers." },
  db: { role: "data", text: "Database access." },
  database: { role: "data", text: "Database access." },
  models: { role: "data", text: "Data models." },
  model: { role: "data", text: "Data models." },
  entities: { role: "data", text: "Data entities." },
  schema: { role: "data", text: "Schemas." },
  schemas: { role: "data", text: "Validation schemas." },
  store: { role: "data", text: "Client state store." },
  stores: { role: "data", text: "Client state stores." },
  state: { role: "data", text: "Application state." },
  repositories: { role: "data", text: "Repositories (persistence access)." },
  persistence: { role: "data", text: "Persistence layer." },
  migrations: { role: "data", text: "Database migrations." },
  prisma: { role: "data", text: "Prisma schema and client." },
  lib: { role: "lib", text: "Shared helpers and utilities." },
  utils: { role: "lib", text: "Utility functions." },
  helpers: { role: "lib", text: "Helper functions." },
  shared: { role: "lib", text: "Code shared across modules." },
  common: { role: "lib", text: "Code shared across modules." },
  core: { role: "lib", text: "Core domain logic." },
  types: { role: "lib", text: "Shared type definitions." },
  config: { role: "lib", text: "Configuration." },
  constants: { role: "lib", text: "Constants." },
  internal: { role: "lib", text: "Internal packages." },
  pkg: { role: "lib", text: "Library packages." },
};

export function moduleRole(dirName: string, pkgType: string): Role {
  const r = ROLES[dirName]?.role ?? "lib";
  if (dirName === "routes" && pkgType === "service") return "services";
  return r;
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return out === "" ? "node" : out.slice(0, 48);
}

export class IdAllocator {
  private readonly used = new Set<string>();
  take(base: string): string {
    let id = base.slice(0, 64);
    for (let n = 2; this.used.has(id); n++) id = `${base.slice(0, 60)}-${n}`;
    this.used.add(id);
    return id;
  }
  has(id: string): boolean {
    return this.used.has(id);
  }
}

// Source root: `src/` when present, else a Python package dir named after the
// project, else the package dir.
export function sourceRoot(ctx: ScanContext, pkg: PackageInfo): string {
  const { fl } = ctx;
  if (pkg.language === "python") {
    const norm = pkg.name.toLowerCase().replace(/[-.]/g, "_");
    for (const cand of [joinRel(pkg.dir, `src/${norm}`), joinRel(pkg.dir, norm)]) {
      if (fl.fileSet.has(`${cand}/__init__.py`)) return cand;
    }
    const src = joinRel(pkg.dir, "src");
    if (fl.dirs.has(src)) {
      const inits = fl.files.filter((f) => f.startsWith(`${src}/`) && /^[^/]+\/__init__\.py$/.test(f.slice(src.length + 1)));
      if (inits.length === 1) return inits[0]?.slice(0, -"/__init__.py".length) ?? src;
      return src;
    }
    const inits = fl.files.filter((f) => {
      const r = pkg.dir === "" ? f : f.startsWith(`${pkg.dir}/`) ? f.slice(pkg.dir.length + 1) : "";
      return /^[a-z_][a-z0-9_]*\/__init__\.py$/.test(r) && !NON_MODULE_DIRS.has(r.split("/")[0] ?? "");
    });
    if (inits.length === 1) return inits[0]?.slice(0, -"/__init__.py".length) ?? pkg.dir;
    return pkg.dir;
  }
  const src = joinRel(pkg.dir, "src");
  return fl.dirs.has(src) ? src : pkg.dir;
}

export interface ModuleTree {
  nodes: ArchNode[]; // module nodes, parents before children
  edges: ArchEdge[];
  rootFiles: string[]; // source files directly in the source root, ranked
  inDegree: Map<string, number>;
}

interface Mod {
  id: string;
  dir: string;
  name: string;
  parent: string | null;
  depth: number;
  files: string[];
  children: Mod[];
}

export interface ModuleTreeOptions {
  pkg: PackageInfo;
  pkgType: string;
  pkgFiles: string[]; // all package files (sorted, repo-relative)
  srcRoot: string;
  parentId: string | null; // parent for level-1 modules (null = top level)
  rootNodeId: string | null; // node that owns files directly in srcRoot, as a sibling of level-1 modules
  depth: 1 | 2;
  ids: IdAllocator;
  idPrefix: string; // "" or "<pkg>."
}

function isSource(f: string): boolean {
  return SOURCE_EXT.test(f) && !isTestFile(f) && !/\.d\.ts$/.test(f) && !/\.gen\.[a-z]+$/.test(f);
}

function childDirs(dir: string, files: string[], minFiles: number): { name: string; files: string[] }[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const groups = new Map<string, string[]>();
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const i = rest.indexOf("/");
    if (i === -1) continue;
    const name = rest.slice(0, i);
    if (NON_MODULE_DIRS.has(name) || name.startsWith(".")) continue;
    const g = groups.get(name) ?? [];
    g.push(f);
    groups.set(name, g);
  }
  return [...groups.entries()]
    .filter(([, fs]) => fs.length >= minFiles)
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_MODULES_PER_LEVEL)
    .map(([name, fs]) => ({ name, files: fs }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function buildModuleTree(ctx: ScanContext, o: ModuleTreeOptions): ModuleTree {
  const source = o.pkgFiles.filter(isSource);
  const srcPrefix = o.srcRoot === "" ? "" : `${o.srcRoot}/`;
  const inRoot = source.filter((f) => f.startsWith(srcPrefix));
  const level1: Mod[] = childDirs(o.srcRoot, inRoot, 1).map(({ name, files }) => ({
    id: o.ids.take(`${o.idPrefix}${slug(name)}`),
    dir: joinRel(o.srcRoot, name),
    name,
    parent: o.parentId,
    depth: 1,
    files,
    children: [],
  }));
  if (o.depth === 2) {
    for (const m of level1) {
      const subs = childDirs(m.dir, m.files, 2);
      if (subs.length < 2) continue;
      m.children = subs.map(({ name, files }) => ({
        id: o.ids.take(`${m.id}.${slug(name)}`),
        dir: joinRel(m.dir, name),
        name,
        parent: m.id,
        depth: 2,
        files,
        children: [],
      }));
    }
  }
  const rootFiles = inRoot.filter((f) => !f.slice(srcPrefix.length).includes("/"));

  // chain(file) = module ids from level 1 downward.
  const byDir = new Map<string, Mod>();
  for (const m of level1) {
    byDir.set(m.dir, m);
    for (const c of m.children) byDir.set(c.dir, c);
  }
  const chainOf = (target: string): string[] | null => {
    if (!target.startsWith(srcPrefix) && target !== o.srcRoot) return null;
    const rest = target.slice(srcPrefix.length).split("/");
    const m1 = byDir.get(joinRel(o.srcRoot, rest[0] ?? ""));
    if (m1 === undefined) {
      // A file directly in the source root belongs to the root node, if any.
      if (rest.length === 1 && o.rootNodeId !== null && ctx.fl.fileSet.has(target)) return [o.rootNodeId];
      return null;
    }
    if (rest.length === 1) return [m1.id];
    // byDir only holds directories, so a hit on rest[1] is a sub-module.
    const m2 = byDir.get(joinRel(m1.dir, rest[1] ?? ""));
    return m2 !== undefined ? [m1.id, m2.id] : [m1.id];
  };

  const resolver = createResolver(ctx, o.pkg, o.srcRoot);
  const inDegree = new Map<string, number>();
  const counts = new Map<string, number>(); // "from\0to" → count
  for (const file of inRoot.slice(0, MAX_IMPORT_FILES_PER_PACKAGE)) {
    const text = readText(ctx.root, file);
    if (text === null) continue;
    const from = chainOf(file);
    const seen = new Set<string>();
    for (const spec of extractSpecifiers(file, text)) {
      const target = resolver.resolve(file, spec);
      if (target === null || target === file || seen.has(target)) continue;
      seen.add(target);
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      if (from === null) continue;
      const to = chainOf(target);
      if (to === null) continue;
      for (let i = 0; i < Math.min(from.length, to.length); i++) {
        const a = from[i];
        const b = to[i];
        if (a === undefined || b === undefined) break;
        if (a !== b) {
          const key = `${a}\u0000${b}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          break;
        }
      }
    }
  }

  // Cap edges per level (grouped by the source node's parent), strongest first.
  const parentOf = new Map<string, string | null>();
  for (const m of byDir.values()) parentOf.set(m.id, m.parent);
  if (o.rootNodeId !== null) parentOf.set(o.rootNodeId, o.parentId);
  const perLevel = new Map<string, { from: string; to: string; n: number }[]>();
  for (const [key, n] of counts) {
    const [from = "", to = ""] = key.split("\u0000");
    const lvl = parentOf.get(from) ?? "";
    const list = perLevel.get(lvl) ?? [];
    list.push({ from, to, n });
    perLevel.set(lvl, list);
  }
  const edges: ArchEdge[] = [];
  for (const list of perLevel.values()) {
    list.sort((a, b) => b.n - a.n || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));
    for (const e of list.slice(0, MAX_EDGES_PER_LEVEL)) {
      edges.push({ from: e.from, to: e.to, label: "imports", kind: "sync" });
    }
  }

  const rank = (files: string[], dir: string): string[] => {
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    const isEntry = (f: string): boolean => {
      const rel = f.slice(dir.length + 1);
      const base = rel.replace(SOURCE_EXT, "");
      return base === "index" || base === "__init__" || base === "mod" || base === name || base === "main";
    };
    return [...files]
      .sort((a, b) => {
        const ea = isEntry(a) ? 1 : 0;
        const eb = isEntry(b) ? 1 : 0;
        if (ea !== eb) return eb - ea;
        const da = inDegree.get(a) ?? 0;
        const db = inDegree.get(b) ?? 0;
        if (da !== db) return db - da;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .slice(0, MAX_FILES_PER_NODE);
  };

  const nodes: ArchNode[] = [];
  const emit = (m: Mod): void => {
    const role = ROLES[m.name];
    const serviceRoutes = m.name === "routes" && o.pkgType === "service" ? "HTTP route handlers." : undefined;
    const desc = readmeLine(ctx, m.dir) ?? serviceRoutes ?? role?.text;
    nodes.push({
      id: m.id,
      type: "module",
      name: m.name,
      path: m.dir,
      files: rank(m.files, m.dir),
      layer: moduleRole(m.name, o.pkgType),
      ...(m.parent !== null ? { parent: m.parent } : {}),
      ...(desc !== undefined ? { description: desc } : {}),
    });
    for (const c of m.children) emit(c);
  };
  for (const m of level1) emit(m);

  const rankedRoot = [...rootFiles].sort((a, b) => {
    const da = inDegree.get(a) ?? 0;
    const db = inDegree.get(b) ?? 0;
    return db - da || (a < b ? -1 : a > b ? 1 : 0);
  });
  return { nodes, edges, rootFiles: rankedRoot, inDegree };
}

export function rankByInDegree(files: string[], inDegree: Map<string, number>): string[] {
  return [...files].sort((a, b) => {
    const da = inDegree.get(a) ?? 0;
    const db = inDegree.get(b) ?? 0;
    return db - da || (a < b ? -1 : a > b ? 1 : 0);
  });
}
