// src/usage/http.ts — GET /api/usage/summary and GET /api/usage/limits
// (CONTRACTS.md §2.3). Returns false for any other path.
import type { IncomingMessage, ServerResponse } from "node:http";
import { UsageRangeSchema } from "../contracts/usage.js";
import type { UsageApi } from "./index.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function handleUsageRequest(req: IncomingMessage, res: ServerResponse, url: URL, usage: UsageApi | undefined): boolean {
  const pathname = url.pathname;
  if (pathname !== "/api/usage/summary" && pathname !== "/api/usage/limits") return false;
  if (req.method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  if (usage === undefined) {
    json(res, 503, { error: "usage tracking is not enabled" });
    return true;
  }
  const fail = (err: unknown): void => {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  };
  if (pathname === "/api/usage/summary") {
    const range = UsageRangeSchema.safeParse(url.searchParams.get("range") ?? "7d");
    if (!range.success) {
      json(res, 400, { error: "range must be one of 24h, 7d, 30d" });
      return true;
    }
    usage.summary(range.data).then((body) => json(res, 200, body), fail);
    return true;
  }
  usage.limits().then((body) => json(res, 200, body), fail);
  return true;
}
