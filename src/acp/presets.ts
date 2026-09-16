import { createRequire } from "node:module";
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
