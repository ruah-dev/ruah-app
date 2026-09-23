// src/serve/map-ops-http.ts — the local IPC endpoints the stdio MCP server
// (`archmap mcp`) calls (CONTRACTS §1.7):
//   GET  /api/arch       → { revision, architecture }
//   POST /api/arch/ops   { ops: ArchOp[] } → ArchOpsResponse (422 { error } when an op or validation fails)
// Not for browsers: loopback peers only, no Origin header, and a per-session
// capability token in `x-ruah-token` (or `Authorization: Bearer`). The Origin
// check alone would not do: the MCP process is not a browser and sends none.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ArchOpsRequestSchema } from "../contracts/map.js";
import { MapOpsError, type MapOpsService } from "./map-ops.js";
import { sendJson } from "./projects-http.js";

const MAX_BODY = 1_048_576;

export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

function tokenOf(req: IncomingMessage): string | undefined {
  const header = req.headers["x-ruah-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new MapOpsError(413, "body over 1 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Handles /api/arch and /api/arch/ops; false for any other path. */
export function handleMapOpsRequest(req: IncomingMessage, res: ServerResponse, url: URL, service: MapOpsService | undefined): boolean {
  if (url.pathname !== "/api/arch" && url.pathname !== "/api/arch/ops") return false;
  if (service === undefined) {
    sendJson(res, 503, { error: "map tools are not available" });
    return true;
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "map ops are local only" });
    return true;
  }
  if (req.headers.origin !== undefined) {
    // A browser page (any site) — never; the viewer edits through the WebSocket.
    sendJson(res, 403, { error: "map ops are not for browsers" });
    return true;
  }
  const ctx = service.contextForToken(tokenOf(req));
  if (ctx === undefined) {
    sendJson(res, 401, { error: "missing or invalid map token" });
    return true;
  }
  const fail = (err: unknown): void => {
    if (err instanceof MapOpsError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  };
  if (url.pathname === "/api/arch") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "GET only" });
      return true;
    }
    try {
      sendJson(res, 200, service.read(ctx));
    } catch (err) {
      fail(err);
    }
    return true;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return true;
  }
  void readBody(req)
    .then(async (text) => {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new MapOpsError(400, "body is not valid JSON");
      }
      const parsed = ArchOpsRequestSchema.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new MapOpsError(400, `invalid ops: ${issue !== undefined ? `${issue.path.join(".")}: ${issue.message}` : "unknown"}`);
      }
      sendJson(res, 200, await service.apply(ctx, parsed.data.ops));
    })
    .catch(fail);
  return true;
}
