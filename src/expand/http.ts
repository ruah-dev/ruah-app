// HTTP for on-demand expansion (CONTRACTS.md §1.6 / §2.3):
//   GET /api/expand/:nodeId          -> Expansion (one level below the element)
//   GET /api/expand-peek?id=a&id=b   -> { counts: { [id]: number | null } }
// Both read the working tree only; the Origin rule of /ws applies (a page on
// another site cannot use the daemon to list the repo).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import { ExpandError, expanderFor, MAX_PEEK_IDS } from "./index.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function isExpandPath(pathname: string): boolean {
  return pathname.startsWith("/api/expand/") || pathname === "/api/expand-peek";
}

/** Returns true when the request was an expand request (answered here). */
export function handleExpandRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: ArchitectureStore,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const pathname = url.pathname;
  if (!isExpandPath(pathname)) return false;
  if (req.method !== "GET") {
    send(res, 405, { error: "method not allowed" });
    return true;
  }
  if (!originOk(req.headers.origin)) {
    send(res, 403, { error: "origin not allowed" });
    return true;
  }
  const arch = store.current();
  if (arch === null) {
    send(res, 503, { error: "architecture not loaded" });
    return true;
  }
  const expander = expanderFor(store);
  if (pathname === "/api/expand-peek") {
    const ids = url.searchParams.getAll("id").slice(0, MAX_PEEK_IDS);
    try {
      send(res, 200, { counts: expander.peek(arch, ids) });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
    return true;
  }
  let nodeId: string;
  try {
    nodeId = decodeURIComponent(pathname.slice("/api/expand/".length));
  } catch {
    send(res, 400, { error: "bad node id" });
    return true;
  }
  if (nodeId === "" || nodeId.length > 1024 || nodeId.includes("\0")) {
    send(res, 400, { error: "bad node id" });
    return true;
  }
  try {
    send(res, 200, expander.expand(arch, nodeId));
  } catch (err) {
    if (err instanceof ExpandError) send(res, err.status, { error: err.message });
    else send(res, 500, { error: (err as Error).message });
  }
  return true;
}
