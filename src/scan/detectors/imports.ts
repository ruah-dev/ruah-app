// Import detector (PLAN.md Phase 2, task 2.2).
//
// Extracts import specifiers from JS/TS, Python, Go and Rust sources with
// regexes (no parser, by design) and resolves the in-repo ones to a
// repo-relative file or directory. JS/TS resolution understands relative
// paths, NodeNext `.js`→`.ts` twins, index files, and tsconfig/jsconfig
// `paths` aliases (falling back to `@/` and `~/` → `src/`). External packages
// resolve to null; cross-package edges come from manifests, not from here.
import type { PackageInfo, ScanContext } from "../types.js";
import { dirname, joinRel, readText } from "../walk.js";

export const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro|py|go|rs)$/;
const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro)$/;
const JS_TRY = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro"];

export function normJoin(dir: string, p: string): string | null {
  const parts: string[] = dir === "" ? [] : dir.split("/");
  for (const seg of p.replaceAll("\\", "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

const JS_STATIC = /(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g;
const JS_DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

export function extractSpecifiers(file: string, text: string): string[] {
  const out: string[] = [];
  if (JS_EXT.test(file)) {
    for (const m of text.matchAll(JS_STATIC)) out.push(m[1] ?? "");
    for (const m of text.matchAll(JS_DYNAMIC)) out.push(m[1] ?? "");
  } else if (file.endsWith(".py")) {
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([\w, \t*\n]+?)\)?[ \t]*$/gm)) {
      const base = m[1] ?? "";
      for (const name of (m[2] ?? "").split(",").map((s) => s.trim().split(/\s+/)[0] ?? "")) {
        if (name === "" || name === "*") out.push(base);
        else out.push(base.endsWith(".") ? `${base}${name}` : `${base}.${name}`);
      }
    }
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) {
      for (const s of (m[1] ?? "").split(",")) out.push(s.trim());
    }
  } else if (file.endsWith(".go")) {
    for (const m of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
      for (const q of (m[1] ?? "").matchAll(/"([^"]+)"/g)) out.push(q[1] ?? "");
    }
    for (const m of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1] ?? "");
  } else if (file.endsWith(".rs")) {
    for (const m of text.matchAll(/\buse\s+(crate(?:::\w+)+)/g)) out.push(m[1] ?? "");
    for (const m of text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) out.push(`self::${m[1] ?? ""}`);
  }
  return out.filter((s) => s !== "");
}

interface Alias {
  prefix: string; // "@/" or exact "foo"
  wildcard: boolean;
  targets: string[]; // repo-relative (dir for wildcard, file base for exact)
}

function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readTsconfigAliases(ctx: ScanContext, file: string, depth = 0): Alias[] {
  const text = readText(ctx.root, file);
  if (text === null) return [];
  const cfg = record(parseJsonc(text));
  if (cfg === null) return [];
  const dir = dirname(file);
  const opts = record(cfg["compilerOptions"]);
  const paths = record(opts?.["paths"]);
  const aliases: Alias[] = [];
  if (paths !== null) {
    const baseUrl = typeof opts?.["baseUrl"] === "string" ? (opts["baseUrl"] as string) : ".";
    const base = normJoin(dir, baseUrl) ?? dir;
    for (const [key, val] of Object.entries(paths)) {
      const targets = (Array.isArray(val) ? val : [])
        .filter((t): t is string => typeof t === "string")
        .map((t) => normJoin(base, t.replace(/\*$/, "")))
        .filter((t): t is string => t !== null);
      if (targets.length === 0) continue;
      const wildcard = key.endsWith("*");
      aliases.push({ prefix: wildcard ? key.slice(0, -1) : key, wildcard, targets });
    }
  }
  const ext = cfg["extends"];
  if (aliases.length === 0 && typeof ext === "string" && ext.startsWith(".") && depth < 3) {
    const target = normJoin(dir, ext.endsWith(".json") ? ext : `${ext}.json`);
    if (target !== null) return readTsconfigAliases(ctx, target, depth + 1);
  }
  return aliases;
}

export interface Resolver {
  resolve(fromFile: string, spec: string): string | null;
}

export function createResolver(ctx: ScanContext, pkg: PackageInfo, srcRoot: string): Resolver {
  const { fl } = ctx;
  let aliases: Alias[] = [];
  if (pkg.language === "js") {
    for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
      aliases = readTsconfigAliases(ctx, joinRel(pkg.dir, name));
      if (aliases.length > 0) break;
    }
    if (aliases.length === 0) {
      const src = fl.dirs.has(joinRel(pkg.dir, "src")) ? joinRel(pkg.dir, "src") : pkg.dir;
      aliases = [
        { prefix: "@/", wildcard: true, targets: [src] },
        { prefix: "~/", wildcard: true, targets: [src] },
      ];
    }
    aliases.sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : 1));
  }

  const fileOrDir = (base: string): string | null => {
    if (fl.fileSet.has(base)) return base;
    const noJs = base.replace(/\.(c|m)?jsx?$/, "");
    for (const ext of JS_TRY) if (fl.fileSet.has(`${noJs}${ext}`)) return `${noJs}${ext}`;
    for (const ext of JS_TRY) if (fl.fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    if (fl.dirs.has(base)) return base;
    return null;
  };

  const pyRoots = [srcRoot, dirname(srcRoot), pkg.dir, joinRel(pkg.dir, "src")].filter(
    (d, i, a) => a.indexOf(d) === i,
  );
  const pyResolve = (fromFile: string, spec: string): string | null => {
    const tryMod = (base: string): string | null => {
      if (fl.fileSet.has(`${base}.py`)) return `${base}.py`;
      if (fl.fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
      if (fl.dirs.has(base) && base !== "") return base;
      return null;
    };
    const attempt = (s: string): string | null => {
      const dots = /^\.*/.exec(s)?.[0].length ?? 0;
      const rest = s.slice(dots).split(".").filter((x) => x !== "").join("/");
      if (dots > 0) {
        let d = dirname(fromFile);
        for (let i = 1; i < dots; i++) d = dirname(d);
        return tryMod(joinRel(d, rest).replace(/\/$/, ""));
      }
      for (const r of pyRoots) {
        const hit = tryMod(joinRel(r, rest));
        if (hit !== null) return hit;
      }
      return null;
    };
    // `from pkg.mod import Name`: Name may be a symbol, so fall back one level.
    return attempt(spec) ?? (spec.includes(".") ? attempt(spec.slice(0, spec.lastIndexOf("."))) : null);
  };

  return {
    resolve(fromFile: string, spec: string): string | null {
      if (fromFile.endsWith(".py")) return pyResolve(fromFile, spec);
      if (fromFile.endsWith(".go")) {
        const mod = pkg.goModule;
        if (mod === undefined || !(spec === mod || spec.startsWith(`${mod}/`))) return null;
        const rel = normJoin(pkg.dir, spec.slice(mod.length + 1));
        return rel !== null && fl.dirs.has(rel) ? rel : null;
      }
      if (fromFile.endsWith(".rs")) {
        const [head, ...segs] = spec.split("::");
        const base = head === "crate" ? joinRel(pkg.dir, "src") : dirname(fromFile);
        for (let n = segs.length; n > 0; n--) {
          const p = joinRel(base, segs.slice(0, n).join("/"));
          if (fl.fileSet.has(`${p}.rs`)) return `${p}.rs`;
          if (fl.fileSet.has(`${p}/mod.rs`)) return `${p}/mod.rs`;
          if (fl.dirs.has(p)) return p;
        }
        return null;
      }
      let base: string | null = null;
      if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
        base = normJoin(dirname(fromFile), spec);
      } else {
        for (const a of aliases) {
          if (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix) {
            for (const t of a.targets) {
              const cand = a.wildcard ? normJoin(t, spec.slice(a.prefix.length)) : t;
              if (cand !== null && fileOrDir(cand) !== null) return fileOrDir(cand);
            }
            break;
          }
        }
        return null;
      }
      if (base === null) return null;
      const clean = base.split("?")[0] ?? base;
      return fileOrDir(clean);
    },
  };
}
