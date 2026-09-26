// src/projects/templates/node.ts — "Node API (TypeScript)" and "Monorepo (pnpm workspaces)".
import { dedent, gitignore, json, jsString, type ProjectTemplate } from "./types.js";

const NODE_TYPES = "^22.20.3";
const TSX = "^4.23.13";
const TYPESCRIPT = "^5.8.3";

export const nodeApiTemplate: ProjectTemplate = {
  id: "node-api-ts",
  name: "Node API (TypeScript)",
  description: "An HTTP API on Node 22's built-in http module: a tiny router, tests with node:test, no framework.",
  run: "pnpm install && pnpm dev",
  setupPrompt:
    "Set up the project: install the dependencies with pnpm, run the tests, start the API and call /health, then ask me which endpoints we need and propose the route layout.",
  scan: true,
  files: ({ name, slug }) => ({
    "package.json": json({
      name: slug,
      private: true,
      version: "0.1.0",
      type: "module",
      engines: { node: ">=22" },
      scripts: {
        dev: "tsx watch src/server.ts",
        build: "tsc -p tsconfig.json",
        start: "node dist/server.js",
        test: "tsx --test test/*.test.ts",
        typecheck: "tsc --noEmit",
      },
      devDependencies: { "@types/node": NODE_TYPES, tsx: TSX, typescript: TYPESCRIPT },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        outDir: "dist",
        rootDir: "src",
        types: ["node"],
        skipLibCheck: true,
      },
      include: ["src"],
    }),
    ".nvmrc": "22\n",
    ".env.example": dedent(`
      # Copy to .env (never committed) and adjust.
      PORT=3000
    `),
    "src/server.ts": dedent(`
      // Entry point: an HTTP server around the router in app.ts.
      import { createServer } from "node:http";
      import { handle } from "./app.js";

      const port = Number(process.env.PORT ?? 3000);

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", \`http://\${req.headers.host ?? "localhost"}\`);
        const result = await handle({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams });
        res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result.body));
      });

      server.listen(port, () => {
        console.log(\`${slug} listening on http://localhost:\${port}\`);
      });
    `),
    "src/app.ts": dedent(`
      // The router: pure functions from a request to a response, easy to test.
      import { health } from "./routes/health.js";
      import { hello } from "./routes/hello.js";

      export interface Request {
        method: string;
        path: string;
        query: URLSearchParams;
      }

      export interface Response {
        status: number;
        body: unknown;
      }

      type Route = (req: Request) => Response | Promise<Response>;

      const routes: Record<string, Route> = {
        "GET /health": health,
        "GET /api/hello": hello,
      };

      export async function handle(req: Request): Promise<Response> {
        const route = routes[\`\${req.method} \${req.path}\`];
        if (!route) return { status: 404, body: { error: "not found" } };
        try {
          return await route(req);
        } catch (err) {
          console.error(err);
          return { status: 500, body: { error: "internal error" } };
        }
      }
    `),
    "src/routes/health.ts": dedent(`
      import type { Response } from "../app.js";

      const started = Date.now();

      export function health(): Response {
        return { status: 200, body: { ok: true, service: ${jsString(slug)}, uptimeMs: Date.now() - started } };
      }
    `),
    "src/routes/hello.ts": dedent(`
      import type { Request, Response } from "../app.js";

      export function hello(req: Request): Response {
        const name = req.query.get("name")?.trim() || "world";
        return { status: 200, body: { message: \`Hello, \${name}!\` } };
      }
    `),
    "test/app.test.ts": dedent(`
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { handle } from "../src/app.js";

      const get = (path: string, query = "") => handle({ method: "GET", path, query: new URLSearchParams(query) });

      test("GET /health answers ok", async () => {
        const res = await get("/health");
        assert.equal(res.status, 200);
        assert.equal((res.body as { ok: boolean }).ok, true);
      });

      test("GET /api/hello greets by name", async () => {
        const res = await get("/api/hello", "name=Ada");
        assert.deepEqual(res.body, { message: "Hello, Ada!" });
      });

      test("unknown routes are 404", async () => {
        assert.equal((await get("/nope")).status, 404);
      });
    `),
    "README.md": dedent(`
      # ${name}

      An HTTP API on Node 22 (\`node:http\`, no framework) in strict TypeScript.

      \`\`\`sh
      pnpm install
      pnpm dev        # http://localhost:3000/health (restarts on save)
      pnpm test       # node:test via tsx
      pnpm build && pnpm start
      \`\`\`

      - \`src/server.ts\` — the HTTP server
      - \`src/app.ts\` — the router (pure, tested in \`test/\`)
      - \`src/routes/\` — one file per route
    `),
    ".gitignore": gitignore(["dist/", "coverage/"]),
  }),
};

export const monorepoTemplate: ProjectTemplate = {
  id: "pnpm-monorepo",
  name: "Monorepo (pnpm workspaces)",
  description: "pnpm workspaces with an API app and a shared TypeScript package, one tsconfig base.",
  run: "pnpm install && pnpm dev",
  setupPrompt:
    "Set up the project: install with pnpm, build the workspace (`pnpm -r build`), start the API app, then ask me which apps and packages we need and propose how to split them.",
  scan: true,
  files: ({ name, slug }) => {
    const shared = `@${slug}/shared`;
    const api = `@${slug}/api`;
    return {
      "package.json": json({
        name: slug,
        private: true,
        version: "0.1.0",
        type: "module",
        engines: { node: ">=22" },
        scripts: {
          build: "pnpm -r build",
          dev: `pnpm --filter ${shared} build && pnpm --filter ${api} dev`,
          test: "pnpm -r test",
          typecheck: "pnpm -r typecheck",
        },
        devDependencies: { "@types/node": NODE_TYPES, tsx: TSX, typescript: TYPESCRIPT },
      }),
      "pnpm-workspace.yaml": dedent(`
        packages:
          - "apps/*"
          - "packages/*"
      `),
      "tsconfig.base.json": json({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          declaration: true,
          skipLibCheck: true,
          types: ["node"],
        },
      }),
      ".nvmrc": "22\n",
      "packages/shared/package.json": json({
        name: shared,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "dist/index.js",
        types: "dist/index.d.ts",
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        scripts: { build: "tsc -p tsconfig.json", typecheck: "tsc --noEmit", test: "tsx --test test/*.test.ts" },
      }),
      "packages/shared/tsconfig.json": json({ extends: "../../tsconfig.base.json", compilerOptions: { outDir: "dist", rootDir: "src" }, include: ["src"] }),
      "packages/shared/src/index.ts": dedent(`
        // Code shared by every app in the workspace.
        export function greet(name: string): string {
          return \`Hello, \${name.trim() || "world"}!\`;
        }

        export const PROJECT = ${jsString(name)};
      `),
      "packages/shared/test/greet.test.ts": dedent(`
        import { test } from "node:test";
        import assert from "node:assert/strict";
        import { greet } from "../src/index.js";

        test("greet", () => {
          assert.equal(greet("Ada"), "Hello, Ada!");
          assert.equal(greet("  "), "Hello, world!");
        });
      `),
      "apps/api/package.json": json({
        name: api,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "tsx watch src/server.ts",
          build: "tsc -p tsconfig.json",
          start: "node dist/server.js",
          typecheck: "tsc --noEmit",
        },
        dependencies: { [shared]: "workspace:*" },
      }),
      "apps/api/tsconfig.json": json({ extends: "../../tsconfig.base.json", compilerOptions: { outDir: "dist", rootDir: "src" }, include: ["src"] }),
      "apps/api/src/server.ts": dedent(`
        import { createServer } from "node:http";
        import { greet, PROJECT } from ${jsString(shared)};

        const port = Number(process.env.PORT ?? 3000);

        createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, project: PROJECT }));
            return;
          }
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(greet(url.searchParams.get("name") ?? ""));
        }).listen(port, () => console.log(\`api listening on http://localhost:\${port}\`));
      `),
      "README.md": dedent(`
        # ${name}

        A pnpm workspace:

        | Folder | Package | What |
        | --- | --- | --- |
        | \`apps/api\` | \`${api}\` | HTTP API (Node 22) |
        | \`packages/shared\` | \`${shared}\` | code shared by the apps |

        \`\`\`sh
        pnpm install
        pnpm -r build   # shared first, then the apps
        pnpm dev        # the API on http://localhost:3000
        pnpm test
        \`\`\`

        Add an app under \`apps/\` or a package under \`packages/\`; depend on another with \`"workspace:*"\`.
      `),
      ".gitignore": gitignore(["dist/", "coverage/", "*.tsbuildinfo"]),
    };
  },
};
