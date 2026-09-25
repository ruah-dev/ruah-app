import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Runner } from "../src/integrations/exec.js";
import { EnginesService } from "../src/engines/index.js";
import { handleEnginesRequest } from "../src/engines/http.js";
import { projectIdFor } from "../src/projects/fs-util.js";
import { ruahHome } from "../src/usage/log.js";
import { engineStatus, isUnknownNamespace, resetEngineProbe, resolveEngineInvocation, runEngineJson } from "../src/engines/cli.js";

function workspace(namespaces: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ruah-eng-"));
  for (const ns of namespaces) {
    const dir = join(root, `ruah-${ns}`, "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli.js"), "// stub\n");
  }
  return root;
}

function service(options: {
  root: string | null;
  runner?: Runner;
  workspaceRoot?: string;
  home?: string;
  enginesOff?: boolean;
}): EnginesService {
  return new EnginesService({
    root: () => options.root,
    architecture: () => null,
    ...(options.home !== undefined ? { home: () => options.home as string } : {}),
    ...(options.runner !== undefined || options.workspaceRoot !== undefined || options.enginesOff === true
      ? {
          cli: {
            ...(options.runner !== undefined ? { runner: options.runner } : {}),
            ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
            env: { PATH: "", ...(options.enginesOff ? { RUAH_ENGINES_OFF: "1" } : {}) },
          },
        }
      : { cli: { env: { PATH: "" } } }),
  });
}

describe("guard, opt, watch engines", () => {
  it("reports not installed without spawning when the binaries are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ruah-miss-"));
    const engines = service({ root, enginesOff: true });
    expect(engines.status().guard?.installed).toBe(false);
    expect(engines.status().guard?.install).toContain("@ruah-dev/guard");
    const scan = await engines.guardScan();
    expect(scan.ok).toBe(false);
    if (!scan.ok) {
      expect(scan.status).toBe(424);
      expect(scan.error).toContain("npm i -g");
    }
    const usage = await engines.optUsage();
    expect(usage.ok).toBe(false);
    if (!usage.ok) expect(usage.error).toContain("@ruah-dev/opt");
  });

  it("scans and lists the audit log through a fake guard CLI", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ruah-guard-root-")));
    const ws = workspace(["guard"]);
    const runner: Runner = async (_file, args) => {
      if (args.includes("scan")) {
        return {
          code: 1,
          stdout: JSON.stringify({
            findings: [{ severity: "high", file: "a.env", message: "secret" }],
            summary: { filesScanned: 2, total: 1, failed: true },
          }),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ entries: [{ action: "scan" }], count: 1 }),
        stderr: "",
      };
    };
    const engines = service({ root, runner, workspaceRoot: ws });
    expect(engines.status().guard?.installed).toBe(true);
    const scan = await engines.guardScan();
    expect(scan.ok).toBe(true);
    if (scan.ok) expect(scan.data.summary?.failed).toBe(true);
    const audit = await engines.guardAudit(10);
    expect(audit.ok).toBe(true);
    if (audit.ok) expect(audit.data.count).toBe(1);
  });

  it("asks opt for the usage log under RUAH_HOME", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ruah-opt-root-")));
    const home = mkdtempSync(join(tmpdir(), "ruah-opt-home-"));
    writeFileSync(join(home, "usage.jsonl"), `${JSON.stringify({ v: 1, model: "opus" })}\n`);
    const ws = workspace(["opt"]);
    let seen: string[] = [];
    const runner: Runner = async (_file, args) => {
      seen = [...args];
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          source: args[1],
          records: 1,
          summary: { totalTokens: 10, costUsd: 0.2, inputTokens: 8, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 1, unpricedTurns: 0 },
          topSpenders: [{ by: "model", key: "opus", turns: 1, tokens: 10, costUsd: 0.2 }],
          waste: [],
          suggestions: ["keep going"],
        }),
        stderr: "",
      };
    };
    const engines = service({ root, runner, workspaceRoot: ws, home });
    const result = await engines.optUsage();
    expect(result.ok).toBe(true);
    expect(seen).toContain("usage");
    expect(seen.some((a) => a.endsWith("usage.jsonl"))).toBe(true);
    if (result.ok) expect(result.data.topSpenders[0]?.key).toBe("opus");
  });

  it("renders one chat turn and serves only that replay file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ruah-watch-root-")));
    const home = mkdtempSync(join(tmpdir(), "ruah-watch-home-"));
    const projectId = projectIdFor(root);
    const chatId = "chat-1";
    const chats = join(home, "projects", projectId, "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(
      join(chats, `${chatId}.jsonl`),
      [
        JSON.stringify({ id: chatId, projectId, title: "Hi", turnCount: 1 }),
        JSON.stringify({ turnId: "turn-1", text: "hello", events: [{ kind: "text", text: "world" }], startedAt: "2026-09-24T00:00:00.000Z" }),
      ].join("\n"),
    );
    const ws = workspace(["watch"]);
    const runner: Runner = async (_file, args) => {
      const out = args[args.indexOf("--out") + 1] ?? "";
      writeFileSync(out, "<html>replay</html>");
      return { code: 0, stdout: JSON.stringify({ ok: true, written: out, turns: 2 }), stderr: "" };
    };
    const engines = new EnginesService({
      root: () => root,
      architecture: () => null,
      home: () => home,
      cli: { runner, workspaceRoot: ws, env: { PATH: "" } },
    });
    const replay = await engines.watchReplay(chatId, "turn-1");
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.data.name).toBe("turn-turn-1.html");
      expect(engines.watchHtml(replay.data.name)).toContain("replay");
    }
    expect(engines.watchHtml("../usage.jsonl")).toBeUndefined();
    const missing = await engines.watchReplay(chatId, "missing");
    expect(missing.ok).toBe(false);
  });
});

describe("engines HTTP", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  function listen(engines: EnginesService): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!handleEnginesRequest(req, res, url, engines, ["http://127.0.0.1"])) {
        res.writeHead(404);
        res.end();
      }
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const handle = {
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        };
        servers.push(handle);
        resolve(handle);
      });
    });
  }

  it("returns install state and a guard scan", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ruah-http-")));
    const ws = workspace(["guard", "opt", "watch"]);
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify({ findings: [], summary: { total: 0, failed: false, filesScanned: 1 } }),
      stderr: "",
    });
    const engines = service({ root, runner, workspaceRoot: ws });
    const http = await listen(engines);
    const status = await fetch(`${http.url}/api/engines/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as { guard: { installed: boolean; install: string } };
    expect(body.guard.installed).toBe(true);
    expect(body.guard.install).toContain("@ruah-dev/guard");
    const scan = await fetch(`${http.url}/api/engines/guard/scan`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
      body: "{}",
    });
    expect(scan.status).toBe(200);
    const scanBody = (await scan.json()) as { summary: { failed: boolean } };
    expect(scanBody.summary.failed).toBe(false);
  });

  it("rejects a guard POST from a foreign origin and a missing opt tool", async () => {
    const engines = service({ root: realpathSync(mkdtempSync(join(tmpdir(), "ruah-http2-"))), enginesOff: true });
    const http = await listen(engines);
    const denied = await fetch(`${http.url}/api/engines/guard/scan`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);
    const usage = await fetch(`${http.url}/api/engines/opt/usage`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
      body: "{}",
    });
    expect(usage.status).toBe(424);
    const err = (await usage.json()) as { error: string };
    expect(err.error).toContain("not installed");
    expect(ruahHome()).not.toBe("");
  });
});

// Regression: with the ruah toolkit on PATH but without an engine's namespace, `ruah guard …`
// printed "unknown command 'guard'" and the Guard button reported "returned non-JSON (exit 1)".
describe("ruah without the engine's namespace", () => {
  afterEach(() => resetEngineProbe());

  function fakeRuahDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ruah-bin-"));
    writeFileSync(join(dir, "ruah"), "#!/bin/sh\n", { mode: 0o755 });
    return dir;
  }
  const unknown = { code: 1, stdout: "", stderr: "ruah: unknown command 'guard'\n\nAvailable namespaces:\n  orch\n" };

  it("falls back to the engine's own CLI", async () => {
    const bin = fakeRuahDir();
    const ws = workspace(["guard"]);
    const calls: string[] = [];
    const runner: Runner = async (file, args) => {
      calls.push(`${file.endsWith("/ruah") ? "ruah" : "direct"} ${args.join(" ")}`);
      return file.endsWith("/ruah") ? unknown : { code: 0, stdout: JSON.stringify({ summary: { total: 0 } }), stderr: "" };
    };
    const deps = { runner, workspaceRoot: ws, env: { PATH: bin } };
    const out = await runEngineJson("guard", ["scan", "."], { cwd: tmpdir(), deps });
    expect(out).toMatchObject({ ok: true, data: { summary: { total: 0 } } });
    expect(calls[0]).toMatch(/^ruah guard scan/);
    expect(calls[1]).toMatch(/^direct .*scan/);
    // Learned: the next call goes straight to the engine's CLI.
    await runEngineJson("guard", ["scan", "."], { cwd: tmpdir(), deps });
    expect(calls[2]).toMatch(/^direct/);
  });

  it("never reports the unknown namespace as non-JSON output", async () => {
    const bin = fakeRuahDir();
    const runner: Runner = async (file) =>
      file.endsWith("/ruah") ? unknown : { code: 0, stdout: "{}", stderr: "" };
    const deps = { runner, env: { PATH: bin } };
    expect(isUnknownNamespace(unknown.stderr, "guard")).toBe(true);
    expect(isUnknownNamespace("unknown command 'guardian'", "guard")).toBe(false);
    const out = await runEngineJson("guard", ["scan", "."], { cwd: tmpdir(), deps });
    if (resolveEngineInvocation("guard", deps) === null) {
      // No ruah-guard anywhere: "not installed" with the install command.
      expect(out).toMatchObject({ ok: false, status: 424, kind: "missing" });
      if (!out.ok) expect(out.error).toContain("npm i -g");
      expect(engineStatus(deps, ["guard"]).guard?.installed).toBe(false);
    } else {
      expect(out.ok).toBe(true);
    }
  });
});
