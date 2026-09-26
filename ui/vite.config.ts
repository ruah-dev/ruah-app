// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// One id per `vite build` (src/lib/build-reload.ts): the prerendered index.html carries it as
// <meta name="ruah-build">, the daemon reports it (GET /api/health `viewerBuild`) and a window
// running an older build reloads. Same id for the client and the prerender (one config load).
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default defineConfig({
  vite: { define: { "import.meta.env.VITE_RUAH_BUILD_ID": JSON.stringify(BUILD_ID) } },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // L6: static single-page build (.output/public/index.html + assets/) that any file
    // server can host; the ruah daemon serves it with `ruah app serve --viewer <dir>`.
    spa: { enabled: true, prerender: { outputPath: "/index.html" } },
  },
});
