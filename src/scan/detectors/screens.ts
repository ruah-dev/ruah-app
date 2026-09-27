// Screens detector (docs/JOURNEYS.md §3.1, CONTRACTS.md §23.4).
//
// For every frontend package, lists the UI routes it serves as product.json
// screens (`source: "scan"`), from file conventions and router configs:
// Next.js (app + pages router), TanStack Router (routeTree.gen.ts, else file
// routes), React Router / Remix (createBrowserRouter objects, <Route> JSX,
// app/routes.ts, flat routes), Expo Router, SvelteKit and Nuxt. Regex and
// file-convention based like the rest of the scanner; no parser dependency.
// Output is deterministic: sorted by route, then path, capped per repo.
import type { Screen } from "../../contracts/product.js";
import type { DepRef, ScanContext } from "../types.js";
import { dirname, readText } from "../walk.js";
import { isTestFile } from "./entrypoints.js";

export const MAX_SCREENS = 200;

export interface ScreenPackage {
  id: string; // map element id of the owning frontend package
  dir: string; // repo-relative package dir ("" = repo root)
  files: string[]; // repo-relative files of the package (nested workspace packages excluded)
  deps: DepRef[];
}

interface Found {
  route: string;
  path: string; // repo-relative file that renders it (or the router file)
  node: string;
  rank: number; // lower wins when two files claim the same route in one package
  component?: string; // component name, when a router config names it
  layout?: boolean; // a candidate layout: dropped when it has child routes
}

const SCRIPT_ALT = "tsx|jsx|ts|js|mts|mjs";
const SCRIPT_EXT = `(?:${SCRIPT_ALT})`;
const EXT_TRY = [".tsx", ".ts", ".jsx", ".js", ".mdx", ".mts", ".mjs"];

export function detectScreens(ctx: ScanContext, packages: ScreenPackage[], max: number = MAX_SCREENS): Screen[] {
  const found: Found[] = [];
  for (const pkg of packages) found.push(...packageScreens(ctx, pkg));
  found.sort((a, b) => cmp(a.route, b.route) || cmp(a.path, b.path) || cmp(a.node, b.node));
  const kept = found.slice(0, max);
  return toScreens(ctx, kept);
}

// ---------------------------------------------------------------- per package

function packageScreens(ctx: ScanContext, pkg: ScreenPackage): Found[] {
  const has = (...names: string[]): boolean => pkg.deps.some((d) => names.includes(d.name));
  const prefix = pkg.dir === "" ? "" : `${pkg.dir}/`;
  const files = pkg.files.filter((f) => f.startsWith(prefix) && !isTestFile(f.slice(prefix.length)));
  const rel = (f: string): string => f.slice(prefix.length);
  const out: Found[] = [];
  const add = (route: string, path: string, rank: number, extra: Partial<Found> = {}): void => {
    out.push({ route, path, node: pkg.id, rank, ...extra });
  };

  if (has("next")) {
    for (const f of files) {
      const app = new RegExp(`^(?:src/)?app/(?:(.*)/)?page\\.(?:${SCRIPT_ALT}|mdx|md)$`).exec(rel(f));
      if (app !== null) {
        const route = folderRoute((app[1] ?? "").split("/").filter((s) => s !== ""), "next-app");
        if (route !== null) add(route, f, 0);
        continue;
      }
      const pages = new RegExp(`^(?:src/)?pages/(.+)\\.(?:${SCRIPT_ALT}|mdx|md)$`).exec(rel(f));
      if (pages !== null) {
        const segs = (pages[1] ?? "").split("/");
        if (segs[0] === "api" || segs.some((s) => s.startsWith("_"))) continue;
        if (segs[segs.length - 1] === "index") segs.pop();
        const route = folderRoute(segs, "brackets");
        if (route !== null) add(route, f, 1);
      }
    }
  } else if (has("expo-router")) {
    for (const f of files) {
      const m = new RegExp(`^(?:src/)?app/(.+)\\.${SCRIPT_EXT}$`).exec(rel(f));
      if (m === null) continue;
      const segs = (m[1] ?? "").replace(/\.(ios|android|web|native)$/, "").split("/");
      const last = segs[segs.length - 1] ?? "";
      if (last.startsWith("_") || segs.some((s) => s.includes("+"))) continue; // _layout, +not-found, +html, x+api
      if (last === "index") segs.pop();
      const route = folderRoute(segs, "brackets");
      if (route !== null) add(route, f, /\.(ios|android|web|native)\.\w+$/.test(f) ? 1 : 0);
    }
  }

  if (has("@sveltejs/kit")) {
    for (const f of files) {
      const m = /^src\/routes\/(?:(.*)\/)?\+page\.svelte$/.exec(rel(f));
      if (m === null) continue;
      const route = folderRoute((m[1] ?? "").split("/").filter((s) => s !== ""), "brackets");
      if (route !== null) add(route, f, 0);
    }
  }

  if (has("nuxt")) {
    const pageFiles = files.filter((f) => /^(?:app\/)?pages\/.+\.vue$/.test(rel(f)));
    for (const f of pageFiles) {
      const m = /^(?:app\/)?pages\/(.+)\.vue$/.exec(rel(f));
      const segs = (m?.[1] ?? "").split("/");
      if (segs[segs.length - 1] === "index") segs.pop();
      const route = folderRoute(segs, "brackets");
      if (route === null) continue;
      // `users.vue` next to `users/` with <NuxtPage/> is the parent layout of the child pages.
      const dir = f.slice(0, -".vue".length);
      const parent = pageFiles.some((o) => o.startsWith(`${dir}/`)) && /<NuxtPage\b/.test(readText(ctx.root, f) ?? "");
      if (!parent) add(route, f, 0);
    }
  }

  if (has("@tanstack/react-router", "@tanstack/solid-router", "@tanstack/react-start", "@tanstack/start", "@tanstack/solid-start")) {
    const gen = files.find((f) => /(^|\/)routeTree\.gen\.(ts|js|tsx)$/.test(rel(f)));
    const fromGen = gen !== undefined ? tanstackGenerated(ctx, gen, new Set(files)) : [];
    if (fromGen.length > 0) {
      for (const r of fromGen) add(r.route, r.path, 0);
    } else {
      for (const dir of ["src/routes", "app/routes"]) {
        for (const f of files) {
          const r = rel(f);
          if (!r.startsWith(`${dir}/`)) continue;
          const m = new RegExp(`^(.+)\\.${SCRIPT_EXT}$`).exec(r.slice(dir.length + 1));
          if (m === null) continue;
          const t = tanstackFileRoute(m[1] ?? "");
          if (t !== null) add(t.route, f, t.index ? 0 : 1, { layout: !t.index && /<Outlet\b/.test(readText(ctx.root, f) ?? "") });
        }
      }
    }
  }

  if (has("react-router-dom", "react-router", "@remix-run/react", "@remix-run/node", "@remix-run/dev", "@react-router/dev")) {
    const fileSet = new Set(files);
    // Framework mode: app/routes.ts (React Router 7) or flat routes (Remix v2, `flatRoutes()`).
    const routesConfig = files.find((f) => new RegExp(`^app/routes\\.${SCRIPT_EXT}$`).test(rel(f)));
    const framework = has("@remix-run/react", "@remix-run/node", "@remix-run/dev", "@react-router/dev");
    let flat = framework && routesConfig === undefined;
    if (routesConfig !== undefined) {
      const text = blankComments(readText(ctx.root, routesConfig) ?? "");
      configRoutes(text, 0, text.length, "/", (route, file) => {
        const target = resolveFile(fileSet, `${prefix}app`, file);
        add(route, target ?? routesConfig, 0);
      });
      if (/\bflatRoutes\s*\(/.test(text)) flat = true;
    }
    if (flat) {
      for (const f of files) {
        const r = rel(f);
        const m = new RegExp(`^app/routes/(.+?)(?:/route)?\\.(?:${SCRIPT_ALT}|mdx|md)$`).exec(r);
        if (m === null || (m[1] ?? "").includes("/")) continue; // a module inside a route folder
        const src = readText(ctx.root, f) ?? "";
        if (!/export\s+default\b/.test(src)) continue; // resource route (loader/action only)
        const t = remixFlatRoute(m[1] ?? "");
        if (t !== null) add(t.route, f, t.index ? 0 : 1, { layout: !t.index && /<Outlet\b/.test(src) });
      }
    }
    // Library mode: createBrowserRouter([...]) / useRoutes / RouteObject[] / <Route> JSX, in any source file.
    for (const f of files) {
      if (!new RegExp(`\\.${SCRIPT_EXT}$`).test(f) || f === routesConfig) continue;
      const raw = readText(ctx.root, f);
      if (raw === null || !/createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|RouteObject|<Route[\s/>]/.test(raw)) continue;
      const text = blankComments(raw);
      const imports = importMap(text);
      const emit = (route: string, component: string | undefined, lazy: string | undefined): void => {
        const spec = lazy ?? (component !== undefined ? imports.get(component.split(".")[0] ?? "") : undefined);
        const target = spec !== undefined ? resolveSpec(fileSet, prefix, f, spec) : undefined;
        add(route, target ?? f, target !== undefined ? 0 : 2, component !== undefined ? { component } : {});
      };
      objectRoutes(text, emit);
      jsxRoutes(text, emit);
    }
  }

  // One file per route (the best-ranked), then drop layouts that have child routes.
  const best = new Map<string, Found>();
  for (const f of out.sort((a, b) => a.rank - b.rank || cmp(a.path, b.path))) if (!best.has(f.route)) best.set(f.route, f);
  const routes = [...best.keys()];
  return [...best.values()].filter(
    (f) => f.layout !== true || !routes.some((r) => r !== f.route && r.startsWith(f.route === "/" ? "/" : `${f.route}/`)),
  );
}

// ---------------------------------------------------------------- route segments

/** Folder-convention segments → route: `(group)` dropped, `[id]` → `:id`. null = not a screen. */
function folderRoute(segs: string[], mode: "next-app" | "brackets"): string | null {
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "") continue;
    if (/^\(\.{1,3}\)/.test(seg)) return null; // Next intercepting routes
    if (/^\(.*\)$/.test(seg)) continue; // route group
    if (mode === "next-app" && (seg.startsWith("@") || seg.startsWith("_"))) return null; // parallel slot, private folder
    out.push(bracketSegment(seg));
  }
  if (mode === "next-app" && out[0] === "api") return null;
  return `/${out.join("/")}`;
}

function bracketSegment(seg: string): string {
  return seg
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, "*$1?")
    .replace(/\[\.\.\.([^\]]+)\]/g, "*$1")
    .replace(/\[\[([^\]=]+)(?:=[^\]]*)?\]\]/g, ":$1?")
    .replace(/\[([^\]=]+)(?:=[^\]]*)?\]/g, ":$1");
}

/** `$id` → `:id`, `$` → `*`, `{-$id}` → `:id?` (TanStack / Remix params). */
function dollarSegment(seg: string): string {
  if (seg === "$") return "*";
  return seg.replace(/^\{-\$([^}]+)\}$/, ":$1?").replace(/^\(\$([^)]+)\)$/, ":$1?").replace(/^\$/, ":");
}

function tanstackFileRoute(relNoExt: string): { route: string; index: boolean } | null {
  const path = relNoExt.replace(/\.lazy$/, "");
  const dirs = path.split("/");
  if (dirs.some((d) => d.startsWith("-"))) return null; // ignored files / folders
  const tokens = dirs.flatMap((d) => (/^\(.*\)$/.test(d) ? [d] : d.split(".")));
  const last = tokens[tokens.length - 1] ?? "";
  if (last === "__root") return null;
  let index = false;
  if (last === "index") {
    tokens.pop();
    index = true;
  } else if (last === "route") {
    tokens.pop();
  } else if (last.startsWith("_")) {
    return null; // pathless layout
  }
  const segs: string[] = [];
  for (const t of tokens) {
    if (t === "" || t.startsWith("_") || /^\(.*\)$/.test(t)) continue;
    segs.push(dollarSegment(t.replace(/_$/, "")));
  }
  return { route: `/${segs.join("/")}`, index };
}

function remixFlatRoute(key: string): { route: string; index: boolean } | null {
  const tokens = key.replace(/\[\.\]/g, "\u0000").split(/[./]/).map((t) => t.replaceAll("\u0000", "."));
  const last = tokens[tokens.length - 1] ?? "";
  let index = false;
  if (last === "_index" || last === "index") {
    tokens.pop();
    index = true;
  } else if (last.startsWith("_")) {
    return null; // pathless layout
  }
  const segs: string[] = [];
  for (const t of tokens) {
    if (t === "" || t.startsWith("_")) continue;
    const plain = t.replace(/_$/, "").replace(/\[([^\]]*)\]/g, "$1");
    segs.push(/^\([^$].*\)$/.test(plain) ? plain.slice(1, -1) : dollarSegment(plain));
  }
  return { route: `/${segs.join("/")}`, index };
}

/** Normalizes a route: leading slash, no duplicate or trailing slashes. */
function normRoute(route: string): string {
  const r = `/${route}`.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return r === "" ? "/" : r;
}

function joinRoute(parent: string, child: string): string {
  return normRoute(child.startsWith("/") ? child : `${parent}/${child}`);
}

// ---------------------------------------------------------------- TanStack routeTree.gen.ts

function tanstackGenerated(ctx: ScanContext, gen: string, fileSet: Set<string>): { route: string; path: string }[] {
  const text = readText(ctx.root, gen);
  if (text === null) return [];
  const genDir = dirname(gen);
  const importsByBase = new Map<string, string>();
  for (const m of text.matchAll(/import\s*\{\s*Route\s+as\s+(\w+)\s*\}\s*from\s*['"]([^'"]+)['"]/g)) {
    importsByBase.set((m[1] ?? "").replace(/(?:Route)?Import$/, ""), m[2] ?? "");
  }
  const fileOf = (varName: string): string => {
    const spec = importsByBase.get(varName.replace(/(?:RouteWithChildren|Route|Import)$/, ""));
    return (spec !== undefined ? resolveRelative(fileSet, genDir, spec) : undefined) ?? gen;
  };
  const entries: { route: string; varName: string }[] = [];
  for (const iface of ["FileRoutesByTo", "FileRoutesByFullPath"]) {
    const block = new RegExp(`interface\\s+${iface}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(text);
    if (block === null) continue;
    for (const m of (block[1] ?? "").matchAll(/['"]([^'"]*)['"]\s*:\s*typeof\s+(\w+)/g)) entries.push({ route: m[1] ?? "", varName: m[2] ?? "" });
    if (entries.length > 0) break;
  }
  if (entries.length === 0) {
    // Older generators: `interface FileRoutesByPath { '/x': { fullPath: '/x'; preLoaderRoute: typeof XImport } }`.
    for (const m of text.matchAll(/fullPath:\s*['"]([^'"]*)['"][\s\S]*?preLoaderRoute:\s*typeof\s+(\w+)/g)) {
      entries.push({ route: m[1] ?? "", varName: m[2] ?? "" });
    }
  }
  const out = new Map<string, string>();
  for (const e of entries) {
    if (e.route === "") continue; // pathless layout
    const route = normRoute(e.route.split("/").map(dollarSegment).join("/"));
    if (!out.has(route)) out.set(route, fileOf(e.varName));
  }
  return [...out].map(([route, path]) => ({ route, path }));
}

// ---------------------------------------------------------------- React Router: route objects

type Emit = (route: string, component: string | undefined, lazy: string | undefined) => void;

function objectRoutes(text: string, emit: Emit): void {
  const arrays = new Set<number>();
  for (const m of text.matchAll(/\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createStaticRouter|useRoutes)\s*\(/g)) {
    let i = (m.index ?? 0) + m[0].length;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] === "[") {
      arrays.add(i);
    } else {
      const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
      if (ident === undefined) continue;
      const decl = new RegExp(`\\b(?:const|let|var)\\s+${ident.replace(/\$/g, "\\$")}\\b[^=;]*=\\s*\\[`).exec(text);
      if (decl !== null) arrays.add(decl.index + decl[0].length - 1);
    }
  }
  for (const m of text.matchAll(/:\s*RouteObject\[\]\s*=\s*\[/g)) arrays.add((m.index ?? 0) + m[0].length - 1);
  for (const open of [...arrays].sort((a, b) => a - b)) {
    const close = matchClose(text, open);
    if (close !== -1) routeArray(text, open, close, "/", emit);
  }
}

function routeArray(text: string, open: number, close: number, parent: string, emit: Emit): void {
  let i = open + 1;
  while (i < close) {
    const c = text[i] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
    } else if (c === "{") {
      const end = matchClose(text, i);
      if (end === -1) return;
      routeObject(text, i, end, parent, emit);
      i = end + 1;
    } else if (c === "(" || c === "[") {
      const end = matchClose(text, i);
      i = end === -1 ? close : end + 1;
    } else {
      i++;
    }
  }
}

function routeObject(text: string, open: number, close: number, parent: string, emit: Emit): void {
  const top = topLevel(text, open, close);
  const prop = (name: string): number => {
    const m = new RegExp(`(?:^|[\\s,{])${name}\\s*:`).exec(top);
    return m === null ? -1 : m.index + m[0].indexOf(name);
  };
  const pathAt = prop("path");
  const pathValue = pathAt === -1 ? undefined : /^path\s*:\s*(["'`])([^"'`]*)\1/.exec(top.slice(pathAt))?.[2];
  const index = /(?:^|[\s,{])index\s*:\s*true\b/.test(top);
  const own = pathValue !== undefined ? joinRoute(parent, pathValue) : parent;
  const childrenAt = prop("children");
  if (childrenAt !== -1) {
    const bracket = top.indexOf("[", childrenAt);
    if (bracket !== -1 && /^children\s*:\s*\[$/.test(top.slice(childrenAt, bracket + 1))) {
      const end = matchClose(text, open + bracket);
      if (end !== -1) routeArray(text, open + bracket, end, own, emit);
      return;
    }
  }
  if (pathValue === undefined && !index) return;
  if (pathValue === "*") return; // catch-all "not found"
  const raw = (at: number): string => text.slice(open + at, close);
  const elementAt = prop("element");
  const element = elementAt === -1 ? undefined : /^element\s*:\s*\(?\s*<([A-Z][\w.]*)/.exec(raw(elementAt))?.[1];
  if (element === "Navigate") return; // a redirect, not a screen
  const componentAt = prop("Component");
  const component = componentAt === -1 ? undefined : /^Component\s*:\s*([A-Z][\w.]*)/.exec(raw(componentAt))?.[1];
  const lazyAt = prop("lazy");
  const lazy = lazyAt === -1 ? undefined : /^lazy\s*:\s*(?:async\s*)?\(\s*\)\s*=>\s*import\(\s*["'`]([^"'`]+)["'`]/.exec(raw(lazyAt))?.[1];
  emit(own, element ?? component, lazy);
}

// ---------------------------------------------------------------- React Router: <Route> JSX

function jsxRoutes(text: string, emit: Emit): void {
  const stack: string[] = [];
  const re = /<\/Route\s*>|<Route(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const end = tagEnd(text, m.index + m[0].length);
    if (end === -1) return;
    re.lastIndex = end + 1;
    const raw = text.slice(m.index, end + 1);
    const top = blankNested(text, m.index, end + 1);
    const parent = stack[stack.length - 1] ?? "/";
    const attr = (name: string): string | undefined => {
      const at = new RegExp(`\\s${name}\\s*=`).exec(top);
      if (at === null) return undefined;
      return /^\s*=\s*\{?\s*(["'`])([^"'`]*)\1/.exec(raw.slice(at.index + 1 + name.length))?.[2];
    };
    const pathValue = attr("path");
    const index = /\sindex(?=[\s/>]|\s*=\s*\{)/.test(top);
    const own = pathValue !== undefined ? joinRoute(parent, pathValue) : parent;
    const selfClosing = /\/\s*>$/.test(raw);
    if (!selfClosing) {
      stack.push(own);
      continue;
    }
    if ((pathValue === undefined && !index) || pathValue === "*") continue;
    const element = /\selement\s*=\s*\{\s*\(?\s*<([A-Z][\w.]*)/.exec(raw)?.[1];
    if (element === "Navigate") continue;
    const component = /\sComponent\s*=\s*\{\s*([A-Z][\w.]*)\s*\}/.exec(raw)?.[1];
    emit(own, element ?? component, undefined);
  }
}

/** Index of the `>` that ends a JSX opening tag starting before `from` (braces and strings skipped). */
function tagEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      const end = matchClose(text, i);
      if (end === -1) return -1;
      i = end;
    } else if (c === '"' || c === "'") {
      i = skipString(text, i) - 1;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------- React Router 7: app/routes.ts

function configRoutes(text: string, start: number, end: number, parent: string, emit: (route: string, file: string) => void): void {
  const re = /\b(index|route|layout|prefix)\s*\(/g;
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < end) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, open);
    if (close === -1 || close > end) return;
    const top = topLevel(text, open, close);
    const strings = [...top.matchAll(/(["'`])([^"'`]*)\1/g)].map((s) => s[2] ?? "");
    const bracket = top.indexOf("[");
    const children = (route: string): void => {
      if (bracket === -1) return;
      const cEnd = matchClose(text, open + bracket);
      if (cEnd !== -1) configRoutes(text, open + bracket + 1, cEnd, route, emit);
    };
    const kind = m[1];
    if (kind === "index" && strings[0] !== undefined) emit(parent, strings[0]);
    else if (kind === "layout") children(parent);
    else if (kind === "prefix" && strings[0] !== undefined) children(joinRoute(parent, strings[0]));
    else if (kind === "route" && strings[0] !== undefined) {
      const route = joinRoute(parent, strings[0]);
      if (bracket !== -1) children(route);
      else if (strings[1] !== undefined && strings[0] !== "*") emit(route, strings[1]);
    }
    re.lastIndex = close + 1;
  }
}

// ---------------------------------------------------------------- imports and files

/** Local name → module specifier, from ES imports and React.lazy(() => import(...)). */
function importMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const spec = m[3] ?? "";
    if (m[1] !== undefined) map.set(m[1], spec);
    for (const part of (m[2] ?? "").split(",")) {
      const names = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (names !== null) map.set(names[2] ?? names[1] ?? "", spec);
    }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:React\.)?lazy\(\s*(?:async\s*)?\(\s*\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) {
    map.set(m[1] ?? "", m[2] ?? "");
  }
  return map;
}

/** A module specifier used in `fromFile` → repo-relative file (relative, `@/` and `~/` aliases). */
function resolveSpec(fileSet: Set<string>, pkgPrefix: string, fromFile: string, spec: string): string | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) return resolveRelative(fileSet, dirname(fromFile), spec);
  const alias = /^[@~]\/(.*)$/.exec(spec);
  if (alias !== null) {
    for (const base of ["src", "app", ""]) {
      const hit = resolveFile(fileSet, `${pkgPrefix}${base}`.replace(/\/$/, ""), alias[1] ?? "");
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function resolveRelative(fileSet: Set<string>, dir: string, spec: string): string | undefined {
  return resolveFile(fileSet, dir, spec);
}

function resolveFile(fileSet: Set<string>, dir: string, spec: string): string | undefined {
  const parts = (dir === "" ? [] : dir.split("/")).concat(spec.split("/"));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (stack.pop() === undefined) return undefined;
    } else stack.push(p);
  }
  const base = stack.join("/");
  if (fileSet.has(base)) return base;
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  for (const ext of EXT_TRY) if (fileSet.has(`${stem}${ext}`)) return `${stem}${ext}`;
  for (const ext of EXT_TRY) if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return undefined;
}

// ---------------------------------------------------------------- source text helpers

function skipString(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) return j + 1;
    if (q !== "`" && c === "\n") return j + 1; // unterminated (JSX text apostrophe): stop at the line end
    j++;
  }
  return j;
}

/** Replaces comments with spaces (offsets kept); strings are left alone. */
export function blankComments(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") out[j++] = " ";
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e === -1 ? text.length : e + 2;
      for (let j = i; j < end; j++) if (out[j] !== "\n") out[j] = " ";
      i = end;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open` (strings skipped), or -1. */
export function matchClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i) - 1;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * text[open..close] with the contents of nested brackets blanked (offsets kept), so
 * regexes only see the top level of an object, a call's arguments or a JSX tag.
 */
function topLevel(text: string, open: number, close: number): string {
  return `${text[open] ?? ""}${blankNested(text, open + 1, close)}${text[close] ?? ""}`;
}

/** text[start..end) with the contents of every bracket pair blanked (offsets kept). */
function blankNested(text: string, start: number, end: number): string {
  const out = text.slice(start, end).split("");
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
    } else if (c === "(" || c === "[" || c === "{") {
      const close = matchClose(text, i);
      const stop = close === -1 || close >= end ? end : close;
      for (let j = i + 1; j < stop; j++) out[j - start] = " ";
      i = stop + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------- ids and names

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const ID_MAX = 64;

function routeSlug(route: string): string {
  const s = route
    .toLowerCase()
    .split("/")
    .map((seg) => seg.replace(/^[:*]+/, "").replace(/[?*]+$/, ""))
    .filter((seg) => seg !== "")
    .join("-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-.]+$/, "");
  return s.slice(0, 56).replace(/[-.]+$/, "");
}

function humanize(identifier: string): string {
  return identifier
    .replace(/(Page|Screen|Route|View)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function routeName(route: string): string {
  if (route === "/") return "Home";
  const segs = route.split("/").filter((s) => s !== "");
  const first = (segs[0] ?? "").replace(/[-_]+/g, " ");
  return [first.charAt(0).toUpperCase() + first.slice(1), ...segs.slice(1)].join(" / ").slice(0, 80);
}

/** A title the screen's own file states: Next `metadata`, `<title>`, Nuxt useHead / definePageMeta, Remix `meta`. */
function fileTitle(text: string): string | undefined {
  const patterns = [
    /export\s+const\s+metadata\b[^=]*=\s*\{[\s\S]{0,400}?\btitle\s*:\s*(["'`])([^"'`\n]{1,80})\1/,
    /(?:useHead|useSeoMeta|definePageMeta)\s*\(\s*\{[\s\S]{0,300}?\btitle\s*:\s*(["'`])([^"'`\n]{1,80})\1/,
    /export\s+(?:const|function)\s+meta\b[\s\S]{0,300}?\btitle\s*:\s*(["'`])([^"'`\n]{1,80})\1/,
    /<title>()([^<{}\n]{1,80})<\/title>/,
  ];
  for (const re of patterns) {
    const t = re.exec(text)?.[2]?.trim();
    if (t !== undefined && t !== "" && !t.includes("${")) return t;
  }
  return undefined;
}

function defaultExportName(text: string): string | undefined {
  return /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Z][\w$]*)/.exec(text)?.[1] ?? /export\s+default\s+([A-Z][\w$]*)\s*;?\s*$/m.exec(text)?.[1];
}

function toScreens(ctx: ScanContext, found: Found[]): Screen[] {
  const nodesWithScreens = new Set(found.map((f) => f.node));
  const prefixed = nodesWithScreens.size > 1;
  const pathCount = new Map<string, number>();
  for (const f of found) pathCount.set(f.path, (pathCount.get(f.path) ?? 0) + 1);
  const texts = new Map<string, string>();
  const textOf = (p: string): string => {
    let t = texts.get(p);
    if (t === undefined) {
      t = /\.(tsx|jsx|ts|js|mts|mjs|vue|svelte|mdx|md)$/.test(p) ? (readText(ctx.root, p) ?? "") : "";
      texts.set(p, t);
    }
    return t;
  };

  const used = new Set<string>();
  const take = (base: string): string => {
    let id = base.slice(0, ID_MAX);
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, ID_MAX - 1 - String(n).length)}-${n}`;
    used.add(id);
    return id;
  };

  return found.map((f): Screen => {
    const own = pathCount.get(f.path) === 1; // the file renders only this screen
    const text = own ? textOf(f.path) : "";
    const component = f.component ?? (own ? defaultExportName(text) : undefined);
    const siblings = found.filter((o) => o.node === f.node && o !== f);
    let base: string;
    let name: string;
    if (f.route === "/") {
      const homeTaken = siblings.some((o) => routeSlug(o.route) === "home");
      const comp = component !== undefined ? routeSlug(`/${humanize(component).toLowerCase()}`) : "";
      base = !homeTaken ? "home" : comp !== "" && comp !== "home" ? comp : "root";
      name = !homeTaken ? "Home" : component !== undefined && humanize(component) !== "" && humanize(component) !== "Home" ? humanize(component) : "Root";
    } else {
      base = routeSlug(f.route) || "screen";
      name = routeName(f.route);
    }
    const title = own ? fileTitle(text) : undefined;
    if (title !== undefined) name = title;
    const id = take(prefixed ? `${f.node}.${base}` : base);
    return { id, name: name.slice(0, 80), route: f.route.slice(0, 200), path: f.path, node: f.node, source: "scan" };
  });
}
