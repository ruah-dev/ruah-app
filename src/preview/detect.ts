// How to run a project's dev server (CONTRACTS §18.2) — deterministic, no
// network, bounded file reads. Looks at the repo root, its workspaces
// (pnpm-workspace.yaml, package.json `workspaces`, lerna.json), its top-level
// folders and apps/* · packages/* · services/* …, and offers a candidate per
// runnable thing:
//   - package.json scripts (dev, develop, start, serve, web, storybook …) with
//     the package manager of the nearest lockfile, the framework read from the
//     script and the dependencies (Vite, Next, Remix, Astro, SvelteKit, Nuxt,
//     Expo web, Storybook, CRA, Angular, …); build watchers and test runners
//     are not servers and are skipped;
//   - deno.json tasks; Django (manage.py), Flask, FastAPI, Streamlit with the
//     project's virtualenv / uv / poetry; Rails (bin/dev, bin/rails), Jekyll;
//     Go with air (or `go run .`); Hugo; docker compose;
//   - a plain index.html → the built-in static server with live reload.
// The saved choice (this computer's, else the repo's .ruah/preview.json) wins;
// otherwise one obvious candidate is selected and several comparable ones
// (monorepos) are left to the user.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PreviewCandidate, PreviewDetection, PreviewFile } from "../contracts/preview.js";
import { parseYaml, yamlGet, yamlKeys, yamlList, yamlString, yamlStrings, type YamlValue } from "../scan/mini-yaml.js";
import { globToRegexSource, IGNORED_DIRS } from "../scan/walk.js";
import { readLocalPreviewFile, readPreviewFile } from "./config.js";

export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

export interface DetectOptions {
  /** PATH used to tell whether the programs a candidate needs exist (default: process.env.PATH). */
  pathEnv?: string | undefined;
  /** Folders inspected at most (default 150). */
  maxDirs?: number;
  /** Multi-repo system (§12): each repo is detected too, its folders prefixed "<id>/". */
  repos?: readonly { id: string; root: string }[];
  /** This computer's choice (`$RUAH_HOME/projects/<id>/preview.json`, §20.3): wins over the repo's. */
  localChoiceFile?: string | undefined;
}

const MAX_JSON_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const CONTAINERS = ["apps", "packages", "services", "sites", "web", "frontend", "backend", "client", "server", "src"];
const MARKERS = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  "manage.py",
  "Gemfile",
  "go.mod",
  "index.html",
  "pyproject.toml",
  "requirements.txt",
  "app.py",
  "main.py",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "hugo.toml",
  "hugo.yaml",
  "config.toml",
  ".air.toml",
];
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

// ---------------------------------------------------------------- small fs helpers

function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(file: string, max = MAX_SOURCE_BYTES): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const text = readText(file, MAX_JSON_BYTES);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** deno.jsonc and friends: drop // and /* *\/ comments outside strings, then parse. */
function readJsonc(file: string): Record<string, unknown> | undefined {
  const text = readText(file, MAX_JSON_BYTES);
  if (text === undefined) return undefined;
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (quote) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') {
      quote = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else out += c;
  }
  try {
    const value: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function childDirs(abs: string): string[] {
  try {
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** True when `bin` is an executable on PATH (absolute or ./relative paths: exists). */
export function onPath(bin: string, pathEnv: string | undefined = process.env.PATH): boolean {
  if (bin.includes("/")) return exists(bin);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      try {
        const file = path.join(dir, bin + ext);
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- folders

function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  const pnpm = readText(path.join(root, "pnpm-workspace.yaml"));
  if (pnpm !== undefined) globs.push(...yamlStrings(yamlGet(parseYaml(pnpm), "packages")));
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg !== undefined) {
    const ws = pkg.workspaces;
    globs.push(...strings(ws), ...strings(record(ws).packages));
  }
  const lerna = readJson(path.join(root, "lerna.json"));
  if (lerna !== undefined) globs.push(...strings(lerna.packages));
  return [...new Set(globs.map((g) => g.trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter((g) => g.length > 0))];
}

function expandGlob(root: string, glob: string, limit: number): string[] {
  if (glob.startsWith("!")) return [];
  if (!glob.includes("*") && !glob.includes("?")) return isDir(path.join(root, glob)) ? [glob] : [];
  const re = new RegExp(`^${globToRegexSource(glob)}$`);
  const depth = glob.includes("**") ? 4 : glob.split("/").length;
  const out: string[] = [];
  let frontier = [""];
  for (let level = 1; level <= depth && frontier.length > 0 && out.length < limit; level += 1) {
    const next: string[] = [];
    for (const rel of frontier) {
      for (const name of childDirs(path.join(root, rel))) {
        const child = rel === "" ? name : `${rel}/${name}`;
        if (re.test(child)) out.push(child);
        next.push(child);
        if (next.length > limit * 4) break;
      }
    }
    frontier = next;
  }
  return out.slice(0, limit);
}

function hasMarker(abs: string): boolean {
  return MARKERS.some((m) => exists(path.join(abs, m)));
}

/** The repo-relative folders worth a look, root first. */
export function candidateDirs(root: string, maxDirs = 150): { dirs: string[]; truncated: boolean } {
  const found = new Set<string>(["."]);
  let truncated = false;
  const add = (rel: string): void => {
    if (found.has(rel)) return;
    if (found.size >= maxDirs) {
      truncated = true;
      return;
    }
    if (hasMarker(path.join(root, rel))) found.add(rel);
  };
  for (const glob of workspaceGlobs(root)) for (const rel of expandGlob(root, glob, maxDirs)) add(rel);
  for (const name of childDirs(root)) add(name);
  for (const container of CONTAINERS) {
    if (!isDir(path.join(root, container))) continue;
    for (const name of childDirs(path.join(root, container))) add(`${container}/${name}`);
  }
  return { dirs: [...found], truncated };
}

// ---------------------------------------------------------------- package managers

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** The package manager of `dir`: nearest lockfile up to the root, else package.json `packageManager`, else npm. */
export function packageManagerFor(root: string, dir: string): PackageManager {
  let current = path.resolve(root, dir);
  const top = path.resolve(root);
  for (;;) {
    for (const [file, pm] of LOCKFILES) if (exists(path.join(current, file))) return pm;
    if (current === top) break;
    const parent = path.dirname(current);
    if (parent === current || !parent.startsWith(top)) break;
    current = parent;
  }
  for (const d of [path.resolve(root, dir), top]) {
    const field = readJson(path.join(d, "package.json"))?.packageManager;
    if (typeof field === "string") {
      const name = field.split("@")[0];
      if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") return name;
    }
  }
  return "npm";
}

const INSTALL_HINT: Record<string, string> = {
  pnpm: "corepack enable pnpm (or npm i -g pnpm)",
  yarn: "corepack enable yarn",
  npm: "install Node.js from https://nodejs.org",
  bun: "install Bun from https://bun.sh",
  deno: "install Deno from https://deno.com",
  python3: "install Python 3 (brew install python)",
  uv: "install uv (brew install uv)",
  poetry: "install Poetry (pipx install poetry)",
  pipenv: "install Pipenv (brew install pipenv)",
  docker: "install Docker Desktop (or OrbStack) and start it",
  air: "go install github.com/air-verse/air@latest",
  go: "install Go (brew install go)",
  hugo: "install Hugo (brew install hugo)",
  bundle: "install Ruby and Bundler (gem install bundler)",
};

export function runScript(pm: PackageManager, script: string, extra = ""): string {
  const args = extra.length > 0 ? (pm === "npm" ? ` -- ${extra}` : ` ${extra}`) : "";
  return `${pm} run ${script}${args}`;
}

// ---------------------------------------------------------------- frameworks

interface Framework {
  framework: string;
  title: string;
  port?: number;
  hmr: boolean;
  /** Score adjustment (a production server, a runner of every app …). */
  bonus: number;
}

const NOT_A_SERVER =
  /^(?:(?:npx|pnpm exec|yarn|bunx)\s+)?(?:tsc|tsup|tsdown|rollup|babel|esbuild|swc|unbuild|microbundle|pkgroll|jest|vitest|mocha|ava|eslint|prettier|biome|changeset|lint-staged|husky|typedoc|prisma|drizzle-kit)\b/;

function fromDeps(deps: Record<string, unknown>): Framework | undefined {
  const has = (name: string): boolean => name in deps;
  if (has("next")) return { framework: "next", title: "Next.js", port: 3000, hmr: true, bonus: 3 };
  if (has("nuxt") || has("nuxt3")) return { framework: "nuxt", title: "Nuxt", port: 3000, hmr: true, bonus: 3 };
  if (has("astro")) return { framework: "astro", title: "Astro", port: 4321, hmr: true, bonus: 3 };
  if (has("@sveltejs/kit")) return { framework: "sveltekit", title: "SvelteKit", port: 5173, hmr: true, bonus: 3 };
  if (has("@remix-run/dev")) return { framework: "remix", title: "Remix", port: 5173, hmr: true, bonus: 3 };
  if (has("@react-router/dev")) return { framework: "react-router", title: "React Router", port: 5173, hmr: true, bonus: 3 };
  if (has("@tanstack/react-start") || has("@tanstack/start")) return { framework: "tanstack-start", title: "TanStack Start", port: 3000, hmr: true, bonus: 3 };
  if (has("@solidjs/start")) return { framework: "solid-start", title: "SolidStart", port: 3000, hmr: true, bonus: 3 };
  if (has("vite")) return { framework: "vite", title: "Vite", port: 5173, hmr: true, bonus: 3 };
  if (has("react-scripts")) return { framework: "cra", title: "Create React App", port: 3000, hmr: true, bonus: 3 };
  if (has("@angular/cli")) return { framework: "angular", title: "Angular", port: 4200, hmr: true, bonus: 3 };
  if (has("gatsby")) return { framework: "gatsby", title: "Gatsby", port: 8000, hmr: true, bonus: 3 };
  if (has("webpack-dev-server")) return { framework: "webpack", title: "webpack", port: 8080, hmr: true, bonus: 2 };
  if (has("parcel")) return { framework: "parcel", title: "Parcel", port: 1234, hmr: true, bonus: 2 };
  return undefined;
}

/** The framework a script runs; undefined = not a server (build watcher, tests, lint). */
export function frameworkOf(script: string, deps: Record<string, unknown> = {}): Framework | undefined {
  const s = script.trim().toLowerCase();
  if (s.length === 0) return undefined;
  if (/\b(turbo|nx)\b.*\b(dev|serve|start|run-many)\b|\blerna run\b|\bpnpm\b.*(-r|--recursive|--filter|-f)\b.*\bdev\b/.test(s)) {
    return { framework: "monorepo", title: "Every app (workspace runner)", hmr: true, bonus: -7 };
  }
  if (/\bstorybook\b|start-storybook/.test(s)) return { framework: "storybook", title: "Storybook", port: 6006, hmr: true, bonus: 0 };
  if (/\bnext\s+start\b/.test(s)) return { framework: "next", title: "Next.js (production)", port: 3000, hmr: false, bonus: -5 };
  if (/\bnext\b/.test(s)) return { framework: "next", title: "Next.js", port: 3000, hmr: true, bonus: 3 };
  if (/\bnuxi?\b/.test(s)) return { framework: "nuxt", title: "Nuxt", port: 3000, hmr: true, bonus: 3 };
  if (/\bastro\b/.test(s)) return { framework: "astro", title: "Astro", port: 4321, hmr: true, bonus: 3 };
  if (/\bremix\s+vite:dev\b/.test(s)) return { framework: "remix", title: "Remix", port: 5173, hmr: true, bonus: 3 };
  if (/\bremix\s+dev\b/.test(s)) return { framework: "remix", title: "Remix", port: 3000, hmr: true, bonus: 3 };
  if (/\breact-router\s+dev\b/.test(s)) return { framework: "react-router", title: "React Router", port: 5173, hmr: true, bonus: 3 };
  if (/\bexpo\s+start\b/.test(s)) return { framework: "expo", title: "Expo (web)", port: 8081, hmr: true, bonus: 3 };
  if (/\bng\s+(serve|s)\b/.test(s)) return { framework: "angular", title: "Angular", port: 4200, hmr: true, bonus: 3 };
  if (/\bvue-cli-service\s+serve\b/.test(s)) return { framework: "vue", title: "Vue CLI", port: 8080, hmr: true, bonus: 3 };
  if (/\bgatsby\s+develop\b/.test(s)) return { framework: "gatsby", title: "Gatsby", port: 8000, hmr: true, bonus: 3 };
  if (/\bdocusaurus\s+start\b/.test(s)) return { framework: "docusaurus", title: "Docusaurus", port: 3000, hmr: true, bonus: 3 };
  if (/\bvitepress\s+dev\b/.test(s)) return { framework: "vitepress", title: "VitePress", port: 5173, hmr: true, bonus: 3 };
  if (/\beleventy\b.*--serve/.test(s)) return { framework: "eleventy", title: "Eleventy", port: 8080, hmr: true, bonus: 3 };
  if (/\bsvelte-kit\s+dev\b/.test(s)) return { framework: "sveltekit", title: "SvelteKit", port: 3000, hmr: true, bonus: 3 };
  if (/\breact-scripts\s+start\b|\bcraco\s+start\b/.test(s)) return { framework: "cra", title: "Create React App", port: 3000, hmr: true, bonus: 3 };
  if (/\bwebpack(-dev-server|\s+serve)\b/.test(s)) return { framework: "webpack", title: "webpack", port: 8080, hmr: true, bonus: 2 };
  if (/\bparcel\b(?!\s+build)/.test(s)) return { framework: "parcel", title: "Parcel", port: 1234, hmr: true, bonus: 2 };
  if (/\bwrangler\s+(pages\s+)?dev\b/.test(s)) return { framework: "wrangler", title: "Cloudflare Workers", port: 8787, hmr: false, bonus: 2 };
  if (/\bvite\b(?!-)/.test(s) && !/\bvite\s+(build|preview|optimize)\b/.test(s)) {
    // Meta-frameworks on Vite keep their own name (the port is whatever the server prints).
    const meta = fromDeps(deps);
    if (meta !== undefined && ["sveltekit", "remix", "react-router", "tanstack-start", "solid-start"].includes(meta.framework)) return meta;
    return { framework: "vite", title: "Vite", port: 5173, hmr: true, bonus: 3 };
  }
  if (/\bvite\s+(build|preview)\b/.test(s)) return undefined;
  if (/\b(live-server|browser-sync)\b/.test(s)) return { framework: "static", title: "Live server", port: 8080, hmr: true, bonus: 1 };
  if (/\b(serve|http-server)\b\s/.test(s) && !/\bnpm\b/.test(s)) return { framework: "static", title: "Static server", port: s.includes("http-server") ? 8080 : 3000, hmr: false, bonus: 0 };
  if (NOT_A_SERVER.test(s) || /^(tsc|tsup|rollup|esbuild)\b.*(-w|--watch)\b/.test(s)) return undefined;
  if (/\b(concurrently|npm-run-all|run-p|run-s)\b/.test(s)) {
    const dep = fromDeps(deps);
    return dep !== undefined ? { ...dep, bonus: dep.bonus - 1 } : { framework: "node", title: "Scripts", hmr: false, bonus: -1 };
  }
  if (/\b(nodemon|ts-node-dev|tsx\s+watch|node\s+--watch|bun\s+--(hot|watch))\b/.test(s)) return { framework: "node", title: "Node server", hmr: false, bonus: 0 };
  const dep = fromDeps(deps);
  if (dep !== undefined) return dep;
  if (/\b(node|bun|deno|tsx|ts-node)\b/.test(s)) return { framework: "node", title: "Node", hmr: false, bonus: -1 };
  return { framework: "node", title: "Script", hmr: false, bonus: -2 };
}

const SCRIPT_SCORE: [string, number][] = [
  ["dev", 10],
  ["develop", 9],
  ["dev:web", 9],
  ["start:web", 8],
  ["web", 8],
  ["start", 7],
  ["serve", 6],
  ["storybook", 4],
];

// ---------------------------------------------------------------- per folder

interface DirContext {
  root: string;
  dir: string; // repo-relative ("." = root)
  abs: string;
  /** Prefix for multi-repo systems ("<repoId>/"). */
  prefix: string;
}

function relDir(ctx: DirContext): string {
  const own = ctx.dir === "." ? "" : ctx.dir;
  const joined = `${ctx.prefix}${own}`.replace(/\/+$/, "");
  return joined.length === 0 ? "." : joined;
}

function nodeModulesMissing(ctx: DirContext): boolean {
  return !isDir(path.join(ctx.abs, "node_modules")) && !isDir(path.join(ctx.root, "node_modules"));
}

function nodeCandidates(ctx: DirContext): PreviewCandidate[] {
  const pkg = readJson(path.join(ctx.abs, "package.json"));
  if (pkg === undefined) return [];
  const scripts = record(pkg.scripts);
  const deps = { ...record(pkg.dependencies), ...record(pkg.devDependencies) };
  const pm = packageManagerFor(ctx.root, ctx.dir);
  const name = typeof pkg.name === "string" ? pkg.name : undefined;
  const out: PreviewCandidate[] = [];
  const setup = nodeModulesMissing(ctx) ? `${pm} install` : undefined;
  for (const [script, base] of SCRIPT_SCORE) {
    const body = scripts[script];
    if (typeof body !== "string") continue;
    const fw = frameworkOf(body, deps);
    if (fw === undefined) continue;
    let extra = "";
    if (fw.framework === "expo" && !/--web\b/.test(body)) {
      if (!("react-native-web" in deps)) continue; // native only: nothing to show in a browser
      extra = "--web";
    }
    const dir = relDir(ctx);
    out.push({
      id: `${dir}#${script}`,
      title: fw.title,
      command: runScript(pm, script, extra),
      dir,
      framework: fw.framework,
      kind: "script",
      ...(fw.port !== undefined ? { port: fw.port } : {}),
      hmr: fw.hmr,
      reason: `package.json scripts.${script}: ${body.length > 80 ? `${body.slice(0, 77)}…` : body}`,
      score: base + fw.bonus,
      ...(name !== undefined ? { workspace: name } : {}),
      needs: pm,
      ...(setup !== undefined ? { setup } : {}),
    });
  }
  return out;
}

function denoCandidates(ctx: DirContext): PreviewCandidate[] {
  const file = ["deno.json", "deno.jsonc"].map((f) => path.join(ctx.abs, f)).find(exists);
  if (file === undefined) return [];
  const tasks = record(readJsonc(file)?.tasks);
  const out: PreviewCandidate[] = [];
  for (const [task, score] of [["dev", 10], ["start", 7]] as const) {
    const body = tasks[task];
    const text = typeof body === "string" ? body : typeof record(body).command === "string" ? String(record(body).command) : undefined;
    if (text === undefined) continue;
    const fresh = /\bfresh\b|dev\.ts/.test(text);
    const dir = relDir(ctx);
    out.push({
      id: `${dir}#deno-${task}`,
      title: fresh ? "Fresh (Deno)" : "Deno",
      command: `deno task ${task}`,
      dir,
      framework: "deno",
      kind: "deno",
      port: 8000,
      hmr: fresh,
      reason: `${path.basename(file)} tasks.${task}`,
      score: score + (fresh ? 3 : 0),
      needs: "deno",
    });
  }
  return out;
}

function pythonInterpreter(ctx: DirContext): { cmd: string; needs?: string } {
  for (const base of [ctx.abs, path.resolve(ctx.root)]) {
    for (const venv of [".venv", "venv", "env"]) {
      const py = path.join(base, venv, process.platform === "win32" ? "Scripts" : "bin", "python");
      if (exists(py)) {
        const rel = path.relative(ctx.abs, py).split(path.sep).join("/");
        return { cmd: rel.startsWith("./") || rel.startsWith("../") ? rel : `./${rel}` };
      }
    }
  }
  const up = [ctx.abs, path.resolve(ctx.root)];
  if (up.some((d) => exists(path.join(d, "uv.lock")))) return { cmd: "uv run python", needs: "uv" };
  if (up.some((d) => exists(path.join(d, "poetry.lock")))) return { cmd: "poetry run python", needs: "poetry" };
  if (up.some((d) => exists(path.join(d, "Pipfile.lock")))) return { cmd: "pipenv run python", needs: "pipenv" };
  return { cmd: "python3", needs: "python3" };
}

const PY_FILES = ["app.py", "main.py", "server.py", "wsgi.py", "asgi.py", "application.py", "run.py", "api.py", "app/__init__.py", "app/main.py", "src/app.py", "src/main.py", "api/main.py"];

function pythonCandidates(ctx: DirContext): PreviewCandidate[] {
  const out: PreviewCandidate[] = [];
  const dir = relDir(ctx);
  const hasPyProject = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "manage.py", ...PY_FILES].some((f) => exists(path.join(ctx.abs, f)));
  if (!hasPyProject) return out;
  const py = pythonInterpreter(ctx);
  const needs = py.needs !== undefined ? { needs: py.needs } : {};
  if (exists(path.join(ctx.abs, "manage.py"))) {
    out.push({ id: `${dir}#django`, title: "Django", command: `${py.cmd} manage.py runserver 127.0.0.1:{port}`, dir, framework: "django", kind: "python", port: 8000, hmr: false, reason: "manage.py", score: 9, ...needs });
  }
  let flask = false;
  let fastapi = false;
  let streamlit = false;
  for (const rel of PY_FILES) {
    const text = readText(path.join(ctx.abs, rel));
    if (text === undefined) continue;
    const module = rel.replace(/\/__init__\.py$/, "").replace(/\.py$/, "").split("/").join(".");
    const fa = /^\s*(\w+)\s*(?::\s*\w+\s*)?=\s*FastAPI\(/m.exec(text);
    if (!fastapi && fa !== null) {
      fastapi = true;
      out.push({ id: `${dir}#fastapi`, title: "FastAPI", command: `${py.cmd} -m uvicorn ${module}:${fa[1]} --reload --port {port}`, dir, framework: "fastapi", kind: "python", port: 8000, hmr: false, reason: `${rel}: ${fa[1]} = FastAPI()`, score: 8, ...needs });
    }
    const fl = /^\s*(\w+)\s*=\s*Flask\(|^\s*def\s+create_app\s*\(/m.exec(text);
    if (!flask && fl !== null && /\bflask\b/i.test(text)) {
      flask = true;
      out.push({ id: `${dir}#flask`, title: "Flask", command: `${py.cmd} -m flask --app ${module} run --debug --port {port}`, dir, framework: "flask", kind: "python", port: 5000, hmr: false, reason: `${rel}: Flask app`, score: 8, ...needs });
    }
    if (!streamlit && /^\s*import\s+streamlit\b|^\s*from\s+streamlit\b/m.test(text)) {
      streamlit = true;
      out.push({ id: `${dir}#streamlit`, title: "Streamlit", command: `${py.cmd} -m streamlit run ${rel} --server.port {port} --server.headless true`, dir, framework: "streamlit", kind: "python", port: 8501, hmr: false, reason: `${rel}: import streamlit`, score: 8, ...needs });
    }
  }
  return out;
}

function rubyCandidates(ctx: DirContext): PreviewCandidate[] {
  const gemfile = readText(path.join(ctx.abs, "Gemfile"));
  if (gemfile === undefined) return [];
  const out: PreviewCandidate[] = [];
  const dir = relDir(ctx);
  if (/^\s*gem\s+["']rails["']/m.test(gemfile) && exists(path.join(ctx.abs, "bin", "rails"))) {
    const live = /hotwire-livereload|rails_live_reload/.test(gemfile);
    if (exists(path.join(ctx.abs, "bin", "dev"))) {
      out.push({ id: `${dir}#rails-dev`, title: "Rails", command: "bin/dev", dir, framework: "rails", kind: "ruby", port: 3000, hmr: live, reason: "bin/dev", score: 10, env: { PORT: "{port}" } });
    }
    out.push({ id: `${dir}#rails`, title: "Rails", command: "bin/rails server -p {port}", dir, framework: "rails", kind: "ruby", port: 3000, hmr: live, reason: "bin/rails", score: 8 });
  }
  if (/^\s*gem\s+["']jekyll["']/m.test(gemfile) && exists(path.join(ctx.abs, "_config.yml"))) {
    out.push({ id: `${dir}#jekyll`, title: "Jekyll", command: "bundle exec jekyll serve --livereload --port {port}", dir, framework: "jekyll", kind: "ruby", port: 4000, hmr: true, reason: "Gemfile: jekyll", score: 8, needs: "bundle" });
  }
  return out;
}

function goCandidates(ctx: DirContext): PreviewCandidate[] {
  if (!exists(path.join(ctx.abs, "go.mod"))) return [];
  const dir = relDir(ctx);
  const out: PreviewCandidate[] = [];
  const air = [".air.toml", "air.toml"].find((f) => exists(path.join(ctx.abs, f)));
  if (air !== undefined) {
    out.push({ id: `${dir}#air`, title: "Go (air)", command: air === ".air.toml" ? "air" : `air -c ${air}`, dir, framework: "go", kind: "go", port: 8080, hmr: false, reason: air, score: 8, needs: "air" });
  }
  if (exists(path.join(ctx.abs, "main.go"))) {
    out.push({ id: `${dir}#go-run`, title: "Go", command: "go run .", dir, framework: "go", kind: "go", port: 8080, hmr: false, reason: "main.go", score: 4, needs: "go" });
  }
  return out;
}

function hugoCandidates(ctx: DirContext): PreviewCandidate[] {
  const dir = relDir(ctx);
  const own = ["hugo.toml", "hugo.yaml", "hugo.json"].find((f) => exists(path.join(ctx.abs, f)));
  const legacy = own === undefined && exists(path.join(ctx.abs, "config.toml")) && isDir(path.join(ctx.abs, "content")) && /baseURL/i.test(readText(path.join(ctx.abs, "config.toml")) ?? "");
  if (own === undefined && !legacy) return [];
  return [{ id: `${dir}#hugo`, title: "Hugo", command: "hugo server --port {port}", dir, framework: "hugo", kind: "go", port: 1313, hmr: true, reason: own ?? "config.toml + content/", score: 9, needs: "hugo" }];
}

/** Host ports a compose file publishes, best service (web, app, frontend …) first. */
export function composePorts(doc: YamlValue): number[] {
  const services = yamlGet(doc, "services");
  const preferred = /^(web|app|frontend|ui|site|client|nginx|caddy|proxy)$/i;
  const ranked = yamlKeys(services).sort((a, b) => Number(preferred.test(b)) - Number(preferred.test(a)));
  const ports: number[] = [];
  for (const name of ranked) {
    for (const entry of yamlList(yamlGet(yamlGet(services, name), "ports"))) {
      const published = yamlString(yamlGet(entry, "published"));
      if (published !== undefined) {
        const n = Number.parseInt(published, 10);
        if (Number.isInteger(n)) ports.push(n);
        continue;
      }
      const text = yamlString(entry);
      if (text === undefined) continue;
      const parts = text.replace(/\/(tcp|udp)$/, "").split(":");
      if (parts.length < 2) continue; // container port only: a random host port
      const host = Number.parseInt(parts[parts.length - 2] ?? "", 10);
      if (Number.isInteger(host) && host > 0) ports.push(host);
    }
  }
  return ports;
}

function composeCandidates(ctx: DirContext): PreviewCandidate[] {
  const file = COMPOSE_FILES.find((f) => exists(path.join(ctx.abs, f)));
  if (file === undefined) return [];
  const text = readText(path.join(ctx.abs, file), 256 * 1024);
  const ports = text !== undefined ? composePorts(parseYaml(text)) : [];
  const dir = relDir(ctx);
  const watch = text !== undefined && /^\s+develop:\s*$/m.test(text);
  return [
    {
      id: `${dir}#compose`,
      title: "Docker Compose",
      command: watch ? "docker compose up --watch" : "docker compose up",
      dir,
      framework: "compose",
      kind: "compose",
      ...(ports[0] !== undefined ? { port: ports[0] } : {}),
      hmr: false,
      reason: file,
      score: ports.length > 0 ? 5 : 2,
      needs: "docker",
    },
  ];
}

function staticCandidate(ctx: DirContext, sub = ""): PreviewCandidate | undefined {
  const folder = sub === "" ? ctx.abs : path.join(ctx.abs, sub);
  if (!exists(path.join(folder, "index.html"))) return undefined;
  const own = relDir(ctx);
  const dir = sub === "" ? own : own === "." ? sub : `${own}/${sub}`;
  return {
    id: `${dir}#static`,
    title: "Static site",
    command: "built-in static server",
    dir,
    framework: "static",
    kind: "static",
    port: 4800,
    hmr: true,
    reason: `${sub === "" ? "" : `${sub}/`}index.html`,
    score: ctx.dir === "." && sub === "" ? 5 : 3,
  };
}

function candidatesIn(ctx: DirContext): PreviewCandidate[] {
  const out = [...nodeCandidates(ctx), ...denoCandidates(ctx), ...pythonCandidates(ctx), ...rubyCandidates(ctx), ...goCandidates(ctx), ...hugoCandidates(ctx), ...composeCandidates(ctx)];
  const hasPackage = exists(path.join(ctx.abs, "package.json"));
  if (!hasPackage) {
    const own = staticCandidate(ctx);
    if (own !== undefined) out.push(own);
    else if (ctx.dir === "." && out.length === 0) {
      for (const sub of ["public", "docs", "site", "www"]) {
        const hit = staticCandidate(ctx, sub);
        if (hit !== undefined) {
          out.push(hit);
          break;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- detection

export function customCandidate(choice: Pick<PreviewFile, "command" | "dir">, reason = ".ruah/preview.json"): PreviewCandidate {
  return {
    id: "custom",
    title: "Your command",
    command: choice.command ?? "",
    dir: choice.dir ?? ".",
    framework: "custom",
    kind: "custom",
    hmr: false,
    reason,
    score: 100,
  };
}

/** Picks what a start without arguments runs, or null when the user should choose. */
export function selectCandidate(candidates: readonly PreviewCandidate[], choice: PreviewFile | null): string | null {
  if (choice?.command !== undefined) return "custom";
  if (choice?.candidate !== undefined && candidates.some((c) => c.id === choice.candidate)) return choice.candidate;
  const runnable = candidates.filter((c) => c.kind !== "custom");
  if (runnable.length === 0) return null;
  const best = new Map<string, PreviewCandidate>();
  for (const c of runnable) {
    const prev = best.get(c.dir);
    if (prev === undefined || c.score > prev.score) best.set(c.dir, c);
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  if (first === undefined) return null;
  if (second === undefined || first.score - second.score >= 5) return first.id;
  return null;
}

export function detectPreview(root: string, options: DetectOptions = {}): PreviewDetection {
  const absRoot = path.resolve(root);
  const roots: { root: string; prefix: string }[] = [{ root: absRoot, prefix: "" }];
  for (const repo of options.repos ?? []) roots.push({ root: path.resolve(repo.root), prefix: `${repo.id}/` });
  const candidates: PreviewCandidate[] = [];
  let truncated = false;
  for (const r of roots) {
    const { dirs, truncated: t } = candidateDirs(r.root, options.maxDirs ?? 150);
    truncated ||= t;
    for (const dir of dirs) candidates.push(...candidatesIn({ root: r.root, dir, abs: path.join(r.root, dir), prefix: r.prefix }));
  }
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  for (const c of unique) {
    if (c.needs === undefined) continue;
    c.available = onPath(c.needs, options.pathEnv);
    if (!c.available && INSTALL_HINT[c.needs] !== undefined) c.install = INSTALL_HINT[c.needs];
  }
  const read = readPreviewFile(absRoot);
  const local = options.localChoiceFile !== undefined ? readLocalPreviewFile(options.localChoiceFile) : null;
  const choice = local ?? read.config;
  const choiceFrom = local !== null ? ("local" as const) : read.config !== null ? ("repo" as const) : undefined;
  if (choice?.command !== undefined) unique.unshift(customCandidate(choice, choiceFrom === "local" ? "saved on this computer" : ".ruah/preview.json"));
  unique.sort((a, b) => b.score - a.score || (a.dir === b.dir ? 0 : a.dir === "." ? -1 : b.dir === "." ? 1 : a.dir.localeCompare(b.dir)) || a.id.localeCompare(b.id));
  const dirs = new Set(unique.filter((c) => c.kind !== "custom").map((c) => c.dir));
  const pkgRoot = exists(path.join(absRoot, "package.json"));
  return {
    root: absRoot,
    candidates: unique,
    monorepo: dirs.size > 1,
    ...(pkgRoot ? { packageManager: packageManagerFor(absRoot, ".") } : {}),
    selected: selectCandidate(unique, choice),
    choice,
    ...(choiceFrom !== undefined ? { choiceFrom } : {}),
    ...(read.error !== undefined ? { configError: read.error } : {}),
    truncated,
  };
}
