// src/acp/default-modes.ts — the permission mode each agent starts in unless
// the user saved another: the agent's "edit files without asking" mode, never a
// bypass / trust-everything one. Terminal commands and other tools still go
// through session/request_permission (the viewer's permission card).
//   Claude (SDK and claude-agent-acp): acceptEdits
//   Cursor Agent: agent (its default mode edits files already)
//   OpenCode: build
//   Grok Build: none offered — the agent's own default stays
//   Kiro and unknown agents: a mode that reads as "accept edits" / "auto edit",
//   if one is offered and does not read as bypass / trust-all; else the default.
import type { ModeState } from "../contracts/ws.js";

/** Known agents: the mode ids to prefer, in order. An empty list = keep the agent's default. */
export const BUILT_IN_DEFAULT_MODES: Readonly<Record<string, readonly string[]>> = {
  claude: ["acceptEdits"],
  "claude-acp": ["acceptEdits"],
  cursor: ["agent"],
  opencode: ["build"],
  grok: [],
  mock: [],
};

const EDITS_WITHOUT_ASKING = /accept[\s_-]*(all[\s_-]*)?edits?|auto[\s_-]*(accept[\s_-]*)?edits?|edit[\s_-]*automatically/i;
const TOO_PERMISSIVE = /bypass|trust|yolo|force|dangerous|skip[\s_-]*permission|all[\s_-]*tools|full[\s_-]*(access|auto)|always[\s_-]*approve|unrestricted/i;

/** Whether a mode would let the agent do more than edit files unasked (never picked by default). */
export function isPermissiveMode(mode: { id: string; name: string; description?: string | undefined }): boolean {
  return TOO_PERMISSIVE.test(`${mode.id} ${mode.name} ${mode.description ?? ""}`);
}

/**
 * The built-in default mode of `agentId` among `modes.available`, or undefined
 * (keep what the agent started with).
 */
export function builtInDefaultMode(agentId: string, modes: ModeState | undefined): string | undefined {
  const available = modes?.available ?? [];
  if (available.length === 0) return undefined;
  const preferred = BUILT_IN_DEFAULT_MODES[agentId];
  if (preferred !== undefined) {
    return preferred.find((id) => available.some((mode) => mode.id === id));
  }
  const match = available.find((mode) => EDITS_WITHOUT_ASKING.test(`${mode.id} ${mode.name}`) && !isPermissiveMode(mode));
  return match?.id;
}
