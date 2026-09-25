// src/usage/http.ts — GET /api/usage/summary and GET /api/usage/limits
// (CONTRACTS.md §2.3), GET /api/usage/agents (§15). Returns false for any
// other path.
import type { IncomingMessage, ServerResponse } from "node:http";
import { UsageRangeSchema } from "../contracts/usage.js";
import type { UsageApi } from "./index.js";
import { UnknownAgentError } from "./limits/service.js";
import { limitsAgentId } from "./limits/estimate.js";

const PATHS = new Set(["/api/usage/summary", "/api/usage/limits", "/api/usage/agents"]);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function handleUsageRequest(req: IncomingMessage, res: ServerResponse, url: URL, usage: UsageApi | undefined): boolean {
  const pathname = url.pathname;
  if (!PATHS.has(pathname)) return false;
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
  if (pathname === "/api/usage/agents") {
    if (usage.agentLimits === undefined) {
      json(res, 404, { error: "per-agent limits are not available" });
      return true;
    }
    const agent = url.searchParams.get("agent")?.trim().toLowerCase();
    const refresh = url.searchParams.get("refresh") === "1";
    usage
      .agentLimits({ ...(agent !== undefined && agent.length > 0 ? { agentId: limitsAgentId(agent) } : {}), refresh })
      .then(
        (body) => json(res, 200, body),
        (err: unknown) => (err instanceof UnknownAgentError ? json(res, 400, { error: err.message }) : fail(err)),
      );
    return true;
  }
  usage.limits().then((body) => json(res, 200, body), fail);
  return true;
}
