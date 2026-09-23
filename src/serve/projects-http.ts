// src/serve/projects-http.ts — CONTRACTS §5.3 endpoints: GET /api/projects,
// POST /api/projects/{open,create,pin,forget}, GET /api/chats/recent. Every
// POST passes the same Origin check as /ws (403 otherwise; CSRF defence for a
// localhost daemon). Bodies are JSON, at most 64 KiB.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import {
  CreateProjectBodySchema,
  ForgetProjectBodySchema,
  OpenProjectBodySchema,
  PinProjectBodySchema,
} from "../contracts/projects.js";
import { ProjectError, type ProjectService } from "../projects/service.js";

const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ProjectError(413, "request body exceeds 64 KiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseBody<T extends z.ZodTypeAny>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  const raw = await readBody(req);
  let value: unknown;
  try {
    value = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new ProjectError(400, "body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProjectError(400, `invalid body: ${issue !== undefined ? `${issue.path.join(".") || "body"}: ${issue.message}` : "unknown"}`);
  }
  return parsed.data as z.infer<T>;
}

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof ProjectError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * Handles the request when it is one of the §5.3 endpoints (true), else false.
 * Without a service (tests) the endpoints answer 503.
 */
export function handleProjectsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: ProjectService | undefined,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const { pathname } = url;
  const isProjects = pathname === "/api/projects" || pathname.startsWith("/api/projects/");
  const isChats = pathname === "/api/chats/recent";
  if (!isProjects && !isChats) return false;
  if (service === undefined) {
    sendJson(res, 503, { error: "projects are not available" });
    return true;
  }

  if (req.method === "GET") {
    if (pathname === "/api/projects") {
      sendJson(res, 200, service.list());
      return true;
    }
    if (isChats) {
      const raw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 50;
      sendJson(res, 200, { chats: service.recentChats(limit) });
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  if (!originOk(req.headers.origin)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }

  const run = async (): Promise<void> => {
    switch (pathname) {
      case "/api/projects/open": {
        const body = await parseBody(req, OpenProjectBodySchema);
        const result = await service.open(body.path);
        sendJson(res, 200, result.project);
        return;
      }
      case "/api/projects/create": {
        const body = await parseBody(req, CreateProjectBodySchema);
        const result = await service.create(body);
        sendJson(res, 200, result.project);
        return;
      }
      case "/api/projects/pin": {
        const body = await parseBody(req, PinProjectBodySchema);
        if (!service.pin(body.id, body.pinned !== false)) throw new ProjectError(404, `unknown project: ${body.id}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      case "/api/projects/forget": {
        const body = await parseBody(req, ForgetProjectBodySchema);
        if (!service.forget(body.id)) throw new ProjectError(404, `unknown project: ${body.id}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      default:
        sendJson(res, 404, { error: "not found" });
    }
  };
  run().catch((err: unknown) => fail(res, err));
  return true;
}
