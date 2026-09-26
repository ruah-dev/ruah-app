// src/projects/templates/index.ts — the curated, offline project templates
// (CONTRACTS §20.2). Order = the order the wizard lists them in.
import type { TemplateInfo } from "../../contracts/projects.js";
import { emptyTemplate, staticSiteTemplate } from "./basic.js";
import { infraTemplate } from "./infra.js";
import { monorepoTemplate, nodeApiTemplate } from "./node.js";
import { slugify, type ProjectTemplate, type TemplateContext } from "./types.js";
import { webViteReactTemplate } from "./web.js";

export { slugify, type ProjectTemplate, type TemplateContext } from "./types.js";

export const TEMPLATES: readonly ProjectTemplate[] = [
  emptyTemplate,
  webViteReactTemplate,
  nodeApiTemplate,
  staticSiteTemplate,
  monorepoTemplate,
  infraTemplate,
];

export const DEFAULT_TEMPLATE = "empty";

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templateContext(name: string, now: Date = new Date()): TemplateContext {
  return { name, slug: slugify(name), year: now.getFullYear() };
}

/** The files a template writes for `name`, sorted by path (plus architecture.json, written after the scan). */
export function renderTemplate(template: ProjectTemplate, name: string, now: Date = new Date()): [string, string][] {
  return Object.entries(template.files(templateContext(name, now))).sort(([a], [b]) => a.localeCompare(b));
}

/** Top-level entries (folders end with "/"), for the wizard's preview. */
export function topLevelEntries(template: ProjectTemplate): string[] {
  const out = new Set<string>();
  for (const file of Object.keys(template.files(templateContext("preview")))) {
    const slash = file.indexOf("/");
    out.add(slash === -1 ? file : `${file.slice(0, slash)}/`);
  }
  if (!template.scan) out.add("architecture.json");
  return [...out].sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
}

export function templateInfo(template: ProjectTemplate): TemplateInfo {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    files: topLevelEntries(template),
    ...(template.run !== undefined ? { run: template.run } : {}),
    setupPrompt: template.setupPrompt,
  };
}

export function templateInfos(): TemplateInfo[] {
  return TEMPLATES.map(templateInfo);
}
