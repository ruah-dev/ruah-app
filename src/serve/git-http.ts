// src/serve/git-http.ts — CONTRACTS §24 viewer endpoints for the open
// project's branches: GET /api/git/branches and POST /api/git/switch
// { name, create?, from? }. Same rules as the §20 endpoints in projects-http.ts:
// the GET runs git, so a cross-site page is refused like a POST (403); the POST
// passes the Origin check; bodies are JSON (64 KiB at most).
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { GitBranchError } from "../git/branches.js";
import { projectBranches, switchProjectBranch, type GitSwitchDeps, type GitSwitchHost } from "../git/project-switch.js";
import { ProjectError } from "../projects/project-names.js";
import { crossSiteWithoutOrigin, parseBody, sendJson } from "./projects-http.js";

export const GitSwitchBodySchema = z.object({
  name: z.string().min(1).max(250),
  create: z.boolean().optional(),
  from: z.string().min(1).max(250).optional(),
});

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof GitBranchError || err instanceof ProjectError) {
    sendJson(res, err.status, { error: err.message, ...(err instanceof GitBranchError ? { code: err.code } : {}) });
    return;
  }
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

/** Handles /api/git/* (true), else false. */
export function handleGitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  host: GitSwitchHost,
  originOk: (origin: string | undefined) => boolean,
  deps: GitSwitchDeps = {},
): boolean {
  const { pathname } = url;
  if (pathname !== "/api/git/branches" && pathname !== "/api/git/switch") return false;
  const expected = pathname === "/api/git/branches" ? "GET" : "POST";
  if (req.method !== expected) {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  if (!originOk(req.headers.origin) || crossSiteWithoutOrigin(req)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  if (pathname === "/api/git/branches") {
    projectBranches(host, deps).then(
      (list) => sendJson(res, 200, list),
      (err: unknown) => fail(res, err),
    );
    return true;
  }
  const run = async (): Promise<void> => {
    const body = await parseBody(req, GitSwitchBodySchema);
    const result = await switchProjectBranch(
      host,
      body.name,
      { ...(body.create !== undefined ? { create: body.create } : {}), ...(body.from !== undefined ? { from: body.from } : {}) },
      deps,
    );
    sendJson(res, 200, result);
  };
  run().catch((err: unknown) => fail(res, err));
  return true;
}
