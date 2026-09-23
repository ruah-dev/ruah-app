// src/serve/run-serve.ts — the `archmap serve` entry point: store + bridge +
// hub + server wiring, startup banner, --open.
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createArchitectureStore } from "./architecture-store.js";
import { AgentCatalog, MOCK_AGENT_ID, agentIdOf, type AgentProvider } from "../acp/index.js";
import { SessionHub } from "./session.js";
import { startServer } from "./server.js";
import { UsageLimitsService, UsageLog, UsageService, ruahHome } from "../usage/index.js";
import { probeClaudePlanUsage } from "../usage/claude-probe.js";

export interface ServeFlags {
  repo: string;
  file?: string;
  port: number;
  host: string;
  viewer: string;
  mock: boolean;
  agent: AgentProvider;
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
  const catalog = new AgentCatalog({ root, clientVersion: version, onStderr: debug }, { mock: flags.mock });
  const agentId = flags.mock ? MOCK_AGENT_ID : agentIdOf(flags.agent);
  const check = catalog.check(agentId);
  if (!check.ok) {
    process.stderr.write(`archmap serve: ${check.message}\n`);
    store.close();
    return 2;
  }
  const bridge = catalog.create(agentId);
  // Usage log in $RUAH_HOME (~/.ruah); the Claude limits probe is a CLI start
  // without a model turn — RUAH_CLAUDE_USAGE_PROBE=0 turns it off.
  let hubRef: SessionHub | undefined;
  const limits = new UsageLimitsService({
    agents: () => catalog.choices(hubRef?.agentId() ?? agentId).available.map(({ id, name, installed }) => ({ id, name, installed })),
    currentAgentId: () => hubRef?.agentId() ?? agentId,
    currentBridge: () => hubRef?.bridge,
    ...(process.env.RUAH_CLAUDE_USAGE_PROBE === "0" ? {} : { probeClaude: () => probeClaudePlanUsage(root) }),
    debug,
  });
  const usage = new UsageService(new UsageLog(ruahHome()), limits, { onError: (line) => process.stderr.write(`${line}\n`) });
  const hub = new SessionHub(store, bridge, { version, links: flags.links, debug, info, agentId, agents: catalog, usage });
  hubRef = hub;
  // A failed start (e.g. the CLI is not logged in) leaves the agent in state
  // "error" with the reason; the viewer still comes up and can switch agents.
  let startError: string | undefined;
  await bridge.start().catch((err: unknown) => {
    startError = err instanceof Error ? err.message : String(err);
  });
  const running = await startServer(store, hub, {
    host: flags.host,
    port: flags.port,
    viewerDir: path.resolve(flags.viewer),
    allowOrigins: flags.allowOrigins,
    logger: (line: string) => debug(line),
    usage,
  });

  const startupMs = Date.now() - t0;
  info(`viewer ${running.url}  agent ${agentId} ${bridge.status()} (${startupMs} ms)${startError !== undefined ? `: ${startError}` : ""}`);

  if (flags.open) {
    const child = spawn("open", [running.url], { stdio: "ignore", detached: true });
    child.unref();
  }

  const shutdown = (): void => {
    hub.close();
    store.close();
    void hub.bridge.stop().then(() => running.close()).then(() => resolveServe(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // serve runs until signalled; the promise resolves only on shutdown.
  return new Promise<number>((resolve) => {
    resolveServe = resolve;
  });
}
