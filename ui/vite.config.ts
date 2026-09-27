// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { readFileSync } from "node:fs";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// The app version lives in the repo root package.json; Lovable builds ui/ alone, so fall back.
let APP_VERSION = "dev";
try {
  APP_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
} catch {}

// One id per `vite build` (src/lib/build-reload.ts): the prerendered index.html carries it as
// <meta name="ruah-build">, the daemon reports it (GET /api/health `viewerBuild`) and a window
// running an older build reloads. Same id for the client and the prerender (one config load).
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Developing Ruah (`pnpm dev`, scripts/dev.ts): the daemon runs separately under a watcher;
// the dev server proxies its HTTP API and WebSockets so the viewer stays same-origin (the
// terminal token needs that, CONTRACTS §7.1). Unset (Lovable, `vite build`): no proxy.
const daemon = process.env["RUAH_DEV_DAEMON_URL"];
const devServer = daemon
  ? {
      server: {
        proxy: {
          "/api": { target: daemon },
          "^/ws(/|$)": { target: daemon.replace(/^http/, "ws"), ws: true },
        },
      },
    }
  : {};

export default defineConfig({
  vite: {
    ...devServer,
    define: {
      "import.meta.env.VITE_RUAH_BUILD_ID": JSON.stringify(BUILD_ID),
      "import.meta.env.VITE_RUAH_VERSION": JSON.stringify(APP_VERSION),
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // L6: static single-page build (.output/public/index.html + assets/) that any file
    // server can host; the ruah daemon serves it with `ruah app serve --viewer <dir>`.
    spa: { enabled: true, prerender: { outputPath: "/index.html" } },
  },
});
