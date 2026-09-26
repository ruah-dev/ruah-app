// src/usage/settings.ts — the usage settings (CONTRACTS §20.1): whether Ruah
// may read an agent app's saved login to show its plan usage. Today that is
// the Cursor app's login (state.vscdb `cursorAuth/accessToken`), used for one
// read-only GET to cursor.com and never stored. It is **off by default**: the
// user turns it on in the app (the Cursor limits card or Settings → Features),
// which saves `usage.readAppLogins` in $RUAH_HOME/settings.json.
// RUAH_USAGE_READ_LOGINS (0/1) overrides the saved value for one process.
import type { UsageSettingsView } from "../contracts/ws.js";

export type { UsageSettingsView };

export const READ_LOGINS_ENV = "RUAH_USAGE_READ_LOGINS";

/** RUAH_USAGE_READ_LOGINS as a boolean; undefined when unset or not a recognised value. */
export function envReadLogins(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[READ_LOGINS_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  return undefined;
}

/**
 * The effective setting: the environment wins, then the saved value, then the
 * default (off).
 */
export function resolveUsageSettings(env: NodeJS.ProcessEnv, saved: boolean | undefined): UsageSettingsView {
  const fromEnv = envReadLogins(env);
  if (fromEnv !== undefined) return { readAppLogins: fromEnv, source: "env" };
  if (saved !== undefined) return { readAppLogins: saved, source: "settings" };
  return { readAppLogins: false, source: "default" };
}
