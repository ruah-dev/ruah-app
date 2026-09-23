import { afterEach, describe, expect, test } from "vitest";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { TerminalServerMessage } from "../src/contracts/terminal.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { originAllowed, startServer } from "../src/serve/server.js";
import { SessionHub } from "../src/serve/session.js";
import { resolveTerminalCwd, TerminalError, type TerminalProject } from "../src/terminal/cwd.js";
import { resolveShell, terminalEnv } from "../src/terminal/env.js";
import { TerminalGateway } from "../src/terminal/gateway.js";
import { ScrollbackBuffer, altScreenAfter, sanitizeReplayChunk } from "../src/terminal/history.js";
import { FLOW_HIGH_WATERMARK, TerminalManager, pastedCommand, type TerminalSink } from "../src/terminal/manager.js";
import { loadPty, type PtyBackend, type PtyExitEvent, type PtyLoadResult, type PtyProcess, type PtySpawnInput } from "../src/terminal/pty.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ruah-term-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- fakes

class FakePty implements PtyProcess {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  sizes: [number, number][] = [];
  signals: (string | undefined)[] = [];
  paused = false;
  private data = new Set<(d: string) => void>();
  private exit = new Set<(e: PtyExitEvent) => void>();
  constructor(readonly input: PtySpawnInput) {}
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.signals.push(signal);
    if (signal === "SIGHUP" || signal === "SIGKILL") queueMicrotask(() => this.emitExit(0, 1));
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  onData(cb: (d: string) => void): () => void {
    this.data.add(cb);
    return () => this.data.delete(cb);
  }
  onExit(cb: (e: PtyExitEvent) => void): () => void {
    this.exit.add(cb);
    return () => this.exit.delete(cb);
  }
  emit(d: string): void {
    for (const cb of [...this.data]) cb(d);
  }
  emitExit(exitCode: number, signal: number | null = null): void {
    for (const cb of [...this.exit]) cb({ exitCode, signal });
  }
}

function fakeBackend(): { backend: PtyBackend; spawned: FakePty[]; load: () => Promise<PtyLoadResult> } {
  const spawned: FakePty[] = [];
  const backend: PtyBackend = {
    spawn(input) {
      const p = new FakePty(input);
      spawned.push(p);
      return p;
    },
  };
  return { backend, spawned, load: () => Promise.resolve({ ok: true, backend }) };
}

function project(root: string, id = "p1", extra: Partial<TerminalProject> = {}): TerminalProject {
  return { id, name: id, root, store: null, ...extra };
}

function manager(opts: { root: string; current?: { value: TerminalProject | null }; idleMs?: number; now?: () => number }) {
  const fake = fakeBackend();
  const current = opts.current ?? { value: project(opts.root) };
  const m = new TerminalManager({
    project: () => current.value,
    version: "test",
    loadPty: fake.load,
    shell: { shell: "/bin/zsh", args: ["-l"] },
    env: { PATH: "/usr/bin", HOME: "/home/x" },
    sweep: false,
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  cleanups.push(() => m.shutdown(0));
  return { m, fake, current };
}

// ---------------------------------------------------------------- history

describe("scrollback buffer", () => {
  test("keeps output under the byte cap and restarts at a line break", () => {
    const buf = new ScrollbackBuffer(64);
    for (let i = 0; i < 20; i += 1) buf.append(`line ${i} ${"x".repeat(5)}\r\n`);
    expect(buf.byteLength).toBeLessThanOrEqual(64);
    const value = buf.value();
    expect(value.startsWith("line ")).toBe(true);
    expect(value.endsWith("line 19 xxxxx\r\n")).toBe(true);
  });

  test("counts UTF-8 bytes, not UTF-16 units", () => {
    const buf = new ScrollbackBuffer(1024);
    buf.append("é€😀\n");
    expect(buf.byteLength).toBe(2 + 3 + 4 + 1);
  });

  test("drops terminal queries from the replay but keeps colours and modes", () => {
    const buf = new ScrollbackBuffer(1024);
    buf.append("\u001b[31mred\u001b[0m\u001b[6n\u001b[c\u001b]11;?\u0007\u001b[?1049h");
    expect(buf.value()).toBe("\u001b[31mred\u001b[0m\u001b[?1049h");
  });

  test("an escape split across chunks is held back until complete", () => {
    const first = sanitizeReplayChunk("", "abc\u001b[3");
    expect(first).toEqual({ text: "abc", pending: "\u001b[3" });
    expect(sanitizeReplayChunk(first.pending, "1mX")).toEqual({ text: "\u001b[31mX", pending: "" });
  });

  test("tracks the alternate screen", () => {
    expect(altScreenAfter(false, "\u001b[?1049h")).toBe(true);
    expect(altScreenAfter(true, "x\u001b[?1049l")).toBe(false);
    expect(altScreenAfter(true, "plain")).toBe(true);
  });
});

describe("pasted commands", () => {
  test("bracketed paste keeps newlines literal and never executes", () => {
    expect(pastedCommand("ls -la\n", true)).toBe("\u001b[200~ls -la\u001b[201~");
    expect(pastedCommand("a\u001b[201~b", true)).toBe("\u001b[200~ab\u001b[201~");
  });
  test("without bracketed paste, newlines become spaces (nothing runs)", () => {
    expect(pastedCommand("echo 1\necho 2\n", false)).toBe("echo 1 echo 2");
  });
});

// ---------------------------------------------------------------- env / shell

describe("terminal environment", () => {
  test("drops daemon plumbing, keeps the user's variables, sets the terminal identity", () => {
    const env = terminalEnv(
      { PATH: "/bin", HOME: "/h", NPM_TOKEN: "user", npm_lifecycle_event: "desktop", ELECTRON_RUN_AS_NODE: "1", RUAH_PARENT_PID: "1", RUAH_MCP_TOKEN: "t" },
      { projectRoot: "/repo", version: "1.2.3" },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.NPM_TOKEN).toBe("user");
    expect(env.npm_lifecycle_event).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.RUAH_PARENT_PID).toBeUndefined();
    expect(env.RUAH_MCP_TOKEN).toBeUndefined();
    expect(env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Ruah", RUAH_PROJECT_ROOT: "/repo", LANG: "en_US.UTF-8" });
  });

  test("login shell from $SHELL, falling back to /bin/zsh or /bin/sh", () => {
    expect(resolveShell({ SHELL: "/bin/sh" }, "darwin")).toEqual({ shell: "/bin/sh", args: ["-l"] });
    const fallback = resolveShell({ SHELL: "/no/such/shell" }, "darwin");
    expect(fallback.args[0]).toBe("-l");
    expect(resolveShell({ SHELL: "/bin/zsh" }, "darwin")).toEqual({ shell: "/bin/zsh", args: ["-l", "-o", "nopromptsp"] });
    expect(["/bin/zsh", "/bin/bash", "/bin/sh"]).toContain(fallback.shell);
  });
});

// ---------------------------------------------------------------- cwd

describe("terminal cwd", () => {
  test("root by default; folders, files (→ folder) and missing paths (→ nearest parent) inside the project", () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "api"), { recursive: true });
    writeFileSync(join(root, "src", "api", "server.ts"), "");
    const p = project(root);
    expect(resolveTerminalCwd(p, {})).toBe(root);
    expect(resolveTerminalCwd(p, { cwd: "src/api" })).toBe(join(root, "src", "api"));
    expect(resolveTerminalCwd(p, { cwd: "src/api/server.ts" })).toBe(join(root, "src", "api"));
    expect(resolveTerminalCwd(p, { cwd: "src/api/new/thing.ts" })).toBe(join(root, "src", "api"));
    expect(resolveTerminalCwd(p, { cwd: join(root, "src") })).toBe(join(root, "src"));
  });

  test("refuses paths outside the project, symlinks included", () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, "escape"));
    const p = project(root);
    expect(() => resolveTerminalCwd(p, { cwd: "../x" })).toThrow(TerminalError);
    expect(() => resolveTerminalCwd(p, { cwd: outside })).toThrow(/outside the project/);
    expect(() => resolveTerminalCwd(p, { cwd: "escape" })).toThrow(/outside the project/);
    expect(() => resolveTerminalCwd(p, { cwd: "/" })).toThrow(/outside the project/);
  });

  test("an element's folder: its path, else its first file's folder", async () => {
    const root = tempDir();
    mkdirSync(join(root, "services", "billing"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(
      join(root, "architecture.json"),
      JSON.stringify({
        version: 1,
        name: "t",
        nodes: [
          { id: "billing", name: "Billing", type: "service", path: "services/billing" },
          { id: "util", name: "Util", type: "module", files: ["lib/util.ts"] },
        ],
        edges: [],
        workflows: [],
      }),
    );
    writeFileSync(join(root, "lib", "util.ts"), "");
    const store = createArchitectureStore(join(root, "architecture.json"), { watch: false });
    await store.load();
    const p = project(root, "p1", { store });
    expect(resolveTerminalCwd(p, { nodeId: "billing" })).toBe(join(root, "services", "billing"));
    expect(resolveTerminalCwd(p, { nodeId: "util" })).toBe(join(root, "lib"));
    expect(() => resolveTerminalCwd(p, { nodeId: "nope" })).toThrow(/unknown element/);
    // An element the map does not store (a drilled-in level) falls back to the given folder.
    expect(resolveTerminalCwd(p, { nodeId: "ephemeral:lib", cwd: "lib" })).toBe(join(root, "lib"));
  });
});

// ---------------------------------------------------------------- manager

describe("terminal manager", () => {
  test("create → attach replays the scrollback, streams output, resize/rename/input reach the PTY", async () => {
    const root = tempDir();
    const { m, fake } = manager({ root });
    const info = await m.create({ cols: 80, rows: 24 });
    expect(info).toMatchObject({ projectId: "p1", title: "zsh", cwd: root, status: "running", cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    expect(pty.input).toMatchObject({ shell: "/bin/zsh", args: ["-l"], cwd: root });
    expect(pty.input.env).toMatchObject({ TERM: "xterm-256color", RUAH_PROJECT_ROOT: root });

    pty.emit("hello\r\n");
    const got: TerminalServerMessage[] = [];
    const sink: TerminalSink = (msg) => got.push(msg);
    const attached = m.attach(info.id, sink);
    expect(attached.replay).toBe("hello\r\n");
    pty.emit("\u001b[32mworld\u001b[0m");
    expect(got).toEqual([{ type: "output", id: info.id, data: "\u001b[32mworld\u001b[0m" }]);

    m.input(info.id, "ls\r");
    m.resize(info.id, 120, 40);
    m.rename(info.id, "server");
    expect(pty.written).toEqual(["ls\r"]);
    expect(pty.sizes.at(-1)).toEqual([120, 40]);
    expect(m.list()[0]).toMatchObject({ title: "server", cols: 120, rows: 40 });

    // A second viewer (reload) gets everything so far.
    expect(m.attach(info.id, () => {}).replay).toBe("hello\r\n\u001b[32mworld\u001b[0m");
    m.clear(info.id);
    expect(m.attach(info.id, () => {}).replay).toBe("");
  });

  test("exit is reported and the terminal stays listed until closed; kill removes it", async () => {
    const { m, fake } = manager({ root: tempDir() });
    const changes: string[] = [];
    m.onChange((id) => changes.push(id));
    const info = await m.create({ cols: 80, rows: 24 });
    const got: TerminalServerMessage[] = [];
    m.attach(info.id, (msg) => got.push(msg));
    fake.spawned[0]!.emitExit(3);
    expect(got).toContainEqual({ type: "exit", id: info.id, exitCode: 3, signal: null });
    expect(m.list()[0]).toMatchObject({ status: "exited", exitCode: 3 });
    m.kill(info.id);
    expect(m.list()).toEqual([]);
    expect(changes).toEqual(["p1", "p1", "p1"]);
  });

  test("kill hangs up a running shell", async () => {
    const { m, fake } = manager({ root: tempDir() });
    const info = await m.create({ cols: 80, rows: 24 });
    m.kill(info.id);
    expect(fake.spawned[0]!.signals).toEqual(["SIGHUP"]);
    expect(() => m.input(info.id, "x")).toThrow(/unknown terminal/);
  });

  test("terminals are per project, survive a project switch and die after the project is closed for idleMs", async () => {
    const root = tempDir();
    let now = 1_000_000;
    const current = { value: project(root, "a") as TerminalProject | null };
    const { m, fake } = manager({ root, current, idleMs: 60_000, now: () => now });
    const a = await m.create({ cols: 80, rows: 24 });
    current.value = project(root, "b");
    const b = await m.create({ cols: 80, rows: 24 });
    expect(m.list("a").map((t) => t.id)).toEqual([a.id]);
    expect(m.list().map((t) => t.id)).toEqual([b.id]);
    m.sweep(now);
    now += 30_000;
    m.sweep(now);
    expect(m.list("a")).toHaveLength(1); // closed 30 s: kept
    now += 31_000;
    m.sweep(now);
    expect(m.list("a")).toHaveLength(0); // closed > 60 s: killed
    expect(fake.spawned[0]!.signals).toContain("SIGHUP");
    expect(m.list("b")).toHaveLength(1); // the open project's terminal stays
  });

  test("flow control pauses the PTY while a viewer is behind and resumes on ack", async () => {
    const { m, fake } = manager({ root: tempDir() });
    const info = await m.create({ cols: 80, rows: 24 });
    const sink: TerminalSink = () => {};
    m.attach(info.id, sink);
    const pty = fake.spawned[0]!;
    pty.emit("x".repeat(FLOW_HIGH_WATERMARK + 1));
    expect(pty.paused).toBe(true);
    m.ack(info.id, sink, FLOW_HIGH_WATERMARK);
    expect(pty.paused).toBe(false);
    pty.emit("y".repeat(FLOW_HIGH_WATERMARK + 1));
    expect(pty.paused).toBe(true);
    m.detach(info.id, sink); // the slow viewer went away
    expect(pty.paused).toBe(false);
  });

  test("'Run in terminal' types the command at the first prompt without Enter", async () => {
    const { m, fake } = manager({ root: tempDir() });
    await m.create({ cols: 80, rows: 24, input: "pnpm test\n" });
    const pty = fake.spawned[0]!;
    pty.emit("\u001b[?2004h% ");
    await new Promise((r) => setTimeout(r, 400));
    expect(pty.written).toEqual(["\u001b[200~pnpm test\u001b[201~"]);
  });

  test("full-screen apps are nudged to redraw on re-attach", async () => {
    const { m, fake } = manager({ root: tempDir() });
    const info = await m.create({ cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    pty.emit("\u001b[?1049h");
    m.attach(info.id, () => {});
    await new Promise((r) => setTimeout(r, 80));
    expect(pty.sizes).toEqual([
      [80, 23],
      [80, 24],
    ]);
  });

  test("no project → 409; node-pty missing → the fix in the message, the daemon keeps running", async () => {
    const none = manager({ root: tempDir(), current: { value: null } });
    await expect(none.m.create({ cols: 80, rows: 24 })).rejects.toThrow(/open a project first/);
    const broken = new TerminalManager({
      project: () => project(tempDir()),
      version: "t",
      sweep: false,
      loadPty: () => Promise.resolve({ ok: false, reason: "Terminal unavailable: … run `pnpm rebuild node-pty`" }),
    });
    await expect(broken.create({ cols: 80, rows: 24 })).rejects.toThrow(/pnpm rebuild node-pty/);
    expect(await broken.availability()).toEqual({ available: false, reason: expect.stringMatching(/pnpm rebuild node-pty/) });
  });
});

// ---------------------------------------------------------------- real PTY

describe("node-pty (real)", () => {
  test("runs a login shell in the project and reports its exit", async () => {
    const loaded = await loadPty();
    if (!loaded.ok) {
      console.warn(`skipping real PTY test: ${loaded.reason}`);
      return;
    }
    const root = tempDir();
    const m = new TerminalManager({ project: () => project(root), version: "t", sweep: false, shell: { shell: "/bin/sh", args: [] } });
    cleanups.push(() => m.shutdown(0));
    const info = await m.create({ cols: 80, rows: 24 });
    let out = "";
    const exited = new Promise<number | null>((resolve) =>
      m.attach(info.id, (msg) => {
        if (msg.type === "output") out += msg.data;
        if (msg.type === "exit") resolve(msg.exitCode);
      }),
    );
    m.input(info.id, 'printf "cwd=%s term=%s\\n" "$PWD" "$TERM"; exit 7\r');
    expect(await exited).toBe(7);
    expect(out).toContain(`cwd=${root} term=xterm-256color`);
  });
});

// ---------------------------------------------------------------- gateway (security)

interface Harness {
  url: string;
  gateway: TerminalGateway;
  fake: ReturnType<typeof fakeBackend>;
}

async function gatewayServer(options: { host?: string; allowRemote?: boolean; allowOrigins?: string[] } = {}): Promise<Harness> {
  const root = tempDir();
  const fake = fakeBackend();
  const m = new TerminalManager({ project: () => project(root), version: "t", loadPty: fake.load, sweep: false, shell: { shell: "/bin/zsh", args: ["-l"] } });
  const gateway = new TerminalGateway({
    manager: m,
    host: options.host ?? "127.0.0.1",
    allowRemote: options.allowRemote ?? false,
    originAllowed: (origin) => originAllowed(origin, options.allowOrigins ?? []),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!gateway.handleHttp(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!gateway.handleUpgrade(req, socket, head, url)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    gateway.close();
    await m.shutdown(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, gateway, fake };
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

function wsStatus(url: string, options: { origin?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options.origin !== undefined ? { origin: options.origin } : {});
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", (err) => {
      if (!/Unexpected server response/.test(err.message)) reject(err);
    });
  });
}

function openClient(url: string, origin?: string): Promise<{ ws: WebSocket; next: (type: string) => Promise<TerminalServerMessage> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin !== undefined ? { origin } : {});
    const queue: TerminalServerMessage[] = [];
    const waiters: { type: string; resolve: (m: TerminalServerMessage) => void }[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as TerminalServerMessage;
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i !== -1) waiters.splice(i, 1)[0]!.resolve(msg);
      else queue.push(msg);
    });
    const next = (type: string) =>
      new Promise<TerminalServerMessage>((res) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i !== -1) res(queue.splice(i, 1)[0]!);
        else waiters.push({ type, resolve: res });
      });
    ws.on("open", () => {
      cleanups.push(() => ws.terminate());
      resolve({ ws, next });
    });
    ws.on("error", reject);
  });
}

describe("terminal gateway security", () => {
  test("token: same-origin page and local tools get it; cross-origin, cross-site and rebound hosts do not", async () => {
    const h = await gatewayServer();
    const origin = h.url;
    const ok = await get(`${h.url}/api/terminal/token`, { origin, "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ token: h.gateway.token });
    expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect((await get(`${h.url}/api/terminal/token`)).status).toBe(200); // curl-like local tool
    expect((await get(`${h.url}/api/terminal/token`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await get(`${h.url}/api/terminal/token`, { origin: "http://localhost:9999" })).status).toBe(403); // another local site
    expect((await get(`${h.url}/api/terminal/token`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(`${h.url}/api/terminal/token`, { host: "evil.example:4177" })).status).toBe(403); // DNS rebinding
  });

  test("socket: needs the token, an allowed Origin and a loopback Host", async () => {
    const h = await gatewayServer();
    const ws = h.url.replace("http:", "ws:");
    expect(await wsStatus(`${ws}/ws/terminal`)).toBe(401);
    expect(await wsStatus(`${ws}/ws/terminal?token=wrong`)).toBe(401);
    expect(await wsStatus(`${ws}/ws/terminal?token=${h.gateway.token}`, { origin: "https://evil.example" })).toBe(403);
    expect(await wsStatus(`${ws}/ws/terminal?token=${h.gateway.token}`, { origin: h.url })).toBe(101);
  });

  test("non-loopback peers are refused; a non-loopback --host disables terminals unless --allow-remote-terminal", async () => {
    const root = tempDir();
    const m = new TerminalManager({ project: () => project(root), version: "t", sweep: false, loadPty: fakeBackend().load });
    cleanups.push(() => m.shutdown(0));
    const call = (gateway: TerminalGateway, remoteAddress: string, host: string) => {
      let status = 0;
      const req = { method: "GET", headers: { host }, socket: { remoteAddress } } as unknown as IncomingMessage;
      const res = { writeHead: (s: number) => (status = s), end: () => {} } as unknown as ServerResponse;
      gateway.handleHttp(req, res, new URL("http://x/api/terminal/token"));
      return status;
    };
    const local = new TerminalGateway({ manager: m, host: "127.0.0.1", allowRemote: false, originAllowed: () => true });
    expect(call(local, "192.168.1.20", "127.0.0.1:4177")).toBe(403);
    const lan = new TerminalGateway({ manager: m, host: "0.0.0.0", allowRemote: false, originAllowed: () => true });
    expect(lan.disabledReason()).toMatch(/--allow-remote-terminal/);
    expect(call(lan, "127.0.0.1", "127.0.0.1:4177")).toBe(403);
    const remote = new TerminalGateway({ manager: m, host: "0.0.0.0", allowRemote: true, originAllowed: () => true });
    expect(call(remote, "192.168.1.20", "192.168.1.5:4177")).toBe(200);
    expect(call(remote, "192.168.1.20", "rebound.example:4177")).toBe(403);
  });

  test("protocol: create, attach with replay, input, resize, rename, kill", async () => {
    const h = await gatewayServer();
    const { ws, next } = await openClient(`${h.url.replace("http:", "ws:")}/ws/terminal?token=${h.gateway.token}`, h.url);
    expect(await next("ready")).toMatchObject({ available: true, projectId: "p1", shell: "/bin/zsh" });
    ws.send(JSON.stringify({ type: "create", requestId: "r1", cols: 100, rows: 30, title: "dev" }));
    const created = (await next("created")) as Extract<TerminalServerMessage, { type: "created" }>;
    expect(created.terminal).toMatchObject({ title: "dev", cols: 100, rows: 30 });
    const pty = h.fake.spawned[0]!;
    pty.emit("before\r\n");
    ws.send(JSON.stringify({ type: "attach", id: created.terminal.id }));
    expect(await next("attached")).toMatchObject({ replay: "before\r\n" });
    pty.emit("after");
    expect(await next("output")).toEqual({ type: "output", id: created.terminal.id, data: "after" });
    ws.send(JSON.stringify({ type: "input", id: created.terminal.id, data: "echo hi\r" }));
    ws.send(JSON.stringify({ type: "resize", id: created.terminal.id, cols: 90, rows: 20 }));
    ws.send(JSON.stringify({ type: "list", requestId: "l1" }));
    while (((await next("terminals")) as { requestId?: string }).requestId !== "l1");
    expect(pty.written).toEqual(["echo hi\r"]);
    expect(pty.sizes.at(-1)).toEqual([90, 20]);
    ws.send(JSON.stringify({ type: "input", id: "t_nope", data: "x" }));
    expect(await next("error")).toMatchObject({ id: "t_nope", message: expect.stringMatching(/unknown terminal/) });
    ws.send(JSON.stringify({ type: "create", requestId: "r2", cols: 1, rows: 30 }));
    expect(await next("error")).toMatchObject({ requestId: "r2" });
    ws.send(JSON.stringify({ type: "kill", id: created.terminal.id }));
    for (;;) {
      const list = (await next("terminals")) as Extract<TerminalServerMessage, { type: "terminals" }>;
      if (list.terminals.length === 0) break;
    }
    expect(pty.signals).toContain("SIGHUP");
  });

  test("the daemon serves the token and socket (startServer wiring)", async () => {
    const root = tempDir();
    const hub = new SessionHub(null, null, { version: "t", links: false, debug: () => {}, info: () => {} });
    const m = new TerminalManager({ project: () => project(root), version: "t", sweep: false, loadPty: fakeBackend().load });
    const terminal = new TerminalGateway({ manager: m, host: "127.0.0.1", allowRemote: false, originAllowed: (o) => originAllowed(o, []) });
    const running = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, terminal });
    cleanups.push(async () => {
      await running.close();
      await m.shutdown(0);
      await hub.shutdown();
    });
    const token = await get(`${running.url}/api/terminal/token`, { origin: running.url });
    expect(token.status).toBe(200);
    expect(await wsStatus(`${running.url.replace("http:", "ws:")}/ws/terminal`)).toBe(401);
    expect(await wsStatus(`${running.url.replace("http:", "ws:")}/ws/terminal?token=${terminal.token}`, { origin: running.url })).toBe(101);
    expect((await get(`${running.url}/api/terminal/token`, { origin: "https://evil.example" })).status).toBe(403);
  });
});
