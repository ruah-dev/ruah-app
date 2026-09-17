// src/serve/run-serve.ts — the `archmap serve` entry point: store + bridge +
// hub + server wiring, startup banner, --open.
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createArchitectureStore } from "./architecture-store.js";
import { createBridge } from "../acp/index.js";
import { SessionHub } from "./session.js";
import { startServer } from "./server.js";

export interface ServeFlags {
  repo: string;
  file?: string;
  port: number;
  host: string;
  viewer: string;
  mock: boolean;
  allowOrigins: string[];
  links: boolean;
  open: boolean;
}

export async function runServe(flags: ServeFlags, version: string): Promise<number> {
  let resolveServe: (code: number) => void = () => {};
  const root = path.resolve(flags.repo);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`archmap serve: repo directory not found: ${flags.repo}\n`);
    return 2;
  }
  const archPath = path.resolve(flags.file !== undefined ? path.resolve(flags.file) : path.join(root, "architecture.json"));
  const t0 = Date.now();

  const store = createArchitectureStore(archPath, { watch: true });
  await store.load();

  const info = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const debug = (line: string): void => {
    if (process.env.ARCHMAP_DEBUG === "1") process.stderr.write(`${line}\n`);
  };
  const bridge = createBridge({
    root,
    preset: { command: "none", args: [] },
    clientVersion: version,
    mock: flags.mock,
  });
  await bridge.start();

  const hub = new SessionHub(store, bridge, { version, links: flags.links, debug, info });
  const running = await startServer(store, hub, {
    host: flags.host,
    port: flags.port,
    viewerDir: path.resolve(flags.viewer),
    allowOrigins: flags.allowOrigins,
    logger: (line: string) => debug(line),
  });

  const startupMs = Date.now() - t0;
  const agentName = flags.mock ? "mock" : "claude-agent-acp";
  info(`viewer ${running.url}  agent ${agentName} ${bridge.status()} (${startupMs} ms)`);

  if (flags.open) {
    const child = spawn("open", [running.url], { stdio: "ignore", detached: true });
    child.unref();
  }

  const shutdown = (): void => {
    hub.close();
    store.close();
    void bridge.stop().then(() => running.close()).then(() => resolveServe(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // serve runs until signalled; the promise resolves only on shutdown.
  return new Promise<number>((resolve) => {
    resolveServe = resolve;
  });
}
