import type { ArchIndex, ArchEdgeRef } from "./graph.js";
import { collapse } from "./graph.js";
import type { ArchNode } from "../contracts/architecture.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { systemRepoRoot } from "../system/roots.js";

export const DESCRIPTION_MAX = 400;
export const NOTES_MAX = 600;
export const FILE_LIMIT = 12;
export const CHILDREN_MAX = 12;
export const EDGE_LIMIT = 12;
export const NEIGHBORS_MAX = 12;
export const TRUNCATION_MARK = "…";

const INSTRUCTION_PREFIX =
  "The user selected the node above on an architecture diagram of the repository at ";
const INSTRUCTION_SUFFIX =
  ". Treat that node as the scope of the request. Open the listed path and files first; search elsewhere only if they do not answer the question. If you change files outside this node, say so explicitly.";

function oneLine(text: string, max: number): string {
  let s = collapse(text);
  if (s.length > max) s = s.slice(0, max) + TRUNCATION_MARK;
  return s;
}

function nameOf(node: ArchNode): string {
  return collapse(node.name);
}

function edgePath(other: ArchNode): string {
  return other.path === undefined ? "" : ` path=${other.path}`;
}

function edgeTags(edge: ArchEdgeRef): string {
  let out = "";
  if (edge.label !== undefined && edge.label !== "") out += ` [${collapse(edge.label)}]`;
  if (edge.kind !== undefined && edge.kind !== "") out += ` [${edge.kind}]`;
  return out;
}

export const INFRA_SETTINGS_MAX = 12;
export const INFRA_DETAILS_MAX = 12;

/**
 * CONTRACTS §11: what an infrastructure-as-code element is, where it is
 * declared (path:line) and its key settings. Absent `infra` adds nothing, so
 * packs of code-only maps are unchanged.
 */
function infraLines(infra: NonNullable<ArchNode["infra"]>): string[] {
  const out = [`infra: ${[infra.tool, infra.kind, infra.address].filter((x) => x !== undefined && x !== "").join(" ")}`];
  if (infra.source !== undefined && infra.source.length > 0) out.push(`declared in: ${infra.source.join(", ")}`);
  const settings = Object.entries(infra.settings ?? {});
  if (settings.length > 0) {
    const shown = settings.slice(0, INFRA_SETTINGS_MAX).map(([k, v]) => `${k}=${oneLine(v, 120)}`);
    out.push(`settings: ${shown.join("; ")}${settings.length > INFRA_SETTINGS_MAX ? `; +${settings.length - INFRA_SETTINGS_MAX} more` : ""}`);
  }
  const details = infra.details ?? [];
  if (details.length > 0) {
    out.push(`folded: ${details.slice(0, INFRA_DETAILS_MAX).map((d) => oneLine(d, 120)).join("; ")}${details.length > INFRA_DETAILS_MAX ? `; +${details.length - INFRA_DETAILS_MAX} more` : ""}`);
  }
  return out;
}

/** Appended to the instruction paragraph when the agent has the ruah_* map tools (CONTRACTS §1.7). */
export const MAP_TOOLS_SENTENCE =
  " You can read and edit this project's architecture map with the ruah_* tools; keep it in sync when you add or change services, modules, datastores or links.";

export function buildContextPack(
  index: ArchIndex,
  nodeId: string,
  root: string,
  userText?: string,
  options: { mapTools?: boolean } = {},
): string {
  const node = index.byId(nodeId);
  if (node === undefined) throw new Error(`unknown node: ${nodeId}`);
  const lines: string[] = [];

  lines.push("[ruah context]");
  lines.push(`node: ${collapse(node.name)} (${node.type}) id=${node.id}`);

  if (node.path !== undefined && node.path !== "") lines.push(`path: ${node.path}`);
  // Multi-repo systems (CONTRACTS §1.5, §12): paths are "<repoId>/<path>"; say where that repo is.
  const repoId = node.repo ?? /^([a-z0-9][a-z0-9-]{0,62}):/.exec(node.id)?.[1];
  const repoRoot = repoId !== undefined ? systemRepoRoot(root, repoId) : undefined;
  if (repoId !== undefined && repoRoot !== undefined) lines.push(`repo: ${repoId} at ${repoRoot} (paths "${repoId}/<path>" are inside it)`);
  if (node.description !== undefined && collapse(node.description) !== "") {
    lines.push(`description: ${oneLine(node.description, DESCRIPTION_MAX)}`);
  }
  if (node.notes !== undefined && collapse(node.notes) !== "") {
    lines.push(`notes: ${oneLine(node.notes, NOTES_MAX)}`);
  }
  if (node.tech !== undefined && node.tech.length > 0) lines.push(`tech: ${node.tech.join(", ")}`);
  if (node.layer !== undefined && node.layer !== "") lines.push(`layer: ${node.layer}`);
  if (node.infra !== undefined) lines.push(...infraLines(node.infra));

  const parent = node.parent === undefined ? undefined : index.byId(node.parent);
  if (parent !== undefined) {
    const parentPath = parent.path === undefined ? "" : ` path=${parent.path}`;
    lines.push(`parent: ${collapse(parent.name)} (${parent.type})${parentPath}`);
  }

  const children = index.children(node.id).slice(0, CHILDREN_MAX);
  if (children.length > 0) {
    lines.push(`children: ${children.map((c) => `${collapse(c.name)} (${c.type})`).join("; ")}`);
  }

  const files = node.files ?? [];
  if (files.length > 0) {
    lines.push("files:");
    for (const f of files.slice(0, FILE_LIMIT)) lines.push(`- ${f}`);
    if (files.length > FILE_LIMIT) lines.push(`- +${files.length - FILE_LIMIT} more`);
  }

  const incoming = index.incoming(node.id).slice(0, EDGE_LIMIT);
  if (incoming.length > 0) {
    lines.push("incoming:");
    for (const edge of incoming) {
      const other = index.byId(edge.from);
      if (other === undefined) continue;
      lines.push(`- ${collapse(other.name)} (${other.type})${edgePath(other)} -> THIS${edgeTags(edge)}`);
    }
  }

  const outgoing = index.outgoing(node.id).slice(0, EDGE_LIMIT);
  if (outgoing.length > 0) {
    lines.push("outgoing:");
    for (const edge of outgoing) {
      const other = index.byId(edge.to);
      if (other === undefined) continue;
      lines.push(`- THIS -> ${collapse(other.name)} (${other.type})${edgePath(other)}${edgeTags(edge)}`);
    }
  }

  const neighbors = index.neighbors(node.id).slice(0, NEIGHBORS_MAX);
  if (neighbors.length > 0) lines.push(`neighbors: ${neighbors.map(nameOf).join(", ")}`);

  const memberships = index.workflowsOf(node.id);
  if (memberships.length > 0) {
    lines.push("workflows:");
    for (const m of memberships) {
      const step = `step ${m.index + 1} of ${m.workflow.steps.length}`;
      if (m.prev !== undefined && m.next !== undefined) {
        lines.push(
          `- ${collapse(m.workflow.name)}: ${step} (${collapse(m.prev.name)} -> THIS -> ${collapse(m.next.name)})`,
        );
      } else if (m.prev !== undefined) {
        lines.push(`- ${collapse(m.workflow.name)}: ${step} (${collapse(m.prev.name)} -> THIS)`);
      } else {
        const next = m.next === undefined ? "" : collapse(m.next.name);
        lines.push(`- ${collapse(m.workflow.name)}: ${step} (THIS -> ${next})`);
      }
    }
  }

  lines.push("[/ruah context]");
  lines.push("");
  lines.push(`${INSTRUCTION_PREFIX}${root}${INSTRUCTION_SUFFIX}${options.mapTools === true ? MAP_TOOLS_SENTENCE : ""}`);
  if (userText !== undefined) {
    lines.push("");
    lines.push(userText);
  }
  return lines.join("\n");
}

export function buildPromptBlocks(
  pack: string,
  files: readonly string[],
  root: string,
  links: boolean,
  resolvePath?: (rel: string) => { abs: string } | null,
): ContentBlock[] {
  // Links first, pack text last: the pack ends with the user's question, and
  // agents join adjacent blocks, so a link right after the question reads as
  // part of it (e.g. "Reply with exactly: OK[@src/app.ts](…)" got echoed).
  const text: ContentBlock = { type: "text", text: pack };
  if (!links) return [text];
  const linkBlocks: ContentBlock[] = [];
  for (const rel of files.slice(0, FILE_LIMIT)) {
    const abs = resolvePath !== undefined ? resolvePath(rel)?.abs : resolve(root, rel);
    if (abs !== undefined) linkBlocks.push({ type: "resource_link", uri: pathToFileURL(abs).href, name: rel });
  }
  return [...linkBlocks, text];
}
