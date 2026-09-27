// src/serve/product-shots-http.ts — CONTRACTS §23.8 screenshots of the app's screens, captured
// from the live preview by the desktop app:
//   POST /api/product/shot { screen, image: "data:image/(jpeg|png|webp);base64,…" }
//        → writes <root>/.ruah/shots/<screen>.<ext> (local: .ruah is not meant to be committed;
//          screenshots can show real data) and sets that screen's `shot`; { ok, shot }
//   GET  /api/product/shot?path=<shot>  → the image (only files under .ruah/shots/ or
//          product/shots/ of the open project, symlinks resolved; image types only)
// Viewer endpoints: the POST passes the Origin check; a cross-site GET is refused.
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PRODUCT_ID_PATTERN } from "../contracts/product.js";
import type { ProductStore } from "./product-store.js";
import { sendJson } from "./projects-http.js";

export const SHOT_DIR = ".ruah/shots";
const SHOT_DIRS = [".ruah/shots", "product/shots"];
const MAX_BODY = 12 * 1024 * 1024;
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const DATA_URI = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/;

export interface ShotsHost {
  readonly product: ProductStore | null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("screenshot over 12 MB"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The absolute file for a `shot` path, when it is an image inside one of the shot folders of `root`. */
export function resolveShot(root: string, shot: string): string | null {
  const rel = path.posix.normalize(shot.replaceAll("\\", "/"));
  if (rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
  if (!SHOT_DIRS.some((d) => rel.startsWith(`${d}/`))) return null;
  if (TYPES[path.extname(rel).toLowerCase()] === undefined) return null;
  const abs = path.join(root, rel);
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(abs);
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const inside = SHOT_DIRS.some((d) => real.startsWith(`${path.join(realRoot, d)}${path.sep}`));
  return inside ? real : null;
}

/** Handles /api/product/shot (true), else false. */
export function handleProductShotRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  host: ShotsHost,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  if (url.pathname !== "/api/product/shot") return false;
  const product = host.product;
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.headers.origin === undefined && req.headers["sec-fetch-site"] === "cross-site") {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    if (product === null) {
      sendJson(res, 409, { error: "no project open" });
      return true;
    }
    const file = resolveShot(product.root, url.searchParams.get("path") ?? "");
    if (file === null) {
      sendJson(res, 404, { error: "no such screenshot" });
      return true;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
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
  if (product === null) {
    sendJson(res, 409, { error: "no project open" });
    return true;
  }
  void readBody(req)
    .then(async (text) => {
      let body: { screen?: unknown; image?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        sendJson(res, 400, { error: "body is not valid JSON" });
        return;
      }
      const screenId = typeof body.screen === "string" ? body.screen : "";
      const match = typeof body.image === "string" ? DATA_URI.exec(body.image) : null;
      if (!PRODUCT_ID_PATTERN.test(screenId) || match === null) {
        sendJson(res, 400, { error: "expected { screen: <screen id>, image: data:image/jpeg|png|webp;base64,… }" });
        return;
      }
      const current = product.current();
      const screen = current?.screens.find((s) => s.id === screenId);
      if (current === null || screen === undefined) {
        sendJson(res, 404, { error: `unknown screen: ${screenId}` });
        return;
      }
      const ext = match[1] === "jpeg" ? "jpg" : match[1]!;
      // A namespaced system screen id ("web:home") becomes a flat file name.
      const shot = `${SHOT_DIR}/${screenId.replace(":", "__")}.${ext}`;
      const dir = path.join(product.root, SHOT_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const abs = path.join(product.root, shot);
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, Buffer.from(match[2]!, "base64"));
      fs.renameSync(tmp, abs);
      // Other formats of the same screen are stale now.
      for (const other of ["jpg", "png", "webp"]) {
        if (other !== ext) fs.rmSync(path.join(dir, `${screenId.replace(":", "__")}.${other}`), { force: true });
      }
      const next = structuredClone(current);
      const target = next.screens.find((s) => s.id === screenId)!;
      target.shot = shot;
      await product.save(next, { by: { kind: "user" } });
      sendJson(res, 200, { ok: true, shot });
    })
    .catch((err: unknown) => {
      const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  return true;
}
