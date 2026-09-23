// Adapted from t3code apps/server/src/provider/acp/CursorAcpSupport.ts
// (buildCursorAcpSpawnInput: `cursor-agent acp`) and
// apps/server/src/provider/acp/GrokAcpSupport.ts (grokAcpSpawnArgs:
// `grok agent stdio`) (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/presets.ts — the coding agents ruah can drive, how to launch each
// ACP one, and whether its CLI is installed. Only the default-mode launch args
// are used (no --force / --always-approve / --permission-mode): permissions go
// through session/request_permission and the viewer's mode picker. t3code's
// GROK_OAUTH2_REFERRER override is deliberately not set.
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import type { AcpPreset } from "./bridge.js";

const PASSTHROUGH_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_EXECUTABLE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "MAX_THINKING_TOKENS",
  "CLAUDE_AGENT_LOGS",
] as const;

export function claudeCode(): AcpPreset {
  const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { command: process.execPath, args: [entry], env };
}

// ---------- agent catalog ----------

/** "claude" runs on the Claude Agent SDK; the rest are ACP agents. "claude-acp" is CLI-only. */
export type AgentId = "claude" | "claude-acp" | "cursor" | "grok" | "kiro" | "opencode";

export interface AgentDefinition {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  /** Shown in the viewer's agent picker. */
  readonly listed: boolean;
  readonly installHint?: string;
  /** How to launch it; undefined when the CLI is not installed. Claude (SDK) has no preset. */
  preset(env?: NodeJS.ProcessEnv): AcpPreset | undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of an agent CLI. Lookup order: `overrideVar` (a path, or a
 * name looked up like the default) → `name` on PATH → ~/.local/bin → the
 * tool's own install dirs (`homeDirs`, relative to $HOME). The explicit dirs
 * matter because a daemon started from Electron / Finder gets a minimal PATH.
 */
export function resolveAgentBinary(
  name: string,
  overrideVar: string,
  homeDirs: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env[overrideVar]?.trim();
  const wanted = override !== undefined && override.length > 0 ? override : name;
  if (wanted.includes("/") || wanted.includes(path.sep)) {
    const absolute = path.resolve(wanted);
    return isExecutableFile(absolute) ? absolute : undefined;
  }
  const home = env.HOME ?? homedir();
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  dirs.push(path.join(home, ".local", "bin"), ...homeDirs.map((dir) => path.join(home, dir)));
  for (const dir of dirs) {
    const candidate = path.join(dir, wanted);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function cliAgent(
  binary: string,
  overrideVar: string,
  args: readonly string[],
  homeDirs: readonly string[] = [],
): (env?: NodeJS.ProcessEnv) => AcpPreset | undefined {
  return (env = process.env) => {
    const command = resolveAgentBinary(binary, overrideVar, homeDirs, env);
    return command === undefined ? undefined : { command, args: [...args] };
  };
}

export const AGENTS: readonly AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    description: "Claude Agent SDK with your Claude Code setup (skills, plugins, MCP servers, CLAUDE.md)",
    listed: true,
    preset: () => undefined,
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    description: "Cursor's agent CLI over ACP (`cursor-agent acp`)",
    listed: true,
    installHint: "Install the Cursor CLI (https://cursor.com/cli), then run `cursor-agent login`. Set RUAH_CURSOR_BIN to use another binary.",
    preset: cliAgent("cursor-agent", "RUAH_CURSOR_BIN", ["acp"], [".cursor/bin"]),
  },
  {
    id: "grok",
    name: "Grok Build",
    description: "xAI's Grok CLI over ACP (`grok agent stdio`)",
    listed: true,
    installHint: "Install the Grok CLI (`grok`) and sign in with it. Set RUAH_GROK_BIN to use another binary.",
    preset: cliAgent("grok", "RUAH_GROK_BIN", ["agent", "stdio"], [".grok/bin"]),
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    description: "Kiro's CLI over ACP (`kiro-cli acp`)",
    listed: true,
    installHint: "Install Kiro CLI: https://kiro.dev/docs/cli/ — then run `kiro-cli login`. Set RUAH_KIRO_BIN to use another binary.",
    // Never -a/--trust-all-tools: tool approval goes through the viewer.
    preset: cliAgent("kiro-cli", "RUAH_KIRO_BIN", ["acp"]),
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "OpenCode over ACP (`opencode acp`, stdio)",
    listed: true,
    installHint: "Install OpenCode (https://opencode.ai), then run `opencode auth login`. Set RUAH_OPENCODE_BIN to use another binary.",
    preset: cliAgent("opencode", "RUAH_OPENCODE_BIN", ["acp"], [".opencode/bin"]),
  },
  {
    id: "claude-acp",
    name: "Claude Code (ACP)",
    description: "Claude through the claude-agent-acp adapter",
    listed: false,
    preset: () => claudeCode(),
  },
];

export function agentDefinition(id: string): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.id === id);
}
