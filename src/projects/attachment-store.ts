// src/projects/attachment-store.ts — image attachments for chat prompts
// (CONTRACTS §5.6): $RUAH_HOME/projects/<projectId>/attachments/<sha256>.<ext>.
// Content-addressed, so the same image uploaded twice is stored once and its
// id never changes. The type is taken from the file's magic bytes, never from
// what the client claimed. Files are kept when a chat is deleted (another
// chat may reference the same image).
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFileSync } from "./fs-util.js";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PROMPT = 8;
export const ATTACHMENT_NAME_MAX = 120;
/** `<sha256 hex>.<ext>`; anything else is rejected before a path is built. */
export const ATTACHMENT_ID = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

const EXTENSION: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MIME_OF_EXTENSION: Record<string, ImageMimeType> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: ImageMimeType;
  size: number;
  width?: number;
  height?: number;
}

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function isAttachmentId(id: string): boolean {
  return ATTACHMENT_ID.test(id);
}

export function mimeTypeOfId(id: string): ImageMimeType | undefined {
  const match = ATTACHMENT_ID.exec(id);
  return match !== null ? MIME_OF_EXTENSION[match[1] ?? ""] : undefined;
}

/** The image type from the magic bytes, or undefined when the data is not a PNG/JPEG/GIF/WebP. */
export function sniffImage(data: Uint8Array): ImageMimeType | undefined {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Pixel size from the image header; undefined when the header is truncated or unusual. */
export function imageSize(data: Uint8Array, mimeType: ImageMimeType): { width: number; height: number } | undefined {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  try {
    switch (mimeType) {
      case "image/png":
        if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return undefined;
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      case "image/gif":
        if (b.length < 10) return undefined;
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case "image/webp": {
        if (b.length < 30) return undefined;
        const chunk = b.toString("latin1", 12, 16);
        if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
        if (chunk === "VP8L") {
          const bits = b.readUInt32LE(21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
        return undefined;
      }
      case "image/jpeg": {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) return undefined;
          const marker = b[i + 1] ?? 0;
          if (marker === 0xff) {
            i += 1; // fill byte
            continue;
          }
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
          }
          const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isFrame) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
          if (marker === 0xd9 || marker === 0xda) return undefined; // end / start of scan before a frame header
          i += 2 + b.readUInt16BE(i + 2);
        }
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
}

/** A display name: last path segment, no control characters, at most 120 chars; default `image.<ext>`. */
export function attachmentName(raw: string | null | undefined, mimeType: ImageMimeType): string {
  const base = (raw ?? "").split(/[\\/]/).at(-1) ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, ATTACHMENT_NAME_MAX);
  return clean.length > 0 ? clean : `image.${EXTENSION[mimeType]}`;
}

export class AttachmentStore {
  constructor(readonly home: string) {}

  dir(projectId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new AttachmentError(400, `invalid project id: ${projectId}`);
    return path.join(this.home, "projects", projectId, "attachments");
  }

  /** The file for `id`, or undefined for an invalid id (never a path outside the attachments folder). */
  file(projectId: string, id: string): string | undefined {
    if (!isAttachmentId(id)) return undefined;
    return path.join(this.dir(projectId), id);
  }

  /** Validates (type by magic bytes, size) and stores the image; the same bytes give the same id. */
  save(projectId: string, data: Uint8Array, name?: string | null): AttachmentInfo {
    if (data.byteLength === 0) throw new AttachmentError(400, "empty body");
    if (data.byteLength > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "image exceeds 10 MB");
    const mimeType = sniffImage(data);
    if (mimeType === undefined) throw new AttachmentError(415, "not a PNG, JPEG, GIF or WebP image");
    const id = `${createHash("sha256").update(data).digest("hex")}.${EXTENSION[mimeType]}`;
    const file = path.join(this.dir(projectId), id);
    if (!fs.existsSync(file)) atomicWriteFileSync(file, data);
    const size = imageSize(data, mimeType);
    return {
      id,
      name: attachmentName(name, mimeType),
      mimeType,
      size: data.byteLength,
      ...(size !== undefined && size.width > 0 && size.height > 0 ? size : {}),
    };
  }

  /** The stored image, or undefined when the id is invalid or the file is missing. */
  read(projectId: string, id: string): { data: Buffer; mimeType: ImageMimeType } | undefined {
    const file = this.file(projectId, id);
    const mimeType = mimeTypeOfId(id);
    if (file === undefined || mimeType === undefined) return undefined;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > ATTACHMENT_MAX_BYTES) return undefined;
      return { data: fs.readFileSync(file), mimeType };
    } catch {
      return undefined;
    }
  }
}
