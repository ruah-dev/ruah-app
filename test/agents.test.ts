// test/agents.test.ts — agent catalog: CLI detection (override → PATH →
// ~/.local/bin → tool dir), picker entries with install hints, check/create.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCatalog, isAgentProvider, agentIdOf } from "../src/acp/index.js";
import { AcpProcessBridge } from "../src/acp/acp-bridge.js";
import { ClaudeSdkBridge } from "../src/acp/claude-sdk-bridge.js";
import { MockBridge } from "../src/acp/mock-bridge.js";
import { resolveAgentBinary } from "../src/acp/presets.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

function sandbox() {
  const base = mkdtempSync(path.join(tmpdir(), "ruah-agents-"));
  dirs.push(base);
  const home = path.join(base, "home");
  const bin = path.join(base, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { home, bin, env: { PATH: bin, HOME: home } as NodeJS.ProcessEnv };
}

const base = { root: "/repo", clientVersion: "0" };

describe("agent catalog", () => {
  it("resolves CLIs: override, PATH, ~/.local/bin, tool dir; ignores non-executables", () => {
    const { home, bin, env } = sandbox();
    expect(resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [".opencode/bin"], env)).toBeUndefined();
    const toolDir = executable(path.join(home, ".opencode", "bin"), "opencode");
    expect(resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [".opencode/bin"], env)).toBe(toolDir);
    const local = executable(path.join(home, ".local", "bin"), "opencode");
    expect(resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [".opencode/bin"], env)).toBe(local);
    const onPath = executable(bin, "opencode");
    expect(resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [".opencode/bin"], env)).toBe(onPath);
    const custom = executable(path.join(home, "custom"), "oc");
    expect(resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [], { ...env, RUAH_OPENCODE_BIN: custom })).toBe(custom);
    // An override that does not exist means "not installed", not a fallback.
    expect(resolveAgentBinary("opencode", "RUAH_OPENCODE_BIN", [], { ...env, RUAH_OPENCODE_BIN: path.join(home, "missing") })).toBeUndefined();
    writeFileSync(path.join(bin, "grok"), "not executable");
    expect(resolveAgentBinary("grok", "RUAH_GROK_BIN", [], env)).toBeUndefined();
  });

  it("lists the pickable agents with installed flags and hints; claude-acp only while current", () => {
    const { bin, env } = sandbox();
    executable(bin, "cursor-agent");
    const catalog = new AgentCatalog(base, { env });
    const choices = catalog.choices("claude");
    expect(choices.currentAgentId).toBe("claude");
    expect(choices.available.map((a) => [a.id, a.installed])).toEqual([
      ["claude", true],
      ["cursor", true],
      ["grok", false],
      ["kiro", false],
      ["opencode", false],
    ]);
    expect(choices.available.find((a) => a.id === "kiro")?.installHint).toMatch(/kiro\.dev/);
    expect(choices.available.find((a) => a.id === "cursor")?.installHint).toBeUndefined();
    // Image support: static for the Claude SDK; ACP agents are only known after initialize.
    expect(choices.available.find((a) => a.id === "claude")?.images).toBe(true);
    expect(choices.available.find((a) => a.id === "cursor")?.images).toBeUndefined();
    expect(catalog.choices("claude-acp").available.map((a) => a.id)).toContain("claude-acp");
  });

  it("check / create: unknown, missing, ACP, SDK and mock", () => {
    const { bin, env } = sandbox();
    executable(bin, "grok");
    const catalog = new AgentCatalog(base, { env, mock: true });
    expect(catalog.check("nope")).toEqual({ ok: false, code: "bad_message", message: "unknown agent: nope" });
    expect(catalog.check("kiro")).toMatchObject({ ok: false, code: "agent_spawn_failed", message: expect.stringMatching(/^Kiro CLI is not installed/) });
    expect(() => catalog.create("kiro")).toThrow(/not installed/);
    expect(catalog.check("grok")).toEqual({ ok: true });
    expect(catalog.create("grok")).toBeInstanceOf(AcpProcessBridge);
    expect(catalog.create("claude")).toBeInstanceOf(ClaudeSdkBridge);
    expect(catalog.create("mock")).toBeInstanceOf(MockBridge);
    expect(catalog.choices("mock").available[0]).toMatchObject({ id: "mock", installed: true });
    expect(new AgentCatalog(base, { env }).check("mock")).toMatchObject({ ok: false });
  });

  it("--agent values: acp is the claude-acp alias", () => {
    for (const value of ["claude", "cursor", "grok", "kiro", "opencode", "acp", "claude-acp"]) expect(isAgentProvider(value)).toBe(true);
    expect(isAgentProvider("mock")).toBe(false);
    expect(agentIdOf("acp")).toBe("claude-acp");
  });
});
