// src/serve/server.ts — http.createServer + ws upgrade at /ws with the Origin
// check from CONTRACTS.md §2.2 rule 10, HTTP endpoints (§2.3), and static SPA
// serving from --viewer. No framework; `ws` for the WebSocket server.
import * as http from "node:http";
import { WebSocketServer } from "ws";
import type { ArchitectureStore } from "./architecture-store.js";
import { serveStatic } from "./static.js";
import { serveFile } from "./files.js";
import { serveContext } from "./context-endpoint.js";
import { attachSession, NO_PROJECT_MESSAGE, type SessionHub } from "./session.js";
import { handleUsageRequest } from "../usage/http.js";
import type { UsageApi } from "../usage/index.js";
import { handleIntegrationsRequest } from "../integrations/http.js";
import type { IntegrationsApi } from "../integrations/index.js";
import { scanRepo, summarize } from "../scan/index.js";
import { handleProjectsRequest, sendJson } from "./projects-http.js";
import { handleExportRequest } from "../export/http.js";
import type { ProjectService } from "../projects/service.js";

export interface ServeOptions {
  host: string;
  port: number;
  viewerDir?: string;
  allowOrigins: string[];
  logger: (line: string) => void;
  /** GET /api/usage/*; answered 503 when absent. */
  usage?: UsageApi;
  /** CONTRACTS §5.3 /api/projects/* and /api/chats/recent; answered 503 when absent. */
  projects?: ProjectService;
  /** /api/integrations, /api/cloud/*, /api/work/*, /api/ruah/* (§6); answered 503 when absent. */
  integrations?: IntegrationsApi;
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

/**
 * `_store` is kept for callers of the single-repo era; the hub's current
 * project store is what every endpoint serves (null = launcher state, 409).
 */
export function startServer(
  _store: ArchitectureStore | null,
  hub: SessionHub,
  options: ServeOptions,
): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: hub.version(), agent: hub.agentState(), project: hub.project()?.id ?? null });
      return;
    }
    if (handleUsageRequest(req, res, url, options.usage)) return;
    if (handleProjectsRequest(req, res, url, options.projects, (origin) => originAllowed(origin, options.allowOrigins))) return;
    // Integrations resolve the current project themselves (409 when none is open).
    if (handleIntegrationsRequest(req, res, url, options.integrations, options.allowOrigins)) return;
    // GET /api/export/drawio (409 when no project is open).
    if (handleExportRequest(req, res, url, { store: () => hub.store, integrations: options.integrations, version: () => hub.version() })) return;

    // Everything below needs an open project.
    const needsProject =
      pathname === "/api/architecture" || pathname === "/api/rescan" || pathname === "/api/file" || pathname.startsWith("/api/context/");
    const store = hub.store;
    if (needsProject && store === null) {
      if (req.method === "POST" && !originAllowed(req.headers.origin, options.allowOrigins)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      sendJson(res, 409, { error: NO_PROJECT_MESSAGE });
      return;
    }

    if (pathname === "/api/architecture" && req.method === "GET" && store !== null) {
      const arch = store.current();
      if (arch === null) {
        sendJson(res, 503, { error: "architecture not loaded" });
        return;
      }
      sendJson(res, 200, arch);
      return;
    }
    const contextMatch = /^\/api\/context\/([^/]+)$/.exec(pathname);
    if (contextMatch !== null && req.method === "GET" && store !== null) {
      const nodeId = decodeURIComponent(contextMatch[1] ?? "");
      serveContext(store, nodeId, url.searchParams.get("text") ?? undefined, res);
      return;
    }
    if (pathname === "/api/rescan" && req.method === "POST" && store !== null) {
      // A state-changing POST: same Origin rule as the WebSocket so another
      // site open in the browser cannot trigger it (CSRF).
      if (!originAllowed(req.headers.origin, options.allowOrigins)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      const started = Date.now();
      let arch;
      try {
        arch = scanRepo(store.root, { version: hub.version(), now: new Date(), previous: store.current() });
      } catch (err) {
        sendJson(res, 500, { error: `scan failed: ${(err as Error).message}` });
        return;
      }
      // store.save validates, writes atomically and broadcasts reason "saved".
      store.save(arch).then(
        () => {
          const s = summarize(arch);
          sendJson(res, 200, { ok: true, nodes: s.nodes, edges: s.edges, layers: s.layers, ms: Date.now() - started });
        },
        (err: Error) => {
          sendJson(res, 422, { error: `rescan rejected: ${err.message}` });
        },
      );
      return;
    }
    if (pathname === "/api/file" && req.method === "GET" && store !== null) {
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
