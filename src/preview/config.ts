// `<repo>/.ruah/preview.json` (CONTRACTS §18.3): the project's remembered dev
// server choice. Committable, no secrets: a candidate id, or a command + folder,
// and optionally a fixed URL. Written only by an explicit choice (the command
// picker, `ruah app preview --pick … --remember`), only when the content
// changes, pretty-printed with a stable key order. An invalid file is reported
// and never overwritten.
import * as fs from "node:fs";
import * as path from "node:path";
import { PreviewFileSchema, type PreviewFile } from "../contracts/preview.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";

export const PREVIEW_FILE = path.join(".ruah", "preview.json");
const MAX_BYTES = 64 * 1024;

export class PreviewConfigError extends Error {}

export interface PreviewFileRead {
  file: string;
  exists: boolean;
  config: PreviewFile | null;
  error?: string;
}

export function previewFileOf(root: string): string {
  return path.join(root, PREVIEW_FILE);
}

export function readPreviewFile(root: string): PreviewFileRead {
  const file = previewFileOf(root);
  let raw: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { file, exists: true, config: null, error: `${PREVIEW_FILE} is not a file` };
    if (stat.size > MAX_BYTES) return { file, exists: true, config: null, error: `${PREVIEW_FILE} is larger than 64 KiB` };
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { file, exists: false, config: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { file, exists: true, config: null, error: `${PREVIEW_FILE} is not valid JSON (${(err as Error).message})` };
  }
  const parsed = PreviewFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { file, exists: true, config: null, error: `${PREVIEW_FILE}: ${issue !== undefined ? `${issue.path.join(".") || "file"}: ${issue.message}` : "invalid"}` };
  }
  return { file, exists: true, config: parsed.data };
}

export function formatPreviewFile(config: PreviewFile): string {
  const ordered: PreviewFile = { version: 1 };
  if (config.candidate !== undefined) ordered.candidate = config.candidate;
  if (config.command !== undefined) ordered.command = config.command;
  if (config.dir !== undefined && config.dir !== ".") ordered.dir = config.dir;
  if (config.url !== undefined) ordered.url = config.url;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface PreviewChoicePatch {
  candidate?: string | null | undefined;
  command?: string | null | undefined;
  dir?: string | null | undefined;
  url?: string | null | undefined;
}

/**
 * Applies a choice: a candidate replaces a saved command and vice versa; null
 * clears a field. An empty result removes the file. Returns the saved config
 * (null = no file). Throws PreviewConfigError on an invalid existing file.
 */
export function writePreviewChoice(root: string, patch: PreviewChoicePatch): PreviewFile | null {
  const current = readPreviewFile(root);
  if (current.error !== undefined) throw new PreviewConfigError(`${current.error} — fix or delete it first`);
  const next: PreviewFile = { version: 1, ...(current.config ?? {}) };
  if (patch.candidate !== undefined) {
    if (patch.candidate === null) delete next.candidate;
    else {
      next.candidate = patch.candidate;
      delete next.command;
      delete next.dir;
    }
  }
  if (patch.command !== undefined) {
    if (patch.command === null) {
      delete next.command;
      delete next.dir;
    } else {
      next.command = patch.command;
      delete next.candidate;
    }
  }
  if (patch.dir !== undefined) {
    if (patch.dir === null || patch.dir === ".") delete next.dir;
    else next.dir = patch.dir;
  }
  if (patch.url !== undefined) {
    if (patch.url === null) delete next.url;
    else next.url = patch.url;
  }
  const empty = next.candidate === undefined && next.command === undefined && next.url === undefined;
  const file = previewFileOf(root);
  if (empty) {
    if (current.exists) fs.rmSync(file, { force: true });
    return null;
  }
  const checked = PreviewFileSchema.parse(next);
  const text = formatPreviewFile(checked);
  let before: string | undefined;
  try {
    before = fs.readFileSync(file, "utf8");
  } catch {
    before = undefined;
  }
  if (before !== text) atomicWriteFileSync(file, text);
  return checked;
}
