// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

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
  vite: devServer,
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // L6: static single-page build (.output/public/index.html + assets/) that any file
    // server can host; the ruah daemon serves it with `ruah app serve --viewer <dir>`.
    spa: { enabled: true, prerender: { outputPath: "/index.html" } },
  },
});
