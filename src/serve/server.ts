// src/serve/server.ts — http.createServer + ws upgrade at /ws with the Origin
// check from CONTRACTS.md §2.2 rule 10, HTTP endpoints (§2.3), and static SPA
// serving from --viewer. No framework; `ws` for the WebSocket server.
import * as http from "node:http";
import { WebSocketServer } from "ws";
import type { ArchitectureStore } from "./architecture-store.js";
import { serveStatic } from "./static.js";
import { serveFile } from "./files.js";
import { serveContext } from "./context-endpoint.js";
import { attachSession, type SessionHub } from "./session.js";
import { handleUsageRequest } from "../usage/http.js";
import type { UsageApi } from "../usage/index.js";
import { scanRepo, summarize } from "../scan/index.js";

export interface ServeOptions {
  host: string;
  port: number;
  viewerDir?: string;
  allowOrigins: string[];
  logger: (line: string) => void;
  /** GET /api/usage/*; answered 503 when absent. */
  usage?: UsageApi;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

// Glob match for --allow-origin: "*" matches everything; "*" inside the glob
// matches any run of characters except "." so "https://*.lovable.app" matches
// subdomains but not deeper dots.
export function originMatches(origin: string, glob: string): boolean {
  if (glob === "*") return true;
  const pattern = [...glob].map((ch) => (ch === "*" ? "[^.]*" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).valueOf()).join("");
  return new RegExp(`^${pattern}$`).test(origin);
}

export function originAllowed(origin: string | undefined, allowOrigins: readonly string[]): boolean {
  if (origin === undefined) return true; // non-browser clients (curl, tests)
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1") return true;
  return allowOrigins.some((glob) => originMatches(origin, glob));
}

export function startServer(
  store: ArchitectureStore,
  hub: SessionHub,
  options: ServeOptions,
): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, version: hub.version(), agent: hub.agentState() }));
      return;
    }
    if (pathname === "/api/architecture" && req.method === "GET") {
      const arch = store.current();
      if (arch === null) {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "architecture not loaded" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(arch));
      return;
    }
    const contextMatch = /^\/api\/context\/([^/]+)$/.exec(pathname);
    if (contextMatch !== null && req.method === "GET") {
      const nodeId = decodeURIComponent(contextMatch[1] ?? "");
      serveContext(store, nodeId, url.searchParams.get("text") ?? undefined, res);
      return;
    }
    if (handleUsageRequest(req, res, url, options.usage)) return;
    if (pathname === "/api/rescan" && req.method === "POST") {
      // A state-changing POST: same Origin rule as the WebSocket so another
      // site open in the browser cannot trigger it (CSRF).
      if (!originAllowed(req.headers.origin, options.allowOrigins)) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "origin not allowed" }));
        return;
      }
      const started = Date.now();
      let arch;
      try {
        arch = scanRepo(store.root, { version: hub.version(), now: new Date(), previous: store.current() });
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `scan failed: ${(err as Error).message}` }));
        return;
      }
      // store.save validates, writes atomically and broadcasts reason "saved".
      store.save(arch).then(
        () => {
          const s = summarize(arch);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, nodes: s.nodes, edges: s.edges, layers: s.layers, ms: Date.now() - started }));
        },
        (err: Error) => {
          res.writeHead(422, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: `rescan rejected: ${err.message}` }));
        },
      );
      return;
    }
    if (pathname === "/api/file" && req.method === "GET") {
      serveFile(store, url.searchParams.get("path") ?? "", res);
      return;
    }

    const staticResult = serveStatic(options.viewerDir, pathname);
    res.writeHead(staticResult.status, {
      ...(staticResult.contentType !== undefined ? { "content-type": staticResult.contentType } : {}),
      ...(staticResult.cacheControl !== undefined ? { "cache-control": staticResult.cacheControl } : {}),
    });
    res.end(staticResult.body);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, options.allowOrigins)) {
      options.logger(`rejected websocket origin: ${req.headers.origin ?? "(none)"}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSession(hub, ws);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        url: `http://${options.host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const client of wss.clients) client.terminate();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
