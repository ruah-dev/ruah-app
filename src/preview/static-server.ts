// The built-in static server for a plain index.html site (no build tool): serves
// one folder on 127.0.0.1 with live reload — an EventSource script is injected
// into HTML pages; a CSS change swaps the stylesheets in place, anything else
// reloads the page. Paths never leave the folder (symlinks resolved), nothing
// is cached, and no framing headers are sent so the preview pane can show it.
// It is reachable by any web page the user has open, so:
//   - the Host header must be a loopback name (DNS rebinding: a rebound
//     attacker hostname would otherwise read the folder same-origin);
//   - dotfiles and dot-folders (.env, .git, .ssh, …) are never served;
//   - request paths reach the preview log (and so "Ask agent to fix") only for
//     the page's own same-origin requests, and error answers carry no details.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { hostnameOf, isLoopbackHostName } from "../terminal/gateway.js";

export const LIVE_PATH = "/__ruah/live";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

const LIVE_SCRIPT = `<script>(function(){if(window.__ruahLive)return;window.__ruahLive=1;var es=new EventSource(${JSON.stringify(LIVE_PATH)});es.onmessage=function(e){if(e.data==="css"){var links=document.querySelectorAll('link[rel="stylesheet"]');if(links.length){links.forEach(function(l){var u=new URL(l.href);u.searchParams.set("ruah",Date.now());l.href=u.toString()});return}}location.reload()}})();</script>`;

export function injectLiveReload(html: string): string {
  const at = html.search(/<\/body\s*>/i);
  return at === -1 ? html + LIVE_SCRIPT : html.slice(0, at) + LIVE_SCRIPT + html.slice(at);
}

export interface StaticServerOptions {
  dir: string;
  port: number;
  host?: string;
  liveReload?: boolean;
  /** One line per request error / reload, for the preview's log. */
  log?: (line: string) => void;
}

export interface StaticServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** A path segment that starts with "." (.env, .git, .ssh, .npmrc …); `.well-known` is public by design. */
function hasHiddenSegment(rel: string): boolean {
  return rel.split(/[/\\]+/).some((seg) => seg.startsWith(".") && seg !== "." && seg !== ".well-known");
}

/**
 * May a request with this Host header be served? Loopback names only
 * (localhost, *.localhost, 127.x, [::1]) plus the bind name; no Host at all
 * (HTTP/1.0, non-browser clients) is allowed — browsers always send one.
 */
export function staticHostAllowed(hostHeader: string | undefined, bindHost = "127.0.0.1"): boolean {
  if (hostHeader === undefined || hostHeader.length === 0) return true;
  const name = hostnameOf(hostHeader);
  if (name === undefined) return false;
  if (isLoopbackHostName(name)) return true;
  const bind = bindHost.replace(/^\[|\]$/g, "").toLowerCase();
  return bind !== "0.0.0.0" && bind !== "::" && name.toLowerCase() === bind;
}

/** The file for a URL path inside `root`, or undefined (404) / null (403: outside the folder, or a dotfile). */
export function resolveStaticPath(root: string, urlPath: string): string | null | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = path.posix.normalize(`/${decoded}`);
  if (hasHiddenSegment(normalized)) return null;
  const target = path.resolve(root, `.${normalized}`);
  if (!inside(target, root)) return null;
  if (hasHiddenSegment(path.relative(root, target))) return null;
  const tryFiles = [target, path.join(target, "index.html"), `${target}.html`];
  for (const file of tryFiles) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(file);
      // A symlink may point into a dot-folder of the project (config -> .git/config).
      return inside(real, realRoot) && !hasHiddenSegment(path.relative(realRoot, real)) ? file : null;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** A request path for the log: raw (percent-encoded) path only, printable, short. */
function loggablePath(url: string): string {
  const raw = (url.split("?")[0] ?? "/").replace(/[^\x21-\x7e]/g, "");
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

export function startStaticServer(options: StaticServerOptions): Promise<StaticServer> {
  const root = path.resolve(options.dir);
  const host = options.host ?? "127.0.0.1";
  const live = options.liveReload !== false;
  const clients = new Set<http.ServerResponse>();
  const log = options.log ?? (() => {});

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (!staticHostAllowed(req.headers.host, host)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("host not allowed");
      return;
    }
    if (live && url.startsWith(LIVE_PATH)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": ruah live reload\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const file = resolveStaticPath(root, url);
    if (file === null) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (file === undefined) {
      // Any page can request any path here (an <img> needs no CORS), so only the preview's own
      // requests may put a path in the log that "Ask agent to fix" hands to the agent.
      if (req.headers["sec-fetch-site"] === "same-origin") log(`404 ${loggablePath(url)}`);
      res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(live ? injectLiveReload("<!doctype html><title>Not found</title><p>Not found</p>") : "Not found");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    fs.readFile(file, (err, data) => {
      if (err !== null) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("could not read the file");
        return;
      }
      const body = live && type.startsWith("text/html") ? Buffer.from(injectLiveReload(data.toString("utf8"))) : data;
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    });
  });

  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pending: "css" | "reload" | undefined;
  if (live) {
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, name) => {
        const rel = typeof name === "string" ? name : "";
        if (/(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(rel)) return;
        const kind = rel.toLowerCase().endsWith(".css") ? "css" : "reload";
        pending = pending === "reload" ? "reload" : kind;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          const message = pending ?? "reload";
          pending = undefined;
          if (clients.size > 0) log(`changed ${rel} — ${message === "css" ? "restyling" : "reloading"} ${clients.size} page${clients.size === 1 ? "" : "s"}`);
          for (const client of clients) client.write(`data: ${message}\n\n`);
        }, 80);
      });
      watcher.on("error", () => {});
    } catch {
      watcher = undefined; // recursive watch unsupported: no live reload, still serving
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      const url = `http://${host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" ? "localhost" : host}:${port}/`;
      log(`Serving ${root} at ${url}${live ? " (live reload)" : ""}`);
      resolve({
        url,
        port,
        close: () =>
          new Promise<void>((done) => {
            watcher?.close();
            if (timer !== undefined) clearTimeout(timer);
            for (const client of clients) client.end();
            clients.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
