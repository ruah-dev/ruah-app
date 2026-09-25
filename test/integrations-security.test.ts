import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBridge, type MockBridgeOptions } from "../src/acp/mock-bridge.js";
import { type RunOptions, cliMessage, CliError, defaultRunner, redact, type RunResult, type Runner } from "../src/integrations/exec.js";
import type { IntegrationsApi } from "../src/integrations/index.js";
import { Keychain, KeychainError } from "../src/integrations/keychain.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { startServer } from "../src/serve/server.js";
import { SessionHub } from "../src/serve/session.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// Fake, secret-shaped values are assembled at runtime so the source never contains one.
const TOKEN = ["ATATT3xFfGF0", "super-secret-token-value", "1234567890"].join("-");
const FAKE_AWS_KEY = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
const FAKE_GH_TOKEN = ["gh", "p_", "a".repeat(36)].join("");
const FAKE_DO_TOKEN = ["dop", "_v1_", "0123456789abcdef".repeat(4)].join("");

type Recording = Runner & { calls: { file: string; args: string[] }[]; inputs: (string | undefined)[] };

function recordingRunner(result: RunResult | ((args: readonly string[]) => RunResult)): Recording {
  const calls: { file: string; args: string[] }[] = [];
  const inputs: (string | undefined)[] = [];
  const runner = ((file: string, args: readonly string[], options?: RunOptions) => {
    calls.push({ file, args: [...args] });
    inputs.push(options?.input);
    return Promise.resolve(typeof result === "function" ? result(args) : result);
  }) as Recording;
  runner.calls = calls;
  runner.inputs = inputs;
  return runner;
}

describe("Keychain wrapper", () => {
  test("set: `security -i` with the command on stdin, so the token is never in argv", async () => {
    const runner = recordingRunner({ code: 0, stdout: "", stderr: "" });
    await new Keychain({ runner, platform: "darwin" }).set("jira:acme.atlassian.net", TOKEN);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.file).toBe("/usr/bin/security");
    expect(runner.calls[0]?.args).toEqual(["-i"]);
    expect(runner.calls[0]?.args.join(" ")).not.toContain(TOKEN);
    expect(runner.inputs[0]).toBe(`add-generic-password -U -s "ruah" -a "jira:acme.atlassian.net" -w "${TOKEN}"\n`);
  });

  test("set: a failure printed by `security -i` (exit 0) is an error and never carries the token", async () => {
    const runner = recordingRunner({ code: 0, stdout: "", stderr: `security: SecKeychainItemCreateFromContent: error -w ${TOKEN}` });
    await expect(new Keychain({ runner, platform: "darwin" }).set("jira:x", TOKEN)).rejects.toThrow(/keychain write failed/);
    await expect(new Keychain({ runner, platform: "darwin" }).set("jira:x", TOKEN)).rejects.not.toThrow(TOKEN);
  });

  test("set: refuses quotes/newlines that could break out of the stdin command", async () => {
    const runner = recordingRunner({ code: 0, stdout: "", stderr: "" });
    await expect(new Keychain({ runner, platform: "darwin" }).set("jira:x", 'a"b')).rejects.toThrow(/unsupported characters/);
    expect(runner.calls).toHaveLength(0);
  });

  test("get: find-generic-password -w, trailing newline trimmed; exit 44 → null", async () => {
    const found = recordingRunner({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });
    expect(await new Keychain({ runner: found, platform: "darwin" }).get("jira:x")).toBe(TOKEN);
    expect(found.calls[0]?.args).toEqual(["find-generic-password", "-s", "ruah", "-a", "jira:x", "-w"]);
    const missing = recordingRunner({ code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." });
    expect(await new Keychain({ runner: missing, platform: "darwin" }).get("jira:x")).toBeNull();
  });

  test("delete: exit 44 → false, 0 → true", async () => {
    expect(await new Keychain({ runner: recordingRunner({ code: 0, stdout: "", stderr: "" }), platform: "darwin" }).delete("a")).toBe(true);
    expect(await new Keychain({ runner: recordingRunner({ code: 44, stdout: "", stderr: "" }), platform: "darwin" }).delete("a")).toBe(false);
  });

  test("failures never carry the token (even if security echoes it)", async () => {
    const echo = recordingRunner({ code: 1, stdout: "", stderr: `security: bad input -w ${TOKEN}` });
    const err = await new Keychain({ runner: echo, platform: "darwin" }).set("a", TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainError);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    const throwing: Runner = () => Promise.reject(new CliError(`security timed out ${TOKEN}`, "timeout"));
    const err2 = await new Keychain({ runner: throwing, platform: "darwin" }).set("a", TOKEN).catch((e: unknown) => e);
    expect(String((err2 as Error).message)).not.toContain(TOKEN);
    expect(String((err2 as Error).message)).toContain("[redacted]");
  });

  test("non-macOS: refuses instead of writing anywhere else", async () => {
    const runner = recordingRunner({ code: 0, stdout: "", stderr: "" });
    await expect(new Keychain({ runner, platform: "linux" }).set("a", TOKEN)).rejects.toThrow(/macOS Keychain/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("redaction", () => {
  test("known secrets and secret-shaped strings are replaced", () => {
    expect(redact(`failed with ${TOKEN}`, [TOKEN])).toBe("failed with [redacted]");
    expect(redact("Authorization: Basic bWVAZXhhbXBsZS5jb206c2VjcmV0")).toBe("Authorization: Basic [redacted]");
    expect(redact(`Bearer ${FAKE_DO_TOKEN}`)).toBe("Bearer [redacted]");
    expect(redact(`api said ${FAKE_DO_TOKEN}`)).toBe("api said [redacted]");
    expect(redact(`key ${FAKE_AWS_KEY} used`)).toBe("key [redacted] used");
    expect(redact("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG")).toBe("aws_secret_access_key = [redacted]");
    expect(redact(`see ${FAKE_GH_TOKEN}`)).toBe("see [redacted]");
    expect(redact("oops ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz end")).toBe("oops [redacted] end");
    expect(redact("security add-generic-password -a x -w hunter2secret")).toBe("security add-generic-password -a x -w [redacted]");
    expect(redact("nothing secret here: 403 Forbidden")).toBe("nothing secret here: 403 Forbidden");
    expect(redact("Error when retrieving token from sso: Token has expired")).toBe("Error when retrieving token from sso: Token has expired");
    expect(redact("invalid token provider configuration")).toBe("invalid token provider configuration");
    expect(redact("token=abcdef0123456789abcdef")).toBe("token=[redacted]");
  });

  test("cliMessage prefers doctl JSON error details and redacts", () => {
    const msg = cliMessage({ code: 1, stdout: JSON.stringify({ errors: [{ detail: `401 Unable to authenticate you (Bearer ${FAKE_DO_TOKEN})` }] }), stderr: "" });
    expect(msg).toBe("401 Unable to authenticate you (Bearer [redacted])");
  });
});

describe("defaultRunner (real execFile)", () => {
  test("non-zero exit resolves with the code; no shell is involved", async () => {
    const result = await defaultRunner(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.exit(3)", "$(echo pwned); `id`"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("$(echo pwned); `id`");
  });

  test("timeout and missing binary reject with messages that never include the arguments", async () => {
    const t = await defaultRunner(process.execPath, ["-e", "setTimeout(() => {}, 5000)", TOKEN], { timeoutMs: 150 }).catch((e: unknown) => e);
    expect(t).toBeInstanceOf(CliError);
    expect((t as CliError).kind).toBe("timeout");
    expect((t as Error).message).not.toContain(TOKEN);
    const m = await defaultRunner("/nonexistent/ruah-no-such-cli", [TOKEN]).catch((e: unknown) => e);
    expect((m as CliError).kind).toBe("missing");
    expect((m as Error).message).not.toContain(TOKEN);
  });

  // Regression: output over the buffer also kills the child, and was reported as "timed out after 20 s".
  test("output over the buffer is not reported as a timeout", async () => {
    const big = await defaultRunner(process.execPath, ["-e", "process.stdout.write('x'.repeat(33 * 1024 * 1024))"]).catch((e: unknown) => e);
    expect(big).toBeInstanceOf(CliError);
    expect((big as CliError).kind).toBe("failed");
    expect((big as Error).message).toMatch(/more than 32 MiB/);
  });
});

describe("HTTP routes: origin checks, validation, redaction", () => {
  const calls: string[] = [];
  const api: IntegrationsApi = {
    list: () => Promise.resolve({ integrations: [] }),
    connect: (id) => {
      calls.push(`connect:${id}`);
      return Promise.reject(new Error(`Jira rejected Basic bWVAZXhhbXBsZS5jb206${"x".repeat(20)} and ${TOKEN}`));
    },
    disconnect: (id) => {
      calls.push(`disconnect:${id}`);
      return Promise.resolve({ id, family: "work", name: id, status: "not_connected" });
    },
    cloudSync: () => {
      calls.push("sync");
      return Promise.resolve({ resources: [], syncedAt: "2026-09-23T00:00:00.000Z", errors: [] });
    },
    cloudResources: () => Promise.resolve({ resources: [], syncedAt: null, errors: [] }),
    cloudLink: () => Promise.resolve({ ok: true }),
    cloudScope: () => Promise.resolve({ root: "/r", scope: { configured: false, accounts: [], files: [], writable: true }, evidence: [], resources: [], counts: { in: 0, suggestions: 0, excluded: 0, total: 0 } }),
    cloudScopeAccounts: (body) => {
      calls.push(`scope-accounts:${body.accounts.length}`);
      return Promise.resolve({ configured: true, accounts: body.accounts, files: [], writable: true });
    },
    cloudScopeResource: (body) => {
      calls.push(`scope-resource:${body.action}`);
      return Promise.resolve({ ok: true, scope: { in: body.action === "include", reasons: [] } });
    },
    workItems: () => Promise.resolve({ items: [] }),
    workLink: () => Promise.resolve({ ok: true }),
    workCreate: () => {
      calls.push("create");
      return Promise.reject(new Error("should not be reached in these tests"));
    },
    ruahStatus: () => Promise.resolve({ initialized: false, hint: "ruah init" }),
    ruahTask: () => Promise.resolve({}),
    ruahTaskAction: (name, action) => {
      calls.push(`task:${name}:${action}`);
      return Promise.resolve({ name, action });
    },
    ruahWorkflows: () => Promise.resolve({ workflows: [] }),
    ruahWorkflowRun: (name) => Promise.resolve({ name }),
  };

  async function serve(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "ruah-int-http-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const archPath = join(dir, "architecture.json");
    writeFileSync(archPath, JSON.stringify({ version: 1, name: "f", nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }));
    const store = createArchitectureStore(archPath);
    await store.load();
    cleanups.push(() => store.close());
    const bridge = new MockBridge({ chunkDelayMs: 1 } as MockBridgeOptions);
    const hub = new SessionHub(store, bridge, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock" });
    const server = await startServer(store, hub, { host: "127.0.0.1", port: 0, allowOrigins: ["https://*.lovable.app"], logger: () => {}, integrations: api });
    cleanups.push(() => server.close());
    return server.url;
  }

  const post = (url: string, body: unknown, origin?: string): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) }, body: JSON.stringify(body) });

  test("every POST is rejected with 403 from a foreign Origin before reaching the service", async () => {
    const url = await serve();
    calls.length = 0;
    const posts: [string, unknown][] = [
      ["/api/integrations/jira/connect", { site: "acme", email: "a@b.c", token: "t" }],
      ["/api/integrations/digitalocean/disconnect", {}],
      ["/api/cloud/sync", {}],
      ["/api/cloud/link", { resourceId: "x", nodeId: "api" }],
      ["/api/work/link", { provider: "github", itemId: "o/r#1", nodeId: "api", linked: true }],
      ["/api/work/create", { provider: "github", title: "t", body: "b", nodeId: "api" }],
      ["/api/ruah/task", { name: "t", prompt: "p" }],
      ["/api/ruah/task/t/merge", {}],
      ["/api/ruah/workflows/w/run", {}],
    ];
    for (const [path, body] of posts) {
      const res = await post(`${url}${path}`, body, "https://evil.example");
      expect(res.status, path).toBe(403);
    }
    expect(calls).toEqual([]);
    // Loopback and --allow-origin globs pass.
    expect((await post(`${url}/api/cloud/sync`, {}, "http://localhost:5173")).status).toBe(200);
    expect((await post(`${url}/api/cloud/sync`, {}, "https://preview-1.lovable.app")).status).toBe(200);
    expect((await post(`${url}/api/ruah/task/demo/done`, {}, "http://127.0.0.1:4177")).status).toBe(200);
    expect(calls).toEqual(["sync", "sync", "task:demo:done"]);
  });

  test("GETs work; wrong method → 405; unknown path → 404; bad bodies → 400; oversized → 413", async () => {
    const url = await serve();
    expect(await (await fetch(`${url}/api/integrations`)).json()).toEqual({ integrations: [] });
    expect(await (await fetch(`${url}/api/ruah/status`)).json()).toEqual({ initialized: false, hint: "ruah init" });
    expect((await fetch(`${url}/api/cloud/sync`)).status).toBe(405);
    expect((await post(`${url}/api/integrations`, {})).status).toBe(405);
    expect((await fetch(`${url}/api/cloud/nope`)).status).toBe(404);
    expect((await post(`${url}/api/cloud/link`, { resourceId: "x", nodeId: "Bad Id!" })).status).toBe(400);
    expect((await post(`${url}/api/ruah/task`, { name: "../evil", prompt: "x" })).status).toBe(400);
    expect((await post(`${url}/api/ruah/task`, { name: "ok", prompt: "--exec rm" })).status).toBe(400);
    expect((await post(`${url}/api/ruah/task/ok/explode`, {})).status).toBe(400);
    expect((await fetch(`${url}/api/cloud/sync`, { method: "POST", body: "{nope" })).status).toBe(400);
    const huge = await fetch(`${url}/api/cloud/sync`, { method: "POST", body: JSON.stringify({ providers: ["x".repeat(200_000)] }) });
    expect(huge.status).toBe(413);
  });

  test("errors returned to the viewer are redacted", async () => {
    const url = await serve();
    const res = await post(`${url}/api/integrations/jira/connect`, { site: "acme", email: "a@b.c", token: TOKEN });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("bWVAZXhhbXBsZS5jb206");
    expect(text).toContain("[redacted]");
  });
});
