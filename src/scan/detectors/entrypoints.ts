// Entrypoint + framework detector (PLAN.md Phase 2, task 2.2).
//
// From a package's manifest dependencies and its files, decides the node
// `type` (frontend | service | module), a short `tech` list in a fixed
// priority order, and the entry files (manifest `main`/`bin`, conventional
// `src/index|main|app|server.*`, `main.go`, `src/main.rs`, `__main__.py`, …).
import type { NodeType } from "../../contracts/architecture.js";
import type { DepRef, PackageInfo } from "../types.js";

interface Framework {
  deps: string[]; // any of these (exact name, or prefix when ending in "/")
  tech: string;
  kind: "frontend" | "service" | "tech";
  versioned?: boolean; // append the major version: "React 19"
}

// Priority order: earlier entries appear first in `tech`.
const FRAMEWORKS: Framework[] = [
  { deps: ["next"], tech: "Next.js", kind: "frontend", versioned: true },
  { deps: ["@tanstack/react-start", "@tanstack/start"], tech: "TanStack Start", kind: "frontend" },
  { deps: ["@remix-run/react", "@remix-run/node", "react-router-dom", "@react-router/dev"], tech: "React Router", kind: "frontend" },
  { deps: ["nuxt"], tech: "Nuxt", kind: "frontend" },
  { deps: ["@sveltejs/kit"], tech: "SvelteKit", kind: "frontend" },
  { deps: ["astro"], tech: "Astro", kind: "frontend" },
  { deps: ["@angular/core"], tech: "Angular", kind: "frontend" },
  { deps: ["expo"], tech: "Expo", kind: "frontend" },
  { deps: ["react-native"], tech: "React Native", kind: "frontend" },
  { deps: ["electron"], tech: "Electron", kind: "frontend" },
  { deps: ["@tauri-apps/api", "tauri"], tech: "Tauri", kind: "frontend" },
  { deps: ["react"], tech: "React", kind: "tech", versioned: true },
  { deps: ["vue"], tech: "Vue", kind: "frontend", versioned: true },
  { deps: ["svelte"], tech: "Svelte", kind: "frontend" },
  { deps: ["solid-js"], tech: "Solid", kind: "frontend" },
  { deps: ["@tanstack/react-router"], tech: "TanStack Router", kind: "tech" },
  { deps: ["@nestjs/core"], tech: "NestJS", kind: "service" },
  { deps: ["express"], tech: "Express", kind: "service", versioned: true },
  { deps: ["fastify"], tech: "Fastify", kind: "service" },
  { deps: ["koa"], tech: "Koa", kind: "service" },
  { deps: ["hono"], tech: "Hono", kind: "service" },
  { deps: ["elysia"], tech: "Elysia", kind: "service" },
  { deps: ["@trpc/server"], tech: "tRPC", kind: "tech" },
  { deps: ["graphql", "@apollo/server"], tech: "GraphQL", kind: "tech" },
  { deps: ["effect"], tech: "Effect", kind: "tech" },
  { deps: ["@prisma/client", "prisma"], tech: "Prisma", kind: "tech" },
  { deps: ["drizzle-orm"], tech: "Drizzle", kind: "tech" },
  { deps: ["tailwindcss"], tech: "Tailwind", kind: "tech" },
  { deps: ["zod"], tech: "Zod", kind: "tech" },
  // Python
  { deps: ["fastapi"], tech: "FastAPI", kind: "service" },
  { deps: ["django"], tech: "Django", kind: "service" },
  { deps: ["flask"], tech: "Flask", kind: "service" },
  { deps: ["starlette"], tech: "Starlette", kind: "service" },
  { deps: ["celery"], tech: "Celery", kind: "service" },
  { deps: ["streamlit"], tech: "Streamlit", kind: "frontend" },
  { deps: ["sqlalchemy"], tech: "SQLAlchemy", kind: "tech" },
  { deps: ["pydantic"], tech: "Pydantic", kind: "tech" },
  // Go
  { deps: ["github.com/gin-gonic/gin"], tech: "Gin", kind: "service" },
  { deps: ["github.com/labstack/echo/v4", "github.com/labstack/echo"], tech: "Echo", kind: "service" },
  { deps: ["github.com/gofiber/fiber/v2", "github.com/gofiber/fiber/v3"], tech: "Fiber", kind: "service" },
  { deps: ["github.com/go-chi/chi/v5", "github.com/go-chi/chi"], tech: "chi", kind: "service" },
  // Rust
  { deps: ["axum"], tech: "Axum", kind: "service" },
  { deps: ["actix-web"], tech: "Actix Web", kind: "service" },
  { deps: ["rocket"], tech: "Rocket", kind: "service" },
  { deps: ["tokio"], tech: "Tokio", kind: "tech" },
  // JVM
  { deps: ["spring-boot-starter-web", "spring-boot-starter-webflux"], tech: "Spring Boot", kind: "service" },
];

const LANGUAGE_TECH: Record<PackageInfo["language"], string | null> = {
  js: null, // decided below: TypeScript vs Node
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "JVM",
  unknown: null,
};

const MAX_TECH = 5;

function matches(dep: DepRef, names: string[]): boolean {
  return names.some((n) => (n.endsWith("/") ? dep.name.startsWith(n) : dep.name === n));
}

function major(version: string | undefined): string | null {
  if (version === undefined) return null;
  const m = /^[\^~>=v\s]*(\d+)(?:\.|$|\s)/.exec(version);
  return m?.[1] ?? null;
}

export interface Classification {
  type: NodeType;
  tech: string[];
  entryFiles: string[]; // repo-relative, existing, most relevant first
}

const ENTRY_BASENAMES = [
  "index", "main", "app", "server", "App", "entry", "entrypoint", "bin", "cli", "start", "worker", "__main__",
  "manage", "wsgi", "asgi", "lib", "mod",
];
const ENTRY_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt)$/;

// `pkgFiles` are the package's files relative to the repo root, sorted.
export function classify(pkg: PackageInfo, pkgFiles: string[]): Classification {
  const runtime = pkg.deps.filter((d) => !d.dev);
  const tech: string[] = [];
  let frontend = false;
  let service = false;
  for (const fw of FRAMEWORKS) {
    const hit = pkg.deps.find((d) => matches(d, fw.deps));
    if (hit === undefined) continue;
    // Dev-only framework deps still count for build tools (vite) and UI kits
    // bundled at build time, but never make a package a server.
    if (fw.kind === "service" && hit.dev) continue;
    const v = fw.versioned === true ? major(hit.version) : null;
    const label = v !== null ? `${fw.tech} ${v}` : fw.tech;
    if (!tech.includes(label)) tech.push(label);
    if (fw.kind === "frontend") frontend = true;
    if (fw.kind === "service") service = true;
  }
  const rel = (f: string): string => (pkg.dir === "" ? f : f.slice(pkg.dir.length + 1));
  const has = (re: RegExp): boolean => pkgFiles.some((f) => re.test(rel(f)));
  const langTech = LANGUAGE_TECH[pkg.language];
  if (pkg.language === "js") {
    tech.unshift(has(/\.(ts|tsx|mts|cts)$/) ? "TypeScript" : "JavaScript");
  } else if (langTech !== null) {
    tech.unshift(langTech);
  }
  // React alone (no framework, no bundler) is a component library; with a
  // bundler or an index.html it is an app.
  const react = pkg.deps.some((d) => d.name === "react" || d.name === "react-dom");
  const bundler = pkg.deps.some((d) => ["vite", "vite-plus", "webpack", "parcel", "@rsbuild/core"].includes(d.name));
  if (!frontend && react && (bundler || has(/^(index\.html|public\/index\.html)$/))) frontend = true;
  if (!frontend && (runtime.some((d) => d.name === "vue") || bundler) && has(/^index\.html$/)) frontend = true;
  if (has(/^wrangler\.(toml|json|jsonc)$/)) {
    tech.splice(1, 0, "Cloudflare Workers");
    service = true;
  }
  // Vite counts as tech only where it builds something (a config or an app),
  // not when it arrives as a test-runner dependency.
  if (pkg.deps.some((d) => d.name === "vite" || d.name === "vite-plus") && (frontend || has(/^vite\.config\.[cm]?[jt]s$/))) {
    tech.push("Vite");
  }
  if (has(/(^|\/)Dockerfile(\.[\w-]+)?$/)) tech.push("Docker");


  const hasStart = pkg.scripts["start"] !== undefined || pkg.scripts["serve"] !== undefined;
  const goMain = pkg.language === "go" && has(/(^|\/)main\.go$/);
  const rustBin = pkg.language === "rust" && has(/^src\/main\.rs$/);
  const pyMain = pkg.language === "python" && has(/(^|\/)(__main__|manage|wsgi|asgi)\.py$/);

  let type: NodeType;
  if (service) type = "service";
  else if (frontend) type = "frontend";
  else if (goMain || rustBin || pyMain || hasStart) type = "service";
  else type = "module";

  return { type, tech: tech.slice(0, MAX_TECH), entryFiles: entryFiles(pkg, pkgFiles) };
}

export function entryFiles(pkg: PackageInfo, pkgFiles: string[]): string[] {
  const set = new Set(pkgFiles);
  const out: string[] = [];
  const add = (f: string): void => {
    if (set.has(f) && !out.includes(f) && !isTestFile(f)) out.push(f);
  };
  for (const h of pkg.entryHints) {
    add(h);
    // Build output hints (dist/index.js) → try the source twin.
    const src = h.replace(/(^|\/)(dist|build|lib|out)\//, "$1src/").replace(/\.(c|m)?js$/, "");
    for (const ext of [".ts", ".tsx", ".js", ".mts"]) add(`${src}${ext}`);
  }
  const prefix = pkg.dir === "" ? "" : `${pkg.dir}/`;
  for (const base of ENTRY_BASENAMES) {
    for (const f of pkgFiles) {
      const r = f.slice(prefix.length);
      const m = /^(?:src\/|app\/|cmd\/[^/]+\/|[a-z_][a-z0-9_]*\/)?([^/]+)$/.exec(r);
      if (m === null) continue;
      const file = m[1] ?? "";
      if (!ENTRY_EXT.test(file)) continue;
      if (file.replace(ENTRY_EXT, "") !== base) continue;
      // Only the package root, src/, app/, cmd/*/ and a python package dir.
      const dirPart = r.slice(0, r.length - file.length);
      if (dirPart !== "" && dirPart !== "src/" && dirPart !== "app/" && !dirPart.startsWith("cmd/")) {
        if (!(pkg.language === "python" && /^[a-z_][a-z0-9_]*\/$/.test(dirPart))) continue;
      }
      add(f);
    }
  }
  return out.slice(0, 6);
}

export function isTestFile(f: string): boolean {
  return (
    /\.(test|spec|bench|stories|e2e)\.[a-z]+$/.test(f) ||
    /(^|\/)(__tests__|__mocks__|tests?|testing|testUtils|test-utils|fixtures|e2e|__snapshots__|__screenshots__)\//.test(f) ||
    /(^|\/)(test_[^/]+|[^/]+_test)\.(py|go)$/.test(f) ||
    /(^|\/)conftest\.py$/.test(f)
  );
}
