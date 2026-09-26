// src/engines/http.ts — /api/engines/* routes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { originAllowed } from "../serve/server.js";
import type { EnginesService } from "./index.js";

const MAX_BODY = 256 * 1024;
const OWNED = /^\/api\/engines(\/|$)/;

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

export function handleEnginesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  engines: EnginesService | undefined,
  allowOrigins: readonly string[],
): boolean {
  if (!OWNED.test(url.pathname)) return false;
  if (engines === undefined) {
    json(res, 503, { error: "engines service not available" });
    return true;
  }
  const method = req.method ?? "GET";
  if (method === "POST" && !originAllowed(req.headers.origin, allowOrigins)) {
    json(res, 403, { error: "origin not allowed" });
    return true;
  }

  void (async () => {
    try {
      if (method === "GET" && url.pathname === "/api/engines/status") {
        json(res, 200, engines.status());
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/guard/scan") {
        const result = await engines.guardScan();
        json(res, result.ok ? 200 : result.status, result.ok ? result.data : { error: result.error });
        return;
      }
      if (method === "GET" && url.pathname === "/api/engines/guard/audit") {
        const lastRaw = url.searchParams.get("last");
        const last = lastRaw === null ? undefined : Number(lastRaw);
        if (last !== undefined && (!Number.isInteger(last) || last < 0)) {
          json(res, 400, { error: "last must be a non-negative integer" });
          return;
        }
        const result = await engines.guardAudit(last);
        json(res, result.ok ? 200 : result.status, result.ok ? result.data : { error: result.error });
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/opt/usage") {
        const result = await engines.optUsage();
        json(res, result.ok ? 200 : result.status, result.ok ? result.data : { error: result.error });
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/watch/replay") {
        const body = z.object({ chatId: z.string().min(1), turnId: z.string().min(1) }).parse(await readBody(req));
        const result = await engines.watchReplay(body.chatId, body.turnId);
        json(res, result.ok ? 200 : result.status, result.ok ? result.data : { error: result.error });
        return;
      }
      if (method === "GET" && url.pathname === "/api/engines/watch/view") {
        const name = url.searchParams.get("name") ?? "";
        const html = engines.watchHtml(name);
        if (html === undefined) {
          json(res, 404, { error: "replay not found" });
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (method === "GET" && url.pathname === "/api/engines/verify/state") {
        json(res, 200, engines.verifyStateOf());
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/verify/sync") {
        const result = engines.syncVerify();
        json(res, 200, result);
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/verify/run") {
        const body = z.object({ nodeId: z.string().min(1) }).parse(await readBody(req));
        const state = await engines.runVerify(body.nodeId);
        json(res, 200, state);
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/eval/run") {
        const body = z
          .object({ nodeId: z.string().min(1), prompt: z.string().min(1) })
          .parse(await readBody(req));
        const result = await engines.runEval(body.nodeId, body.prompt);
        json(res, result.ok ? 200 : result.status, result.ok ? result : { error: result.error });
        return;
      }
      if (method === "GET" && url.pathname === "/api/engines/conv/detect") {
        const nodeId = url.searchParams.get("nodeId");
        if (!nodeId) {
          json(res, 400, { error: "nodeId required" });
          return;
        }
        json(res, 200, { specs: engines.detectConv(nodeId) });
        return;
      }
      if (method === "POST" && url.pathname === "/api/engines/conv/run") {
        const body = z
          .object({
            nodeId: z.string().min(1),
            specPath: z.string().min(1),
            command: z.enum(["inspect", "curate", "generate", "validate"]),
          })
          .parse(await readBody(req));
        const result = await engines.runConv(body.nodeId, body.specPath, body.command);
        json(res, result.ok ? 200 : result.status, result.ok ? result : { error: result.error });
        return;
      }
      json(res, 404, { error: "unknown engines route" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, statusOf(err), { error: message });
    }
  })();
  return true;
}
