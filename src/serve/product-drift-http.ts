// src/serve/product-drift-http.ts — CONTRACTS §23.9 GET /api/product/drift: reviewed journeys whose
// code changed since (git). Runs git, so a cross-site page is refused; answers are cached briefly
// per product / architecture revision.
import type { IncomingMessage, ServerResponse } from "node:http";
import { productDrift, type JourneyDrift } from "../product/drift.js";
import type { ArchitectureStore } from "./architecture-store.js";
import type { ProductStore } from "./product-store.js";
import { crossSiteWithoutOrigin, sendJson } from "./projects-http.js";

const CACHE_MS = 20_000;
let cache: { key: string; at: number; value: JourneyDrift[] } | null = null;

export interface DriftHost {
  readonly store: ArchitectureStore | null;
  readonly product: ProductStore | null;
}

export function handleProductDriftRequest(req: IncomingMessage, res: ServerResponse, url: URL, host: DriftHost, originOk: (origin: string | undefined) => boolean): boolean {
  if (url.pathname !== "/api/product/drift") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return true;
  }
  if (!originOk(req.headers.origin) || crossSiteWithoutOrigin(req)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  const product = host.product;
  const store = host.store;
  const current = product?.current() ?? null;
  if (product === null || store === null) {
    sendJson(res, 409, { error: "no project open" });
    return true;
  }
  if (current === null) {
    sendJson(res, 200, { journeys: [] });
    return true;
  }
  const key = `${product.root}:${product.revision}:${store.revision}`;
  if (cache !== null && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    sendJson(res, 200, { journeys: cache.value });
    return true;
  }
  productDrift(current, store.current(), { root: store.root, ...(store.resolvePath !== undefined ? { resolvePath: store.resolvePath.bind(store) } : {}) })
    .then((value) => {
      cache = { key, at: Date.now(), value };
      sendJson(res, 200, { journeys: value });
    })
    .catch((err: unknown) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  return true;
}
