// src/extensions/agents.ts — what each agent supports and where its own
// configuration lives (researched from the CLIs installed on 2026-09-25):
//
//   Claude Code (Agent SDK)  per session: options.mcpServers, options.plugins [{type:"local",path}]
//                            (skills, commands, agents, hooks, .mcp.json of a plugin), systemPrompt.append.
//                            Own config: ~/.claude.json mcpServers (+ projects[root].mcpServers),
//                            <repo>/.mcp.json, ~/.claude/skills, <repo>/.claude/skills,
//                            ~/.claude/plugins/installed_plugins.json, ~/.claude/rules, CLAUDE.md.
//   Cursor Agent (ACP)       per session: session/new mcpServers, `cursor-agent --plugin-dir <dir> acp`
//                            (reads .claude-plugin/ and .cursor-plugin/ manifests).
//                            Own config: ~/.cursor/mcp.json, <repo>/.cursor/mcp.json, ~/.cursor/skills,
//                            <repo>/.cursor/skills, <repo>/.cursor/rules/*.mdc, ~/.cursor/plugins.
//   Grok Build (ACP)         per session: session/new mcpServers, `grok agent --plugin-dir <dir> stdio`
//                            (Claude Code plugin layout). Own config: ~/.grok/config.toml [mcp_servers.*],
//                            <repo>/.grok/config.toml, ~/.grok/skills, <repo>/.grok/skills,
//                            ~/.grok/plugins; it also reads Claude Code's skills / plugins / .mcp.json.
//   Kiro CLI (ACP)           per session: session/new mcpServers only. Own config:
//                            ~/.kiro/settings/mcp.json, <repo>/.kiro/settings/mcp.json, ~/.kiro/skills,
//                            <repo>/.kiro/skills, ~/.kiro/steering, <repo>/.kiro/steering,
//                            ~/.kiro/agents/*.json, ~/.kiro/powers.
//   OpenCode (ACP)           per session: session/new mcpServers, OPENCODE_CONFIG_CONTENT (merged config:
//                            skills.paths, instructions). Own config: ~/.config/opencode/opencode.json[c],
//                            <repo>/opencode.json[c], ~/.config/opencode/skills, <repo>/.opencode/skills.
import type { Delivery, ExtensionAgent, ExtensionKind, McpRuns, SupportInfo } from "../contracts/extensions.js";
import { EXTENSION_AGENTS } from "../contracts/extensions.js";

type Matrix = Record<ExtensionKind, Record<ExtensionAgent, SupportInfo>>;

const s = (delivery: Delivery, note: string): SupportInfo => ({ delivery, note });

export const SUPPORT: Matrix = {
  mcp: {
    claude: s("session", "Passed to the Claude Agent SDK (mcpServers) when a session starts"),
    cursor: s("session", "Passed in ACP session/new (mcpServers)"),
    grok: s("session", "Passed in ACP session/new (mcpServers)"),
    kiro: s("session", "Passed in ACP session/new (mcpServers)"),
    opencode: s("session", "Passed in ACP session/new (mcpServers)"),
  },
  skill: {
    claude: s("session", "Loaded as a skill of Ruah's session plugin"),
    cursor: s("session", "Loaded through --plugin-dir (Ruah's session plugin)"),
    grok: s("session", "Loaded through --plugin-dir (Ruah's session plugin)"),
    kiro: s("install", "Kiro has no per-session skill option: use Also install into → Kiro"),
    opencode: s("session", "Loaded through OPENCODE_CONFIG_CONTENT skills.paths"),
  },
  power: {
    claude: s("partial", "Its MCP servers per session; POWER.md becomes a skill"),
    cursor: s("partial", "Its MCP servers per session; POWER.md becomes a skill"),
    grok: s("partial", "Its MCP servers per session; POWER.md becomes a skill"),
    kiro: s("partial", "Its MCP servers per session; POWER.md via Also install into → Kiro"),
    opencode: s("partial", "Its MCP servers per session; POWER.md becomes a skill"),
  },
  plugin: {
    claude: s("session", "Passed to the Claude Agent SDK (plugins): skills, commands, agents, hooks, MCP"),
    cursor: s("session", "Loaded through --plugin-dir"),
    grok: s("session", "Loaded through --plugin-dir"),
    kiro: s("partial", "Only its MCP servers (Kiro cannot load plugins)"),
    opencode: s("partial", "Its MCP servers and skills (OpenCode cannot load plugins)"),
  },
  rule: {
    claude: s("session", "Appended to the system prompt"),
    cursor: s("install", "Use Also install into → Cursor (.cursor/rules)"),
    grok: s("none", "Grok reads AGENTS.md / CLAUDE.md; add the rule there"),
    kiro: s("install", "Use Also install into → Kiro (.kiro/steering)"),
    opencode: s("session", "Passed through OPENCODE_CONFIG_CONTENT instructions"),
  },
};

/** Support of one agent for one extension (remote servers depend on the agent's HTTP MCP support). */
export function supportFor(kind: ExtensionKind, agent: ExtensionAgent, runs?: McpRuns): SupportInfo {
  const base = SUPPORT[kind][agent];
  if (kind === "mcp" && runs !== undefined && runs.type !== "stdio" && agent !== "claude") {
    return s("session", `Passed in ACP session/new when the agent supports remote (${runs.type.toUpperCase()}) MCP servers; skipped otherwise`);
  }
  return base;
}

export function supportMatrix(kind: ExtensionKind, runs?: McpRuns): Record<ExtensionAgent, SupportInfo> {
  return Object.fromEntries(EXTENSION_AGENTS.map((agent) => [agent, supportFor(kind, agent, runs)])) as Record<ExtensionAgent, SupportInfo>;
}

/** Agents that take plugin folders per process (`--plugin-dir`) or per query (Claude SDK). */
export function loadsPlugins(agent: ExtensionAgent): boolean {
  return agent === "claude" || agent === "cursor" || agent === "grok";
}

/**
 * The ACP launch args with `--plugin-dir <dir>` for each folder:
 * cursor-agent takes it as a global option (before `acp`), grok on `agent`
 * (`grok agent --plugin-dir <dir> stdio`). Other agents: unchanged.
 */
export function withPluginDirs(agent: ExtensionAgent, args: readonly string[], dirs: readonly string[]): string[] {
  if (dirs.length === 0) return [...args];
  const flags = dirs.flatMap((dir) => ["--plugin-dir", dir]);
  if (agent === "cursor") return [...flags, ...args];
  if (agent === "grok") {
    const at = args.indexOf("agent");
    return at === -1 ? [...flags, ...args] : [...args.slice(0, at + 1), ...flags, ...args.slice(at + 1)];
  }
  return [...args];
}
