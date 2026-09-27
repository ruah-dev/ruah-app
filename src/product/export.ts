// src/product/export.ts — the journey exports behind `ruah app journeys export` and
// GET /api/product/export (CONTRACTS §23.7): one entry point per format, the file
// name and content type, and the local screenshots (docs/JOURNEYS.md §6) read from
// disk and embedded as data URIs, confined to the project folder.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import type { ProductFile } from "../contracts/product.js";
import { journeysToDrawio } from "../export/drawio.js";
import { journeyMarkdown } from "./markdown.js";
import { requireJourney, safeFileBase } from "./share.js";
import { renderStoryboard } from "./storyboard.js";

export type JourneyExportFormat = "html" | "md" | "drawio";
export const JOURNEY_EXPORT_FORMATS: readonly JourneyExportFormat[] = ["html", "md", "drawio"];

export function isJourneyExportFormat(value: string): value is JourneyExportFormat {
  return (JOURNEY_EXPORT_FORMATS as readonly string[]).includes(value);
}

const CONTENT_TYPE: Record<JourneyExportFormat, string> = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  drawio: "application/vnd.jgraph.mxfile; charset=utf-8",
};

export interface JourneyExportInput {
  product: ProductFile;
  architecture: Architecture | null;
  /** One journey (id or name); absent = all journeys. */
  journeyId?: string;
  warnings?: readonly string[];
  /** html only: screen id → image data URI. */
  screenshots?: Readonly<Record<string, string>>;
  /** Project name, used for the all-journeys title and file name. */
  projectName?: string;
  /** mxfile agent attribute. */
  agent?: string;
  date?: Date;
}

export interface JourneyExport {
  body: string;
  contentType: string;
  fileName: string;
}

/** Renders one format. Throws `unknown journey "…"` for an unknown journey id. */
export function exportJourneys(format: JourneyExportFormat, input: JourneyExportInput): JourneyExport {
  const { product, architecture } = input;
  const journey = input.journeyId !== undefined ? requireJourney(product, input.journeyId) : undefined;
  const base = journey !== undefined ? safeFileBase(journey.id, "journey") : `${safeFileBase(input.projectName ?? "", "product")}-journeys`;
  const allTitle = input.projectName !== undefined && input.projectName !== "" ? `${input.projectName} — customer journeys` : undefined;
  const warnings = input.warnings ?? [];
  let body: string;
  let fileName: string;
  switch (format) {
    case "html":
      body = renderStoryboard(product, architecture, journey?.id, {
        warnings,
        ...(input.screenshots !== undefined ? { screenshots: input.screenshots } : {}),
        ...(journey === undefined && allTitle !== undefined ? { title: allTitle } : {}),
        ...(input.date !== undefined ? { date: input.date } : {}),
      });
      fileName = journey !== undefined ? `${base}.storyboard.html` : `${base}.html`;
      break;
    case "md":
      body = journeyMarkdown(product, architecture, journey?.id, { warnings, ...(allTitle !== undefined ? { title: allTitle } : {}) });
      fileName = `${base}.md`;
      break;
    case "drawio":
      body = journeysToDrawio(product, architecture, { warnings, ...(journey !== undefined ? { journeyId: journey.id } : {}), ...(input.agent !== undefined ? { agent: input.agent } : {}) });
      fileName = `${base}.drawio`;
      break;
  }
  return { body, contentType: CONTENT_TYPE[format], fileName };
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
const MAX_SHOT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

/** A file inside `root` (symlinks resolved), or null. */
function confined(root: string, rel: string): string | null {
  const norm = path.posix.normalize(rel.replaceAll("\\", "/"));
  if (norm === "" || norm === "." || path.posix.isAbsolute(norm) || norm === ".." || norm.startsWith("../") || norm.includes("\0")) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(root, norm));
    const inside = path.relative(realRoot, real);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Screenshots of the product's screens as data URIs: `screen.shot` (a path inside the
 * project folder), else `.ruah/shots/<screen id>.{webp,png,jpg,jpeg}`. Only image types,
 * ≤ 8 MB each and 48 MB in all; anything else is skipped silently.
 */
export function loadScreenshots(root: string, product: ProductFile): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const screen of product.screens) {
    const candidates = [
      ...(screen.shot !== undefined ? [screen.shot] : []),
      ...[".webp", ".png", ".jpg", ".jpeg"].map((ext) => `.ruah/shots/${screen.id}${ext}`),
    ];
    for (const rel of candidates) {
      const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
      if (type === undefined) continue;
      const abs = confined(root, rel);
      if (abs === null) continue;
      const size = fs.statSync(abs).size;
      if (size === 0 || size > MAX_SHOT_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      out[screen.id] = `data:${type};base64,${fs.readFileSync(abs).toString("base64")}`;
      total += size;
      break;
    }
  }
  return out;
}
