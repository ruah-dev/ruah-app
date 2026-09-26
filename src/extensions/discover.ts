// src/extensions/discover.ts — read-only discovery of what each agent already
// has on its own (its MCP configs, skills, plugins, rules), so the Per agent
// view shows the whole picture next to what Ruah injects. Only names,
// commands, args, URLs and env var NAMES are read out — never values. Nothing
// is written and no CLI is run (installation is probed on disk).
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { AgentDiscovery, DiscoveredItem, ExtensionAgent, ExtensionScope } from "../contracts/extensions.js";
import { EXTENSION_AGENTS } from "../contracts/extensions.js";
import { agentDefinition } from "../acp/presets.js";
import { parseToml, isTable, tomlString, tomlStrings, type TomlTable } from "../scan/mini-toml.js";
import { parseMcpServers, readFrontmatter, readTextBounded, skillsIn, stripJsonComments, type BundledServer } from "./inspect.js";
import { AGENT_NAMES, redactArgs, redactUrl } from "./model.js";

const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;

export interface DiscoverOptions {
  root?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Only these agents (default: all). */
  agents?: readonly ExtensionAgent[];
}

class Collector {
  readonly looked: string[] = [];
  readonly items: DiscoveredItem[] = [];
  readonly errors: string[] = [];

  look(p: string): boolean {
    this.looked.push(p);
    return fs.existsSync(p);
  }

  servers(file: string, servers: BundledServer[], scope: ExtensionScope, disabled: ReadonlySet<string> = new Set()): void {
    for (const s of servers) {
      this.items.push({
        kind: "mcp",
        name: s.name,
        scope,
        source: file,
        runs: {
          name: s.name,
          transport: s.runs.type,
          ...(s.runs.type === "stdio" ? { command: s.runs.command, args: redactArgs(s.runs.args) } : { url: redactUrl(s.runs.url) }),
          env: s.env,
          ...(s.runs.type !== "stdio" && s.runs.headers !== undefined ? { headers: s.runs.headers } : {}),
        },
        ...(disabled.has(s.name) ? { enabled: false } : {}),
      });
    }
  }

  mcpJson(file: string, scope: ExtensionScope): void {
    if (!this.look(file)) return;
    const doc = readJson(file, this.errors);
    const disabled = new Set<string>();
    const table = isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : {};
    for (const [name, raw] of Object.entries(table)) if (isRecord(raw) && raw.disabled === true) disabled.add(name);
    this.servers(file, parseMcpServers(doc), scope, disabled);
  }

  skills(dir: string, scope: ExtensionScope): void {
    if (!this.look(dir)) return;
    for (const skill of skillsIn(dir)) {
      const fm = readFrontmatter(skill.file);
      this.items.push({ kind: "skill", name: skill.name, scope, source: skill.dir, ...(fm.description !== undefined ? { description: fm.description } : {}) });
    }
  }

  rules(dir: string, scope: ExtensionScope, pattern = /\.(md|mdc)$/i): void {
    if (!this.look(dir)) return;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((n) => pattern.test(n)).sort().slice(0, 100);
    } catch {
      return;
    }
    for (const name of entries) {
      const file = path.join(dir, name);
      const fm = readFrontmatter(file);
      this.items.push({ kind: "rule", name: name.replace(/\.(md|mdc)$/i, ""), scope, source: file, ...(fm.description !== undefined ? { description: fm.description } : {}) });
    }
  }

  file(kind: DiscoveredItem["kind"], file: string, scope: ExtensionScope, name = path.basename(file)): void {
    if (this.look(file)) this.items.push({ kind, name, scope, source: file });
  }

  plugins(dir: string, scope: ExtensionScope): void {
    if (!this.look(dir)) return;
    for (const name of safeReaddir(dir)) {
      const pluginDir = path.join(dir, name);
      const manifest = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"].map((rel) => path.join(pluginDir, rel)).find((f) => fs.existsSync(f));
      if (manifest === undefined) continue;
      const doc = readJson(manifest, this.errors);
      const pluginName = isRecord(doc) && typeof doc.name === "string" ? doc.name : name;
      const description = isRecord(doc) && typeof doc.description === "string" ? doc.description : undefined;
      this.items.push({ kind: "plugin", name: pluginName, scope, source: pluginDir, ...(description !== undefined ? { description } : {}) });
    }
  }

  result(id: ExtensionAgent, installed: boolean): AgentDiscovery {
    return { id, name: AGENT_NAMES[id], installed, looked: this.looked, items: this.items, errors: this.errors };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().slice(0, 200);
  } catch {
    return [];
  }
}

function readJson(file: string, errors: string[], maxBytes?: number): unknown {
  try {
    if (maxBytes !== undefined) {
      if (fs.statSync(file).size > maxBytes) {
        errors.push(`${file}: too large to read`);
        return undefined;
      }
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    }
    const text = readTextBounded(file);
    if (text === undefined) return undefined;
    return JSON.parse(stripJsonComments(text)) as unknown;
  } catch {
    errors.push(`${file}: not valid JSON`);
    return undefined;
  }
}

function realRoot(root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function discoverClaude(home: string, root: string | undefined, env: NodeJS.ProcessEnv): Collector {
  const c = new Collector();
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  // ~/.claude.json: user-scope servers and the per-project ("local") ones. Only mcpServers is read out.
  const claudeJson = env.CLAUDE_CONFIG_DIR?.trim() ? path.join(configDir, ".claude.json") : path.join(home, ".claude.json");
  if (c.look(claudeJson)) {
    const doc = readJson(claudeJson, c.errors, MAX_CLAUDE_JSON_BYTES);
    if (isRecord(doc)) {
      c.servers(claudeJson, parseMcpServers(doc), "global");
      const projects = isRecord(doc.projects) ? doc.projects : {};
      const real = realRoot(root);
      for (const key of [root, real]) {
        if (key === undefined) continue;
        const entry = projects[key];
        if (isRecord(entry)) {
          c.servers(`${claudeJson} (projects["${key}"])`, parseMcpServers(entry), "project");
          break;
        }
      }
    }
  }
  if (root !== undefined) c.mcpJson(path.join(root, ".mcp.json"), "project");
  c.skills(path.join(configDir, "skills"), "global");
  if (root !== undefined) c.skills(path.join(root, ".claude", "skills"), "project");
  // Installed plugins (marketplace installs) + their enabled state from settings.json.
  const installed = path.join(configDir, "plugins", "installed_plugins.json");
  if (c.look(installed)) {
    const doc = readJson(installed, c.errors);
    const settings = readJson(path.join(configDir, "settings.json"), []);
    const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
    const plugins = isRecord(doc) && isRecord(doc.plugins) ? doc.plugins : {};
    for (const [key, installs] of Object.entries(plugins)) {
      const first = Array.isArray(installs) ? installs.find(isRecord) : undefined;
      const source = first !== undefined && typeof first.installPath === "string" ? first.installPath : installed;
      c.items.push({ kind: "plugin", name: key, scope: "global", source, ...(enabled[key] === false ? { enabled: false } : {}) });
    }
  }
  c.rules(path.join(configDir, "rules"), "global");
  c.file("rule", path.join(configDir, "CLAUDE.md"), "global");
  if (root !== undefined) {
    c.rules(path.join(root, ".claude", "rules"), "project");
    c.file("rule", path.join(root, "CLAUDE.md"), "project");
  }
  return c;
}

function discoverCursor(home: string, root: string | undefined): Collector {
  const c = new Collector();
  c.mcpJson(path.join(home, ".cursor", "mcp.json"), "global");
  if (root !== undefined) c.mcpJson(path.join(root, ".cursor", "mcp.json"), "project");
  c.skills(path.join(home, ".cursor", "skills"), "global");
  if (root !== undefined) c.skills(path.join(root, ".cursor", "skills"), "project");
  c.plugins(path.join(home, ".cursor", "plugins", "local"), "global");
  if (root !== undefined) c.rules(path.join(root, ".cursor", "rules"), "project");
  return c;
}

function discoverKiro(home: string, root: string | undefined): Collector {
  const c = new Collector();
  c.mcpJson(path.join(home, ".kiro", "settings", "mcp.json"), "global");
  if (root !== undefined) c.mcpJson(path.join(root, ".kiro", "settings", "mcp.json"), "project");
  c.skills(path.join(home, ".kiro", "skills"), "global");
  if (root !== undefined) c.skills(path.join(root, ".kiro", "skills"), "project");
  c.rules(path.join(home, ".kiro", "steering"), "global");
  if (root !== undefined) c.rules(path.join(root, ".kiro", "steering"), "project");
  // Custom agents can carry their own mcpServers.
  const agentDirs: [string, ExtensionScope][] = [[path.join(home, ".kiro", "agents"), "global"]];
  if (root !== undefined) agentDirs.push([path.join(root, ".kiro", "agents"), "project"]);
  for (const [dir, scope] of agentDirs) {
    if (!c.look(dir)) continue;
    for (const name of safeReaddir(dir).filter((n) => n.endsWith(".json"))) {
      const file = path.join(dir, name);
      c.servers(`${file}`, parseMcpServers(readJson(file, c.errors)), scope);
    }
  }
  // Powers: folders with a POWER.md anywhere two levels under ~/.kiro/powers.
  const powers = path.join(home, ".kiro", "powers");
  if (c.look(powers)) {
    const candidates = safeReaddir(powers).flatMap((n) => [path.join(powers, n), ...safeReaddir(path.join(powers, n)).map((m) => path.join(powers, n, m))]);
    for (const dir of candidates) {
      const file = path.join(dir, "POWER.md");
      if (!fs.existsSync(file)) continue;
      const fm = readFrontmatter(file);
      c.items.push({ kind: "power", name: fm.displayName ?? fm.name ?? path.basename(dir), scope: "global", source: dir, ...(fm.description !== undefined ? { description: fm.description } : {}) });
    }
  }
  return c;
}

function openCodeServers(file: string, c: Collector, scope: ExtensionScope): void {
  if (!c.look(file)) return;
  const doc = readJson(file, c.errors);
  const table = isRecord(doc) && isRecord(doc.mcp) ? doc.mcp : {};
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    const env = isRecord(raw.environment) ? Object.keys(raw.environment) : [];
    const disabled = raw.enabled === false;
    if (Array.isArray(raw.command)) {
      const [command, ...args] = raw.command.filter((a): a is string => typeof a === "string");
      if (command === undefined) continue;
      c.items.push({ kind: "mcp", name, scope, source: file, runs: { name, transport: "stdio", command, args: redactArgs(args), env }, ...(disabled ? { enabled: false } : {}) });
    } else if (typeof raw.url === "string") {
      const headers = isRecord(raw.headers) ? Object.keys(raw.headers) : [];
      c.items.push({ kind: "mcp", name, scope, source: file, runs: { name, transport: "http", url: redactUrl(raw.url), env: [], ...(headers.length > 0 ? { headers } : {}) }, ...(disabled ? { enabled: false } : {}) });
    }
  }
  const plugins = isRecord(doc) && Array.isArray(doc.plugin) ? doc.plugin.filter((p): p is string => typeof p === "string") : [];
  for (const p of plugins) c.items.push({ kind: "plugin", name: p, scope, source: file });
}

function discoverOpenCode(home: string, root: string | undefined, env: NodeJS.ProcessEnv): Collector {
  const c = new Collector();
  const configDir = env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, "opencode") : path.join(home, ".config", "opencode");
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) openCodeServers(path.join(configDir, name), c, "global");
  if (root !== undefined) {
    for (const name of ["opencode.json", "opencode.jsonc"]) openCodeServers(path.join(root, name), c, "project");
    openCodeServers(path.join(root, ".opencode", "opencode.json"), c, "project");
  }
  c.skills(path.join(configDir, "skills"), "global");
  if (root !== undefined) c.skills(path.join(root, ".opencode", "skills"), "project");
  c.file("rule", path.join(configDir, "AGENTS.md"), "global");
  if (root !== undefined) c.file("rule", path.join(root, "AGENTS.md"), "project");
  return c;
}

function grokServers(file: string, c: Collector, scope: ExtensionScope): void {
  if (!c.look(file)) return;
  const text = readTextBounded(file);
  if (text === undefined) return;
  let doc: TomlTable;
  try {
    doc = parseToml(text);
  } catch {
    c.errors.push(`${file}: not valid TOML`);
    return;
  }
  const table = doc.mcp_servers;
  if (!isTable(table)) return;
  for (const [name, raw] of Object.entries(table)) {
    if (!isTable(raw)) continue;
    const command = tomlString(raw.command);
    const url = tomlString(raw.url);
    const env = isTable(raw.env) ? Object.keys(raw.env) : [];
    const disabled = raw.enabled === false;
    if (command !== undefined) {
      c.items.push({ kind: "mcp", name, scope, source: file, runs: { name, transport: "stdio", command, args: redactArgs(tomlStrings(raw.args)), env }, ...(disabled ? { enabled: false } : {}) });
    } else if (url !== undefined) {
      const headers = isTable(raw.headers) ? Object.keys(raw.headers) : [];
      c.items.push({ kind: "mcp", name, scope, source: file, runs: { name, transport: "http", url: redactUrl(url), env: [], ...(headers.length > 0 ? { headers } : {}) }, ...(disabled ? { enabled: false } : {}) });
    }
  }
}

function discoverGrok(home: string, root: string | undefined): Collector {
  const c = new Collector();
  grokServers(path.join(home, ".grok", "config.toml"), c, "global");
  if (root !== undefined) grokServers(path.join(root, ".grok", "config.toml"), c, "project");
  c.skills(path.join(home, ".grok", "skills"), "global");
  if (root !== undefined) c.skills(path.join(root, ".grok", "skills"), "project");
  c.plugins(path.join(home, ".grok", "plugins"), "global");
  if (root !== undefined) c.plugins(path.join(root, ".grok", "plugins"), "project");
  return c;
}

function isInstalled(agent: ExtensionAgent, env: NodeJS.ProcessEnv): boolean {
  if (agent === "claude") return true; // the Agent SDK ships its own CLI
  return agentDefinition(agent)?.preset(env) !== undefined;
}

export function discoverAgents(options: DiscoverOptions = {}): AgentDiscovery[] {
  const env = options.env ?? process.env;
  const home = env.HOME ?? homedir();
  const root = options.root;
  const wanted = options.agents ?? EXTENSION_AGENTS;
  return wanted.map((agent) => {
    let c: Collector;
    switch (agent) {
      case "claude":
        c = discoverClaude(home, root, env);
        break;
      case "cursor":
        c = discoverCursor(home, root);
        break;
      case "kiro":
        c = discoverKiro(home, root);
        break;
      case "opencode":
        c = discoverOpenCode(home, root, env);
        break;
      case "grok":
        c = discoverGrok(home, root);
        break;
    }
    return c.result(agent, isInstalled(agent, env));
  });
}
