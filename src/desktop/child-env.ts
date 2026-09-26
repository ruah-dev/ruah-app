// src/desktop/child-env.ts — the daemon's own plumbing stays with the daemon.
//
// The desktop app starts the daemon on its own binary as Node
// (ELECTRON_RUN_AS_NODE=1) and tells it who its parent is (RUAH_PARENT_PID).
// Neither may reach agents, the commands their tools run or the CLIs the
// integrations call: with ELECTRON_RUN_AS_NODE an Electron-based CLI (`code`,
// `cursor`, …) starts as plain Node. The few children that run on this very
// binary (the MCP server, the claude-agent-acp adapter, a workspace engine)
// ask for it explicitly with selfNodeEnv().

/** Variables the desktop app sets for the daemon only. */
export const DAEMON_PLUMBING = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "RUAH_PARENT_PID", "RUAH_LOGIN_ENV"] as const;

/** A copy of `env` without the daemon's plumbing. */
export function withoutDaemonPlumbing<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const key of DAEMON_PLUMBING) delete out[key];
  return out;
}

/**
 * What a child started on process.execPath needs to run as Node: Electron's
 * binary is Node only with ELECTRON_RUN_AS_NODE (plain Node needs nothing).
 */
export function selfNodeEnv(versions: NodeJS.ProcessVersions = process.versions): Record<string, string> {
  return versions.electron !== undefined ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}
