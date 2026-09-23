// src/serve/attachments-http.ts — CONTRACTS §5.6: POST /api/attachments
// (raw image body, Origin-checked like every state-changing POST) and
// GET /api/attachments/:id (the stored image, for the viewer's thumbnails).
// Both work on the open project's attachments folder (409 without one).
import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentError, ATTACHMENT_MAX_BYTES, isAttachmentId, isImageMimeType, type AttachmentStore } from "../projects/attachment-store.js";
import { sendJson } from "./projects-http.js";
import { NO_PROJECT_MESSAGE } from "./session.js";

function readImageBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > ATTACHMENT_MAX_BYTES) {
        failed = true;
        reject(new AttachmentError(413, "image exceeds 10 MB"));
        req.resume(); // drain the rest so the 413 reaches the client
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** True when the request was handled (it was an /api/attachments route). */
export function handleAttachmentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: AttachmentStore | undefined,
  projectId: () => string | null,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const pathname = url.pathname;
  if (pathname !== "/api/attachments" && !pathname.startsWith("/api/attachments/")) return false;

  if (pathname === "/api/attachments") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!originOk(req.headers.origin)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    if (store === undefined) {
      sendJson(res, 503, { error: "attachments are not available" });
      return true;
    }
    const project = projectId();
    if (project === null) {
      sendJson(res, 409, { error: NO_PROJECT_MESSAGE });
      return true;
    }
    const declared = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isImageMimeType(declared)) {
      sendJson(res, 415, { error: "Content-Type must be image/png, image/jpeg, image/gif or image/webp" });
      return true;
    }
    const length = Number.parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(length) && length > ATTACHMENT_MAX_BYTES) {
      sendJson(res, 413, { error: "image exceeds 10 MB" });
      req.resume();
      return true;
    }
    readImageBody(req)
      .then((body) => {
        // The stored type comes from the magic bytes; `declared` only gates the request.
        const info = store.save(project, body, url.searchParams.get("name"));
        sendJson(res, 200, info);
      })
      .catch((err: unknown) => {
        if (err instanceof AttachmentError) sendJson(res, err.status, { error: err.message });
        else sendJson(res, 500, { error: `storing the image failed: ${(err as Error).message}` });
      });
    return true;
  }

  // GET /api/attachments/:id
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  let id = "";
  try {
    id = decodeURIComponent(pathname.slice("/api/attachments/".length));
  } catch {
    id = "";
  }
  if (!isAttachmentId(id)) {
    sendJson(res, 400, { error: "invalid attachment id" });
    return true;
  }
  if (store === undefined) {
    sendJson(res, 503, { error: "attachments are not available" });
    return true;
  }
  const project = projectId();
  if (project === null) {
    sendJson(res, 409, { error: NO_PROJECT_MESSAGE });
    return true;
  }
  const image = store.read(project, id);
  if (image === undefined) {
    sendJson(res, 404, { error: "attachment not found" });
    return true;
  }
  res.writeHead(200, {
    "content-type": image.mimeType,
    "content-length": String(image.data.length),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-site",
    // Content-addressed: the bytes behind an id never change.
    "cache-control": "private, max-age=31536000, immutable",
  });
  res.end(req.method === "HEAD" ? undefined : image.data);
  return true;
}
