// src/extensions/inspect.ts — what a folder or file on disk is and what it
// would run, read without executing anything. Layouts understood:
//   skill   <dir>/SKILL.md (Agent Skills: Claude, Cursor, Kiro, OpenCode, Grok)
//   power   <dir>/POWER.md (+ mcp.json, steering/*.md) — Kiro powers
//   plugin  <dir>/.claude-plugin/plugin.json or .cursor-plugin/plugin.json (+ skills/, commands/,
//           agents/, hooks/hooks.json, .mcp.json, .lsp.json, monitors/monitors.json, settings.json)
//           — Claude Code / Cursor / Grok plugins; a folder of skills/<name>/SKILL.md without a
//           manifest counts as a plugin too. What it runs is read the way Claude Code's loader
//           reads it (hooks/hooks.json always, plus manifest `hooks` as a path, an object or a
//           list; .mcp.json always, merged with manifest `mcpServers` in any form; LSP servers,
//           monitors, the subagent status line). A form Ruah does not understand makes the
//           plugin invalid (fail closed) instead of being skipped.
//   mcp     <dir>/.mcp.json or mcp.json with exactly one server (or a .json file)
//   rule    a .md / .mdc file, or a folder of them
// Reads are bounded (256 KiB per file, 200 entries per folder).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionKind, McpRuns, WhatItRuns } from "../contracts/extensions.js";
import { parseYaml, yamlGet, yamlString, type YamlValue } from "../scan/mini-yaml.js";
import { ExtensionError, sha256Hex, stableStringify } from "./model.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
/** Script files hashed into the digest: at most this many, each read up to this size. */
const MAX_SCRIPT_FILES = 64;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_LINES = 50;

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
  /**
   * Hash of the runnable configuration as read (servers, hooks, LSP servers,
   * monitors, settings) and of the files its commands point to inside the
   * folder; part of the fingerprint, so an edited script needs a new approval.
   */
  digest?: string;
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
  return parseServerTable(table, false);
}

/**
 * Servers of a `{ name: {...} }` table. `strict`: an entry that is neither a
 * command nor a URL server throws (what an agent would run must be understood).
 */
function parseServerTable(table: Record<string, unknown>, strict: boolean): BundledServer[] {
  const servers: BundledServer[] = [];
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) {
      if (strict) throw new ExtensionError(400, `MCP server "${name}" is not an object`);
      continue;
    }
    if (strict && typeof raw.type === "string" && !["stdio", "http", "sse", "streamable-http"].includes(raw.type)) {
      throw new ExtensionError(400, `MCP server "${name}" uses transport "${raw.type}", which Ruah cannot show or check`);
    }
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
    } else if (strict) throw new ExtensionError(400, `MCP server "${name}" has neither a command nor a URL`);
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

function pluginManifests(dir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rel of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    const doc = readJsonBounded(file);
    // A manifest that exists but cannot be read would hide what the agent loads from it.
    if (!isRecord(doc)) throw new ExtensionError(400, `${rel} is not a readable JSON object`);
    out.push(doc);
  }
  return out;
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

/** `rel` inside `base` (after `${CLAUDE_PLUGIN_ROOT}` and symlinks), or undefined when it escapes. */
function safeJoin(base: string, rel: string): string | undefined {
  const resolved = path.resolve(base, rel.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, "."));
  const r = path.relative(base, resolved);
  if (r.startsWith("..") || path.isAbsolute(r)) return undefined;
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(resolved);
    const rr = path.relative(realBase, real);
    if (rr.startsWith("..") || path.isAbsolute(rr)) return undefined;
  } catch {
    // does not exist (yet): the lexical check above is what applies
  }
  return resolved;
}

/**
 * A JSON(C) file of a plugin. undefined when it does not exist; throws
 * (fail closed) when it points outside the folder, is too large or does not
 * parse — the agent's own loader might still read something from it.
 */
function readPluginJson(dir: string, rel: string, label: string): { rel: string; doc: unknown } | undefined {
  const file = safeJoin(dir, rel);
  if (file === undefined) throw new ExtensionError(400, `${label} ${rel} points outside the plugin folder`);
  if (!fs.existsSync(file)) return undefined;
  const text = readTextBounded(file);
  if (text === undefined) throw new ExtensionError(400, `${label} ${rel} cannot be read (not a file, or larger than 256 KiB)`);
  try {
    return { rel: path.relative(dir, file), doc: JSON.parse(stripJsonComments(text)) as unknown };
  } catch {
    throw new ExtensionError(400, `${label} ${rel} is not valid JSON`);
  }
}

/** A manifest field that may be one value or a list of them. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * One line per hook of an events table: Claude Code's `{ Event: [ { matcher,
 * hooks: [ {type, command…} ] } ] }` or Cursor's `{ event: [ { command } ] }`
 * (either may sit under a top-level `hooks` key, next to `version` /
 * `description`). Anything else that could define a hook throws.
 */
function hookLines(events: unknown, where: string): string[] {
  const table = isRecord(events) && isRecord(events.hooks) ? events.hooks : events;
  if (!isRecord(table)) throw new ExtensionError(400, `${where}: hooks must be an object of events`);
  const out: string[] = [];
  const describe = (event: string, hook: unknown): string => {
    if (!isRecord(hook)) throw new ExtensionError(400, `${where}: hooks.${event} has a hook Ruah cannot read`);
    const type = typeof hook.type === "string" ? hook.type : "command";
    if (typeof hook.command === "string") {
      const args = Array.isArray(hook.args) ? hook.args.map((a) => String(a)) : [];
      return `${event}: ${[hook.command, ...args].join(" ")}`;
    }
    if (typeof hook.url === "string") return `${event}: ${type.toUpperCase()} ${hook.url}`;
    if (type === "prompt" || type === "agent") return `${event}: ${type} hook (asks the model)`;
    throw new ExtensionError(400, `${where}: a ${type} hook on ${event} has no command Ruah can show`);
  };
  for (const [event, entries] of Object.entries(table)) {
    // Scalars (a file's version, description, $schema) cannot define a hook.
    if (typeof entries === "string" || typeof entries === "number" || typeof entries === "boolean" || entries === null) continue;
    if (!Array.isArray(entries)) throw new ExtensionError(400, `${where}: hooks.${event} must be a list`);
    for (const entry of entries) {
      if (isRecord(entry) && Array.isArray(entry.hooks)) for (const hook of entry.hooks) out.push(describe(event, hook));
      else out.push(describe(event, entry));
    }
  }
  return out;
}

/** Tokens of a command line / argument that point to a file inside `root`. */
function referencedFiles(root: string, values: readonly string[], pluginRoot: boolean): string[] {
  const out: string[] = [];
  for (const value of values) {
    const expanded = pluginRoot ? value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root) : value;
    for (const token of expanded.split(/[\s"'`;&|()<>=]+/)) {
      if (token.length === 0 || token.length > 1024 || token.startsWith("-")) continue;
      const candidate = path.isAbsolute(token) ? token : /[/\\]|\.[A-Za-z0-9]{1,8}$/.test(token) ? path.resolve(root, token) : undefined;
      if (candidate === undefined) continue;
      const rel = path.relative(root, candidate);
      if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (isFile(candidate)) out.push(candidate);
    }
  }
  return out;
}

function fileHash(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, MAX_SCRIPT_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return `${sha256Hex(buf)}:${size}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "unreadable";
  }
}

/** Hash of the runnable config plus the content of the files its commands point to inside `root`. */
function digestOf(root: string, config: unknown, commandValues: readonly string[], pluginRoot: boolean): string {
  const files: Record<string, string> = {};
  for (const file of [...new Set(referencedFiles(root, commandValues, pluginRoot))].sort().slice(0, MAX_SCRIPT_FILES)) {
    files[path.relative(root, file)] = fileHash(file);
  }
  return sha256Hex(stableStringify({ config, files })).slice(0, 32);
}

/** Every string a server runs with (command, args, env and header values), for digestOf. */
function serverValues(servers: readonly BundledServer[]): string[] {
  return servers.flatMap((s) => [
    ...(s.runs.type === "stdio" ? [s.runs.command, ...s.runs.args] : [s.runs.url]),
    ...Object.values(s.envValues),
  ]);
}

/** The manifest fields that make a plugin run something (hashed whole, whatever their form). */
const RUNNABLE_MANIFEST_KEYS = ["hooks", "mcpServers", "lspServers", "monitors", "settings", "experimental", "userConfig", "channels", "dependencies"];

/** Inspects a plugin folder (manifest optional), reading what it runs the way Claude Code's plugin loader does. */
function inspectPlugin(dir: string): Inspection {
  const manifests = pluginManifests(dir);
  const first = manifests[0];
  const skills = skillsIn(path.join(dir, "skills"));
  const config: Record<string, unknown> = {
    manifests: manifests.map((m) => Object.fromEntries(RUNNABLE_MANIFEST_KEYS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]))),
  };
  const commandValues: string[] = [];

  // MCP servers: .mcp.json (always), then each manifest's mcpServers (a path, an object, or a list of them); later names win.
  const table: Record<string, unknown> = {};
  const std = readPluginJson(dir, ".mcp.json", ".mcp.json");
  if (std !== undefined) {
    const doc = std.doc;
    const map = isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : doc;
    if (!isRecord(map)) throw new ExtensionError(400, ".mcp.json must be an object of servers");
    Object.assign(table, map);
    config.mcpFile = doc;
  }
  const mcpFiles: unknown[] = [];
  for (const manifest of manifests) {
    if (manifest.mcpServers === undefined) continue;
    for (const item of listOf(manifest.mcpServers)) {
      if (typeof item === "string") {
        if (/\.(mcpb|dxt)$/i.test(item) || /^https?:\/\//i.test(item)) throw new ExtensionError(400, `mcpServers "${item}": MCP bundles are not supported; Ruah cannot show what they run`);
        const file = readPluginJson(dir, item, "mcpServers file");
        if (file === undefined) continue;
        const map = isRecord(file.doc) && isRecord(file.doc.mcpServers) ? file.doc.mcpServers : file.doc;
        if (!isRecord(map)) throw new ExtensionError(400, `mcpServers file ${item} must be an object of servers`);
        Object.assign(table, map);
        mcpFiles.push(file.doc);
      } else if (isRecord(item)) Object.assign(table, item);
      else throw new ExtensionError(400, "manifest mcpServers must be a path, an object of servers, or a list of them");
    }
  }
  config.mcpFiles = mcpFiles;
  const servers = parseServerTable(table, true);
  commandValues.push(...serverValues(servers));

  // Hooks: hooks/hooks.json (always), then each manifest's hooks (a path, an inline object, or a list of them).
  const hooks: string[] = [];
  const hookDocs: unknown[] = [];
  const stdHooks = readPluginJson(dir, "hooks/hooks.json", "hooks file");
  const loadedHookFiles = new Set<string>();
  if (stdHooks !== undefined) {
    hooks.push(...hookLines(stdHooks.doc, "hooks/hooks.json"));
    hookDocs.push(stdHooks.doc);
    loadedHookFiles.add(path.normalize(stdHooks.rel));
  }
  for (const manifest of manifests) {
    if (manifest.hooks === undefined) continue;
    for (const item of listOf(manifest.hooks)) {
      if (typeof item === "string") {
        const file = readPluginJson(dir, item, "hooks file");
        if (file === undefined || loadedHookFiles.has(path.normalize(file.rel))) continue;
        loadedHookFiles.add(path.normalize(file.rel));
        hooks.push(...hookLines(file.doc, item));
        hookDocs.push(file.doc);
      } else if (isRecord(item)) {
        hooks.push(...hookLines(item, "plugin.json hooks"));
        hookDocs.push(item);
      } else throw new ExtensionError(400, "manifest hooks must be a path, an object of events, or a list of them");
    }
  }
  config.hooks = hookDocs;

  // LSP servers: .lsp.json, then each manifest's lspServers (a path, an object, or a list of them).
  const lsp: Record<string, unknown> = {};
  const lspDocs: unknown[] = [];
  const addLsp = (doc: unknown, where: string): void => {
    const map = isRecord(doc) && isRecord(doc.lspServers) ? doc.lspServers : doc;
    if (!isRecord(map)) throw new ExtensionError(400, `${where} must be an object of LSP servers`);
    Object.assign(lsp, map);
    lspDocs.push(doc);
  };
  const stdLsp = readPluginJson(dir, ".lsp.json", ".lsp.json");
  if (stdLsp !== undefined) addLsp(stdLsp.doc, ".lsp.json");
  for (const manifest of manifests) {
    if (manifest.lspServers === undefined) continue;
    for (const item of listOf(manifest.lspServers)) {
      if (typeof item === "string") {
        const file = readPluginJson(dir, item, "lspServers file");
        if (file !== undefined) addLsp(file.doc, item);
      } else if (isRecord(item)) addLsp(item, "manifest lspServers");
      else throw new ExtensionError(400, "manifest lspServers must be a path, an object of servers, or a list of them");
    }
  }
  config.lsp = lspDocs;
  for (const [name, raw] of Object.entries(lsp)) {
    if (!isRecord(raw) || typeof raw.command !== "string") throw new ExtensionError(400, `LSP server "${name}" has no command Ruah can show`);
    const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [];
    hooks.push(`LSP server ${name}: ${[raw.command, ...args].join(" ")}`);
    commandValues.push(raw.command, ...args, ...Object.values(stringRecord(raw.env)));
  }

  // Monitors: each manifest's (experimental.)monitors (a path or an inline list), else monitors/monitors.json.
  const monitorDocs: unknown[] = [];
  for (const manifest of manifests.length > 0 ? manifests : [{}]) {
    const experimental = isRecord(manifest.experimental) ? manifest.experimental : undefined;
    const ref = experimental?.monitors ?? manifest.monitors;
    let list: unknown;
    if (ref === undefined) list = readPluginJson(dir, "monitors/monitors.json", "monitors file")?.doc;
    else if (typeof ref === "string") list = readPluginJson(dir, ref, "monitors file")?.doc;
    else list = ref;
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new ExtensionError(400, "monitors must be a list");
    monitorDocs.push(list);
    for (const monitor of list) {
      if (!isRecord(monitor) || typeof monitor.command !== "string") throw new ExtensionError(400, "a monitor has no command Ruah can show");
      hooks.push(`Monitor ${typeof monitor.name === "string" ? monitor.name : "?"}: ${monitor.command}`);
      commandValues.push(monitor.command);
    }
  }
  config.monitors = monitorDocs;

  // Settings (settings.json, else each manifest's settings): the subagent status line runs a command.
  const settingsFile = readPluginJson(dir, "settings.json", "settings.json")?.doc;
  const settingsDocs = settingsFile !== undefined ? [settingsFile] : manifests.map((m) => m.settings).filter((v) => v !== undefined);
  config.settings = settingsDocs;
  for (const settings of settingsDocs) {
    if (!isRecord(settings)) throw new ExtensionError(400, "plugin settings must be an object");
    const line = settings.subagentStatusLine;
    if (line === undefined) continue;
    if (!isRecord(line) || typeof line.command !== "string") throw new ExtensionError(400, "subagentStatusLine has no command Ruah can show");
    hooks.push(`Subagent status line: ${line.command}`);
    commandValues.push(line.command);
  }

  // What hooks run lives in hook commands; hash the files they (and the servers) point to.
  commandValues.push(...hooks);
  const shown = hooks.length > MAX_LINES ? [...hooks.slice(0, MAX_LINES), `… and ${hooks.length - MAX_LINES} more`] : hooks;
  const name = typeof first?.name === "string" ? first.name : undefined;
  const description = typeof first?.description === "string" ? first.description : undefined;
  const commandFiles = markdownFiles(path.join(dir, "commands"), 0);
  const agentFiles = markdownFiles(path.join(dir, "agents"), 0);
  return {
    kind: "plugin",
    root: dir,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    servers,
    skills,
    hooks: shown,
    files: relFiles(dir, [...skills.map((s) => s.file), ...commandFiles, ...agentFiles]),
    rules: [],
    digest: digestOf(dir, config, commandValues, true),
  };
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
      const doc = readJsonBounded(abs);
      const servers = parseMcpServers(doc);
      if (servers.length > 0) {
        const root = path.dirname(abs);
        return { kind: "mcp", root, servers, skills: [], hooks: [], files: [], rules: [], digest: digestOf(root, doc, serverValues(servers), false) };
      }
    }
    throw new ExtensionError(400, `not an extension: ${abs} (expected a SKILL.md / POWER.md folder, a plugin, an MCP config or a Markdown rule)`);
  }

  const has = (rel: string): boolean => isFile(path.join(abs, rel));
  const detected: ExtensionKind | undefined =
    kindHint ??
    (has(".claude-plugin/plugin.json") || has(".cursor-plugin/plugin.json")
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
      return inspectPlugin(abs);
    case "power": {
      const file = path.join(abs, "POWER.md");
      if (!isFile(file)) throw new ExtensionError(400, `no POWER.md in ${abs}`);
      const fm = readFrontmatter(file);
      const steering = markdownFiles(path.join(abs, "steering"), 1);
      const mcpDoc = readPluginJson(abs, "mcp.json", "mcp.json")?.doc;
      const mcpTable = isRecord(mcpDoc) && isRecord(mcpDoc.mcpServers) ? mcpDoc.mcpServers : undefined;
      if (mcpDoc !== undefined && mcpTable === undefined) throw new ExtensionError(400, "mcp.json has no mcpServers object");
      const servers = mcpTable !== undefined ? parseServerTable(mcpTable, true) : [];
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
        digest: digestOf(abs, mcpDoc ?? null, serverValues(servers), false),
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
      let doc: unknown;
      for (const rel of [".mcp.json", "mcp.json"]) {
        doc = readPluginJson(abs, rel, rel)?.doc;
        if (doc !== undefined) break;
      }
      const table = isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : undefined;
      const servers = table !== undefined ? parseServerTable(table, true) : [];
      if (servers.length === 0) throw new ExtensionError(400, `no MCP servers in ${abs}`);
      return { kind: "mcp", root: abs, servers, skills: [], hooks: [], files: [], rules: [], digest: digestOf(abs, doc, serverValues(servers), false) };
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
