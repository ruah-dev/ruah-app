// Adapted from t3code apps/server/src/provider/Drivers/ClaudeHome.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/claude-home.ts — the environment the Claude Agent SDK child runs
// with, plus the signed-out hint. t3code's per-instance `homePath` setting is
// replaced by an inherited CLAUDE_CONFIG_DIR: ruah uses the user's own
// Claude Code setup (~/.claude, or wherever CLAUDE_CONFIG_DIR points).

/**
 * Variables that mark the *parent* as a Claude Code session. When ruah is
 * itself started from inside Claude Code they must not leak into the child,
 * which would otherwise treat itself as nested. The SDK sets its own
 * entrypoint.
 */
const PARENT_SESSION_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] as const;

/**
 * Full inherited environment (PATH, HOME, keychain access, proxy settings)
 * plus explicit overrides — the SDK replaces the child env with what it is
 * given, so passing only a whitelist would break login lookup. Overrides come
 * from the preset (see presets.ts PASSTHROUGH_ENV).
 */
export function makeClaudeEnvironment(
  overrides: Record<string, string> | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, ...overrides };
  for (const key of PARENT_SESSION_ENV) delete env[key];
  // Isolation is done via CLAUDE_CONFIG_DIR rather than HOME: overriding HOME
  // also relocates the macOS login keychain lookup, so the CLI could not find
  // its stored OAuth credentials and would report "Not logged in".
  return env;
}

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export function claudeSignedOutMessage(input: { configDir: string | undefined; cwd: string }): string {
  const configuration = input.configDir !== undefined
    ? ` from ${JSON.stringify(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${JSON.stringify(input.configDir)}`
    : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this machine${configuration}, then reset the session. For API-key authentication, set ANTHROPIC_API_KEY.`;
}
