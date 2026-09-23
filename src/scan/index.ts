// `archmap scan` core: scanRepo(root, opts) → Architecture (PLAN.md Phase 2,
// CONTRACTS.md §1, ASSUMPTIONS.md 22).
//
// Monorepo (workspaces found): one node per workspace package (layer = its
// top-level directory), `depends on` edges from workspace dependencies, and
// one drill-down level of module children per package from its source dirs.
// Single package: an entry node for the package plus a module node per
// top-level source directory (two levels, via `parent`), with import edges.
// Both: docker-compose services and well-known client libraries become
// datastore / queue / gateway / external nodes with edges from their users.
// Output is deterministic: sorted inputs, stable ids, no timestamps unless
// `opts.now` is given.
import type { Architecture, ArchEdge, ArchNode } from "../contracts/architecture.js";
import { detectCompose, externalsFromDeps, infraFromDeps, type InfraKind } from "./detectors/compose.js";
import { classify, isTestFile } from "./detectors/entrypoints.js";
import { SOURCE_EXT } from "./detectors/imports.js";
import { readManifest } from "./detectors/manifests.js";
import { detectWorkspaces } from "./detectors/workspaces.js";
import { layoutArchitecture } from "./layout.js";
import { mergeWithExisting } from "./merge.js";
import { buildModuleTree, IdAllocator, rankByInDegree, slug, sourceRoot } from "./modules.js";
import type { Language, PackageInfo, ScanContext } from "./types.js";
import { listFiles } from "./walk.js";

export interface ScanOptions {
  name?: string; // display name (default: root directory name)
  version?: string; // archmap version for generatedBy
  now?: Date; // generatedAt; omitted when absent (keeps output byte-stable)
  useGit?: boolean; // default true: use `git ls-files` when root has .git
  previous?: Architecture | null; // existing architecture.json to merge hand edits from
}

const LAYER_ORDER = [
  "clients", "frontend", "web", "apps", "app", "entry", "ui", "edge", "gateway", "services", "service",
  "servers", "api", "backend", "functions", "workers", "cmd", "infra", "packages", "libs", "lib", "modules",
  "crates", "internal", "pkg", "shared", "core",
];
const LAYER_TAIL = ["tooling", "tools", "scripts", "data", "external"];

export function orderLayers(layers: Iterable<string>): string[] {
  const rank = (l: string): number => {
    const i = LAYER_ORDER.indexOf(l);
    if (i !== -1) return i;
    const t = LAYER_TAIL.indexOf(l);
    if (t !== -1) return 1000 + t;
    return 500;
  };
  return [...new Set(layers)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function guessLanguage(files: string[]): Language {
  const counts: Record<Language, number> = { js: 0, python: 0, go: 0, rust: 0, java: 0, unknown: 0 };
  for (const f of files) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) counts.js++;
    else if (f.endsWith(".py")) counts.python++;
    else if (f.endsWith(".go")) counts.go++;
    else if (f.endsWith(".rs")) counts.rust++;
    else if (/\.(java|kt)$/.test(f)) counts.java++;
  }
  let best: Language = "unknown";
  let n = 0;
  for (const l of ["js", "python", "go", "rust", "java"] as const) {
    if (counts[l] > n) {
      best = l;
      n = counts[l];
    }
  }
  return best;
}

function normName(n: string): string {
  return n.toLowerCase().replaceAll("_", "-");
}

const TOOLING_RE = /(^|[-_])(scripts?|tools?|tooling|config|configs|eslint|lint|oxlint|plugin|prettier|tsconfig)([-_]|$)/;

export function scanRepo(root: string, opts: ScanOptions = {}): Architecture {
  const fl = listFiles(root, opts.useGit === false ? { useGit: false } : {});
  const ctx: ScanContext = { root, fl };
  const ids = new IdAllocator();
  const nodes: ArchNode[] = [];
  const edges: ArchEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (e: ArchEdge): void => {
    if (e.from === e.to) return;
    const key = `${e.from}\u0000${e.to}\u0000${e.label ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(e);
  };

  // Packages the infra pass attaches edges to: [package, node id].
  const owners: { pkg: PackageInfo; id: string }[] = [];
  const ws = detectWorkspaces(ctx);

  const filesUnder = (dir: string, exclude: string[]): string[] => {
    const prefix = dir === "" ? "" : `${dir}/`;
    return fl.files.filter(
      (f) => f.startsWith(prefix) && !exclude.some((x) => x !== dir && (f === x || f.startsWith(`${x}/`))),
    );
  };

  const packageFiles = (
    pkg: PackageInfo,
    entry: string[],
    source: string[],
    inDegree: Map<string, number>,
    extra: string[] = [],
  ): string[] => {
    const out: string[] = [];
    for (const f of [...entry, ...(pkg.manifest !== null ? [pkg.manifest] : []), ...extra, ...rankByInDegree(source, inDegree)]) {
      if (!out.includes(f)) out.push(f);
      if (out.length >= 10) break;
    }
    return out;
  };

  if (ws.dirs.length > 0) {
    // ---- Monorepo ----
    const pkgs = ws.dirs.map(
      (dir): PackageInfo =>
        readManifest(ctx, dir) ?? {
          dir,
          manifest: null,
          name: basename(dir),
          language: guessLanguage(filesUnder(dir, [])),
          deps: [],
          entryHints: [],
          scripts: {},
        },
    );
    const baseCount = new Map<string, number>();
    for (const p of pkgs) baseCount.set(basename(p.dir), (baseCount.get(basename(p.dir)) ?? 0) + 1);
    const pkgIds = pkgs.map((p) => ids.take(slug((baseCount.get(basename(p.dir)) ?? 0) > 1 ? p.dir : basename(p.dir))));
    const byName = new Map<string, string>();
    pkgs.forEach((p, i) => byName.set(normName(p.name), pkgIds[i] ?? ""));

    pkgs.forEach((pkg, i) => {
      const id = pkgIds[i] ?? "";
      const files = filesUnder(pkg.dir, ws.dirs);
      const cls = classify(pkg, files);
      const segs = pkg.dir.split("/");
      const layer =
        segs.length >= 2
          ? (segs[0] ?? "packages")
          : TOOLING_RE.test(basename(pkg.dir))
            ? "tooling"
            : cls.type === "frontend" || cls.type === "service"
              ? "apps"
              : "packages";
      const srcRoot = sourceRoot(ctx, pkg);
      const tree = buildModuleTree(ctx, {
        pkg,
        pkgType: cls.type,
        pkgFiles: files,
        srcRoot,
        parentId: id,
        rootNodeId: null,
        depth: 1,
        ids,
        idPrefix: `${id}.`,
      });
      const source = files.filter((f) => SOURCE_EXT.test(f) && !isTestFile(f));
      nodes.push({
        id,
        type: cls.type,
        name: basename(pkg.dir),
        path: pkg.dir,
        ...(cls.tech.length > 0 ? { tech: cls.tech } : {}),
        layer,
        description: pkg.description ?? `Workspace package ${pkg.name}.`,
        files: packageFiles(pkg, cls.entryFiles, source, tree.inDegree),
      });
      nodes.push(...tree.nodes);
      for (const e of tree.edges) addEdge(e);
      owners.push({ pkg, id });
    });

    // Workspace dependency edges.
    pkgs.forEach((pkg, i) => {
      const from = pkgIds[i] ?? "";
      for (const d of pkg.deps) {
        const to = byName.get(normName(d.name));
        if (to === undefined || to === from) continue;
        addEdge({ from, to, label: d.dev ? "dev dependency" : "depends on", kind: "sync" });
      }
    });
  } else {
    // ---- Single package ----
    const repoName = basename(root.replace(/[\\/]+$/, ""));
    const pkg: PackageInfo = readManifest(ctx, "") ?? {
      dir: "",
      manifest: null,
      name: repoName,
      language: guessLanguage(fl.files),
      deps: [],
      entryHints: [],
      scripts: {},
    };
    const cls = classify(pkg, fl.files);
    const srcRoot = sourceRoot(ctx, pkg);
    const entryId = ids.take(slug(pkg.name === "" ? repoName : pkg.name));
    const tree = buildModuleTree(ctx, {
      pkg,
      pkgType: cls.type,
      pkgFiles: fl.files,
      srcRoot,
      parentId: null,
      rootNodeId: entryId,
      depth: 2,
      ids,
      idPrefix: "",
    });
    nodes.push({
      id: entryId,
      type: cls.type,
      name: pkg.name,
      ...(srcRoot !== "" ? { path: srcRoot } : {}),
      ...(cls.tech.length > 0 ? { tech: cls.tech } : {}),
      layer: "entry",
      ...(pkg.description !== undefined ? { description: pkg.description } : {}),
      files: packageFiles(pkg, cls.entryFiles, [], tree.inDegree, tree.rootFiles),
    });
    nodes.push(...tree.nodes);
    for (const e of tree.edges) addEdge(e);
    owners.push({ pkg, id: entryId });
  }

  // ---- Infrastructure: compose services, client libraries, externals ----
  const compose = detectCompose(ctx, ws.dirs);
  const ownerByDir = new Map(owners.map((o) => [o.pkg.dir, o.id]));
  const composeIds = new Map<string, string>();
  const infraNodeByKind = new Map<string, string>();
  for (const svc of compose) {
    const mapped = svc.buildContext !== undefined ? ownerByDir.get(svc.buildContext) : undefined;
    if (mapped !== undefined) {
      composeIds.set(svc.name, mapped);
      continue;
    }
    const kind = svc.kind;
    const id = ids.take(slug(svc.name));
    composeIds.set(svc.name, id);
    if (kind !== undefined && !infraNodeByKind.has(kind.key)) infraNodeByKind.set(kind.key, id);
    const type = kind?.type ?? "service";
    const tech = kind !== undefined ? [svc.version !== undefined ? `${kind.name} ${svc.version}` : kind.name] : svc.image !== undefined ? [svc.image] : ["Docker"];
    const buildDir = svc.buildContext !== undefined && svc.buildContext !== "" && fl.dirs.has(svc.buildContext) ? svc.buildContext : undefined;
    nodes.push({
      id,
      type,
      name: svc.name,
      tech,
      ...(buildDir !== undefined ? { path: buildDir } : {}),
      layer: type === "datastore" || type === "queue" ? "data" : type === "gateway" ? "edge" : "services",
      description: `${svc.image !== undefined ? `Container ${svc.image}` : "Locally built container"} from ${svc.file}.`,
      files: [svc.file],
    });
  }
  for (const svc of compose) {
    const from = composeIds.get(svc.name);
    if (from === undefined) continue;
    for (const dep of svc.dependsOn) {
      const to = composeIds.get(dep);
      if (to === undefined) continue;
      const target = compose.find((c) => c.name === dep)?.kind;
      addEdge(infraEdge(from, to, target, "depends on"));
    }
  }
  const externalIds = new Map<string, string>();
  for (const { pkg, id } of owners) {
    for (const kind of infraFromDeps(pkg.deps)) {
      let to = infraNodeByKind.get(kind.key);
      if (to === undefined) {
        to = ids.take(kind.key);
        infraNodeByKind.set(kind.key, to);
        const libs = pkg.deps.filter((d) => !d.dev && kind.deps.includes(d.name)).map((d) => d.name);
        nodes.push({
          id: to,
          type: kind.type,
          name: kind.name,
          tech: [kind.name],
          layer: "data",
          description: `Inferred from the ${libs.join(", ")} client ${libs.length === 1 ? "library" : "libraries"}; no container definition found.`,
        });
      }
      addEdge(infraEdge(id, to, kind, kind.label));
    }
    for (const ext of externalsFromDeps(pkg.deps)) {
      let to = externalIds.get(ext.key);
      if (to === undefined) {
        to = ids.take(ext.key);
        externalIds.set(ext.key, to);
        nodes.push({
          id: to,
          type: "external",
          name: ext.name,
          layer: "external",
          description: `Third-party service, detected from SDK dependencies.`,
        });
      }
      addEdge({ from: id, to, label: "API", kind: "sync" });
    }
  }

  edges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : (a.label ?? "") < (b.label ?? "") ? -1 : 1,
  );
  const layers = orderLayers(nodes.map((n) => n.layer).filter((l): l is string => l !== undefined));
  let arch: Architecture = {
    version: 1,
    name: opts.name ?? basename(root.replace(/[\\/]+$/, "")),
    generatedBy: `archmap scan ${opts.version ?? "0.1.0"}`,
    ...(opts.now !== undefined ? { generatedAt: opts.now.toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
    layers,
    nodes,
    edges,
    workflows: [],
  };
  // Provenance: every scanned edge is marked, so re-scans replace only these.
  arch = { ...arch, edges: arch.edges.map((e) => ({ ...e, source: "scan" })) };
  if (opts.previous !== undefined && opts.previous !== null) arch = mergeWithExisting(arch, opts.previous);
  return layoutArchitecture(arch);
}

function infraEdge(from: string, to: string, kind: InfraKind | undefined, fallback: string): ArchEdge {
  const label = kind?.label ?? fallback;
  const k = kind?.type === "datastore" ? "data" : kind?.type === "queue" ? "async" : "sync";
  return { from, to, label, kind: k };
}

export interface ScanSummary {
  nodes: number;
  topLevel: number;
  edges: number;
  layers: string[];
}

export function summarize(arch: Architecture): ScanSummary {
  return {
    nodes: arch.nodes.length,
    topLevel: arch.nodes.filter((n) => n.parent === undefined).length,
    edges: arch.edges.length,
    layers: arch.layers ?? [],
  };
}
