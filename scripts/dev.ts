// `pnpm dev` — develop Ruah with hot reload everywhere (README "Developing Ruah"):
//   daemon   `tsx watch src/cli.ts serve …` — restarts on every src/ change; viewers reconnect
//            and re-open the project that was open
//   viewer   the Vite dev server for ui/ (React Fast Refresh / HMR), proxying /api and /ws to
//            the daemon so the viewer stays same-origin
//   desktop  Electron on the Vite URL, attached to that daemon (RUAH_VIEWER_URL,
//            RUAH_DAEMON_URL); restarted when electron/*.cjs changes
// So an agent editing Ruah's own UI (or daemon) shows up in the running app at once.
//
//   pnpm dev [<repo>] [--mock] [--agent <id>] [--no-electron] [--daemon-port <n>] [--viewer-port <n>]
//
// Other flags go to `ruah app serve`. RUAH_HOME etc. pass through; RUAH_ELECTRON_ARGS adds
// Electron switches (e.g. --remote-debugging-port=9333). Ctrl+C (or closing the window) stops
// everything.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(ROOT, "ui");
const require = createRequire(import.meta.url);

const COLORS: Record<string, string> = { daemon: "36", viewer: "35", electron: "33", dev: "32" };
function log(tag: string, text: string): void {
  const prefix = process.stdout.isTTY ? `\u001b[${COLORS[tag] ?? "37"}m[${tag}]\u001b[0m` : `[${tag}]`;
  for (const line of text.split(/\r?\n/)) if (line.length > 0) process.stdout.write(`${prefix} ${line}\n`);
}

function pipe(tag: string, child: ChildProcess): void {
  let rest = { out: "", err: "" };
  const on = (key: "out" | "err") => (chunk: Buffer) => {
    const text = rest[key] + chunk.toString();
    const lines = text.split("\n");
    rest = { ...rest, [key]: lines.pop() ?? "" };
    if (lines.length > 0) log(tag, lines.join("\n"));
  };
  child.stdout?.on("data", on("out"));
  child.stderr?.on("data", on("err"));
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      if (port > start + 100) {
        reject(new Error(`no free port from ${start}`));
        return;
      }
      const probe = net.createServer();
      probe.once("error", () => tryPort(port + 1));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(port)));
    };
    tryPort(start);
  });
}

function ok(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.setTimeout(1500, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function waitFor(url: string, what: string, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ok(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not answer at ${url} within ${ms / 1000} s`);
}

function takeValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const noElectron = args.includes("--no-electron") || process.env.RUAH_DEV_ELECTRON === "0";
  if (args.includes("--no-electron")) args.splice(args.indexOf("--no-electron"), 1);
  const daemonPort = Number(takeValue(args, "--daemon-port") ?? process.env.RUAH_DEV_DAEMON_PORT ?? 0) || (await freePort(4190));
  const viewerPort = Number(takeValue(args, "--viewer-port") ?? process.env.RUAH_DEV_VIEWER_PORT ?? 0) || (await freePort(8080));
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const viewerUrl = `http://127.0.0.1:${viewerPort}`;
  const children = new Set<ChildProcess>();
  let stopping = false;

  const stopAll = (code: number): void => {
    if (stopping) return;
    stopping = true;
    log("dev", "stopping…");
    for (const child of children) child.kill("SIGTERM");
    const force = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      process.exit(code);
    }, 4000);
    force.unref();
    const waitAll = [...children].map((c) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r()))));
    void Promise.all(waitAll).then(() => process.exit(code));
  };
  process.on("SIGINT", () => stopAll(0));
  process.on("SIGTERM", () => stopAll(0));

  // 1. The daemon under a watcher: any change to src/ restarts it (SIGTERM: PTYs and preview
  //    servers are stopped cleanly); RUAH_PARENT_PID ends it if this script dies.
  const tsxCli = require.resolve("tsx/cli");
  const daemon = spawn(
    process.execPath,
    [tsxCli, "watch", "--clear-screen=false", "src/cli.ts", "serve", ...args, "--port", String(daemonPort), "--viewer", path.join(ROOT, "viewer")],
    { cwd: ROOT, env: { ...process.env, RUAH_PARENT_PID: String(process.pid), FORCE_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(daemon);
  pipe("daemon", daemon);
  daemon.on("exit", (code) => {
    children.delete(daemon);
    if (!stopping) {
      log("dev", `the daemon watcher exited (${code ?? "signal"})`);
      stopAll(1);
    }
  });

  // 2. The viewer on the Vite dev server (HMR), proxying the daemon (ui/vite.config.ts).
  const viteBin = path.join(UI, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    log("dev", "ui/node_modules is missing — run `bun install` in ui/ first");
    stopAll(1);
    return;
  }
  const viewer = spawn(process.execPath, [viteBin, "dev", "--port", String(viewerPort), "--strictPort", "--host", "127.0.0.1"], {
    cwd: UI,
    env: { ...process.env, RUAH_DEV_DAEMON_URL: daemonUrl, FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(viewer);
  pipe("viewer", viewer);
  viewer.on("exit", (code) => {
    children.delete(viewer);
    if (!stopping) {
      log("dev", `the viewer dev server exited (${code ?? "signal"})`);
      stopAll(1);
    }
  });

  await Promise.all([waitFor(`${daemonUrl}/api/health`, "the daemon"), waitFor(`${viewerUrl}/`, "the viewer")]);
  log("dev", `daemon ${daemonUrl} (restarts on src/ changes) · viewer ${viewerUrl} (hot reload)`);
  if (noElectron) {
    log("dev", `open ${viewerUrl} in a browser`);
    return;
  }

  // 3. Electron on the dev server, attached to the daemon; restarted when electron/ changes.
  let electronPath: string;
  try {
    electronPath = require("electron") as string;
  } catch {
    log("dev", `Electron is not installed (pnpm install) — open ${viewerUrl} in a browser`);
    return;
  }
  let electron: ChildProcess | null = null;
  let restarting = false;
  const startElectron = (): void => {
    const env: NodeJS.ProcessEnv = { ...process.env, RUAH_VIEWER_URL: viewerUrl, RUAH_DAEMON_URL: daemonUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    // RUAH_ELECTRON_ARGS: extra Chromium / Electron switches, e.g. --remote-debugging-port=9333.
    const extra = (process.env.RUAH_ELECTRON_ARGS ?? "").split(/\s+/).filter((a) => a.length > 0);
    const child = spawn(electronPath, [...extra, ROOT], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    electron = child;
    children.add(child);
    pipe("electron", child);
    child.on("exit", (code) => {
      children.delete(child);
      if (electron === child) electron = null;
      if (restarting || stopping) return;
      log("dev", `the window closed (${code ?? "signal"})`);
      stopAll(0);
    });
  };
  startElectron();
  let timer: NodeJS.Timeout | undefined;
  fs.watch(path.join(ROOT, "electron"), (_event, name) => {
    if (typeof name !== "string" || !name.endsWith(".cjs")) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      log("dev", `${name} changed — restarting Electron`);
      restarting = true;
      const old = electron;
      const again = (): void => {
        restarting = false;
        if (!stopping) startElectron();
      };
      if (old === null) again();
      else {
        old.once("exit", again);
        old.kill("SIGTERM");
      }
    }, 300);
  });
}

main().catch((err: unknown) => {
  log("dev", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
