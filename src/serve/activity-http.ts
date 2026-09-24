// src/serve/activity-http.ts — CONTRACTS §13 HTTP endpoints:
//   GET  /api/activity?since=&projectId=&limit=   live counts + logged events
//   POST /api/activity/read { projectId, chatId? } clear unread markers
//   GET  /api/projects/:id/resume                  "where you left off"
//   GET  /api/projects/:id/view                    the viewer's view state
//   POST /api/projects/:id/view { view }           save it (≤ 16 KB)
// POSTs pass the same Origin check as /ws (403). Routed before
// projects-http.ts, which answers every other /api/projects/* path.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ResumeInfo } from "../contracts/resume.js";
import { parseSince } from "../activity/log.js";
import { checkView, MAX_VIEW_BYTES, type ProjectStateStore } from "../projects/project-state.js";
import { isProjectId, ProjectError } from "../projects/service.js";
import type { ActivityService } from "./activity.js";
import { parseBody, sendJson } from "./projects-http.js";

export interface ActivityHttpDeps {
  activity: ActivityService;
  /** Shared ProjectStateStore (ChatStore.state). */
  state: ProjectStateStore;
  /** Undefined = unknown project (404). */
  resume: (projectId: string) => Promise<ResumeInfo | undefined>;
  /** Clears unread markers (the hub, so viewers get activity.project). */
  markRead: (projectId: string, chatId?: string) => void;
}

const ReadBodySchema = z.object({ projectId: z.string().min(1).max(64), chatId: z.string().min(1).max(64).optional() });
const ViewBodySchema = z.object({ view: z.unknown() });
const EVENTS_DEFAULT = 100;
const EVENTS_MAX = 2000;

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof ProjectError) sendJson(res, err.status, { error: err.message });
  else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

/** True when the request was one of the §13 endpoints (answered), else false. */
export function handleActivityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ActivityHttpDeps | undefined,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const { pathname } = url;
  const projectMatch = /^\/api\/projects\/([^/]+)\/(resume|view)$/.exec(pathname);
  const isActivity = pathname === "/api/activity" || pathname === "/api/activity/read";
  if (projectMatch === null && !isActivity) return false;
  if (deps === undefined) {
    sendJson(res, 503, { error: "activity is not available" });
    return true;
  }
  const post = req.method === "POST";
  if (post && !originOk(req.headers.origin)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  if (!post && req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const run = async (): Promise<void> => {
    if (pathname === "/api/activity") {
      if (post) throw new ProjectError(405, "method not allowed");
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw !== null ? parseSince(sinceRaw) : undefined;
      if (sinceRaw !== null && since === undefined) throw new ProjectError(400, "since must be an ISO time or a duration like 24h");
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? `${EVENTS_DEFAULT}`, 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), EVENTS_MAX) : EVENTS_DEFAULT;
      const snapshot = deps.activity.snapshotMessage();
      const events = deps.activity.log.read({ ...(since !== undefined ? { since } : {}), ...(projectId !== undefined ? { projectId } : {}), limit });
      sendJson(res, 200, {
        projects: projectId !== undefined ? [deps.activity.projectActivity(projectId)] : snapshot.projects,
        events,
        settings: snapshot.settings,
        maxBackgroundTurns: snapshot.maxBackgroundTurns,
      });
      return;
    }
    if (pathname === "/api/activity/read") {
      if (!post) throw new ProjectError(405, "method not allowed");
      const body = await parseBody(req, ReadBodySchema);
      if (!isProjectId(body.projectId)) throw new ProjectError(400, "invalid project id");
      deps.markRead(body.projectId, body.chatId);
      sendJson(res, 200, { ok: true, project: deps.activity.projectActivity(body.projectId) });
      return;
    }
    const projectId = decodeURIComponent(projectMatch?.[1] ?? "");
    if (!isProjectId(projectId)) throw new ProjectError(400, "invalid project id");
    if (projectMatch?.[2] === "resume") {
      if (post) throw new ProjectError(405, "method not allowed");
      const info = await deps.resume(projectId);
      if (info === undefined) throw new ProjectError(404, "unknown project");
      sendJson(res, 200, info);
      return;
    }
    // view
    if (!post) {
      sendJson(res, 200, deps.state.view(projectId));
      return;
    }
    const body = await parseBody(req, ViewBodySchema);
    const size = Buffer.byteLength(JSON.stringify(body.view ?? null), "utf8");
    if (size > MAX_VIEW_BYTES) throw new ProjectError(413, `view is ${size} bytes (max ${MAX_VIEW_BYTES})`);
    const problem = checkView(body.view) ?? deps.state.setView(projectId, body.view);
    if (problem !== undefined) throw new ProjectError(400, problem);
    sendJson(res, 200, { ok: true, updatedAt: deps.state.view(projectId).updatedAt });
  };
  run().catch((err: unknown) => fail(res, err));
  return true;
}
