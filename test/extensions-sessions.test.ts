// test/extensions-sessions.test.ts — enabled extensions reach agent sessions
// (CONTRACTS §15.5): the Claude Agent SDK bridge gets them in query() options
// (fake query, no Claude process), an ACP bridge in session/new (the fake ACP
// agent of test/fake-agent.ts, spawned for real), plus the /api/extensions
// endpoints (Origin check, no secret echo) and `ruah app ext`.
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo, Options, Query, SDKControlInitializeResponse, SDKMessage, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkBridge } from "../src/acp/claude-sdk-bridge.js";
import { AcpProcessBridge } from "../src/acp/acp-bridge.js";
import type { AcpPreset, AgentExtensions, BridgeEvent } from "../src/acp/bridge.js";
import { MemorySecretStore } from "../src/integrations/keychain.js";
import { ExtensionsService, projectRefFor, type ProjectRef } from "../src/extensions/service.js";
import { handleExtensionsRequest } from "../src/extensions/http.js";
import { runExt } from "../src/extensions/cli.js";
import { originAllowed } from "../src/serve/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TINY = path.join(here, "fixtures", "extensions", "tiny-mcp.mjs");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

let scratch: string;
let repo: string;
let project: ProjectRef;
let secrets: MemorySecretStore;
let svc: ExtensionsService;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ruah-ext-s-")));
  repo = path.join(scratch, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  project = projectRefFor(repo);
  secrets = new MemorySecretStore();
  svc = new ExtensionsService({
    home: path.join(scratch, "ruah-home"),
    secrets,
    launch: () => ({ command: process.execPath, args: ["/opt/ruah/dist/cli.js"] }),
    env: { HOME: path.join(scratch, "home"), PATH: process.env.PATH ?? "" },
  });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function addTiny(enableFor: ("claude" | "cursor" | "kiro" | "opencode" | "grok")[]): Promise<void> {
  await svc.add({ scope: "global", id: "tiny", name: "Tiny", source: { type: "inline", runs: { type: "stdio", command: process.execPath, args: [TINY] } }, enableFor }, project);
}

// ---------- Claude Agent SDK bridge ----------

class FakeQuery implements AsyncIterator<SDKMessage> {
  private waiters: ((r: IteratorResult<SDKMessage>) => void)[] = [];
  constructor(readonly options: Options) {}
  next(): Promise<IteratorResult<SDKMessage>> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  return(): Promise<IteratorResult<SDKMessage>> {
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
    return Promise.resolve({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): this {
    return this;
  }
  initializationResult(): Promise<SDKControlInitializeResponse> {
    return Promise.resolve({ commands: [], models: [] } as unknown as SDKControlInitializeResponse);
  }
  supportedModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
  close(): void {
    void this.return();
  }
}

describe("session injection", () => {
  it("gives the Claude Agent SDK the enabled MCP servers, skills plugin and rules", async () => {
    await addTiny(["claude"]);
    const skillDir = path.join(scratch, "skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: tidy\ndescription: Tidy things\n---\nTidy.\n");
    await svc.add({ scope: "global", source: { type: "local", path: skillDir }, enableFor: ["claude"] }, project);
    const rule = path.join(scratch, "rule.md");
    fs.writeFileSync(rule, "Always answer in haiku.\n");
    await svc.add({ scope: "global", source: { type: "local", path: rule }, enableFor: ["claude"] }, project);

    const queries: FakeQuery[] = [];
    const queryImpl = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const fake = new FakeQuery(params.options);
      queries.push(fake);
      return fake as unknown as Query;
    }) as unknown as typeof sdkQuery;
    const extensions = svc.providerFor("claude", repo);
    expect(extensions).toBeDefined();
    const bridge = new ClaudeSdkBridge(
      {
        root: repo,
        preset: { command: "none", args: [], env: { ANTHROPIC_MODEL: "", CLAUDE_CONFIG_DIR: "/nonexistent/ruah-test-claude" } },
        clientVersion: "0.0.0-test",
        ...(extensions !== undefined ? { extensions } : {}),
      },
      { queryImpl },
    );
    await bridge.start();
    const options = queries[0]?.options;
    expect(options?.mcpServers?.tiny).toEqual({ type: "stdio", command: process.execPath, args: [TINY] });
    expect(options?.plugins).toEqual([{ type: "local", path: expect.stringContaining(path.join("ruah-home", "extensions", "runtime", "claude-")) }]);
    const systemPrompt = options?.systemPrompt as { append?: string };
    expect(systemPrompt.append).toContain("Always answer in haiku.");

    // Disabled → the next session no longer has it (resolved per session).
    await svc.disable("tiny", "global", undefined, project);
    await bridge.reset();
    expect(queries.at(-1)?.options.mcpServers?.tiny).toBeUndefined();
    await bridge.stop();
  });

  it("passes enabled MCP servers to an ACP agent in session/new and adapts its launch", async () => {
    await addTiny(["kiro"]);
    await svc.add({ scope: "global", id: "remote", source: { type: "inline", runs: { type: "http", url: "https://mcp.example.com/mcp" } }, enableFor: ["kiro"] }, project);
    const real = svc.providerFor("kiro", repo);
    if (real === undefined) throw new Error("no provider");
    // Wrap the real provider: also turn on the fake agent's image capability through the adapted preset,
    // which proves the bridge spawned with the preset the extensions returned.
    const extensions: AgentExtensions = {
      resolve: async (preset?: AcpPreset) => {
        const resolved = await real.resolve(preset);
        const base = resolved.acp?.preset ?? preset;
        return { ...resolved, acp: { mcpServers: resolved.acp?.mcpServers ?? [], ...(base !== undefined ? { preset: { ...base, env: { ...(base.env ?? {}), FAKE_AGENT_IMAGES: "1" } } } : {}) } };
      },
    };
    let stderr = "";
    const bridge = new AcpProcessBridge(
      {
        root: repo,
        preset: { command: process.execPath, args: ["--import", tsxLoader, path.join(here, "fake-agent.ts")] },
        clientVersion: "0.0.0-test",
        onStderr: (chunk) => {
          stderr += chunk;
        },
        extensions,
      },
      { killGraceMs: 200 },
    );
    const events: BridgeEvent[] = [];
    bridge.on((e) => events.push(e));
    await bridge.start();
    expect(stderr).toMatch(new RegExp(`fake: session/new \\S+ cwd=\\S+ mcp=tiny:${process.execPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    // The fake agent advertises no HTTP MCP support: the remote server is skipped, with a note.
    expect(stderr).toContain("remote: this agent does not support http MCP servers; skipped");
    expect(bridge.supportsImages()).toBe(true);
    await bridge.stop();
  });
});

// ---------- HTTP ----------

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!handleExtensionsRequest(req, res, url, svc, () => project, (origin) => originAllowed(origin, []))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (base: string, p: string, body: unknown, origin = "http://127.0.0.1:4177") =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

describe("/api/extensions", () => {
  it("adds, enables, stores secrets and previews — with the Origin check on every POST", async () => {
    await withServer(async (base) => {
      const denied = await post(base, "/api/extensions/add", { source: { type: "featured", id: "github" } }, "https://evil.example");
      expect(denied.status).toBe(403);
      expect(((await (await fetch(`${base}/api/extensions`)).json()) as { installed: unknown[] }).installed).toEqual([]);

      const added = await post(base, "/api/extensions/add", { scope: "global", source: { type: "featured", id: "github" } });
      expect(added.status).toBe(200);
      const { extension } = (await added.json()) as { extension: { id: string; what: { launcher: boolean }; secrets: unknown[] } };
      expect(extension).toMatchObject({ id: "github", what: { launcher: true }, secrets: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", set: false }] });

      const secret = await post(base, "/api/extensions/secret", { id: "github", scope: "global", name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "ghp_http_secret_123456" });
      expect(await secret.json()).toEqual({ ok: true });
      const badSecret = await post(base, "/api/extensions/secret", { id: "github", scope: "global", name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: 42 });
      const badText = await badSecret.text();
      expect(badSecret.status).toBe(400);
      expect(badText).not.toContain("42");

      expect((await post(base, "/api/extensions/enable", { id: "github", scope: "global", agents: ["claude"] })).status).toBe(200);
      const preview = (await (await fetch(`${base}/api/extensions/preview?agent=claude`)).json()) as { servers: { name: string; env: string[] }[] };
      expect(preview.servers).toEqual([expect.objectContaining({ name: "github", env: ["GITHUB_PERSONAL_ACCESS_TOKEN"] })]);
      const list = await (await fetch(`${base}/api/extensions`)).text();
      expect(list).not.toContain("ghp_http_secret");
      expect(list).toContain('"set":true');

      expect((await fetch(`${base}/api/extensions/featured`)).status).toBe(200);
      expect((await fetch(`${base}/api/extensions/discover?agent=cursor`)).status).toBe(200);
      expect((await fetch(`${base}/api/extensions/discover?agent=nope`)).status).toBe(400);
      expect((await fetch(`${base}/api/extensions/add`)).status).toBe(405);
      expect((await post(base, "/api/extensions/enable", { id: "missing", scope: "global", agents: ["claude"] })).status).toBe(404);
      expect((await post(base, "/api/extensions/add", { scope: "global", source: { type: "inline", runs: { type: "stdio", command: "npx -y evil", args: [] } } })).status).toBe(400);
      expect((await post(base, "/api/extensions/add", { scope: "global", source: { type: "local", path: "relative/path" } })).status).toBe(400);

      const removed = await post(base, "/api/extensions/remove", { id: "github", scope: "global" });
      expect(removed.status).toBe(200);
      expect(secrets.secrets.size).toBe(0);
    });
  });
});

// ---------- CLI ----------

describe("ruah app ext", () => {
  it("adds an MCP server by command, enables it per agent and removes it", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const run = (...argv: string[]) => runExt(argv, { service: svc, cwd: repo, out: (l) => lines.push(l), err: (l) => errors.push(l) });

    expect(await run("add", "--mcp", "tiny", "--env", "TINY_TOKEN", "--", process.execPath, TINY)).toBe(0);
    expect(lines.join("\n")).toContain("Added tiny (mcp, global). Nothing was run.");
    expect(lines.join("\n")).toContain("ruah app ext secret set tiny TINY_TOKEN");
    lines.length = 0;
    expect(await run("enable", "tiny", "--agent", "claude", "--agent", "opencode")).toBe(0);
    expect(lines[0]).toBe("tiny: enabled for claude, opencode");
    lines.length = 0;
    const withSecret = await runExt(["secret", "set", "tiny", "TINY_TOKEN"], { service: svc, cwd: repo, out: (l) => lines.push(l), err: (l) => errors.push(l), readSecret: () => Promise.resolve("cli-secret") });
    expect(withSecret).toBe(0);
    expect(secrets.secrets.get("ext:global:tiny:TINY_TOKEN")).toBe("cli-secret");
    lines.length = 0;
    expect(await run("list", "--json")).toBe(0);
    const list = JSON.parse(lines.join("\n")) as { installed: { id: string; enabledFor: string[] }[] };
    expect(list.installed.map((e) => [e.id, e.enabledFor])).toEqual([["tiny", ["claude", "opencode"]]]);
    expect(lines.join("\n")).not.toContain("cli-secret");
    lines.length = 0;
    expect(await run("preview", "--agent", "opencode")).toBe(0);
    expect(lines.join("\n")).toContain("mcp    tiny:");
    lines.length = 0;
    expect(await run("add", "featured:claude-design", "--project", "--agent", "claude")).toBe(0);
    expect(fs.existsSync(path.join(repo, ".ruah", "extensions.json"))).toBe(true);
    expect(await run("disable", "tiny")).toBe(0);
    expect(await run("remove", "tiny")).toBe(0);
    expect(await run("remove", "tiny")).toBe(1);
    expect(errors.join("\n")).toContain('no global extension "tiny"');
    expect(await run("enable", "x", "--agent", "nope")).toBe(2);
  }, 30_000);
});
