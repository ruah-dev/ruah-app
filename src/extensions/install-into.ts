// src/extensions/install-into.ts — "Also install into Claude Code / Cursor /
// Kiro": the only code that writes another tool's configuration, and only when
// the user asks for it, per extension and per target. Every write is recorded
// on the extension (installedInto) so Remove undoes exactly it.
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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { Extension, ExtensionScope, InstallRecord, InstallTarget } from "../contracts/extensions.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { defaultRunner, resolveBin, type Runner } from "../integrations/exec.js";
import type { Evaluated } from "./evaluate.js";
import { readTextBounded, stripJsonComments, type BundledServer } from "./inspect.js";
import { ExtensionError, expandPlaceholders, slugify } from "./model.js";

const MARKER = ".ruah-installed.json";

export interface InstallContext {
  target: InstallTarget;
  targetScope: ExtensionScope;
  root: string | undefined;
  home?: string;
  runner?: Runner;
  /** The Claude Code CLI (default: `claude` on PATH). */
  claudeBin?: string | undefined;
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
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
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

function mergeServer(file: string, name: string, entry: Record<string, unknown>, owned: boolean): boolean {
  const doc = readConfig(file);
  const servers = typeof doc.mcpServers === "object" && doc.mcpServers !== null && !Array.isArray(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  if (servers[name] !== undefined && !owned) {
    if (JSON.stringify(servers[name]) === JSON.stringify(entry)) return false;
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

function copySkill(source: string, instructions: string, dest: string, ext: Extension): void {
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
    throw new ExtensionError(409, `${dest} already exists (not installed by Ruah)`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(path.relative(source, src)),
  });
  if (path.basename(instructions) !== "SKILL.md") fs.copyFileSync(instructions, path.join(dest, "SKILL.md"));
  fs.writeFileSync(path.join(dest, MARKER), `${JSON.stringify({ by: "ruah", id: ext.id, source }, null, 2)}\n`);
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
  const previous = ext.installedInto ?? [];
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
        const run = ctx.runner ?? defaultRunner;
        const result = await run(bin, ["mcp", "add-json", "--scope", "user", "--", server.name, JSON.stringify(entry)], { timeoutMs: 30_000 });
        if (result.code !== 0) throw new ExtensionError(502, `claude mcp add-json failed: ${result.stderr.trim().split("\n").slice(-1)[0] ?? `exit ${result.code}`}`);
        records.push({ target: ctx.target, scope: ctx.targetScope, path: path.join(home, ".claude.json"), type: "claude-cli", key: ["mcpServers", server.name], at });
        written.push(`claude mcp (user): ${server.name}`);
        continue;
      }
      const file = mcpFile(ctx.target, ctx.targetScope, dir);
      const key = ["mcpServers", server.name];
      mergeServer(file, server.name, entry, owns(file, key));
      records.push({ target: ctx.target, scope: ctx.targetScope, path: file, type: "json-key", key, at });
      written.push(file);
    }
  }

  if (ext.kind === "skill" || ext.kind === "power") {
    for (const skill of ev.inspection?.skills ?? []) {
      const dest = path.join(skillsDir(ctx.target, dir), slugify(skill.name));
      copySkill(skill.dir, skill.file, dest, ext);
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
  if (records.length === 0) throw new ExtensionError(422, `nothing to install for ${ext.id}`);
  return { records, written, notes };
}

/** Undoes install records (only what Ruah wrote and that is still unchanged). Returns notes for what was left. */
export async function uninstallRecords(records: readonly InstallRecord[], options: { runner?: Runner; claudeBin?: string | undefined } = {}): Promise<string[]> {
  const notes: string[] = [];
  for (const record of records) {
    try {
      if (record.type === "claude-cli") {
        const bin = options.claudeBin ?? resolveBin("claude");
        const name = record.key?.[1];
        if (bin === undefined || name === undefined) {
          notes.push(`remove "${name ?? "?"}" from Claude Code yourself: claude mcp remove -s user ${name ?? ""}`);
          continue;
        }
        await (options.runner ?? defaultRunner)(bin, ["mcp", "remove", "--scope", "user", "--", name], { timeoutMs: 30_000 });
      } else if (record.type === "json-key") {
        if (!fs.existsSync(record.path) || record.key === undefined) continue;
        const doc = readConfig(record.path);
        const [section, name] = record.key;
        const table = section !== undefined ? doc[section] : undefined;
        if (name === undefined || typeof table !== "object" || table === null) continue;
        const servers = table as Record<string, unknown>;
        if (!(name in servers)) continue;
        delete servers[name];
        atomicWriteFileSync(record.path, `${JSON.stringify(doc, null, 2)}\n`);
      } else if (record.type === "copy") {
        if (!fs.existsSync(record.path)) continue;
        if (fs.statSync(record.path).isDirectory()) {
          if (fs.existsSync(path.join(record.path, MARKER))) fs.rmSync(record.path, { recursive: true, force: true });
          else notes.push(`${record.path} was not removed (no Ruah marker)`);
        } else if (record.sha256 !== undefined && sha256(record.path) === record.sha256) fs.rmSync(record.path, { force: true });
        else notes.push(`${record.path} was not removed (changed since Ruah wrote it)`);
      }
    } catch (err) {
      notes.push(`${record.path}: ${(err as Error).message}`);
    }
  }
  return notes;
}
