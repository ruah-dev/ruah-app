// src/extensions/resolve.ts — what one agent session receives, computed fresh
// every time a session starts (CONTRACTS §17.5). Injection only: nothing here
// writes another tool's configuration.
//   Claude (Agent SDK)  mcpServers + plugins (a generated "ruah-ext" plugin holding the enabled
//                       skills, plus plugin extensions) + rules appended to the system prompt.
//                       A plugin whose MCP servers need secrets is loaded with skipMcpDiscovery
//                       and its servers are started by Ruah (through the launcher), so Keychain
//                       values reach them.
//   ACP agents          session/new mcpServers; Cursor / Grok also get --plugin-dir; OpenCode gets
//                       OPENCODE_CONFIG_CONTENT { skills.paths, instructions }
// Stdio servers that need secrets start through `ruah app ext exec`, which reads
// them from the Keychain in its own process: no secret value is put in an
// argument list, a config file or the agent's own environment. Remote servers'
// header secrets are the exception: they travel in the MCP config the agent is
// given (ACP: the session/new message; Claude SDK: its CLI arguments).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAgent, ServerPreview, SessionPreview } from "../contracts/extensions.js";
import { resolveBin } from "../integrations/exec.js";
import type { SecretStore } from "../integrations/keychain.js";
import { loadsPlugins, withPluginDirs } from "./agents.js";
import { evaluate, type Evaluated } from "./evaluate.js";
import type { BundledServer, SkillEntry } from "./inspect.js";
import { readTextBounded } from "./inspect.js";
import { expandPlaceholders, secretAccount, slugify } from "./model.js";
import type { ExtensionsStore } from "./store.js";

/** Claude Agent SDK MCP server configs (structurally McpStdioServerConfig / McpHttpServerConfig / McpSSEServerConfig). */
export type ClaudeMcpConfig =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** ACP session/new McpServer (stdio / http / sse). */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http" | "sse"; name: string; url: string; headers: { name: string; value: string }[] };

export interface ResolvedSession {
  preview: SessionPreview;
  /** `pluginsWithoutMcp`: plugin folders (also in `plugins`) to load with skipMcpDiscovery (their servers are in mcpServers). */
  claude: { mcpServers: Record<string, ClaudeMcpConfig>; plugins: string[]; pluginsWithoutMcp: string[]; systemPromptAppend?: string };
  acp: { mcpServers: AcpMcpServer[]; pluginDirs: string[]; env: Record<string, string> };
}

export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ResolveInput {
  store: ExtensionsStore;
  agent: ExtensionAgent;
  /** true for Claude over ACP (claude-acp): Claude's switches, ACP delivery. */
  viaAcp?: boolean;
  root: string | undefined;
  projectId: string | undefined;
  secrets?: SecretStore | undefined;
  /** How to start `ruah app ext exec` (node + the CLI entry). */
  launch: () => Launch;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** A preview (GET /preview): compute only; never prune generated folders running sessions may use. */
  preview?: boolean;
}

const RULES_MAX_BYTES = 64 * 1024;
const RUNTIME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_NAME = "ruah-ext";

/** Enabled, approved extensions for `agent` (project entries win over global ones with the same id). */
export function activeExtensions(input: Pick<ResolveInput, "store" | "agent" | "root" | "projectId">): { active: Evaluated[]; skipped: { id: string; reason: string }[] } {
  const { store, agent, root, projectId } = input;
  const skipped: { id: string; reason: string }[] = [];
  const active: Evaluated[] = [];
  const lists: { scope: "global" | "project"; entries: Evaluated[] }[] = [];
  const global = store.read("global");
  if (global.error !== undefined) skipped.push({ id: "(global)", reason: `${global.file}: ${global.error}` });
  lists.push({ scope: "global", entries: global.extensions.filter((e) => e.enabledFor.includes(agent)).map((e) => evaluate(store, e, "global", root, projectId)) });
  if (root !== undefined && projectId !== undefined) {
    const project = store.read("project", root);
    if (project.error !== undefined) skipped.push({ id: "(project)", reason: `${project.file}: ${project.error}` });
    lists.push({ scope: "project", entries: project.extensions.filter((e) => e.enabledFor.includes(agent)).map((e) => evaluate(store, e, "project", root, projectId)) });
  }
  const projectIds = new Set(lists.find((l) => l.scope === "project")?.entries.map((e) => e.ext.id) ?? []);
  for (const list of lists) {
    for (const entry of list.entries) {
      if (list.scope === "global" && projectIds.has(entry.ext.id)) {
        skipped.push({ id: entry.ext.id, reason: "the project's extension with the same id is used instead" });
        continue;
      }
      if (entry.status !== "ready") {
        skipped.push({ id: entry.ext.id, reason: entry.statusDetail ?? entry.status });
        continue;
      }
      active.push(entry);
    }
  }
  return { active, skipped };
}

function preview(server: BundledServer, name: string): ServerPreview {
  const runs = server.runs;
  return {
    name,
    transport: runs.type,
    ...(runs.type === "stdio" ? { command: runs.command, args: [...runs.args] } : { url: runs.url }),
    env: [...server.env],
    ...(runs.type !== "stdio" && runs.headers !== undefined ? { headers: [...runs.headers] } : {}),
  };
}

async function readSecret(secrets: SecretStore | undefined, account: string): Promise<string | null> {
  if (secrets === undefined) return null;
  try {
    return await secrets.get(account);
  } catch {
    return null; // no Keychain (non-macOS) or locked: the value is simply missing
  }
}

/** Literal env values from a bundled file ("${VAR}" references are names, not values). */
function literalEnv(server: BundledServer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.envValues)) if (!/\$\{/.test(value)) out[name] = value;
  return out;
}

function expandPluginRoot(value: string, pluginRoot: string | undefined): string {
  return pluginRoot === undefined ? value : value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

/** Env names a server needs from outside its file (no literal value): Keychain or environment. */
function secretNamesOf(server: BundledServer): string[] {
  const literals = literalEnv(server);
  return server.env.filter((n) => literals[n] === undefined);
}

/**
 * The generated plugin folder holding the enabled skills (content-addressed;
 * reused while unchanged, and touched then so its age says when a session
 * last used it). `prune`: remove other generated folders unused for a week.
 */
export function skillsPlugin(store: ExtensionsStore, agent: ExtensionAgent, skills: readonly { entry: SkillEntry; power: boolean }[], options: { prune?: boolean } = {}): string | undefined {
  if (skills.length === 0) return undefined;
  const used = new Set<string>();
  const planned = skills.map(({ entry, power }) => {
    let name = slugify(entry.name);
    for (let i = 2; used.has(name); i++) name = `${slugify(entry.name)}-${i}`;
    used.add(name);
    return { name, entry, power };
  });
  const hash = createHash("sha1").update(JSON.stringify(planned.map((p) => [p.name, p.entry.dir, p.entry.file, p.power]))).digest("hex").slice(0, 12);
  const dir = path.join(store.runtimeDir, `${agent}-${hash}`);
  if (options.prune !== false) pruneRuntime(store.runtimeDir, dir);
  if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
    try {
      const now = new Date();
      fs.utimesSync(dir, now, now);
    } catch {
      // read-only or gone: the folder is still usable
    }
    return dir;
  }
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  const manifest = `${JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "Skills enabled in Ruah (generated; do not edit)" }, null, 2)}\n`;
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".cursor-plugin"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude-plugin", "plugin.json"), manifest);
  fs.writeFileSync(path.join(tmp, ".cursor-plugin", "plugin.json"), manifest);
  fs.mkdirSync(path.join(tmp, "skills"), { recursive: true });
  for (const { name, entry, power } of planned) {
    const target = path.join(tmp, "skills", name);
    if (!power) {
      fs.symlinkSync(entry.dir, target, "dir");
      continue;
    }
    // A power's instructions are POWER.md (+ steering/): expose them under the skill layout.
    fs.mkdirSync(target);
    fs.symlinkSync(entry.file, path.join(target, "SKILL.md"), "file");
    const steering = path.join(entry.dir, "steering");
    if (fs.existsSync(steering)) fs.symlinkSync(steering, path.join(target, "steering"), "dir");
  }
  try {
    fs.renameSync(tmp, dir);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true }); // a concurrent session built the same folder
  }
  return dir;
}

function pruneRuntime(runtimeDir: string, keep: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(runtimeDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    const p = path.join(runtimeDir, name);
    if (p === keep) continue;
    try {
      if (now - fs.lstatSync(p).mtimeMs > RUNTIME_MAX_AGE_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function rulesText(files: readonly string[]): string | undefined {
  let total = 0;
  const parts: string[] = [];
  for (const file of files) {
    const text = readTextBounded(file)?.trim();
    if (text === undefined || text.length === 0) continue;
    if (total + text.length > RULES_MAX_BYTES) break;
    total += text.length;
    parts.push(`<rule file="${path.basename(file)}">\n${text}\n</rule>`);
  }
  return parts.length > 0 ? `\n\n# Rules enabled in Ruah\n\n${parts.join("\n\n")}` : undefined;
}

/** Merges ours into an existing OPENCODE_CONFIG_CONTENT (the user's own wins nothing it did not set). */
function openCodeConfig(existing: string | undefined, skills: string[], instructions: string[]): string | undefined {
  if (skills.length === 0 && instructions.length === 0) return undefined;
  let base: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim().length > 0) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // not JSON: replaced
    }
  }
  const baseSkills = typeof base.skills === "object" && base.skills !== null ? (base.skills as Record<string, unknown>) : {};
  const basePaths = Array.isArray(baseSkills.paths) ? baseSkills.paths.filter((p): p is string => typeof p === "string") : [];
  const baseInstructions = Array.isArray(base.instructions) ? base.instructions.filter((p): p is string => typeof p === "string") : [];
  return JSON.stringify({
    ...base,
    ...(skills.length > 0 ? { skills: { ...baseSkills, paths: [...basePaths, ...skills] } } : {}),
    ...(instructions.length > 0 ? { instructions: [...baseInstructions, ...instructions] } : {}),
  });
}

export async function resolveSession(input: ResolveInput): Promise<ResolvedSession> {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? homedir();
  const acpMode = input.agent !== "claude" || input.viaAcp === true;
  const { active, skipped } = activeExtensions(input);
  const notes: string[] = [];
  const vars = { project: input.root ?? home, home };

  const servers: { server: BundledServer; ev: Evaluated; pluginRoot?: string }[] = [];
  const skills: { entry: SkillEntry; power: boolean }[] = [];
  const plugins: string[] = [];
  const pluginsWithoutMcp: string[] = [];
  const rules: string[] = [];

  for (const ev of active) {
    const { ext, inspection } = ev;
    switch (ext.kind) {
      case "mcp":
        for (const server of ev.servers) servers.push({ server, ev });
        break;
      case "skill":
        for (const entry of inspection?.skills ?? []) skills.push({ entry, power: false });
        break;
      case "power":
        for (const server of ev.servers) servers.push({ server, ev });
        if (input.agent === "kiro") notes.push(`${ext.id}: POWER.md is not injected into Kiro sessions (use Also install into → Kiro)`);
        else for (const entry of inspection?.skills ?? []) skills.push({ entry, power: true });
        break;
      case "plugin":
        if (loadsPlugins(input.agent) && !(input.agent === "claude" && acpMode) && ev.path !== undefined) {
          plugins.push(ev.path);
          const needSecrets = [...new Set(ev.servers.flatMap(secretNamesOf))];
          if (needSecrets.length > 0 && input.agent === "claude") {
            // The SDK loads the plugin without its MCP servers; Ruah starts them (Keychain values via the launcher).
            pluginsWithoutMcp.push(ev.path);
            for (const server of ev.servers) servers.push({ server, ev, pluginRoot: ev.path });
          } else if (needSecrets.length > 0) {
            notes.push(`${ext.id}: its MCP servers read ${needSecrets.join(", ")} from ${input.agent}'s own environment (the Keychain is not used when the agent loads the plugin itself)`);
          }
        } else {
          for (const server of ev.servers) servers.push({ server, ev, ...(ev.path !== undefined ? { pluginRoot: ev.path } : {}) });
          if (input.agent === "opencode") for (const entry of inspection?.skills ?? []) skills.push({ entry, power: false });
          else if ((inspection?.skills.length ?? 0) > 0) notes.push(`${ext.id}: its skills cannot be loaded by this agent`);
        }
        break;
      case "rule":
        if (input.agent === "claude" && !acpMode) rules.push(...(inspection?.rules ?? []));
        else if (input.agent === "opencode") rules.push(...(inspection?.rules ?? []));
        else notes.push(`${ext.id}: rules are not injected into ${input.agent} sessions (use Also install into)`);
        break;
    }
  }

  // Unique server names ("ruah" is the map tools' server).
  const used = new Set<string>(["ruah"]);
  const named = servers.map((item) => {
    let name = item.server.name;
    for (let i = 2; used.has(name); i++) name = `${item.server.name}-${i}`;
    used.add(name);
    return { ...item, name };
  });

  const claudeServers: Record<string, ClaudeMcpConfig> = {};
  const acpServers: AcpMcpServer[] = [];
  const previews: ServerPreview[] = [];
  for (const { server, ev, name, pluginRoot } of named) {
    previews.push(preview(server, name));
    const runs = server.runs;
    if (runs.type === "stdio") {
      const args = runs.args.map((a) => expandPluginRoot(expandPlaceholders(a, vars), pluginRoot));
      const commandRaw = expandPluginRoot(expandPlaceholders(runs.command, vars), pluginRoot);
      const command = path.isAbsolute(commandRaw) ? commandRaw : (resolveBin(commandRaw, env) ?? commandRaw);
      if (!path.isAbsolute(command)) notes.push(`${name}: \`${commandRaw}\` was not found on PATH`);
      const literals = literalEnv(server);
      const secretNames = server.env.filter((n) => literals[n] === undefined);
      let spec: { command: string; args: string[]; env: Record<string, string> };
      if (secretNames.length > 0) {
        const launch = input.launch();
        spec = {
          command: launch.command,
          args: [...launch.args, "ext", "exec", "--secrets", `${ev.scopeKey}:${ev.ext.id}`, ...secretNames.flatMap((n) => ["--env", n]), "--", command, ...args],
          env: { ...(launch.env ?? {}), ...literals, ...(env.RUAH_HOME !== undefined ? { RUAH_HOME: env.RUAH_HOME } : {}) },
        };
      } else spec = { command, args, env: literals };
      claudeServers[name] = { type: "stdio", command: spec.command, args: spec.args, ...(Object.keys(spec.env).length > 0 ? { env: spec.env } : {}) };
      acpServers.push({ name, command: spec.command, args: spec.args, env: Object.entries(spec.env).map(([n, value]) => ({ name: n, value })) });
    } else {
      const headers: Record<string, string> = {};
      for (const [header, value] of Object.entries(server.headerValues)) if (!/\$\{/.test(value)) headers[header] = value;
      for (const header of runs.headers ?? []) {
        if (headers[header] !== undefined) continue;
        const value = await readSecret(input.secrets, secretAccount(ev.scopeKey, ev.ext.id, header));
        if (value !== null) headers[header] = value;
        else notes.push(`${name}: header ${header} has no value in the Keychain`);
      }
      claudeServers[name] = { type: runs.type, url: runs.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
      acpServers.push({ type: runs.type, name, url: runs.url, headers: Object.entries(headers).map(([n, value]) => ({ name: n, value })) });
    }
  }

  const pluginDirs: string[] = [...plugins];
  const skillDirs: string[] = [];
  const bundle = input.agent === "kiro" ? undefined : skillsPlugin(input.store, input.agent, skills, { prune: input.preview !== true });
  if (bundle !== undefined) {
    if (loadsPlugins(input.agent) && !(input.agent === "claude" && acpMode)) pluginDirs.unshift(bundle);
    else if (input.agent === "opencode") skillDirs.push(path.join(bundle, "skills"));
    else notes.push("skills are not injected into this agent's sessions");
  } else if (input.agent === "kiro" && skills.length > 0) notes.push("Kiro sessions do not take skills; use Also install into → Kiro");

  const acpEnv: Record<string, string> = {};
  if (input.agent === "opencode") {
    const content = openCodeConfig(env.OPENCODE_CONFIG_CONTENT, skillDirs, rules);
    if (content !== undefined) acpEnv.OPENCODE_CONFIG_CONTENT = content;
  }
  const append = input.agent === "claude" && !acpMode ? rulesText(rules) : undefined;

  return {
    preview: {
      agent: input.agent,
      servers: previews,
      plugins: pluginDirs,
      skills: skills.map((s) => s.entry.dir),
      rules,
      skipped,
      notes,
    },
    claude: { mcpServers: claudeServers, plugins: pluginDirs, pluginsWithoutMcp, ...(append !== undefined ? { systemPromptAppend: append } : {}) },
    acp: { mcpServers: acpServers, pluginDirs: acpMode ? pluginDirs : [], env: acpEnv },
  };
}

/** The ACP launch args for this agent with the resolved plugin folders. */
export function acpArgs(agent: ExtensionAgent, args: readonly string[], resolved: ResolvedSession): string[] {
  return withPluginDirs(agent, args, resolved.acp.pluginDirs);
}
