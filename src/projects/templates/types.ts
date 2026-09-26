// src/projects/templates/types.ts — the shape of a project template (CONTRACTS §20.2).
// Templates are plain TypeScript modules that return file contents: they ship
// inside the bundle (CLI, daemon and the packaged app alike), work offline and
// never run a package manager or touch the network.

export interface TemplateContext {
  /** The folder name the user typed ("Payments API"). */
  name: string;
  /** A package / repo safe form of it ("payments-api"). */
  slug: string;
  /** Four-digit year (LICENSE lines, footers). */
  year: number;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** How to run it once dependencies are installed; absent = nothing to run. */
  run?: string;
  /** The wizard's suggested first prompt for the agent. */
  setupPrompt: string;
  /** false = no scan: the project starts with an empty map you draw (the "Empty" template). */
  scan: boolean;
  /** Relative path (forward slashes) → contents. */
  files(ctx: TemplateContext): Record<string, string>;
}

/** "Payments API" → "payments-api"; empty → "app". Safe as an npm package name and a GitHub repo name. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-.]+$/, "")
    .slice(0, 100);
  return slug === "" ? "app" : slug;
}

/** Shared .gitignore lines every template starts from. */
export const BASE_GITIGNORE = [".DS_Store", "node_modules/", ".env", ".env.*", "!.env.example", "*.log"];

export function gitignore(extra: readonly string[] = []): string {
  return `${[...BASE_GITIGNORE, ...extra].join("\n")}\n`;
}

/** Strips the common leading indentation of a template literal and trims the first newline. */
export function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  return `${lines.map((l) => l.slice(cut)).join("\n").replace(/\s+$/, "")}\n`;
}

/** Text for an HTML element or attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A JavaScript / TypeScript string literal. */
export function jsString(text: string): string {
  return JSON.stringify(text).replace(/</g, "\\u003c");
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
