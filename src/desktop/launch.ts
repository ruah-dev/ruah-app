// src/desktop/launch.ts — how `ruah app [<dir>]` opens the desktop app.
//
// An installed Ruah.app wins (the daily driver: single instance, folders open
// in the running window through `open -a`); a source checkout falls back to
// its own Electron. Pure planning here, so it is testable without launching.
import { spawn } from "node:child_process";
import * as path from "node:path";

export const APP_BUNDLE_NAME = "Ruah.app";

export type DesktopLaunchPlan =
  | { kind: "bundle"; bundle: string; command: "open"; args: string[] }
  | { kind: "electron"; command: string; args: string[] }
  | { kind: "error"; message: string };

export interface DesktopLaunchInput {
  /** Absolute folder to open, or undefined for the start screen. */
  repo?: string;
  /** The package root this CLI runs from (dist/cli.js → ..). */
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists: (file: string) => boolean;
  /** The dev Electron binary (require("electron")), or undefined when it is not installed. */
  electron: () => string | undefined;
}

/** The .app this package root lives in (…/Ruah.app/Contents/Resources/app), if any. */
export function enclosingAppBundle(packageRoot: string): string | undefined {
  const match = /^(.*\.app)\/Contents\/Resources\/app\/?$/.exec(packageRoot);
  return match?.[1];
}

/** Installed Ruah.app: $RUAH_APP_BUNDLE, /Applications, ~/Applications (first that exists). */
export function findInstalledApp(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | undefined {
  const override = env.RUAH_APP_BUNDLE?.trim();
  if (override !== undefined && override.length > 0) return exists(override) ? path.resolve(override) : undefined;
  const home = env.HOME;
  const candidates = [path.join("/Applications", APP_BUNDLE_NAME), ...(home !== undefined ? [path.join(home, "Applications", APP_BUNDLE_NAME)] : [])];
  return candidates.find((candidate) => exists(candidate));
}

/** Env vars `ruah app` forwards to a bundle it launches (`open --env`; an app started by `open` sees none of the shell's). */
const FORWARDED_ENV = ["RUAH_HOME", "RUAH_AGENT", "RUAH_PORT"] as const;

export function planDesktopLaunch(input: DesktopLaunchInput): DesktopLaunchPlan {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const repoArgs = input.repo !== undefined ? [input.repo] : [];
  const forceDev = env.RUAH_APP_DEV === "1";

  const own = enclosingAppBundle(input.packageRoot);
  const bundle = platform === "darwin" && !forceDev ? (own ?? findInstalledApp(env, input.exists)) : undefined;
  if (bundle !== undefined) {
    const forwarded = FORWARDED_ENV.flatMap((key) => {
      const value = env[key]?.trim();
      return value !== undefined && value.length > 0 ? ["--env", `${key}=${value}`] : [];
    });
    // A running Ruah gets the folder (open-file) and comes to the front; the env only
    // applies when this launch starts it.
    return { kind: "bundle", bundle, command: "open", args: ["-a", bundle, ...forwarded, ...repoArgs] };
  }

  if (!input.exists(path.join(input.packageRoot, "viewer", "index.html"))) {
    return { kind: "error", message: `the viewer is not built — run \`pnpm ui:build\` in ${input.packageRoot}` };
  }
  const electron = input.electron();
  if (electron === undefined) {
    return { kind: "error", message: `Electron is not installed — run \`pnpm install\` in ${input.packageRoot} (or install Ruah.app)` };
  }
  return { kind: "electron", command: electron, args: [input.packageRoot, ...repoArgs] };
}

export type OpenOutcome = { ok: true } | { ok: false; message: string };

/**
 * Runs the bundle plan's `open` and waits for it: `open -a` returns once the app is
 * launched or has been handed the folder, and a failure (an app Gatekeeper blocked and
 * nobody approved, a damaged bundle) is its exit status and stderr — never "Opening Ruah…"
 * for an app that did not open.
 */
export function runOpen(command: string, args: readonly string[], timeoutMs = 60_000): Promise<OpenOutcome> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (outcome: OpenOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, message: `${path.basename(command)} did not return within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", (err) => finish({ ok: false, message: err.message }));
    child.on("close", (code, signal) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, message: stderr.trim().length > 0 ? stderr.trim() : `${path.basename(command)} exited ${code ?? signal}` });
    });
  });
}
