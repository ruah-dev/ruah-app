// src/serve/projects-http.ts — CONTRACTS §5.3 endpoints: GET /api/projects,
// POST /api/projects/{open,create,pin,forget}, GET /api/chats/recent, plus the
// switching helpers GET /api/projects/preview and GET /api/chats/history, and
// GET/POST /api/projects/scan-options (§11, per-project scan options). §20: the
// new project wizard (GET /api/projects/new, GET …/new/github, POST …/new/check),
// POST /api/projects/{reorder,tags} and GET /api/projects/overview. Every
// POST passes the same Origin check as /ws (403 otherwise; CSRF defence for a
// localhost daemon), and so do the §20 GETs that run git / gh. Bodies are JSON,
// at most 64 KiB.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import {
  CreateProjectBodySchema,
  ForgetProjectBodySchema,
  NewProjectCheckBodySchema,
  OpenProjectBodySchema,
  PinProjectBodySchema,
  ProjectTagsBodySchema,
  ReorderProjectsBodySchema,
  ScanOptionsBodySchema,
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

export async function parseBody<T extends z.ZodTypeAny>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
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
  const isChats = pathname === "/api/chats/recent" || pathname === "/api/chats/history";
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
    // §20: these run git / gh — refused for cross-site pages like a POST.
    if (pathname === "/api/projects/new" || pathname === "/api/projects/new/github" || pathname === "/api/projects/overview") {
      if (!originOk(req.headers.origin)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return true;
      }
      const answer =
        pathname === "/api/projects/new"
          ? service.newProjectDefaults()
          : pathname === "/api/projects/new/github"
            ? service.githubStatus()
            : service.overview(Number.parseInt(url.searchParams.get("limit") ?? "", 10) || undefined);
      answer.then((body) => sendJson(res, 200, body)).catch((err: unknown) => fail(res, err));
      return true;
    }
    if (pathname === "/api/projects/preview") {
      const preview = service.preview(url.searchParams.get("id") ?? "");
      if (preview === undefined) sendJson(res, 404, { error: "unknown project" });
      else sendJson(res, 200, preview);
      return true;
    }
    if (pathname === "/api/projects/scan-options") {
      try {
        const projectId = service.projectIdOrCurrent(url.searchParams.get("id") ?? undefined);
        sendJson(res, 200, { projectId, options: service.scanOptions(projectId) });
      } catch (err) {
        fail(res, err);
      }
      return true;
    }
    if (pathname === "/api/chats/history") {
      const projectId = url.searchParams.get("projectId") ?? "";
      const chatId = url.searchParams.get("chatId") ?? "";
      const turns = service.chatHistory(projectId, chatId);
      if (turns === undefined) sendJson(res, 404, { error: "unknown chat" });
      else sendJson(res, 200, { projectId, chatId, turns });
      return true;
    }
    if (isChats) {
      const raw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 50;
      const projectId = url.searchParams.get("projectId") ?? undefined;
      sendJson(res, 200, { chats: service.recentChats(limit, projectId) });
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
        const result = await service.open(body.path, body.chatId !== undefined ? { chatId: body.chatId } : {});
        sendJson(res, 200, result.project);
        return;
      }
      case "/api/projects/create": {
        const body = await parseBody(req, CreateProjectBodySchema);
        const result = await service.create(body);
        // The ProjectInfo as before, plus what was done (§20).
        sendJson(res, 200, { ...result.project, ...(result.created !== undefined ? { created: result.created } : {}) });
        return;
      }
      case "/api/projects/new/check": {
        const body = await parseBody(req, NewProjectCheckBodySchema);
        sendJson(res, 200, service.checkNewProject(body));
        return;
      }
      case "/api/projects/reorder": {
        const body = await parseBody(req, ReorderProjectsBodySchema);
        sendJson(res, 200, service.reorder(body.ids));
        return;
      }
      case "/api/projects/tags": {
        const body = await parseBody(req, ProjectTagsBodySchema);
        const info = service.setTags(body.id, body.tags);
        if (info === undefined) throw new ProjectError(404, `unknown project: ${body.id}`);
        sendJson(res, 200, info);
        return;
      }
      case "/api/projects/pin": {
        const body = await parseBody(req, PinProjectBodySchema);
        if (!service.pin(body.id, body.pinned !== false)) throw new ProjectError(404, `unknown project: ${body.id}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      case "/api/projects/scan-options": {
        // CONTRACTS §11: persisted per project; the next rescan uses them.
        const body = await parseBody(req, ScanOptionsBodySchema);
        const projectId = service.projectIdOrCurrent(body.id);
        const options = service.setScanOptions(projectId, body.infra !== undefined ? { infra: body.infra } : {});
        sendJson(res, 200, { projectId, options });
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
