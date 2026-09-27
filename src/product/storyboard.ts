// src/product/storyboard.ts — a journey as one self-contained HTML page for people
// who never open Ruah (docs/JOURNEYS.md §8, CONTRACTS §23.7). Inline CSS only, no
// scripts, no external requests (a CSP meta tag forbids them), light and dark via
// prefers-color-scheme, readable at phone width, print-friendly. Every piece of
// product text is user content and is escaped; screenshots are only accepted as
// base64 image data URIs.
import type { Architecture } from "../contracts/architecture.js";
import type { Journey, JourneyStep, ProductFile } from "../contracts/product.js";
import { describeTouch, LANE_LABEL } from "./lanes.js";
import {
  branchedFrom,
  branchTarget,
  brokenRefs,
  contradicts,
  isoDate,
  journeysByPersona,
  personaOf,
  requireJourney,
  screenOf,
  stepNumber,
  strengthBucket,
  strengthLabel,
} from "./share.js";

export interface StoryboardOptions {
  /** Screen id → `data:image/(png|jpeg|webp|gif|avif);base64,…`. Anything else is ignored. */
  screenshots?: Readonly<Record<string, string>>;
  /** Page title; default "<journey> — storyboard" or "<product title> — journeys". */
  title?: string;
  /** The product store's warnings: touches they mark as broken links are flagged. */
  warnings?: readonly string[];
  /** Footer date; default now. */
  date?: Date;
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Escape for HTML text and double- or single-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const e = escapeHtml;

/** Anchor id for a journey section (and its steps) inside the page. */
function anchor(...parts: string[]): string {
  return parts.map((p) => p.replace(/[^A-Za-z0-9_-]/g, "_")).join("--");
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #faf9f6; --surface: #ffffff; --text: #1f2328; --muted: #6b6558; --line: #e4e0d8;
  --accent: #00a896; --accent-soft: #e0f7f4; --question: #8a5a00; --question-bg: #fff4dc; --question-line: #f0c36b;
  --weak: #b54a43; --medium: #9a6b12; --strong: #2f7a3a; --code-bg: #f3f1ec; --contra: #b54a43;
  --lane-frontend: #7a55d1; --lane-backend: #00917f; --lane-data: #4f7f3a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a; --surface: #1d2024; --text: #e8e6e1; --muted: #a09a8e; --line: #33373d;
    --accent: #3fd6c2; --accent-soft: #123b36; --question: #f3c46b; --question-bg: #3a2e14; --question-line: #7a5a1c;
    --weak: #f08a82; --medium: #e7b35a; --strong: #7fcf8a; --code-bg: #262a2f; --contra: #f08a82;
    --lane-frontend: #b89cf5; --lane-backend: #4fd8c6; --lane-data: #9fcf84;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0.2em 0 0.4em; overflow-wrap: anywhere; }
h2 { font-size: 1.15rem; line-height: 1.3; margin: 0; overflow-wrap: anywhere; }
h4 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 8px; }
p { margin: 0 0 8px; }
a { color: var(--accent); }
code { font: 0.85em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.eyebrow { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.75rem; color: var(--muted); margin: 0; }
.pill { display: inline-block; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.03em; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); vertical-align: middle; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; }
.facts dt { color: var(--muted); font-size: 0.85rem; padding-top: 2px; }
.facts dd { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
.journey { margin: 0 0 56px; }
.journey-head h2 { font-size: 1.6rem; margin: 0.2em 0 0.4em; }
.journey-head { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 28px; }
.from { color: var(--muted); font-size: 0.9rem; margin-top: 12px; }
ol.steps { list-style: none; padding: 0; margin: 0; }
.step { display: grid; grid-template-columns: 36px 1fr; gap: 0 14px; position: relative; padding-bottom: 22px; }
.step::before { content: ""; position: absolute; left: 17px; top: 38px; bottom: 0; width: 2px; background: var(--line); }
.step:last-child::before { display: none; }
.num { width: 36px; height: 36px; border-radius: 50%; background: var(--accent); color: var(--surface); display: flex; align-items: center; justify-content: center; font-weight: 700; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; min-width: 0; }
.screen { color: var(--muted); font-size: 0.9rem; margin: 0 0 6px; overflow-wrap: anywhere; }
.action { font-size: 1.15rem; line-height: 1.3; margin: 0 0 10px; overflow-wrap: anywhere; }
figure { margin: 12px 0; }
figure img { display: block; max-width: 100%; max-height: 560px; height: auto; border: 1px solid var(--line); border-radius: 8px; }
figure figcaption { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
.fields { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 8px 0 0; }
.fields dt { color: var(--muted); font-size: 0.85rem; padding-top: 2px; }
.fields dd { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
.missing { color: var(--muted); font-style: italic; }
.evidence { margin-top: 14px; }
blockquote { margin: 0 0 10px; padding: 8px 12px; border-left: 3px solid var(--line); background: var(--bg); border-radius: 0 8px 8px 0; }
blockquote p { white-space: pre-line; overflow-wrap: anywhere; margin: 0 0 4px; }
blockquote footer { color: var(--muted); font-size: 0.8rem; }
.strength { font-weight: 600; }
.strength.weak { color: var(--weak); } .strength.medium { color: var(--medium); } .strength.strong { color: var(--strong); }
.contra { color: var(--contra); font-weight: 600; }
.question { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--question-line); background: var(--question-bg); color: var(--text); border-radius: 8px; white-space: pre-line; overflow-wrap: anywhere; }
.question strong { color: var(--question); }
details { margin-top: 14px; border-top: 1px dashed var(--line); padding-top: 10px; }
summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; }
.touches { list-style: none; padding: 0; margin: 8px 0 0; }
.touches li { padding: 4px 0; font-size: 0.9rem; overflow-wrap: anywhere; }
.lane { display: inline-block; min-width: 70px; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.lane.frontend { color: var(--lane-frontend); } .lane.backend { color: var(--lane-backend); } .lane.data { color: var(--lane-data); }
.type { color: var(--muted); font-size: 0.8rem; }
.broken { color: var(--weak); font-weight: 600; font-size: 0.8rem; }
.branch { grid-column: 2; margin-top: 8px; padding: 8px 12px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 0.9rem; overflow-wrap: anywhere; }
.branch b { color: var(--text); }
.index { margin: 0 0 48px; }
.index h2 { margin: 20px 0 6px; font-size: 1rem; color: var(--muted); }
.index ul { margin: 0; padding-left: 20px; }
.index li { margin: 4px 0; }
footer.made { color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--line); padding-top: 12px; margin-top: 24px; }
@media (max-width: 520px) {
  main { padding: 20px 16px 36px; }
  h1 { font-size: 1.5rem; }
  .facts, .fields { grid-template-columns: 1fr; gap: 2px; }
  .facts dd, .fields dd { margin-bottom: 8px; }
  .step { grid-template-columns: 28px 1fr; gap: 0 10px; }
  .step::before { left: 13px; top: 30px; }
  .num { width: 28px; height: 28px; font-size: 0.85rem; }
  .card { padding: 14px; }
}
@media print {
  :root { --bg: #ffffff; --surface: #ffffff; --text: #000000; --muted: #444444; --line: #cccccc; --accent: #006b5f; --accent-soft: #e6f4f2; --question-bg: #fff8e6; --code-bg: #f2f2f2; }
  body { background: #ffffff; font-size: 11pt; }
  main { max-width: none; padding: 0; }
  .card, blockquote, figure, .branch, .question { break-inside: avoid; }
  .journey + .journey { break-before: page; }
  details::details-content { content-visibility: visible; display: block; }
  summary { list-style: none; }
  a { color: inherit; text-decoration: none; }
}
`;

function fields(rows: [string, string | undefined, string?][]): string {
  const body = rows
    .filter(([, value, placeholder]) => value !== undefined || placeholder !== undefined)
    .map(([label, value, placeholder]) => `<dt>${e(label)}</dt><dd>${value !== undefined ? e(value) : `<span class="missing">${e(placeholder ?? "")}</span>`}</dd>`)
    .join("");
  return body === "" ? "" : `<dl class="fields">${body}</dl>`;
}

function evidenceHtml(step: JourneyStep): string {
  const list = step.evidence ?? [];
  if (list.length === 0) return "";
  const quotes = list
    .map((ev) => {
      const meta = [ev.source, ev.date].filter((x): x is string => x !== undefined && x !== "").map(e).join(" · ");
      const strength = `<span class="strength ${strengthBucket(ev)}">${e(strengthLabel(ev))}</span>`;
      const stance = contradicts(ev) ? ` · <span class="contra">Contradicts the why</span>` : "";
      return `<blockquote><p>“${e(ev.quote)}”</p><footer>${meta !== "" ? `${meta} · ` : ""}${strength}${stance}</footer></blockquote>`;
    })
    .join("");
  return `<section class="evidence"><h4>Evidence</h4>${quotes}</section>`;
}

function touchesHtml(step: JourneyStep, arch: Architecture | null, broken: ReadonlySet<string>): string {
  const touches = step.touches ?? [];
  if (touches.length === 0) return "";
  const items = touches
    .map((ref) => {
      const info = describeTouch(ref, arch);
      const isBroken = broken.has(ref);
      const lane = `<span class="lane ${info.lane}">${e(LANE_LABEL[info.lane])}</span>`;
      if (info.kind === "unknown" || isBroken) {
        return `<li>${lane} <code>${e(ref)}</code> <span class="broken">${isBroken ? "broken link" : "unresolved"}</span></li>`;
      }
      const type = info.type !== undefined ? ` <span class="type">${e(info.type)}</span>` : "";
      const where = info.path !== undefined && info.path !== "" ? ` <code>${e(info.path)}</code>` : info.kind === "workflow" ? ` <code>${e(ref)}</code>` : "";
      return `<li>${lane} <b>${e(info.name)}</b>${type}${where}</li>`;
    })
    .join("");
  return `<details><summary>Code path (${touches.length})</summary><ul class="touches">${items}</ul></details>`;
}

function stepHtml(product: ProductFile, journey: Journey, step: JourneyStep, index: number, arch: Architecture | null, broken: ReadonlySet<string>, options: StoryboardOptions, anchors: ReadonlyMap<string, string>): string {
  const screen = screenOf(product, step.screen);
  const screenLine =
    screen !== undefined
      ? `<p class="screen">${e(screen.name)}${screen.route !== undefined ? ` <code>${e(screen.route)}</code>` : ""}</p>`
      : step.screen !== undefined
        ? `<p class="screen"><code>${e(step.screen)}</code></p>`
        : "";
  const shot = screen !== undefined ? options.screenshots?.[screen.id] : undefined;
  const figure =
    shot !== undefined && DATA_IMAGE.test(shot)
      ? `<figure><img src="${e(shot)}" alt="${e(`Screenshot of ${screen?.name ?? "the screen"}`)}" loading="lazy"><figcaption>${e(screen?.name ?? "")}</figcaption></figure>`
      : "";
  const question = step.question !== undefined ? `<p class="question"><strong>Open question:</strong> ${e(step.question)}</p>` : "";
  const branches = (journey.branches ?? [])
    .filter((b) => b.from === step.id)
    .map((b) => {
      const target = e(branchTarget(product, journey, b));
      const linkTo = b.journey !== undefined ? anchors.get(b.journey) : b.to !== undefined ? anchors.get(`${journey.id}\u0000${b.to}`) : undefined;
      const body = linkTo !== undefined ? `<a href="#${e(linkTo)}">${target}</a>` : target;
      return `<p class="branch">When <b>${e(b.when)}</b> → ${body}</p>`;
    })
    .join("");
  return (
    `<li class="step" id="${e(anchor("j", journey.id, step.id))}">` +
    `<div class="num" aria-hidden="true">${index + 1}</div>` +
    `<article class="card" aria-label="${e(`Step ${index + 1}`)}">` +
    screenLine +
    `<h3 class="action">${e(step.action)}</h3>` +
    figure +
    fields([
      ["Sees", step.sees],
      ["Why", step.why, "Why not written yet"],
      ["Signal", step.signal],
    ]) +
    evidenceHtml(step) +
    question +
    touchesHtml(step, arch, broken) +
    `</article>` +
    branches +
    `</li>`
  );
}

function journeyHtml(product: ProductFile, journey: Journey, arch: Architecture | null, options: StoryboardOptions, anchors: ReadonlyMap<string, string>, headingTag: "h1" | "h2"): string {
  const persona = personaOf(product, journey);
  const broken = brokenRefs(options.warnings, journey.id);
  const personaText = persona !== undefined ? `${persona.name}${persona.description !== undefined ? ` — ${persona.description}` : ""}` : journey.persona;
  const priority = journey.priority !== undefined ? ` <span class="pill">${e(journey.priority)}</span>` : "";
  const facts = [
    ["Persona", personaText],
    ["Goal", journey.goal],
    ["Why", journey.why],
    ["Signal", journey.signal],
  ]
    .filter((row): row is [string, string] => row[1] !== undefined)
    .map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`)
    .join("");
  const incoming = branchedFrom(product, journey)
    .map(({ journey: from, branch }) => {
      const link = anchors.get(from.id);
      const name = link !== undefined ? `<a href="#${e(link)}">${e(from.name)}</a>` : e(from.name);
      return `${name} (step ${stepNumber(from, branch.from) ?? e(branch.from)}, when ${e(branch.when)})`;
    })
    .join("; ");
  const steps = journey.steps.map((s, i) => stepHtml(product, journey, s, i, arch, broken, options, anchors)).join("");
  // The journey heading is h1 on a single-journey page, h2 under the index; step titles are h3.
  return (
    `<section class="journey" id="${e(anchor("j", journey.id))}">` +
    `<header class="journey-head">` +
    `<p class="eyebrow">Journey · ${journey.steps.length} step${journey.steps.length === 1 ? "" : "s"}${priority}</p>` +
    `<${headingTag}>${e(journey.name)}</${headingTag}>` +
    (facts !== "" ? `<dl class="facts">${facts}</dl>` : "") +
    (incoming !== "" ? `<p class="from">Also reached from: ${incoming}</p>` : "") +
    `</header>` +
    `<ol class="steps">${steps}</ol>` +
    `</section>`
  );
}

function page(title: string, body: string, date: Date): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">\n` +
    `<meta name="color-scheme" content="light dark">\n<meta name="generator" content="Ruah">\n` +
    `<title>${e(title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n<main>\n${body}\n` +
    `<footer class="made">Made with Ruah · ${e(isoDate(date))}</footer>\n</main>\n</body>\n</html>\n`
  );
}

/**
 * One journey as a self-contained HTML storyboard; with no `journeyId`, every journey
 * in one file behind an index grouped by persona. Throws for an unknown journey.
 */
export function renderStoryboard(product: ProductFile, architecture: Architecture | null, journeyId?: string, options: StoryboardOptions = {}): string {
  const date = options.date ?? new Date();
  if (journeyId !== undefined) {
    const journey = requireJourney(product, journeyId);
    // Branch targets that are other journeys are not in this file: no links.
    const anchors = new Map<string, string>(journey.steps.map((s) => [`${journey.id}\u0000${s.id}`, anchor("j", journey.id, s.id)]));
    return page(options.title ?? `${journey.name} — storyboard`, journeyHtml(product, journey, architecture, options, anchors, "h1"), date);
  }
  return renderAllStoryboards(product, architecture, options);
}

/** Every journey in one page: an index grouped by persona (core first), then each journey's section. */
export function renderAllStoryboards(product: ProductFile, architecture: Architecture | null, options: StoryboardOptions = {}): string {
  const date = options.date ?? new Date();
  const anchors = new Map<string, string>();
  for (const j of product.journeys) {
    anchors.set(j.id, anchor("j", j.id));
    for (const s of j.steps) anchors.set(`${j.id}\u0000${s.id}`, anchor("j", j.id, s.id));
  }
  const groups = journeysByPersona(product);
  const index = groups
    .map(({ persona, journeys }) => {
      const items = journeys
        .map((j) => `<li><a href="#${e(anchors.get(j.id) ?? "")}">${e(j.name)}</a>${j.priority !== undefined ? ` <span class="pill">${e(j.priority)}</span>` : ""} — ${e(j.goal)}</li>`)
        .join("");
      return `<h2>${e(persona?.name ?? "No persona")}</h2><ul>${items}</ul>`;
    })
    .join("");
  const title = options.title ?? "Customer journeys";
  const head =
    `<header class="journey-head"><p class="eyebrow">Storyboards · ${product.journeys.length} journey${product.journeys.length === 1 ? "" : "s"}</p>` +
    `<h1>${e(title)}</h1></header>` +
    (product.journeys.length === 0 ? `<p class="missing">No journeys yet.</p>` : `<nav class="index" aria-label="Journeys">${index}</nav>`);
  const ordered = groups.flatMap((g) => g.journeys);
  const sections = ordered.map((j) => journeyHtml(product, j, architecture, options, anchors, "h2")).join("\n");
  return page(title, `${head}\n${sections}`, date);
}
