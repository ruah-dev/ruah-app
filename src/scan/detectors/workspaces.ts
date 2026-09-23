// Workspace detector (PLAN.md Phase 2, task 2.2; ASSUMPTIONS.md 22).
//
// Returns the package directories of a multi-package repo, from (in order):
// pnpm-workspace.yaml, package.json `workspaces`, lerna.json, Cargo
// `[workspace] members`, go.work `use`, uv workspace members, Maven
// `<modules>`, Gradle `include`, nx `project.json` files. With none of those,
// the `apps/ packages/ services/` convention applies: manifest directories at
// depth 1–2 count as packages when there are at least two of them.
import { parseToml, tomlGet, tomlStrings } from "../mini-toml.js";
import { parseYaml, yamlGet, yamlStrings } from "../mini-yaml.js";
import type { ScanContext } from "../types.js";
import { dirname, globToRegexSource, readText } from "../walk.js";

export const MANIFEST_NAMES = [
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "setup.py",
];

const NON_PACKAGE_DIRS = new Set([
  "example", "examples", "fixtures", "fixture", "test", "tests", "__tests__", "e2e", "docs", "doc",
  "templates", "template", "samples", "sample", "benchmarks", "bench",
]);

export interface WorkspaceResult {
  tool: string | null; // e.g. "pnpm", "npm", "cargo", "convention"
  dirs: string[]; // sorted package dirs (never "")
}

function manifestDirs(ctx: ScanContext): string[] {
  const out = new Set<string>();
  for (const f of ctx.fl.files) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (!MANIFEST_NAMES.includes(base)) continue;
    const d = dirname(f);
    if (d === "") continue;
    if (d.split("/").some((s) => NON_PACKAGE_DIRS.has(s))) continue;
    out.add(d);
  }
  return [...out].sort();
}

function expandGlobs(patterns: string[], candidates: string[], allDirs: Set<string>): string[] {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  const exact: string[] = [];
  for (const raw of patterns) {
    let p = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    const neg = p.startsWith("!");
    if (neg) p = p.slice(1).replace(/^\.\//, "");
    if (p === "" || p === ".") continue;
    const re = new RegExp(`^${globToRegexSource(p)}$`);
    if (neg) exclude.push(re);
    else if (!/[*?]/.test(p)) exact.push(p);
    else include.push(re);
  }
  const out = new Set<string>();
  for (const c of candidates) {
    if (include.some((re) => re.test(c))) out.add(c);
  }
  for (const e of exact) if (allDirs.has(e)) out.add(e);
  return [...out].filter((d) => !exclude.some((re) => re.test(d))).sort();
}

function jsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function detectWorkspaces(ctx: ScanContext): WorkspaceResult {
  const { root, fl } = ctx;
  const candidates = manifestDirs(ctx);
  const tryGlobs = (tool: string, patterns: string[]): WorkspaceResult | null => {
    if (patterns.length === 0) return null;
    const dirs = expandGlobs(patterns, candidates, fl.dirs);
    return dirs.length > 0 ? { tool, dirs } : null;
  };

  const pnpm = readText(root, "pnpm-workspace.yaml");
  if (pnpm !== null) {
    const r = tryGlobs("pnpm", yamlStrings(yamlGet(parseYaml(pnpm), "packages")));
    if (r !== null) return r;
  }
  const pkg = jsonObject(readText(root, "package.json"));
  if (pkg !== null) {
    const ws = pkg["workspaces"];
    const patterns = Array.isArray(ws)
      ? stringArray(ws)
      : typeof ws === "object" && ws !== null
        ? stringArray((ws as Record<string, unknown>)["packages"])
        : [];
    const r = tryGlobs(fl.fileSet.has("yarn.lock") ? "yarn" : fl.fileSet.has("bun.lock") ? "bun" : "npm", patterns);
    if (r !== null) return r;
  }
  const lerna = jsonObject(readText(root, "lerna.json"));
  if (lerna !== null) {
    const r = tryGlobs("lerna", stringArray(lerna["packages"]));
    if (r !== null) return r;
  }
  const cargo = readText(root, "Cargo.toml");
  if (cargo !== null) {
    const r = tryGlobs("cargo", tomlStrings(tomlGet(parseToml(cargo), "workspace", "members")));
    if (r !== null) return r;
  }
  const gowork = readText(root, "go.work");
  if (gowork !== null) {
    const uses: string[] = [];
    const block = /use\s*\(([^)]*)\)/m.exec(gowork);
    if (block !== null) uses.push(...(block[1] ?? "").split(/\s+/));
    for (const m of gowork.matchAll(/^use\s+(\S+)\s*$/gm)) uses.push(m[1] ?? "");
    const r = tryGlobs("go", uses.filter((u) => u !== "" && !u.startsWith("//")));
    if (r !== null) return r;
  }
  const pyproject = readText(root, "pyproject.toml");
  if (pyproject !== null) {
    const r = tryGlobs("uv", tomlStrings(tomlGet(parseToml(pyproject), "tool", "uv", "workspace", "members")));
    if (r !== null) return r;
  }
  const pom = readText(root, "pom.xml");
  if (pom !== null) {
    const mods = [...pom.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((m) => m[1] ?? "");
    const r = tryGlobs("maven", mods);
    if (r !== null) return r;
  }
  const gradle = readText(root, "settings.gradle") ?? readText(root, "settings.gradle.kts");
  if (gradle !== null) {
    const mods: string[] = [];
    for (const m of gradle.matchAll(/include\s*\(?([^\n)]*)\)?/g)) {
      for (const q of (m[1] ?? "").matchAll(/["']:?([^"']+)["']/g)) mods.push((q[1] ?? "").replaceAll(":", "/"));
    }
    const r = tryGlobs("gradle", mods);
    if (r !== null) return r;
  }
  if (fl.fileSet.has("nx.json")) {
    const dirs = fl.files
      .filter((f) => f.endsWith("/project.json"))
      .map(dirname)
      .filter((d) => !d.split("/").some((s) => NON_PACKAGE_DIRS.has(s)));
    if (dirs.length > 0) return { tool: "nx", dirs: [...new Set(dirs)].sort() };
  }
  // Convention: manifests at depth 1–2 (apps/web, services/api, frontend/, backend/).
  const shallow = candidates.filter((d) => d.split("/").length <= 2);
  if (shallow.length >= 2) {
    // Drop dirs nested inside another candidate (apps/web/e2e-helper etc.).
    const top = shallow.filter((d) => !shallow.some((o) => o !== d && d.startsWith(`${o}/`)));
    if (top.length >= 2) return { tool: "convention", dirs: top };
  }
  return { tool: null, dirs: [] };
}
