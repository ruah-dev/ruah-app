// src/extensions/inspect.ts — what a folder or file on disk is and what it
// would run, read without executing anything. Layouts understood:
//   skill   <dir>/SKILL.md (Agent Skills: Claude, Cursor, Kiro, OpenCode, Grok)
//   power   <dir>/POWER.md (+ mcp.json, steering/*.md) — Kiro powers
//   plugin  <dir>/.claude-plugin/plugin.json or .cursor-plugin/plugin.json (+ skills/, commands/,
//           agents/, hooks/hooks.json, .mcp.json) — Claude Code / Cursor / Grok plugins; a folder
//           of skills/<name>/SKILL.md without a manifest counts as a plugin too
//   mcp     <dir>/.mcp.json or mcp.json with exactly one server (or a .json file)
//   rule    a .md / .mdc file, or a folder of them
// Reads are bounded (256 KiB per file, 200 entries per folder).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionKind, McpRuns, WhatItRuns } from "../contracts/extensions.js";
import { parseYaml, yamlGet, yamlString, type YamlValue } from "../scan/mini-yaml.js";
import { ExtensionError } from "./model.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;

/** A server bundled in a manifest. `envValues` keeps literal values from the file for agents that need a translation (never shown, never stored by Ruah). */
export interface BundledServer {
  name: string;
  runs: McpRuns;
  env: string[];
  envValues: Record<string, string>;
  headerValues: Record<string, string>;
}

export interface SkillEntry {
  name: string;
  /** Folder holding the instructions file. */
  dir: string;
  /** SKILL.md, or POWER.md for a power. */
  file: string;
}

export interface Inspection {
  kind: ExtensionKind;
  /** The folder (or file for a single rule). */
  root: string;
  name?: string;
  description?: string;
  servers: BundledServer[];
  skills: SkillEntry[];
  hooks: string[];
  /** Instruction files, relative to root. */
  files: string[];
  /** Rule files (absolute). */
  rules: string[];
}

export function readTextBounded(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonBounded(file: string): unknown {
  const text = readTextBounded(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripJsonComments(text)) as unknown;
  } catch {
    return undefined;
  }
}

/** JSONC → JSON: drops // and /* *\/ comments outside strings and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** name / description (and displayName) from a Markdown file's YAML frontmatter. */
export function readFrontmatter(file: string): { name?: string; description?: string; displayName?: string } {
  const text = readTextBounded(file);
  if (text === undefined) return {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    return heading !== undefined ? { name: heading } : {};
  }
  let doc: YamlValue;
  try {
    doc = parseYaml(match[1] ?? "");
  } catch {
    return {};
  }
  const pick = (key: string): string | undefined => {
    const value = yamlString(yamlGet(doc, key))?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const name = pick("name");
  const description = pick("description");
  const displayName = pick("displayName");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = String(v);
  return out;
}

/**
 * Servers of a `{ mcpServers: { name: {...} } }` document (Claude .mcp.json,
 * Cursor / Kiro mcp.json, plugin.json mcpServers). Unknown shapes are skipped.
 */
export function parseMcpServers(doc: unknown): BundledServer[] {
  const table = isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : undefined;
  if (table === undefined) return [];
  const servers: BundledServer[] = [];
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    const envValues = stringRecord(raw.env);
    const headerValues = stringRecord(raw.headers);
    const url = typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : undefined;
    const type = typeof raw.type === "string" ? raw.type : undefined;
    if (typeof raw.command === "string" && raw.command.length > 0) {
      const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
      servers.push({ name, runs: { type: "stdio", command: raw.command, args }, env: Object.keys(envValues), envValues, headerValues });
    } else if (url !== undefined) {
      const transport = type === "sse" ? "sse" : "http";
      const headers = Object.keys(headerValues);
      servers.push({
        name,
        runs: { type: transport, url, ...(headers.length > 0 ? { headers } : {}) },
        env: [],
        envValues: {},
        headerValues,
      });
    }
  }
  return servers;
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** skills/<name>/SKILL.md folders of a plugin (or any folder). */
export function skillsIn(dir: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const entry of listDir(dir)) {
    const sub = path.join(dir, entry.name);
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDir(sub))) continue;
    const file = path.join(sub, "SKILL.md");
    if (!isFile(file)) continue;
    const fm = readFrontmatter(file);
    out.push({ name: fm.name ?? entry.name, dir: sub, file });
  }
  return out;
}

function hookCommands(file: string): string[] {
  const doc = readJsonBounded(file);
  const hooks = isRecord(doc) && isRecord(doc.hooks) ? doc.hooks : isRecord(doc) ? doc : undefined;
  if (hooks === undefined) return [];
  const out: string[] = [];
  const visit = (value: unknown, event: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, event);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.command === "string") out.push(`${event}: ${value.command}`);
    if (value.hooks !== undefined) visit(value.hooks, event);
  };
  for (const [event, value] of Object.entries(hooks)) visit(value, event);
  return out.slice(0, 50);
}

function pluginManifest(dir: string): Record<string, unknown> | undefined {
  for (const rel of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const doc = readJsonBounded(path.join(dir, rel));
    if (isRecord(doc)) return doc;
  }
  return undefined;
}

function relFiles(root: string, files: string[]): string[] {
  return files.map((f) => path.relative(root, f) || path.basename(f));
}

function markdownFiles(dir: string, depth = 1): string[] {
  const out: string[] = [];
  for (const entry of listDir(dir)) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && /\.(md|mdc)$/i.test(entry.name)) out.push(p);
    else if (entry.isDirectory() && depth > 0 && !entry.name.startsWith(".")) out.push(...markdownFiles(p, depth - 1));
  }
  return out.sort();
}

/** Inspects a plugin folder (manifest optional). */
function inspectPlugin(dir: string, manifest: Record<string, unknown> | undefined): Inspection {
  const skills = skillsIn(path.join(dir, "skills"));
  const servers: BundledServer[] = [];
  const mcpRef = manifest?.mcpServers;
  if (isRecord(mcpRef)) servers.push(...parseMcpServers({ mcpServers: mcpRef }));
  else if (typeof mcpRef === "string") {
    const file = safeJoin(dir, mcpRef);
    if (file !== undefined) servers.push(...parseMcpServers(readJsonBounded(file)));
  }
  if (servers.length === 0) servers.push(...parseMcpServers(readJsonBounded(path.join(dir, ".mcp.json"))));
  const hooksRef = typeof manifest?.hooks === "string" ? safeJoin(dir, manifest.hooks) : undefined;
  const hooks = hookCommands(hooksRef ?? path.join(dir, "hooks", "hooks.json"));
  const name = typeof manifest?.name === "string" ? manifest.name : undefined;
  const description = typeof manifest?.description === "string" ? manifest.description : undefined;
  const commandFiles = markdownFiles(path.join(dir, "commands"), 0);
  const agentFiles = markdownFiles(path.join(dir, "agents"), 0);
  return {
    kind: "plugin",
    root: dir,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    servers,
    skills,
    hooks,
    files: relFiles(dir, [...skills.map((s) => s.file), ...commandFiles, ...agentFiles]),
    rules: [],
  };
}

/** `rel` inside `base`, or undefined when it escapes. */
function safeJoin(base: string, rel: string): string | undefined {
  const resolved = path.resolve(base, rel.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, "."));
  const r = path.relative(base, resolved);
  return r.startsWith("..") || path.isAbsolute(r) ? undefined : resolved;
}

/**
 * What `target` is. `kindHint` resolves ambiguous folders (e.g. a plugin that
 * is also a single skill). Throws ExtensionError(400) when nothing is recognised.
 */
export function inspectPath(target: string, kindHint?: ExtensionKind): Inspection {
  const abs = path.resolve(target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ExtensionError(404, `not found: ${abs}`);
  }
  if (stat.isFile()) {
    const base = path.basename(abs);
    if (base === "SKILL.md" || base === "POWER.md") return inspectPath(path.dirname(abs), base === "SKILL.md" ? "skill" : "power");
    if (/\.(md|mdc|txt)$/i.test(base)) {
      const fm = readFrontmatter(abs);
      return {
        kind: "rule",
        root: abs,
        ...(fm.name !== undefined ? { name: fm.name } : {}),
        ...(fm.description !== undefined ? { description: fm.description } : {}),
        servers: [],
        skills: [],
        hooks: [],
        files: [base],
        rules: [abs],
      };
    }
    if (/\.json$/i.test(base)) {
      const servers = parseMcpServers(readJsonBounded(abs));
      if (servers.length > 0) return { kind: "mcp", root: path.dirname(abs), servers, skills: [], hooks: [], files: [], rules: [] };
    }
    throw new ExtensionError(400, `not an extension: ${abs} (expected a SKILL.md / POWER.md folder, a plugin, an MCP config or a Markdown rule)`);
  }

  const manifest = pluginManifest(abs);
  const has = (rel: string): boolean => isFile(path.join(abs, rel));
  const detected: ExtensionKind | undefined =
    kindHint ??
    (manifest !== undefined
      ? "plugin"
      : has("POWER.md")
        ? "power"
        : has("SKILL.md")
          ? "skill"
          : skillsIn(path.join(abs, "skills")).length > 0
            ? "plugin"
            : has(".mcp.json") || has("mcp.json")
              ? "mcp"
              : markdownFiles(abs, 0).length > 0
                ? "rule"
                : undefined);
  switch (detected) {
    case "plugin":
      return inspectPlugin(abs, manifest);
    case "power": {
      const file = path.join(abs, "POWER.md");
      if (!isFile(file)) throw new ExtensionError(400, `no POWER.md in ${abs}`);
      const fm = readFrontmatter(file);
      const steering = markdownFiles(path.join(abs, "steering"), 1);
      const servers = parseMcpServers(readJsonBounded(path.join(abs, "mcp.json")));
      const name = fm.displayName ?? fm.name;
      return {
        kind: "power",
        root: abs,
        ...(name !== undefined ? { name } : {}),
        ...(fm.description !== undefined ? { description: fm.description } : {}),
        servers,
        skills: [{ name: fm.name ?? path.basename(abs), dir: abs, file }],
        hooks: [],
        files: relFiles(abs, [file, ...steering]),
        rules: [],
      };
    }
    case "skill": {
      const file = path.join(abs, "SKILL.md");
      if (!isFile(file)) throw new ExtensionError(400, `no SKILL.md in ${abs}`);
      const fm = readFrontmatter(file);
      return {
        kind: "skill",
        root: abs,
        ...(fm.name !== undefined ? { name: fm.name } : {}),
        ...(fm.description !== undefined ? { description: fm.description } : {}),
        servers: [],
        skills: [{ name: fm.name ?? path.basename(abs), dir: abs, file }],
        hooks: [],
        files: relFiles(abs, [file, ...markdownFiles(abs, 1).filter((f) => f !== file)]),
        rules: [],
      };
    }
    case "mcp": {
      const servers = parseMcpServers(readJsonBounded(path.join(abs, ".mcp.json")));
      if (servers.length === 0) servers.push(...parseMcpServers(readJsonBounded(path.join(abs, "mcp.json"))));
      if (servers.length === 0) throw new ExtensionError(400, `no MCP servers in ${abs}`);
      return { kind: "mcp", root: abs, servers, skills: [], hooks: [], files: [], rules: [] };
    }
    case "rule": {
      const rules = markdownFiles(abs, 0);
      if (rules.length === 0) throw new ExtensionError(400, `no Markdown rules in ${abs}`);
      return { kind: "rule", root: abs, servers: [], skills: [], hooks: [], files: relFiles(abs, rules), rules };
    }
    default:
      throw new ExtensionError(400, `not an extension: ${abs} (expected SKILL.md, POWER.md, a plugin manifest, .mcp.json or Markdown rules)`);
  }
}

/** The "What it runs" part of an inspection. */
export function whatOf(inspection: Inspection | undefined, launcher: boolean): WhatItRuns {
  return {
    servers: (inspection?.servers ?? []).map((s) => ({
      name: s.name,
      transport: s.runs.type,
      ...(s.runs.type === "stdio" ? { command: s.runs.command, args: [...s.runs.args] } : { url: s.runs.url }),
      env: [...s.env],
      ...(s.runs.type !== "stdio" && s.runs.headers !== undefined ? { headers: [...s.runs.headers] } : {}),
    })),
    hooks: inspection?.hooks ?? [],
    files: inspection?.files ?? [],
    launcher,
  };
}
