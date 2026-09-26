// src/serve/server.ts — http.createServer + ws upgrade at /ws with the Origin
// check from CONTRACTS.md §2.2 rule 10, HTTP endpoints (§2.3), and static SPA
// serving from --viewer. No framework; `ws` for the WebSocket server.
import * as http from "node:http";
import { WebSocketServer } from "ws";
import type { ArchitectureStore } from "./architecture-store.js";
import { serveStatic, viewerBuildId } from "./static.js";
import { serveFile } from "./files.js";
import { serveContext } from "./context-endpoint.js";
import { handleExpandRequest, isExpandPath } from "../expand/http.js";
import { attachSession, NO_PROJECT_MESSAGE, type SessionHub } from "./session.js";
import { handleUsageRequest } from "../usage/http.js";
import type { UsageApi } from "../usage/index.js";
import { handleIntegrationsRequest } from "../integrations/http.js";
import type { IntegrationsApi } from "../integrations/index.js";
import { handleEnginesRequest } from "../engines/http.js";
import type { EnginesService } from "../engines/index.js";
import { scanRepo, summarize } from "../scan/index.js";
import { handleProjectsRequest, sendJson } from "./projects-http.js";
import { handleExportRequest } from "../export/http.js";
import type { ProjectService } from "../projects/service.js";
import type { AttachmentStore } from "../projects/attachment-store.js";
import { handleAttachmentsRequest } from "./attachments-http.js";
import { handleMapOpsRequest } from "./map-ops-http.js";
import { handleActivityRequest, type ActivityHttpDeps } from "./activity-http.js";
import type { MapOpsService } from "./map-ops.js";
import { hostnameOf, isLoopbackHostName, type TerminalGateway } from "../terminal/gateway.js";
import { isIP } from "node:net";
import { handleSystemRequest, type SystemService } from "./system-http.js";
import { handleExtensionsRequest } from "../extensions/http.js";
import { ownOrigin } from "./local-mutation.js";
import type { ExtensionsService } from "../extensions/service.js";
import { handlePreviewRequest, type PreviewHttpDeps } from "../preview/http.js";

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
  /** /api/engines/* — verify, eval, conv CLI wrappers; answered 503 when absent. */
  engines?: EnginesService;
  /** CONTRACTS §5.6 /api/attachments; defaults to the hub's store, 503 when neither has one. */
  attachments?: AttachmentStore;
  /** CONTRACTS §1.7 /api/arch + /api/arch/ops (token-authenticated map ops for `ruah app mcp`); 503 when absent. */
  mapOps?: MapOpsService;
  /** CONTRACTS §7 GET /api/terminal/token + /ws/terminal; the token endpoint answers 503 when absent. */
  terminal?: TerminalGateway;
  /** CONTRACTS §12 /api/system/* (multi-repo systems management); answered 503 when absent. */
  system?: SystemService;
  /** CONTRACTS §13 /api/activity*, /api/projects/:id/{resume,view}; answered 503 when absent. */
  activity?: ActivityHttpDeps;
  /** CONTRACTS §17 /api/extensions/* (skills, MCP servers, powers, plugins, rules); answered 503 when absent. */
  extensions?: ExtensionsService;
  /** CONTRACTS §18 /api/preview* (live preview of the project's dev server); answered 503 when absent. */
  preview?: PreviewHttpDeps;
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
  // Same loopback rule as hostAllowed and the terminal: localhost, *.localhost,
  // 127.x and IPv6 ::1 (a viewer opened at http://[::1]:<port>).
  if (isLoopbackHostName(host.replace(/^\[|\]$/g, ""))) return true;
  return allowOrigins.some((glob) => originMatches(origin, glob));
}

/**
 * DNS-rebinding guard: a browser page on evil.example whose name re-resolves
 * to 127.0.0.1 sends same-origin GETs with no Origin header (originAllowed
 * lets those through for curl), so the Host header is what tells it apart.
 * Allowed: no Host (non-browser clients), loopback names, IP literals (they
 * cannot be rebound), the --host bind name, and hosts an --allow-origin glob
 * names.
 */
export function hostAllowed(hostHeader: string | undefined, bindHost: string, allowOrigins: readonly string[]): boolean {
  if (hostHeader === undefined || hostHeader.length === 0) return true;
  const name = hostnameOf(hostHeader);
  if (name === undefined) return false;
  if (isLoopbackHostName(name) || isIP(name) !== 0) return true;
  if (name.toLowerCase() === bindHost.replace(/^\[|\]$/g, "").toLowerCase()) return true;
  return allowOrigins.some(
    (glob) =>
      originMatches(`http://${hostHeader}`, glob) || originMatches(`https://${hostHeader}`, glob) ||
      originMatches(`http://${name}`, glob) || originMatches(`https://${name}`, glob),
  );
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
    if (!hostAllowed(req.headers.host, options.host, options.allowOrigins)) {
      options.logger(`rejected request for host ${req.headers.host ?? "(none)"}`);
      sendJson(res, 403, { error: "host not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        version: hub.version(),
        agent: hub.agentState(),
        project: hub.project()?.id ?? null,
        // The viewer build this daemon serves now (a window on an older build reloads).
        viewerBuild: viewerBuildId(options.viewerDir),
      });
      return;
    }
    if (handleUsageRequest(req, res, url, options.usage, { originAllowed: (origin) => originAllowed(origin, options.allowOrigins), bindHost: options.host })) return;
    if (options.terminal !== undefined ? options.terminal.handleHttp(req, res, url) : pathname === "/api/terminal/token") {
      if (options.terminal === undefined) sendJson(res, 503, { error: "the terminal is not available" });
      return;
    }
    // Agents' map tools (stdio MCP server): loopback + capability token, no browsers.
    if (handleMapOpsRequest(req, res, url, options.mapOps)) return;
    if (
      handleAttachmentsRequest(req, res, url, options.attachments ?? hub.options.attachments, () => hub.project()?.id ?? null, (origin) =>
        originAllowed(origin, options.allowOrigins),
      )
    )
      return;
    // Before projects-http, which answers every other /api/projects/* path.
    if (handleActivityRequest(req, res, url, options.activity, (origin) => originAllowed(origin, options.allowOrigins))) return;
    if (handleProjectsRequest(req, res, url, options.projects, (origin) => originAllowed(origin, options.allowOrigins))) return;
    // Multi-repo systems (§12); also takes POST /api/rescan while a system is open.
    if (handleSystemRequest(req, res, url, options.system, (origin) => originAllowed(origin, options.allowOrigins))) return;
    // Integrations resolve the current project themselves (409 when none is open).
    if (handleIntegrationsRequest(req, res, url, options.integrations, options.allowOrigins)) return;
    if (handleEnginesRequest(req, res, url, options.engines, options.allowOrigins)) return;
    // Agent extensions (§17); project-scoped entries follow the hub's open project.
    if (
      handleExtensionsRequest(req, res, url, options.extensions, () => hub.project() ?? undefined, (origin) =>
        originAllowed(origin, options.allowOrigins),
      )
    )
      return;
    if (handlePreviewRequest(req, res, url, options.preview, (origin) => originAllowed(origin, options.allowOrigins))) return;
    // GET /api/export/drawio (409 when no project is open).
    if (handleExportRequest(req, res, url, { store: () => hub.store, integrations: options.integrations, version: () => hub.version() })) return;

    // Everything below needs an open project.
    const needsProject =
      pathname === "/api/architecture" || pathname === "/api/rescan" || pathname === "/api/file" || pathname.startsWith("/api/context/") ||
      isExpandPath(pathname);
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
        // Per-project scan options (CONTRACTS §11): IaC on unless the project turned it off.
        const projectId = hub.project()?.id;
        const infra = projectId !== undefined && options.projects !== undefined ? options.projects.scanOptions(projectId).infra : true;
        arch = scanRepo(store.root, { version: hub.version(), now: new Date(), previous: store.current(), infra });
      } catch (err) {
        sendJson(res, 500, { error: `scan failed: ${(err as Error).message}` });
        return;
      }
      // store.save validates, writes atomically and broadcasts reason "saved".
      store.save(arch, { by: { kind: "scan" } }).then(
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
    // On-demand drill-in below the stored architecture (CONTRACTS §1.6).
    if (store !== null && handleExpandRequest(req, res, url, store, (origin) => originAllowed(origin, options.allowOrigins))) return;
    if (pathname === "/api/file" && req.method === "GET" && store !== null) {
      serveFile(store, url.searchParams.get("path") ?? "", res);
      return;
    }

    // No handler above took it: an unknown /api path (or a method the path does not
    // take, e.g. PUT /api/architecture) is an error, never the SPA's index.html with 200.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: `no such endpoint: ${req.method ?? "GET"} ${pathname}` });
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
    if (!hostAllowed(req.headers.host, options.host, options.allowOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (options.terminal?.handleUpgrade(req, socket, head, url) === true) return;
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
    // The /ws rule above accepts any loopback port; protected settings (§21.1)
    // additionally need the daemon's own origin (src/serve/local-mutation.ts).
    const own = ownOrigin(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSession(hub, ws, { ownOrigin: own });
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
            options.terminal?.close();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
