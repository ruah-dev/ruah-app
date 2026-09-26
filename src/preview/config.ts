// The project's remembered dev server choice (CONTRACTS §18.3, §20.3): a
// candidate id, or a command + folder, and optionally a fixed URL. No secrets.
// Two places, same format:
//   - `$RUAH_HOME/projects/<projectId>/preview.json` — this computer's choice,
//     where a pick is remembered by default (nothing lands in the repo);
//   - `<repo>/.ruah/preview.json` — committable, shared with the team, written
//     only by an explicit "Save to the repo" (`--save-to-repo` in the CLI).
// The computer's choice wins when both exist. Written only when the content
// changes, pretty-printed with a stable key order. An invalid repo file is
// reported and never overwritten (an invalid local one is replaced).
import * as fs from "node:fs";
import * as path from "node:path";
import { PreviewFileSchema, type PreviewFile } from "../contracts/preview.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { ensureRuahGitignore } from "../projects/repo-files.js";

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

/** `$RUAH_HOME/projects/<projectId>/preview.json`: the choice kept on this computer (the default). */
export function localPreviewFileOf(home: string, projectId: string): string {
  return path.join(home, "projects", projectId, "preview.json");
}

function readChoiceAt(file: string, label: string): PreviewFileRead {
  let raw: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { file, exists: true, config: null, error: `${label} is not a file` };
    if (stat.size > MAX_BYTES) return { file, exists: true, config: null, error: `${label} is larger than 64 KiB` };
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { file, exists: false, config: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { file, exists: true, config: null, error: `${label} is not valid JSON (${(err as Error).message})` };
  }
  const parsed = PreviewFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { file, exists: true, config: null, error: `${label}: ${issue !== undefined ? `${issue.path.join(".") || "file"}: ${issue.message}` : "invalid"}` };
  }
  return { file, exists: true, config: parsed.data };
}

export function readPreviewFile(root: string): PreviewFileRead {
  return readChoiceAt(previewFileOf(root), PREVIEW_FILE);
}

/** This computer's choice; null when there is none (an unreadable file counts as none). */
export function readLocalPreviewFile(file: string): PreviewFile | null {
  return readChoiceAt(file, "preview.json").config;
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

/** A choice with `patch` applied; null when nothing is left. */
function applyChoice(current: PreviewFile | null, patch: PreviewChoicePatch): PreviewFile | null {
  const next: PreviewFile = { version: 1, ...(current ?? {}) };
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
  return empty ? null : PreviewFileSchema.parse(next);
}

/** Writes `config` to `file` (removes it for null) when the content changes; returns whether it wrote. */
function saveChoice(file: string, config: PreviewFile | null): boolean {
  if (config === null) {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
  const text = formatPreviewFile(config);
  let before: string | undefined;
  try {
    before = fs.readFileSync(file, "utf8");
  } catch {
    before = undefined;
  }
  if (before === text) return false;
  atomicWriteFileSync(file, text);
  return true;
}

/**
 * The explicit "Save to the repo": applies a choice to `<repo>/.ruah/preview.json`
 * (a candidate replaces a saved command and vice versa; null clears a field; an
 * empty result removes the file). Returns the saved config (null = no file).
 * Throws PreviewConfigError on an invalid existing file.
 */
export function writePreviewChoice(root: string, patch: PreviewChoicePatch): PreviewFile | null {
  const current = readPreviewFile(root);
  if (current.error !== undefined) throw new PreviewConfigError(`${current.error} — fix or delete it first`);
  const next = applyChoice(current.config, patch);
  const file = previewFileOf(root);
  if (next === null) {
    if (current.exists) fs.rmSync(file, { force: true });
    return null;
  }
  if (saveChoice(file, next)) ensureRuahGitignore(root);
  return next;
}

/** The same for this computer's choice (`localPreviewFileOf`); nothing is written into the repo. */
export function writeLocalPreviewChoice(file: string, patch: PreviewChoicePatch): PreviewFile | null {
  const next = applyChoice(readLocalPreviewFile(file), patch);
  saveChoice(file, next);
  return next;
}
