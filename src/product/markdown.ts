// src/product/markdown.ts — a journey as a PR-ready markdown block (docs/JOURNEYS.md
// §8, CONTRACTS §23.7): heading, persona / goal / why / signal, a numbered step
// list (screen, action, why, signal, evidence as blockquotes, touches as inline
// code, open question) and the branches. Product text is user content: raw HTML is
// neutralized (`<` escaped) and single-line fields are folded to one line so they
// cannot break the list structure.
import type { Architecture } from "../contracts/architecture.js";
import type { Journey, ProductFile } from "../contracts/product.js";
import { describeTouch, LANE_LABEL } from "./lanes.js";
import { branchedFrom, branchTarget, brokenRefs, contradicts, journeysByPersona, personaOf, requireJourney, screenOf, stepNumber, strengthLabel } from "./share.js";

export interface MarkdownOptions {
  /** The product store's warnings: touches they mark as broken links are flagged. */
  warnings?: readonly string[];
  /** Heading of the all-journeys document; default "Customer journeys". */
  title?: string;
}

/** Inline text: one line, markdown-significant characters that could start HTML or break emphasis escaped. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/** Multi-line text (why): each line escaped like inline text, line breaks kept. */
function block(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim().replace(/([\\`*_[\]<>|])/g, "\\$1"));
}

/** Inline code span that survives backticks in the content. */
function code(text: string): string {
  const s = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

function journeyBlock(product: ProductFile, journey: Journey, arch: Architecture | null, options: MarkdownOptions, level: number): string[] {
  const h = "#".repeat(level);
  const out: string[] = [];
  const persona = personaOf(product, journey);
  const broken = brokenRefs(options.warnings, journey.id);
  out.push(`${h} Journey: ${inline(journey.name)}`, "");
  const meta = [
    persona !== undefined ? `**Persona:** ${inline(persona.name)}` : journey.persona !== undefined ? `**Persona:** ${inline(journey.persona)}` : undefined,
    journey.priority !== undefined ? `**Priority:** ${inline(journey.priority)}` : undefined,
    `**Steps:** ${journey.steps.length}`,
  ].filter((x): x is string => x !== undefined);
  out.push(meta.join(" · "), "");
  out.push(`**Goal:** ${inline(journey.goal)}`, "");
  if (journey.why !== undefined) {
    const [first = "", ...rest] = block(journey.why);
    out.push(`**Why:** ${first}`, ...rest, "");
  }
  if (journey.signal !== undefined) out.push(`**Signal:** ${inline(journey.signal)}`, "");
  const incoming = branchedFrom(product, journey);
  if (incoming.length > 0) {
    out.push(`Also reached from: ${incoming.map(({ journey: j, branch }) => `${inline(j.name)} (step ${stepNumber(j, branch.from) ?? inline(branch.from)}, when ${inline(branch.when)})`).join("; ")}`, "");
  }
  out.push(`${h}# Steps`, "");
  journey.steps.forEach((step, i) => {
    const marker = `${i + 1}. `;
    const pad = " ".repeat(marker.length);
    const screen = screenOf(product, step.screen);
    const where = screen !== undefined ? ` — ${inline(screen.name)}${screen.route !== undefined ? ` (${code(screen.route)})` : ""}` : step.screen !== undefined ? ` — ${code(step.screen)}` : "";
    out.push(`${marker}**${inline(step.action)}**${where}`);
    if (step.sees !== undefined) out.push(`${pad}- Sees: ${inline(step.sees)}`);
    if (step.why !== undefined) {
      const [first = "", ...rest] = block(step.why);
      out.push(`${pad}- Why: ${first}`, ...rest.map((l) => (l === "" ? "" : `${pad}  ${l}`)));
    } else {
      out.push(`${pad}- Why: _not written yet_`);
    }
    if (step.signal !== undefined) out.push(`${pad}- Signal: ${inline(step.signal)}`);
    if (step.question !== undefined) out.push(`${pad}- **Open question:** ${inline(step.question)}`);
    const touches = step.touches ?? [];
    if (touches.length > 0) {
      const items = touches.map((ref) => {
        const info = describeTouch(ref, arch);
        const note = broken.has(ref) ? "broken link" : info.kind === "unknown" ? "unresolved" : `${info.name !== ref ? `${inline(info.name)}, ` : ""}${LANE_LABEL[info.lane].toLowerCase()}`;
        return `${code(ref)} (${note})`;
      });
      out.push(`${pad}- Code: ${items.join(", ")}`);
    }
    const evidence = step.evidence ?? [];
    if (evidence.length > 0) {
      out.push(`${pad}- Evidence:`, "");
      for (const ev of evidence) {
        const quote = block(ev.quote);
        const source = [ev.source !== undefined ? inline(ev.source) : undefined, ev.date !== undefined ? inline(ev.date) : undefined].filter((x): x is string => x !== undefined).join(", ");
        const label = `${strengthLabel(ev)}${contradicts(ev) ? ", contradicts the why" : ""}`;
        quote.forEach((l, qi) => out.push(`${pad}  > ${qi === 0 ? "“" : ""}${l}${qi === quote.length - 1 ? "”" : ""}`));
        out.push(`${pad}  > — ${source !== "" ? `${source} ` : ""}(${inline(label)})`, "");
      }
    }
  });
  const branches = journey.branches ?? [];
  if (branches.length > 0) {
    out.push("", `${h}# Branches`, "");
    for (const b of branches) {
      const n = stepNumber(journey, b.from);
      out.push(`- From step ${n ?? inline(b.from)} when **${inline(b.when)}** → ${inline(branchTarget(product, journey, b))}`);
    }
  }
  // No double blank lines, one trailing newline.
  return out;
}

function tidy(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) if (!(l === "" && out.at(-1) === "")) out.push(l);
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

/**
 * A journey (by id or name) as markdown; with no `journeyId`, every journey grouped by
 * persona under one heading. Throws for an unknown journey.
 */
export function journeyMarkdown(product: ProductFile, architecture: Architecture | null, journeyId?: string, options: MarkdownOptions = {}): string {
  if (journeyId !== undefined) return tidy(journeyBlock(product, requireJourney(product, journeyId), architecture, options, 2));
  const lines: string[] = [`# ${inline(options.title ?? "Customer journeys")}`, ""];
  const groups = journeysByPersona(product);
  if (product.journeys.length === 0) lines.push("No journeys yet.");
  for (const { persona, journeys } of groups) {
    lines.push(`- **${inline(persona?.name ?? "No persona")}:** ${journeys.map((j) => `${inline(j.name)}${j.priority !== undefined ? ` (${inline(j.priority)})` : ""}`).join(", ")}`);
  }
  for (const { journeys } of groups) {
    for (const j of journeys) lines.push("", ...journeyBlock(product, j, architecture, options, 2));
  }
  return tidy(lines);
}
