// src/export/http.ts — GET /api/export/drawio (CONTRACTS.md §2.3): the open
// project's architecture as a .drawio download, with linked cloud resources
// and issues when the integrations answer in time (and a page per journey when
// the project has a product.json). 409 without a project.
// GET /api/product/export (CONTRACTS.md §23.7): the open project's customer
// journeys as a storyboard (html), markdown (md) or draw.io swimlanes (drawio).
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchitectureStore } from "../serve/architecture-store.js";
import type { ProductStore } from "../serve/product-store.js";
import type { IntegrationsApi } from "../integrations/index.js";
import { exportJourneys, isJourneyExportFormat, loadScreenshots } from "../product/export.js";
import { findJourney } from "../product/share.js";
import { drawioFileName, toDrawio } from "./drawio.js";
import { extrasFromService } from "./extras.js";

export const DRAWIO_CONTENT_TYPE = "application/vnd.jgraph.mxfile; charset=utf-8";

export interface ExportDeps {
  store: () => ArchitectureStore | null;
  /** The open project's product.json store (§23); absent or null: no journeys. */
  product?: () => ProductStore | null;
  integrations?: IntegrationsApi | undefined;
  version: () => string;
  /** Integrations timeout (ms); default 8000. */
  timeoutMs?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Handles /api/export/* and /api/product/export; returns false for any other path. */
export function handleExportRequest(req: IncomingMessage, res: ServerResponse, url: URL, deps: ExportDeps): boolean {
  if (url.pathname === "/api/product/export") {
    handleProductExport(req, res, url, deps);
    return true;
  }
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
      const product = deps.product?.() ?? null;
      const journeys = product?.current() ?? null;
      const xml = toDrawio(arch, {
        ...extras,
        rootName: path.basename(store.root),
        agent: `ruah ${deps.version()}`,
        ...(product !== null && journeys !== null ? { product: journeys, productWarnings: product.warnings() } : {}),
      });
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

/**
 * GET /api/product/export?format=html|md|drawio[&journey=<id>][&shots=0] — one journey
 * (id or name) or all of them, as an attachment. Same rules as /api/export/drawio: GET or
 * HEAD, the hub's open project (409 without one). 404 when the project has no
 * product.json or the journey is unknown, 400 for another format. html embeds the
 * local screenshots (.ruah/shots) unless shots=0.
 */
function handleProductExport(req: IncomingMessage, res: ServerResponse, url: URL, deps: ExportDeps): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  const store = deps.store();
  if (store === null) {
    json(res, 409, { error: "no project open" });
    return;
  }
  const format = url.searchParams.get("format") ?? "html";
  if (!isJourneyExportFormat(format)) {
    json(res, 400, { error: `unknown format "${format}" (expected html, md or drawio)` });
    return;
  }
  const productStore = deps.product?.() ?? null;
  const product = productStore?.current() ?? null;
  if (productStore === null || product === null) {
    json(res, 404, { error: "this project has no product.json (no journeys yet)" });
    return;
  }
  const journeyId = url.searchParams.get("journey") ?? undefined;
  if (journeyId !== undefined && findJourney(product, journeyId) === undefined) {
    json(res, 404, { error: `unknown journey "${journeyId}"` });
    return;
  }
  let result;
  try {
    const arch = store.current();
    result = exportJourneys(format, {
      product,
      architecture: arch,
      ...(journeyId !== undefined ? { journeyId } : {}),
      warnings: productStore.warnings(),
      ...(format === "html" && url.searchParams.get("shots") !== "0" ? { screenshots: loadScreenshots(productStore.root, product) } : {}),
      projectName: arch?.name ?? path.basename(store.root),
      agent: `ruah ${deps.version()}`,
    });
  } catch (err) {
    json(res, 500, { error: `export failed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const body = Buffer.from(result.body, "utf8");
  res.writeHead(200, {
    "content-type": result.contentType,
    "content-disposition": `attachment; filename="${result.fileName}"`,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // The storyboard is user content served from the daemon's origin: never let it run anything.
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
