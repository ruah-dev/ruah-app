// CONTRACTS §18.4 — the live preview's HTTP endpoints:
//   GET  /api/preview                 the open project's status (409 without a project)
//   GET  /api/preview/detect          candidates, the saved choice and what a start would run
//   GET  /api/preview/logs?lines=     the last output lines (≤ 500)
//   POST /api/preview/start   { candidate? | command?, dir?, remember? }
//   POST /api/preview/stop | /api/preview/restart
//   POST /api/preview/choice  { candidate?, command?, dir?, url? }   → .ruah/preview.json
// POSTs pass the /ws Origin rule (403), are not cross-site browser requests
// (Sec-Fetch-Site, when sent, is same-origin or none: the previewed app itself, on
// another localhost port, cannot drive its own dev server) and come from a loopback
// peer (a remote daemon runs dev servers only with --allow-remote-terminal). Running
// your own command is arbitrary code execution, so `command` also needs the
// per-daemon terminal token (§7.1) in `x-ruah-token` — only the same-origin viewer
// can read it.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PreviewChoiceBodySchema, PreviewStartBodySchema } from "../contracts/preview.js";
import { ProjectError } from "../projects/service.js";
import { parseBody, sendJson } from "../serve/projects-http.js";
import { isLoopbackAddress } from "../terminal/gateway.js";
import { PreviewError, type PreviewManager } from "./manager.js";

export const PREVIEW_TOKEN_HEADER = "x-ruah-token";

export interface PreviewHttpDeps {
  manager: PreviewManager;
  /** The terminal token (§7.1); undefined = custom commands are refused. */
  token: () => string | undefined;
  /** --allow-remote-terminal: remote peers may start dev servers. */
  allowRemote: boolean;
}

function tokenOk(req: IncomingMessage, expected: string | undefined): boolean {
  const given = req.headers[PREVIEW_TOKEN_HEADER];
  if (typeof given !== "string" || given.length === 0 || expected === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof PreviewError) {
    sendJson(res, err.status, { error: err.message, ...(err.detection !== undefined ? { detection: err.detection } : {}) });
  } else if (err instanceof ProjectError) {
    sendJson(res, err.status, { error: err.message });
  } else {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

const PATHS = new Set(["/api/preview", "/api/preview/detect", "/api/preview/logs", "/api/preview/start", "/api/preview/stop", "/api/preview/restart", "/api/preview/choice"]);

/** True when the request was a §18 endpoint (answered), else false. */
export function handlePreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PreviewHttpDeps | undefined,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const { pathname } = url;
  if (!PATHS.has(pathname)) return false;
  if (deps === undefined) {
    sendJson(res, 503, { error: "the live preview is not available" });
    return true;
  }
  const { manager } = deps;
  const post = req.method === "POST";
  const getPaths = pathname === "/api/preview" || pathname === "/api/preview/detect" || pathname === "/api/preview/logs";
  if (getPaths ? req.method !== "GET" : !post) {
    sendJson(res, 405, { error: getPaths ? "GET only" : "POST only" });
    return true;
  }
  if (post) {
    if (!originOk(req.headers.origin)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      sendJson(res, 403, { error: "cross-site request" });
      return true;
    }
    if (!isLoopbackAddress(req.socket.remoteAddress) && !deps.allowRemote) {
      sendJson(res, 403, { error: "dev servers are started from this computer only (--allow-remote-terminal allows remote viewers)" });
      return true;
    }
  }
  const run = async (): Promise<void> => {
    try {
      switch (pathname) {
        case "/api/preview": {
          const status = manager.status();
          if (status === null) throw new PreviewError(409, "open a project first");
          sendJson(res, 200, status);
          return;
        }
        case "/api/preview/detect":
          sendJson(res, 200, await manager.detectFresh());
          return;
        case "/api/preview/logs": {
          if (manager.currentProject() === null) throw new PreviewError(409, "open a project first");
          const n = Number.parseInt(url.searchParams.get("lines") ?? "200", 10);
          sendJson(res, 200, { lines: manager.logs(undefined, Number.isFinite(n) ? n : 200) });
          return;
        }
        case "/api/preview/start": {
          const body = await parseBody(req, PreviewStartBodySchema);
          const allowCommand = body.command !== undefined && tokenOk(req, deps.token());
          if (body.command !== undefined && !allowCommand) throw new PreviewError(403, "running your own command needs the terminal token (open Ruah itself, not a preview of it)");
          sendJson(res, 200, await manager.start(body, { allowCommand }));
          return;
        }
        case "/api/preview/stop":
          sendJson(res, 200, await manager.stop());
          return;
        case "/api/preview/restart":
          sendJson(res, 200, await manager.restart());
          return;
        case "/api/preview/choice": {
          const body = await parseBody(req, PreviewChoiceBodySchema);
          const allowCommand = typeof body.command === "string" && tokenOk(req, deps.token());
          if (typeof body.command === "string" && !allowCommand) throw new PreviewError(403, "saving your own command needs the terminal token");
          sendJson(res, 200, manager.choose(body, { allowCommand }));
          return;
        }
      }
    } catch (err) {
      fail(res, err);
    }
  };
  void run();
  return true;
}
