// src/integrations/http.ts — CONTRACTS.md §6.2 routes: /api/integrations*,
// /api/cloud/*, /api/work/*, /api/ruah/*. Returns false for any other path.
// Every POST passes the same Origin check as /ws (403 otherwise); bodies are
// size-limited JSON validated with zod; every error message is redacted.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodType, ZodTypeDef } from "zod";
import {
  CloudLinkBodySchema,
  CloudSyncBodySchema,
  ConnectBodySchema,
  RUAH_TASK_ACTIONS,
  RuahTaskBodySchema,
  WorkCreateBodySchema,
  WorkLinkBodySchema,
  type RuahTaskAction,
} from "../contracts/integrations.js";
import { originAllowed } from "../serve/server.js";
import { IntegrationError, redact } from "./exec.js";
import type { IntegrationsApi } from "./index.js";

const MAX_BODY = 128 * 1024;
const OWNED = /^\/api\/(integrations|cloud|work|ruah)(\/|$)/;

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
      if (tooLarge) return; // keep draining so the 413 can still be delivered
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(new IntegrationError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new IntegrationError(400, "body is not valid JSON"));
      }
    });
    req.on("error", () => reject(new IntegrationError(400, "could not read body")));
  });
}

async function parseBody<T>(req: IncomingMessage, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const parsed = schema.safeParse(await readBody(req));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new IntegrationError(400, `invalid body: ${issue !== undefined ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "validation failed"}`);
  }
  return parsed.data;
}

type Route = (match: RegExpExecArray, req: IncomingMessage, url: URL, api: IntegrationsApi) => Promise<unknown>;

const d = (value: string | undefined): string => {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new IntegrationError(400, "malformed path");
  }
};

const GET_ROUTES: [RegExp, Route][] = [
  [/^\/api\/integrations$/, (_m, _r, _u, api) => api.list()],
  [/^\/api\/cloud\/resources$/, (_m, _r, _u, api) => api.cloudResources()],
  [
    /^\/api\/work\/items$/,
    (_m, _r, url, api) => {
      const q = url.searchParams.get("q");
      const nodeId = url.searchParams.get("nodeId");
      const provider = url.searchParams.get("provider");
      return api.workItems({
        ...(q !== null && q.length > 0 ? { q: q.slice(0, 256) } : {}),
        ...(nodeId !== null && nodeId.length > 0 ? { nodeId } : {}),
        ...(provider !== null && provider.length > 0 ? { provider } : {}),
      });
    },
  ],
  [/^\/api\/ruah\/status$/, (_m, _r, _u, api) => api.ruahStatus()],
  [/^\/api\/ruah\/workflows$/, (_m, _r, _u, api) => api.ruahWorkflows()],
];

const POST_ROUTES: [RegExp, Route][] = [
  [/^\/api\/integrations\/([^/]+)\/connect$/, async (m, req, _u, api) => api.connect(d(m[1]), await parseBody(req, ConnectBodySchema))],
  [/^\/api\/integrations\/([^/]+)\/disconnect$/, (m, _r, _u, api) => api.disconnect(d(m[1]))],
  [/^\/api\/cloud\/sync$/, async (_m, req, _u, api) => api.cloudSync(await parseBody(req, CloudSyncBodySchema))],
  [/^\/api\/cloud\/link$/, async (_m, req, _u, api) => api.cloudLink(await parseBody(req, CloudLinkBodySchema))],
  [/^\/api\/work\/link$/, async (_m, req, _u, api) => api.workLink(await parseBody(req, WorkLinkBodySchema))],
  [/^\/api\/work\/create$/, async (_m, req, _u, api) => api.workCreate(await parseBody(req, WorkCreateBodySchema))],
  [/^\/api\/ruah\/task$/, async (_m, req, _u, api) => api.ruahTask(await parseBody(req, RuahTaskBodySchema))],
  [
    /^\/api\/ruah\/task\/([^/]+)\/([^/]+)$/,
    (m, _r, _u, api) => {
      const action = d(m[2]);
      if (!(RUAH_TASK_ACTIONS as readonly string[]).includes(action)) throw new IntegrationError(400, `action must be one of ${RUAH_TASK_ACTIONS.join(", ")}`);
      return api.ruahTaskAction(d(m[1]), action as RuahTaskAction);
    },
  ],
  [/^\/api\/ruah\/workflows\/([^/]+)\/run$/, (m, _r, _u, api) => api.ruahWorkflowRun(d(m[1]))],
];

function find(routes: [RegExp, Route][], pathname: string): [RegExpExecArray, Route] | undefined {
  for (const [re, route] of routes) {
    const match = re.exec(pathname);
    if (match !== null) return [match, route];
  }
  return undefined;
}

export function handleIntegrationsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  api: IntegrationsApi | undefined,
  allowOrigins: readonly string[],
): boolean {
  const pathname = url.pathname;
  if (!OWNED.test(pathname)) return false;

  const getRoute = find(GET_ROUTES, pathname);
  const postRoute = find(POST_ROUTES, pathname);
  if (getRoute === undefined && postRoute === undefined) {
    json(res, 404, { error: "not found" });
    return true;
  }
  const route = req.method === "GET" ? getRoute : req.method === "POST" ? postRoute : undefined;
  if (route === undefined) {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  // State-changing POSTs: same Origin rule as the WebSocket (CSRF defence).
  if (req.method === "POST" && !originAllowed(req.headers.origin, allowOrigins)) {
    json(res, 403, { error: "origin not allowed" });
    return true;
  }
  if (api === undefined) {
    json(res, 503, { error: "integrations are not enabled" });
    return true;
  }
  const [match, handler] = route;
  Promise.resolve()
    .then(() => handler(match, req, url, api))
    .then(
      (body) => json(res, 200, body),
      (err: unknown) => {
        if (err instanceof IntegrationError) {
          json(res, err.status, { error: redact(err.message) });
          return;
        }
        json(res, 500, { error: redact(err instanceof Error ? err.message : String(err)) });
      },
    );
  return true;
}
