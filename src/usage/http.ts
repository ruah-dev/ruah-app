// src/usage/http.ts — GET /api/usage/summary and GET /api/usage/limits
// (CONTRACTS.md §2.3), GET /api/usage/agents (§16). Returns false for any
// other path.
//
// These GETs are not free: /limits and /agents start agent CLIs (the Claude
// probe, kiro-cli acp, grok, cursor-agent) and /agents sends the Cursor app's
// saved login to cursor.com. So another web page must not be able to trigger
// them (a cross-site <img> or no-cors fetch: refused by Origin / Sec-Fetch-Site)
// nor read them through DNS rebinding (refused by the Host check).
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UsageRangeSchema } from "../contracts/usage.js";
import type { UsageApi } from "./index.js";
import { UnknownAgentError } from "./limits/service.js";
import { limitsAgentId } from "./limits/estimate.js";

const PATHS = new Set(["/api/usage/summary", "/api/usage/limits", "/api/usage/agents"]);

/** Who may call the usage endpoints (the daemon passes its --allow-origin rule and bind address). */
export interface UsageAccess {
  /** The daemon's Origin rule (loopback origins + --allow-origin); a missing Origin is a non-browser client. */
  originAllowed(origin: string | undefined): boolean;
  /** The --host the daemon listens on; its name is accepted in the Host header too. */
  bindHost?: string;
}

function loopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

const DEFAULT_ACCESS: UsageAccess = { originAllowed: loopbackOrigin };

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.length === 0) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A Host a DNS-rebinding page cannot produce: a loopback name, an IP literal
 * (no DNS involved), or the name the daemon was bound to.
 */
export function usageHostAllowed(hostHeader: string | undefined, bindHost?: string): boolean {
  const name = hostnameOf(hostHeader);
  if (name === undefined) return false;
  if (name === "localhost" || name.endsWith(".localhost") || isIP(name) !== 0) return true;
  const bind = bindHost?.replace(/^\[|\]$/g, "").toLowerCase();
  return bind !== undefined && bind.length > 0 && name === bind;
}

/** Why the request is refused, or undefined when it may proceed. */
export function usageRequestRefused(req: IncomingMessage, access: UsageAccess = DEFAULT_ACCESS): string | undefined {
  if (!usageHostAllowed(req.headers.host, access.bindHost)) return "host not allowed";
  const origin = req.headers.origin;
  if (origin !== undefined) return access.originAllowed(origin) ? undefined : "origin not allowed";
  // No Origin: curl and tests, or a browser's no-cors request from another site (<img>, <script>).
  const site = req.headers["sec-fetch-site"];
  return site === "cross-site" ? "cross-site request" : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function handleUsageRequest(req: IncomingMessage, res: ServerResponse, url: URL, usage: UsageApi | undefined, access?: UsageAccess): boolean {
  const pathname = url.pathname;
  if (!PATHS.has(pathname)) return false;
  if (req.method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const refused = usageRequestRefused(req, access);
  if (refused !== undefined) {
    json(res, 403, { error: refused });
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
