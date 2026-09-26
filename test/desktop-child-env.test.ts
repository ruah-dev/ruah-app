// The daemon's plumbing (ELECTRON_RUN_AS_NODE, RUAH_PARENT_PID) stays with the daemon:
// agents, the commands their tools run and the integrations' CLIs never get it; the
// children that run on the daemon's own binary ask for ELECTRON_RUN_AS_NODE explicitly.
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcess } from "../src/acp/acp-process.js";
import { makeClaudeEnvironment } from "../src/acp/claude-home.js";
import { agentDefinition, claudeCode } from "../src/acp/presets.js";
import { selfNodeEnv, withoutDaemonPlumbing } from "../src/desktop/child-env.js";
import { resetEngineProbe, runEngineJson } from "../src/engines/cli.js";
import { defaultRunner, type RunOptions } from "../src/integrations/exec.js";

const PLUMBING = { ELECTRON_RUN_AS_NODE: "1", RUAH_PARENT_PID: "4242", ELECTRON_NO_ATTACH_CONSOLE: "1", RUAH_LOGIN_ENV: "1" };
const saved = new Map<string, string | undefined>();
const cleanups: (() => void)[] = [];

/** Sets the daemon's plumbing on this process, as the desktop app does for the daemon. */
function asDesktopDaemon(): void {
  for (const [key, value] of Object.entries(PLUMBING)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("child environments", () => {
  test("withoutDaemonPlumbing drops only the plumbing", () => {
    expect(withoutDaemonPlumbing({ ...PLUMBING, PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" })).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" });
  });

  test("selfNodeEnv: Electron's binary needs ELECTRON_RUN_AS_NODE, plain Node nothing", () => {
    expect(selfNodeEnv({ ...process.versions, electron: "44.4.1" })).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    const node = { ...process.versions };
    delete node.electron;
    expect(selfNodeEnv(node)).toEqual({});
  });

  test("the Claude Agent SDK child never gets the plumbing, even through overrides", () => {
    const env = makeClaudeEnvironment({ ELECTRON_RUN_AS_NODE: "1", ANTHROPIC_MODEL: "m" }, { ...PLUMBING, PATH: "/usr/bin", HOME: "/Users/me" });
    expect(env).toEqual({ ANTHROPIC_MODEL: "m", PATH: "/usr/bin", HOME: "/Users/me" });
  });

  test("an ACP agent process does not inherit ELECTRON_RUN_AS_NODE / RUAH_PARENT_PID", async () => {
    asDesktopDaemon();
    const proc = new AgentProcess(
      { command: "/bin/sh", args: ["-c", 'printf "%s|%s|%s" "${ELECTRON_RUN_AS_NODE-unset}" "${RUAH_PARENT_PID-unset}" "${FROM_PRESET-unset}" >&2'], env: { FROM_PRESET: "yes" } },
      tmpdir(),
    );
    await proc.exited;
    expect(proc.stderrTail()).toBe("unset|unset|yes");
  });

  test("the claude-agent-acp preset (this binary) asks for ELECTRON_RUN_AS_NODE only under Electron; the SDK preset never", () => {
    const preset = agentDefinition("claude-acp")?.preset();
    expect(preset?.command).toBe(process.execPath);
    expect(preset?.env?.ELECTRON_RUN_AS_NODE).toBe(process.versions.electron !== undefined ? "1" : undefined);
    expect(claudeCode().env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  test("integration CLIs do not get the plumbing; an explicit env still applies", async () => {
    asDesktopDaemon();
    const result = await defaultRunner("/bin/sh", ["-c", 'printf "%s|%s|%s" "${ELECTRON_RUN_AS_NODE-unset}" "${RUAH_PARENT_PID-unset}" "${EXTRA-unset}"'], { env: { EXTRA: "x" } });
    expect(result.stdout).toBe("unset|unset|x");
  });

  test("a workspace engine runs on this binary with selfNodeEnv", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ruah-ws-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    cleanups.push(() => resetEngineProbe());
    mkdirSync(join(workspace, "ruah-guard", "dist"), { recursive: true });
    const cli = join(workspace, "ruah-guard", "dist", "cli.js");
    writeFileSync(cli, "");
    resetEngineProbe();
    const calls: { file: string; args: readonly string[]; env: RunOptions["env"] }[] = [];
    // An installed `ruah` without the guard engine is skipped, as in real use.
    const runner = async (file: string, args: readonly string[], options?: RunOptions) => {
      calls.push({ file, args, env: options?.env });
      return file === process.execPath ? { code: 0, stdout: '{"ok":true}', stderr: "" } : { code: 1, stdout: "", stderr: "error: unknown command 'guard'" };
    };
    const result = await runEngineJson("guard", ["status"], { cwd: workspace, deps: { runner, workspaceRoot: workspace, env: { PATH: "/nonexistent" } } });
    expect(result).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual({ file: process.execPath, args: [cli, "status", "--json"], env: selfNodeEnv() });
  });
});
