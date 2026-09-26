// src/extensions/install-into.ts — "Also install into Claude Code / Cursor /
// Kiro": the only code that writes another tool's configuration, and only when
// the user asks for it, per extension and per target. Every write is recorded
// on this machine ($RUAH_HOME/extensions-installs.json, never in a committable
// file) with a hash of what was written, so Remove undoes exactly it and only
// while it is unchanged; records whose path or key is not one this module
// writes are refused.
//   MCP servers   Claude Code: <repo>/.mcp.json, or `claude mcp add-json -s user` (never
//                 ~/.claude.json directly); Cursor: .cursor/mcp.json / ~/.cursor/mcp.json;
//                 Kiro: .kiro/settings/mcp.json / ~/.kiro/settings/mcp.json. Secrets are
//                 written as references (Claude / Kiro `${NAME}`, Cursor `${env:NAME}`), never values.
//   skills        copied into the tool's skills folder (.claude/skills, .cursor/skills, .kiro/skills),
//                 a power's POWER.md becoming SKILL.md; a marker file identifies Ruah's copies.
//   rules         Claude Code .claude/rules/<id>.md, Cursor .cursor/rules/<id>.mdc (project only),
//                 Kiro .kiro/steering/<id>.md.
//   plugins       not supported (Claude Code installs plugins from marketplaces; Ruah loads them
//                 per session instead).
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { Extension, ExtensionScope, InstallRecord, InstallTarget } from "../contracts/extensions.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { defaultRunner, resolveBin, type Runner } from "../integrations/exec.js";
import type { Evaluated } from "./evaluate.js";
import { readTextBounded, stripJsonComments, type BundledServer } from "./inspect.js";
import { ExtensionError, expandPlaceholders, sha256Hex, slugify, stableStringify } from "./model.js";

const MARKER = ".ruah-installed.json";
/** ~/.claude.json holds project history too; read (never written) up to this size. */
const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface InstallContext {
  target: InstallTarget;
  targetScope: ExtensionScope;
  root: string | undefined;
  home?: string;
  runner?: Runner;
  /** The Claude Code CLI (default: `claude` on PATH). */
  claudeBin?: string | undefined;
  /** CLAUDE_CONFIG_DIR (where Claude Code keeps .claude.json). */
  env?: NodeJS.ProcessEnv;
  /** Earlier records of this extension on this machine (a re-install may replace what they wrote). */
  previous?: readonly InstallRecord[];
  now?: () => Date;
}

export interface InstallResult {
  records: InstallRecord[];
  written: string[];
  notes: string[];
}

function base(ctx: InstallContext): string {
  if (ctx.targetScope === "global") return ctx.home ?? process.env.HOME ?? homedir();
  if (ctx.root === undefined) throw new ExtensionError(409, "no project is open");
  return ctx.root;
}

function sha256(file: string): string | undefined {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** The hash an install record keeps of a JSON entry (key order does not matter). */
export function entryHash(entry: unknown): string {
  return sha256Hex(stableStringify(entry));
}

/** Claude Code's user config (`claude mcp add-json -s user` writes its mcpServers). */
export function claudeUserConfig(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir !== undefined && dir.length > 0 ? path.join(dir, ".claude.json") : path.join(home, ".claude.json");
}

/** mcpServers[name] of Claude Code's user config; undefined when absent or unreadable. */
function claudeUserServer(file: string, name: string): { found: boolean; entry?: unknown; error?: string } {
  try {
    if (!fs.existsSync(file)) return { found: false };
    if (fs.statSync(file).size > MAX_CLAUDE_JSON_BYTES) return { found: false, error: `${file} is too large to read` };
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const servers = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).mcpServers : undefined;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return { found: false };
    const entry = (servers as Record<string, unknown>)[name];
    return entry === undefined ? { found: false } : { found: true, entry };
  } catch (err) {
    return { found: false, error: `${file}: ${(err as Error).message}` };
  }
}

function envRef(target: InstallTarget, name: string): string {
  return target === "cursor" ? `\${env:${name}}` : `\${${name}}`;
}

/** The server as the target tool's mcp.json entry (secrets as references). */
function serverEntry(target: InstallTarget, server: BundledServer, vars: { project: string; home: string }, notes: string[]): Record<string, unknown> {
  const runs = server.runs;
  if (runs.type === "stdio") {
    const env: Record<string, string> = {};
    for (const name of server.env) {
      const literal = server.envValues[name];
      env[name] = literal !== undefined && !/\$\{/.test(literal) ? literal : envRef(target, name);
    }
    if (server.env.some((n) => server.envValues[n] === undefined)) {
      notes.push(`${server.name}: ${target} reads ${server.env.filter((n) => server.envValues[n] === undefined).join(", ")} from its own environment (the Keychain value is only used inside Ruah)`);
    }
    return {
      ...(target === "claude-code" ? { type: "stdio" } : {}),
      command: runs.command,
      args: runs.args.map((a) => expandPlaceholders(a, vars)),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  if ((runs.headers ?? []).length > 0) notes.push(`${server.name}: header secrets are not written; configure ${runs.headers?.join(", ")} in ${target} yourself`);
  return target === "claude-code" ? { type: runs.type, url: runs.url } : { url: runs.url, ...(runs.type === "sse" ? { transport: "sse" } : {}) };
}

function mcpFile(target: InstallTarget, scope: ExtensionScope, dir: string): string {
  switch (target) {
    case "claude-code":
      return path.join(dir, ".mcp.json");
    case "cursor":
      return path.join(dir, ".cursor", "mcp.json");
    case "kiro":
      return path.join(dir, ".kiro", "settings", "mcp.json");
  }
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = readTextBounded(file);
  if (text === undefined) throw new ExtensionError(409, `${file} is too large or unreadable`);
  try {
    const doc = JSON.parse(stripJsonComments(text)) as unknown;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("not an object");
    return doc as Record<string, unknown>;
  } catch {
    throw new ExtensionError(409, `${file} is not valid JSON; fix it first (Ruah does not overwrite it)`);
  }
}

/** Writes mcpServers[name]; false when the user already has exactly this entry (then it is theirs, not recorded). */
function mergeServer(file: string, name: string, entry: Record<string, unknown>, owned: boolean): boolean {
  const doc = readConfig(file);
  const servers = typeof doc.mcpServers === "object" && doc.mcpServers !== null && !Array.isArray(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  if (servers[name] !== undefined && !owned) {
    if (entryHash(servers[name]) === entryHash(entry)) return false;
    throw new ExtensionError(409, `${file} already has an MCP server named "${name}" (not added by Ruah)`);
  }
  servers[name] = entry;
  doc.mcpServers = servers;
  atomicWriteFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

function skillsDir(target: InstallTarget, dir: string): string {
  switch (target) {
    case "claude-code":
      return path.join(dir, ".claude", "skills");
    case "cursor":
      return path.join(dir, ".cursor", "skills");
    case "kiro":
      return path.join(dir, ".kiro", "skills");
  }
}

function inside(base: string, p: string): boolean {
  const rel = path.relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Copies a skill folder. Symbolic links are followed only while they point
 * inside the skill folder: a link to ~/.aws/credentials in a cloned skill must
 * not be copied into a repo's .claude/skills (and committed). Returns the
 * links that were skipped.
 */
function copySkill(source: string, instructions: string, dest: string, ext: Extension): string[] {
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
    throw new ExtensionError(409, `${dest} already exists (not installed by Ruah)`);
  }
  const realSource = fs.realpathSync(source);
  const skipped: string[] = [];
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (/(^|\/)(\.git|node_modules)(\/|$)/.test(path.relative(source, src))) return false;
      try {
        if (!fs.lstatSync(src).isSymbolicLink()) return true;
        if (inside(realSource, fs.realpathSync(src))) return true;
      } catch {
        // a dangling link: nothing to copy
      }
      skipped.push(path.relative(source, src));
      return false;
    },
  });
  if (path.basename(instructions) !== "SKILL.md") {
    if (!inside(realSource, fs.realpathSync(instructions))) throw new ExtensionError(409, `${instructions} points outside the skill folder`);
    fs.copyFileSync(instructions, path.join(dest, "SKILL.md"));
  }
  fs.writeFileSync(path.join(dest, MARKER), `${JSON.stringify({ by: "ruah", id: ext.id, source }, null, 2)}\n`);
  return skipped;
}

function ruleTarget(target: InstallTarget, scope: ExtensionScope, dir: string, name: string): string {
  switch (target) {
    case "claude-code":
      return path.join(dir, ".claude", "rules", `${name}.md`);
    case "cursor":
      if (scope === "global") throw new ExtensionError(422, "Cursor keeps user rules in its settings UI; install the rule into the project instead");
      return path.join(dir, ".cursor", "rules", `${name}.mdc`);
    case "kiro":
      return path.join(dir, ".kiro", "steering", `${name}.md`);
  }
}

export async function installInto(ev: Evaluated, ctx: InstallContext): Promise<InstallResult> {
  const { ext } = ev;
  if (ev.status === "missing" || ev.status === "invalid") throw new ExtensionError(409, `${ext.id} is ${ev.status}: ${ev.statusDetail ?? ""}`.trim());
  const dir = base(ctx);
  const home = ctx.home ?? process.env.HOME ?? homedir();
  const vars = { project: ctx.root ?? home, home };
  const at = (ctx.now ?? (() => new Date()))().toISOString();
  const previous = ctx.previous ?? [];
  const owns = (p: string, key?: string[]): boolean => previous.some((r) => r.path === p && (key === undefined || JSON.stringify(r.key) === JSON.stringify(key)));
  const records: InstallRecord[] = [];
  const written: string[] = [];
  const notes: string[] = [];

  const servers = ev.servers;
  if ((ext.kind === "mcp" || ext.kind === "power") && servers.length > 0) {
    for (const server of servers) {
      const entry = serverEntry(ctx.target, server, vars, notes);
      if (ctx.target === "claude-code" && ctx.targetScope === "global") {
        const bin = ctx.claudeBin ?? resolveBin("claude");
        if (bin === undefined || !path.isAbsolute(bin)) throw new ExtensionError(424, "the Claude Code CLI (`claude`) is not installed; install into the project instead (.mcp.json)");
        const configFile = claudeUserConfig(home, ctx.env);
        const before = claudeUserServer(configFile, server.name);
        if (before.found && entryHash(before.entry) !== previous.find((r) => r.type === "claude-cli" && r.key?.[1] === server.name)?.sha256) {
          if (entryHash(before.entry) === entryHash(entry)) {
            notes.push(`${server.name}: Claude Code already has this server (left as yours)`);
            continue;
          }
          throw new ExtensionError(409, `Claude Code already has an MCP server named "${server.name}" (not added by Ruah)`);
        }
        const run = ctx.runner ?? defaultRunner;
        if (before.found) await run(bin, ["mcp", "remove", "--scope", "user", "--", server.name], { timeoutMs: 30_000 });
        const result = await run(bin, ["mcp", "add-json", "--scope", "user", "--", server.name, JSON.stringify(entry)], { timeoutMs: 30_000 });
        if (result.code !== 0) throw new ExtensionError(502, `claude mcp add-json failed: ${result.stderr.trim().split("\n").slice(-1)[0] ?? `exit ${result.code}`}`);
        // Hash what Claude Code stored (it may normalise the entry), so Remove can tell it is still Ruah's.
        const after = claudeUserServer(configFile, server.name);
        if (!after.found) notes.push(`${server.name}: could not read it back from ${configFile}; Remove will ask you to remove it yourself`);
        records.push({
          target: ctx.target,
          scope: ctx.targetScope,
          path: configFile,
          type: "claude-cli",
          key: ["mcpServers", server.name],
          ...(after.found ? { sha256: entryHash(after.entry) } : {}),
          at,
        });
        written.push(`claude mcp (user): ${server.name}`);
        continue;
      }
      const file = mcpFile(ctx.target, ctx.targetScope, dir);
      const key = ["mcpServers", server.name];
      if (!mergeServer(file, server.name, entry, owns(file, key))) {
        notes.push(`${server.name}: ${file} already has this server (left as yours)`);
        continue;
      }
      records.push({ target: ctx.target, scope: ctx.targetScope, path: file, type: "json-key", key, sha256: entryHash(entry), at });
      written.push(file);
    }
  }

  if (ext.kind === "skill" || ext.kind === "power") {
    for (const skill of ev.inspection?.skills ?? []) {
      const dest = path.join(skillsDir(ctx.target, dir), slugify(skill.name));
      const skipped = copySkill(skill.dir, skill.file, dest, ext);
      if (skipped.length > 0) notes.push(`${skill.name}: not copied (links outside the skill folder): ${skipped.join(", ")}`);
      records.push({ target: ctx.target, scope: ctx.targetScope, path: dest, type: "copy", at });
      written.push(dest);
    }
  }

  if (ext.kind === "rule") {
    const files = ev.inspection?.rules ?? [];
    for (const file of files) {
      const name = files.length === 1 ? ext.id : `${ext.id}-${slugify(path.basename(file).replace(/\.(md|mdc|txt)$/i, ""))}`;
      const dest = ruleTarget(ctx.target, ctx.targetScope, dir, name);
      if (fs.existsSync(dest) && !owns(dest)) throw new ExtensionError(409, `${dest} already exists (not installed by Ruah)`);
      let text = readTextBounded(file) ?? "";
      if (ctx.target === "cursor" && !/^---\r?\n/.test(text)) text = `---\ndescription: ${ext.name.replace(/\n/g, " ")}\nalwaysApply: true\n---\n\n${text}`;
      atomicWriteFileSync(dest, text);
      records.push({ target: ctx.target, scope: ctx.targetScope, path: dest, type: "copy", sha256: sha256(dest) ?? "", at });
      written.push(dest);
    }
  }

  if (ext.kind === "plugin") {
    throw new ExtensionError(422, "plugins are loaded per session by Ruah; to install one into Claude Code itself add its marketplace (`claude plugin marketplace add <git url>`) and install it there");
  }
  if (records.length === 0 && notes.length === 0) throw new ExtensionError(422, `nothing to install for ${ext.id}`);
  return { records, written, notes };
}

/** Where each target keeps what Ruah writes (a record pointing anywhere else is refused). */
const MCP_FILE_SUFFIX: Record<InstallTarget, string> = {
  "claude-code": ".mcp.json",
  cursor: path.join(".cursor", "mcp.json"),
  kiro: path.join(".kiro", "settings", "mcp.json"),
};
const COPY_DIRS: Record<InstallTarget, string[]> = {
  "claude-code": [path.join(".claude", "skills"), path.join(".claude", "rules")],
  cursor: [path.join(".cursor", "skills"), path.join(".cursor", "rules")],
  kiro: [path.join(".kiro", "skills"), path.join(".kiro", "steering")],
};

function endsWithSegments(p: string, suffix: string): boolean {
  return p === suffix || p.endsWith(`${path.sep}${suffix}`);
}

/** Why a record is not one this module could have written, else undefined. */
function recordProblem(record: InstallRecord, claudeConfig: string): string | undefined {
  if (!path.isAbsolute(record.path) || record.path.includes("\0")) return "not an absolute path";
  const name = record.key?.[1];
  if (record.type === "json-key" || record.type === "claude-cli") {
    if (record.key?.length !== 2 || record.key[0] !== "mcpServers" || name === undefined || !SERVER_NAME.test(name)) return "not an MCP server key";
    if (record.sha256 === undefined) return "no record of what Ruah wrote";
  }
  if (record.type === "json-key" && !endsWithSegments(path.normalize(record.path), MCP_FILE_SUFFIX[record.target])) return `not ${record.target}'s MCP config`;
  if (record.type === "claude-cli" && (record.target !== "claude-code" || path.normalize(record.path) !== path.normalize(claudeConfig))) return "not Claude Code's user config";
  if (record.type === "copy" && !COPY_DIRS[record.target].some((dir) => endsWithSegments(path.dirname(path.normalize(record.path)), dir))) return `not in ${record.target}'s skills or rules folder`;
  return undefined;
}

export interface UninstallOptions {
  runner?: Runner;
  claudeBin?: string | undefined;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Undoes install records — only records of this machine's store, only in the
 * places Ruah writes, and only what is still exactly what Ruah wrote. Returns
 * notes for what was left in place.
 */
export async function uninstallRecords(records: readonly InstallRecord[], options: UninstallOptions = {}): Promise<string[]> {
  const notes: string[] = [];
  const home = options.home ?? process.env.HOME ?? homedir();
  const claudeConfig = claudeUserConfig(home, options.env);
  for (const record of records) {
    const name = record.key?.[1] ?? "";
    const problem = recordProblem(record, claudeConfig);
    if (problem !== undefined) {
      notes.push(`${record.path}: not undone (${problem})`);
      continue;
    }
    try {
      if (record.type === "claude-cli") {
        const current = claudeUserServer(claudeConfig, name);
        if (!current.found) {
          if (current.error !== undefined) notes.push(`${name}: ${current.error}; remove it from Claude Code yourself if it is still there: claude mcp remove -s user ${name}`);
          continue;
        }
        if (entryHash(current.entry) !== record.sha256) {
          notes.push(`Claude Code's "${name}" server was left in place (changed since Ruah added it)`);
          continue;
        }
        const bin = options.claudeBin ?? resolveBin("claude");
        if (bin === undefined) {
          notes.push(`remove "${name}" from Claude Code yourself: claude mcp remove -s user ${name}`);
          continue;
        }
        const result = await (options.runner ?? defaultRunner)(bin, ["mcp", "remove", "--scope", "user", "--", name], { timeoutMs: 30_000 });
        if (result.code !== 0) notes.push(`claude mcp remove ${name} failed: ${result.stderr.trim().split("\n").slice(-1)[0] ?? `exit ${result.code}`}`);
      } else if (record.type === "json-key") {
        if (!fs.existsSync(record.path)) continue;
        const doc = readConfig(record.path);
        const table = doc.mcpServers;
        if (typeof table !== "object" || table === null || Array.isArray(table)) continue;
        const servers = table as Record<string, unknown>;
        if (!(name in servers)) continue;
        if (entryHash(servers[name]) !== record.sha256) {
          notes.push(`${record.path}: "${name}" was left in place (changed since Ruah wrote it)`);
          continue;
        }
        delete servers[name];
        atomicWriteFileSync(record.path, `${JSON.stringify(doc, null, 2)}\n`);
      } else if (record.type === "copy") {
        if (!fs.existsSync(record.path)) continue;
        const stat = fs.lstatSync(record.path);
        if (stat.isDirectory()) {
          let marker: unknown;
          try {
            marker = JSON.parse(fs.readFileSync(path.join(record.path, MARKER), "utf8")) as unknown;
          } catch {
            marker = undefined;
          }
          if (typeof marker === "object" && marker !== null && (marker as { by?: unknown }).by === "ruah") fs.rmSync(record.path, { recursive: true, force: true });
          else notes.push(`${record.path} was not removed (no Ruah marker)`);
        } else if (stat.isFile() && record.sha256 !== undefined && sha256(record.path) === record.sha256) fs.rmSync(record.path, { force: true });
        else notes.push(`${record.path} was not removed (changed since Ruah wrote it)`);
      }
    } catch (err) {
      notes.push(`${record.path}: ${(err as Error).message}`);
    }
  }
  return notes;
}
