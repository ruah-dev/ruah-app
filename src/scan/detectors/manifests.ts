// Manifest detector (PLAN.md Phase 2, task 2.2).
//
// Reads one package directory's manifest into a `PackageInfo`: package.json,
// pyproject.toml (PEP 621 and Poetry), Cargo.toml, go.mod, pom.xml and
// build.gradle (minimal), setup.py / requirements.txt (name + deps only).
// Also extracts a deterministic description: manifest description first, else
// the first prose line of the directory's README.
import { isTable, parseToml, tomlGet, tomlString, type TomlValue } from "../mini-toml.js";
import type { DepRef, PackageInfo, ScanContext } from "../types.js";
import { joinRel, readText } from "../walk.js";

function basename(dir: string): string {
  return dir.slice(dir.lastIndexOf("/") + 1);
}

function normRel(dir: string, p: string): string | null {
  const parts: string[] = dir === "" ? [] : dir.split("/");
  for (const seg of p.replaceAll("\\", "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join("/");
}

function sortDeps(deps: DepRef[]): DepRef[] {
  const byName = new Map<string, DepRef>();
  for (const d of deps) {
    const prev = byName.get(d.name);
    // A runtime declaration wins over a dev one.
    if (prev === undefined || (prev.dev && !d.dev)) byName.set(d.name, d);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function recordDeps(v: unknown, dev: boolean): DepRef[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).map(([name, ver]) =>
    typeof ver === "string" ? { name, dev, version: ver } : { name, dev },
  );
}

function pep508Name(spec: string): string {
  return (/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1] ?? "").toLowerCase().replaceAll("_", "-");
}

function tomlDeps(v: TomlValue | undefined, dev: boolean): DepRef[] {
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => ({ name: pep508Name(s), dev }))
      .filter((d) => d.name !== "");
  }
  if (isTable(v)) {
    return Object.entries(v).map(([name, val]) =>
      typeof val === "string" ? { name: name.toLowerCase(), dev, version: val } : { name: name.toLowerCase(), dev },
    );
  }
  return [];
}

function fromPackageJson(dir: string, text: string): PackageInfo | null {
  let pkg: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    pkg = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const entryHints: string[] = [];
  const addHint = (p: unknown): void => {
    if (typeof p !== "string") return;
    const r = normRel(dir, p);
    if (r !== null) entryHints.push(r);
  };
  addHint(pkg["main"]);
  addHint(pkg["module"]);
  const bin = pkg["bin"];
  if (typeof bin === "string") addHint(bin);
  else if (typeof bin === "object" && bin !== null) for (const v of Object.values(bin)) addHint(v);
  const scripts: Record<string, string> = {};
  const rawScripts = pkg["scripts"];
  if (typeof rawScripts === "object" && rawScripts !== null) {
    for (const [k, v] of Object.entries(rawScripts)) if (typeof v === "string") scripts[k] = v;
  }
  const desc = pkg["description"];
  const name = pkg["name"];
  return {
    dir,
    manifest: joinRel(dir, "package.json"),
    name: typeof name === "string" && name !== "" ? name : basename(dir),
    ...(typeof desc === "string" && desc.trim() !== "" ? { description: desc.trim() } : {}),
    language: "js",
    deps: sortDeps([
      ...recordDeps(pkg["dependencies"], false),
      ...recordDeps(pkg["peerDependencies"], false),
      ...recordDeps(pkg["optionalDependencies"], false),
      ...recordDeps(pkg["devDependencies"], true),
    ]),
    entryHints: [...new Set(entryHints)],
    scripts,
  };
}

function fromPyproject(dir: string, text: string): PackageInfo {
  const t = parseToml(text);
  const name = tomlString(tomlGet(t, "project", "name")) ?? tomlString(tomlGet(t, "tool", "poetry", "name"));
  const desc =
    tomlString(tomlGet(t, "project", "description")) ?? tomlString(tomlGet(t, "tool", "poetry", "description"));
  const deps: DepRef[] = [
    ...tomlDeps(tomlGet(t, "project", "dependencies"), false),
    ...tomlDeps(tomlGet(t, "tool", "poetry", "dependencies"), false),
  ];
  const optional = tomlGet(t, "project", "optional-dependencies");
  if (isTable(optional)) for (const v of Object.values(optional)) deps.push(...tomlDeps(v, true));
  const groups = tomlGet(t, "dependency-groups");
  if (isTable(groups)) for (const v of Object.values(groups)) deps.push(...tomlDeps(v, true));
  deps.push(...tomlDeps(tomlGet(t, "tool", "poetry", "dev-dependencies"), true));
  const scriptsTbl = tomlGet(t, "project", "scripts");
  const scripts: Record<string, string> = {};
  if (isTable(scriptsTbl)) for (const [k, v] of Object.entries(scriptsTbl)) if (typeof v === "string") scripts[k] = v;
  return {
    dir,
    manifest: joinRel(dir, "pyproject.toml"),
    name: name ?? basename(dir),
    ...(desc !== undefined && desc.trim() !== "" ? { description: desc.trim() } : {}),
    language: "python",
    deps: sortDeps(deps.filter((d) => d.name !== "python")),
    entryHints: [],
    scripts,
  };
}

function fromCargo(dir: string, text: string): PackageInfo {
  const t = parseToml(text);
  const name = tomlString(tomlGet(t, "package", "name"));
  const desc = tomlString(tomlGet(t, "package", "description"));
  const deps = [
    ...tomlDeps(tomlGet(t, "dependencies"), false),
    ...tomlDeps(tomlGet(t, "dev-dependencies"), true),
    ...tomlDeps(tomlGet(t, "build-dependencies"), true),
  ];
  return {
    dir,
    manifest: joinRel(dir, "Cargo.toml"),
    name: name ?? basename(dir),
    ...(desc !== undefined && desc.trim() !== "" ? { description: desc.trim() } : {}),
    language: "rust",
    deps: sortDeps(deps),
    entryHints: [],
    scripts: {},
  };
}

function fromGoMod(dir: string, text: string): PackageInfo {
  const mod = /^module\s+(\S+)/m.exec(text)?.[1];
  const deps: DepRef[] = [];
  const block = /require\s*\(([^)]*)\)/gm;
  for (const m of text.matchAll(block)) {
    for (const line of (m[1] ?? "").split("\n")) {
      const dep = /^\s*(\S+)\s+\S+/.exec(line)?.[1];
      if (dep !== undefined && !dep.startsWith("//")) deps.push({ name: dep, dev: line.includes("// indirect") });
    }
  }
  for (const m of text.matchAll(/^require\s+(\S+)\s+\S+/gm)) deps.push({ name: m[1] ?? "", dev: false });
  return {
    dir,
    manifest: joinRel(dir, "go.mod"),
    name: mod?.slice(mod.lastIndexOf("/") + 1) ?? basename(dir),
    language: "go",
    deps: sortDeps(deps.filter((d) => d.name !== "")),
    entryHints: [],
    scripts: {},
    ...(mod !== undefined ? { goModule: mod } : {}),
  };
}

function fromPom(dir: string, text: string): PackageInfo {
  const noParent = text.replace(/<parent>[\s\S]*?<\/parent>/, "").replace(/<dependencies>[\s\S]*<\/dependencies>/, "");
  const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(noParent)?.[1];
  const desc = /<description>\s*([^<]+?)\s*<\/description>/.exec(noParent)?.[1];
  const deps = [...text.matchAll(/<dependency>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>[\s\S]*?<\/dependency>/g)].map(
    (m) => ({ name: m[1] ?? "", dev: false }),
  );
  return {
    dir,
    manifest: joinRel(dir, "pom.xml"),
    name: artifact ?? basename(dir),
    ...(desc !== undefined ? { description: desc } : {}),
    language: "java",
    deps: sortDeps(deps),
    entryHints: [],
    scripts: {},
  };
}

function fromGradle(dir: string, file: string, text: string): PackageInfo {
  const deps: DepRef[] = [];
  for (const m of text.matchAll(/(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([^:"']+):([^:"']+)/g)) {
    deps.push({ name: m[3] ?? "", dev: (m[1] ?? "").startsWith("test") });
  }
  for (const m of text.matchAll(/project\(\s*["']:([^"']+)["']\s*\)/g)) {
    const p = m[1] ?? "";
    deps.push({ name: p.slice(p.lastIndexOf(":") + 1), dev: false });
  }
  return {
    dir,
    manifest: joinRel(dir, file),
    name: basename(dir),
    language: "java",
    deps: sortDeps(deps.filter((d) => d.name !== "")),
    entryHints: [],
    scripts: {},
  };
}

function fromSetupPy(dir: string, text: string, requirements: string | null): PackageInfo {
  const name = /name\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
  const desc = /description\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
  return {
    dir,
    manifest: joinRel(dir, "setup.py"),
    name: name ?? basename(dir),
    ...(desc !== undefined ? { description: desc } : {}),
    language: "python",
    deps: sortDeps(requirementsDeps(requirements)),
    entryHints: [],
    scripts: {},
  };
}

function requirementsDeps(text: string | null): DepRef[] {
  if (text === null) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("-"))
    .map((l) => ({ name: pep508Name(l), dev: false }))
    .filter((d) => d.name !== "");
}

// Reads the first manifest found in `dir`, or null when there is none.
export function readManifest(ctx: ScanContext, dir: string): PackageInfo | null {
  const { root } = ctx;
  const read = (name: string): string | null => readText(root, joinRel(dir, name));
  let info: PackageInfo | null = null;
  const pj = read("package.json");
  if (pj !== null) info = fromPackageJson(dir, pj);
  if (info === null) {
    const py = read("pyproject.toml");
    if (py !== null) info = fromPyproject(dir, py);
  }
  if (info === null) {
    const cargo = read("Cargo.toml");
    if (cargo !== null) info = fromCargo(dir, cargo);
  }
  if (info === null) {
    const gomod = read("go.mod");
    if (gomod !== null) info = fromGoMod(dir, gomod);
  }
  if (info === null) {
    const pom = read("pom.xml");
    if (pom !== null) info = fromPom(dir, pom);
  }
  if (info === null) {
    for (const g of ["build.gradle.kts", "build.gradle"]) {
      const text = read(g);
      if (text !== null) {
        info = fromGradle(dir, g, text);
        break;
      }
    }
  }
  if (info === null) {
    const setup = read("setup.py");
    if (setup !== null) info = fromSetupPy(dir, setup, read("requirements.txt"));
  }
  if (info === null) {
    const req = read("requirements.txt");
    if (req !== null) {
      info = {
        dir,
        manifest: joinRel(dir, "requirements.txt"),
        name: basename(dir),
        language: "python",
        deps: sortDeps(requirementsDeps(req)),
        entryHints: [],
        scripts: {},
      };
    }
  }
  if (info !== null && info.description === undefined) {
    const readme = readmeLine(ctx, dir);
    if (readme !== null) info.description = readme;
  }
  return info;
}

// First prose line of README.md in `dir` (headings, badges, HTML, code fences skipped).
export function readmeLine(ctx: ScanContext, dir: string): string | null {
  const name = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.rst", "README.txt", "README"].find(
    (n) => ctx.fl.fileSet.has(joinRel(dir, n)),
  );
  if (name === undefined) return null;
  const text = readText(ctx.root, joinRel(dir, name));
  if (text === null) return null;
  // Paragraphs = runs of non-blank lines (READMEs are often hard-wrapped).
  const paragraphs: string[][] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      if (cur.length > 0) paragraphs.push(cur);
      cur = [];
      continue;
    }
    if (inFence) continue;
    if (line === "") {
      if (cur.length > 0) paragraphs.push(cur);
      cur = [];
    } else cur.push(line);
  }
  if (cur.length > 0) paragraphs.push(cur);
  for (const para of paragraphs) {
    const first = para[0] ?? "";
    if (/^(#|=|-{3,}|\*{3,}|<|!\[|\[!\[|>|\||:::|\.\.|[-*+] |\d+\. )/.test(first)) continue;
    const plain = para
      .join(" ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`|\*\*?/g, "")
      .replace(/(^|\s)_([^_\s][^_]*)_(?=[\s.,;:!?]|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length < 12 || plain.endsWith(":")) continue;
    return clampDescription(plain);
  }
  return null;
}

export function clampDescription(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= 280) return one;
  const cut = one.slice(0, 280);
  const stop = cut.lastIndexOf(". ");
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.slice(0, 277).trimEnd()}...`;
}
