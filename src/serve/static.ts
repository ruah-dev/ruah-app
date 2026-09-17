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
  <head><meta charset="utf-8"><title>archmap daemon</title></head>
  <body style="font-family: ui-monospace, monospace; max-width: 640px; margin: 4rem auto; line-height: 1.6">
    <h1>archmap daemon is running</h1>
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
    // SPA fallback: extension-less, non-/api paths fall back to index.html.
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
