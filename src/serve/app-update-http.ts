// src/serve/app-update-http.ts — the installed app's updates (src/desktop/self-update.ts):
//   GET  /api/app-update           status
//   POST /api/app-update/check     look for a new commit now (builds it when auto is on)
//   POST /api/app-update/build     build the new commit now (also after a failed build)
//   POST /api/app-update/install   { force? } restart into the staged build; 409 while a turn
//                                  runs (force skips that check)
// POSTs pass the same Origin check as /ws (403).
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { SelfUpdater } from "../desktop/self-update.js";
import { parseBody, sendJson } from "./projects-http.js";

export interface AppUpdateHttpDeps {
  updater: SelfUpdater;
  /** A turn runs or waits somewhere (a restart would stop it). */
  busy: () => boolean;
}

const InstallBodySchema = z.object({ force: z.boolean().optional() });

/** True when the request was one of these endpoints (answered), else false. */
export function handleAppUpdateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AppUpdateHttpDeps | undefined,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const { pathname } = url;
  if (pathname !== "/api/app-update" && !pathname.startsWith("/api/app-update/")) return false;
  if (deps === undefined) {
    sendJson(res, 503, { error: "updates are not available" });
    return true;
  }
  const { updater } = deps;
  if (pathname === "/api/app-update") {
    if (req.method !== "GET") sendJson(res, 405, { error: "method not allowed" });
    else sendJson(res, 200, updater.snapshot());
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
      case "/api/app-update/check":
        sendJson(res, 200, await updater.check());
        return;
      case "/api/app-update/build":
        void updater.build();
        sendJson(res, 202, updater.snapshot());
        return;
      case "/api/app-update/install": {
        const body = await parseBody(req, InstallBodySchema);
        if (!updater.ready) {
          sendJson(res, 409, { error: "no update is ready", status: updater.snapshot() });
          return;
        }
        if (body.force !== true && deps.busy()) {
          sendJson(res, 409, { error: "an agent is still working", busy: true, status: updater.snapshot() });
          return;
        }
        const started = await updater.install(true);
        sendJson(res, started ? 202 : 409, updater.snapshot());
        return;
      }
      default:
        sendJson(res, 404, { error: "not found" });
    }
  };
  run().catch((cause: unknown) => sendJson(res, 500, { error: cause instanceof Error ? cause.message : String(cause) }));
  return true;
}
