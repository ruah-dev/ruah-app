// src/projects/templates/web.ts — "Web app (Vite + React + TS)".
import { dedent, escapeHtml, gitignore, json, jsString, type ProjectTemplate } from "./types.js";

export const webViteReactTemplate: ProjectTemplate = {
  id: "web-vite-react",
  name: "Web app (Vite + React + TS)",
  description: "A React 19 single-page app with Vite and strict TypeScript. Install once, then `pnpm dev`.",
  run: "pnpm install && pnpm dev",
  setupPrompt:
    "Set up the project: install the dependencies with pnpm, make sure `pnpm build` passes, start the dev server, then walk me through the structure and ask what the app should do.",
  scan: true,
  files: ({ name, slug }) => ({
    "package.json": json({
      name: slug,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc --noEmit && vite build",
        preview: "vite preview",
        typecheck: "tsc --noEmit",
      },
      dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
      devDependencies: {
        "@types/react": "^19.2.0",
        "@types/react-dom": "^19.2.0",
        "@vitejs/plugin-react": "^5.2.0",
        typescript: "^5.8.3",
        vite: "^8.1.5",
      },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        isolatedModules: true,
        skipLibCheck: true,
        types: ["vite/client"],
      },
      include: ["src", "vite.config.ts"],
    }),
    "vite.config.ts": dedent(`
      import { defineConfig } from "vite";
      import react from "@vitejs/plugin-react";

      export default defineConfig({
        plugins: [react()],
      });
    `),
    "index.html": dedent(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <title>${escapeHtml(name)}</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/src/main.tsx"></script>
        </body>
      </html>
    `),
    "public/favicon.svg": dedent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#137164"/><circle cx="16" cy="16" r="6" fill="none" stroke="#fff" stroke-width="2.5"/></svg>
    `),
    "src/main.tsx": dedent(`
      import { StrictMode } from "react";
      import { createRoot } from "react-dom/client";
      import { App } from "./App";
      import "./index.css";

      const root = document.getElementById("root");
      if (!root) throw new Error("#root is missing from index.html");

      createRoot(root).render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    `),
    "src/App.tsx": dedent(`
      import { useState } from "react";
      import { Counter } from "./components/Counter";

      const TITLE = ${jsString(name)};

      export function App() {
        const [visits] = useState(() => new Date().toLocaleDateString());
        return (
          <main className="app">
            <h1>{TITLE}</h1>
            <p className="muted">Vite + React + TypeScript — edit <code>src/App.tsx</code> and save.</p>
            <Counter />
            <p className="muted small">Opened {visits}</p>
          </main>
        );
      }
    `),
    "src/components/Counter.tsx": dedent(`
      import { useState } from "react";

      export function Counter() {
        const [count, setCount] = useState(0);
        return (
          <button type="button" className="counter" onClick={() => setCount((c) => c + 1)}>
            Clicked {count} {count === 1 ? "time" : "times"}
          </button>
        );
      }
    `),
    "src/index.css": dedent(`
      :root {
        color-scheme: light dark;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        line-height: 1.5;
        --accent: #137164;
      }
      @media (prefers-color-scheme: dark) {
        :root { --accent: #00d2b9; }
      }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      .app { max-width: 40rem; padding: 2rem; text-align: center; }
      .muted { opacity: 0.7; }
      .small { font-size: 0.875rem; }
      .counter { font: inherit; padding: 0.6rem 1.2rem; border-radius: 0.6rem; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; }
    `),
    "README.md": dedent(`
      # ${name}

      React 19 + Vite + strict TypeScript.

      \`\`\`sh
      pnpm install
      pnpm dev        # http://localhost:5173
      pnpm build      # type-check + production build into dist/
      \`\`\`

      - \`src/main.tsx\` — entry
      - \`src/App.tsx\` — the app
      - \`src/components/\` — components
    `),
    ".gitignore": gitignore(["dist/", "*.local", ".vite/"]),
  }),
};
