// src/serve/static.ts — SPA static serving with a small mime map, immutable
// /assets/* caching, extension-less SPA fallback, and a fallback page when no
// viewer directory exists. No framework.
import * as fs from "node:fs";
import * as path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const NO_VIEWER_PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>ruah daemon</title></head>
  <body style="font-family: ui-monospace, monospace; max-width: 640px; margin: 4rem auto; line-height: 1.6">
    <h1>ruah daemon is running</h1>
    <p>No viewer is being served because <code>--viewer</code> points at a directory that does not exist (default <code>./viewer</code>).</p>
    <p>Start the built viewer separately and point it at this daemon with the <code>?daemon=</code> fallback, e.g.</p>
    <p><code>http://localhost:5173/?daemon=ws://127.0.0.1:4177/ws</code></p>
    <p>The WebSocket endpoint is <code>/ws</code>; HTTP endpoints are <code>/api/health</code>, <code>/api/architecture</code>, <code>/api/context/&lt;nodeId&gt;</code>, <code>/api/file?path=</code>.</p>
  </body>
</html>
`;

export interface StaticResult {
  status: number;
  contentType?: string | undefined;
  body: Buffer | string;
  cacheControl?: string | undefined;
}

function notFound(): StaticResult {
  return { status: 404, body: "not found" };
}

// Serves `urlPath` (a pathname, no query) from viewerDir. When the dir does
// not exist, every path gets the explanatory page.
export function serveStatic(viewerDir: string | undefined, urlPath: string): StaticResult {
  if (viewerDir === undefined || !fs.existsSync(viewerDir) || !fs.statSync(viewerDir).isDirectory()) {
    return { status: 200, contentType: "text/html; charset=utf-8", body: NO_VIEWER_PAGE };
  }
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes("..")) {
    return notFound();
  }
  let rel = decoded.replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  if (path.isAbsolute(rel)) {
    return notFound();
  }
  const abs = path.resolve(viewerDir, rel);
  const rootAbs = path.resolve(viewerDir);
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
    return notFound();
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    // SPA fallback: extension-less paths fall back to index.html (server.ts
    // answers unknown /api paths with 404 before they get here).
    if (!path.extname(rel).includes(".")) {
      const indexAbs = path.join(rootAbs, "index.html");
      try {
        return {
          status: 200,
          contentType: MIME[".html"],
          body: fs.readFileSync(indexAbs),
          cacheControl: "no-cache",
        };
      } catch {
        return notFound();
      }
    }
    return notFound();
  }
  if (stat.isDirectory()) {
    const indexAbs = path.join(abs, "index.html");
    try {
      return { status: 200, contentType: MIME[".html"], body: fs.readFileSync(indexAbs), cacheControl: "no-cache" };
    } catch {
      return notFound();
    }
  }
  const ext = path.extname(abs).toLowerCase();
  const contentType = MIME[ext];
  if (contentType === undefined) return notFound();
  const cacheControl = rel.startsWith(`assets${path.sep}`) || rel.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return { status: 200, contentType, body: fs.readFileSync(abs), cacheControl };
}

// ---------------------------------------------------------------------------
// Viewer build id (CONTRACTS §2.3 /api/health `viewerBuild`): every viewer build stamps
// <meta name="ruah-build" content="<id>"> into its prerendered index.html (ui/vite.config.ts).
// An open window compares it with its own id and reloads onto a newer build. Read on demand
// (`pnpm ui:build` replaces the whole directory while the daemon runs), cached by mtime + size.

const buildIdCache = new Map<string, { mtimeMs: number; size: number; id: string | null }>();

/** The id in a viewer index.html, or null (an older build without the meta tag). */
export function parseViewerBuildId(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bname\s*=\s*["']ruah-build["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim();
    return content ? content : null;
  }
  return null;
}

/** The build id of the viewer served from `viewerDir`; null without a viewer or an id. */
export function viewerBuildId(viewerDir: string | undefined): string | null {
  if (viewerDir === undefined) return null;
  const index = path.join(path.resolve(viewerDir), "index.html");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(index);
  } catch {
    return null;
  }
  const cached = buildIdCache.get(index);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.id;
  let id: string | null = null;
  try {
    id = parseViewerBuildId(fs.readFileSync(index, "utf8"));
  } catch {
    return null;
  }
  buildIdCache.set(index, { mtimeMs: stat.mtimeMs, size: stat.size, id });
  return id;
}
