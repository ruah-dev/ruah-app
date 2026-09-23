// src/export/http.ts — GET /api/export/drawio (CONTRACTS.md §2.3): the open
// project's architecture as a .drawio download, with linked cloud resources
// and issues when the integrations answer in time. 409 without a project.
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import type { IntegrationsApi } from "../integrations/index.js";
import { drawioFileName, toDrawio } from "./drawio.js";
import { extrasFromService } from "./extras.js";

export const DRAWIO_CONTENT_TYPE = "application/vnd.jgraph.mxfile; charset=utf-8";

export interface ExportDeps {
  store: () => ArchitectureStore | null;
  integrations?: IntegrationsApi | undefined;
  version: () => string;
  /** Integrations timeout (ms); default 8000. */
  timeoutMs?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Handles /api/export/*; returns false for any other path. */
export function handleExportRequest(req: IncomingMessage, res: ServerResponse, url: URL, deps: ExportDeps): boolean {
  if (!url.pathname.startsWith("/api/export/")) return false;
  if (url.pathname !== "/api/export/drawio") {
    json(res, 404, { error: "unknown export format" });
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const store = deps.store();
  if (store === null) {
    json(res, 409, { error: "no project open" });
    return true;
  }
  const arch = store.current();
  if (arch === null) {
    json(res, 503, { error: "architecture not loaded" });
    return true;
  }
  void extrasFromService(deps.integrations, deps.timeoutMs)
    .catch((err: unknown) => ({ notes: [`integrations unavailable: ${err instanceof Error ? err.message : String(err)}`] }))
    .then((extras) => {
      const xml = toDrawio(arch, { ...extras, rootName: path.basename(store.root), agent: `ruah ${deps.version()}` });
      const body = Buffer.from(xml, "utf8");
      const name = drawioFileName(arch.name);
      res.writeHead(200, {
        "content-type": DRAWIO_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${name}"`,
        "content-length": body.length,
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    })
    .catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: `export failed: ${err instanceof Error ? err.message : String(err)}` });
    });
  return true;
}
