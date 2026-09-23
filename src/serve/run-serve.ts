// src/serve/run-serve.ts — the `archmap serve [<repo>]` entry point: hub +
// projects + server wiring, startup banner, --open. Without <repo> the daemon
// starts in the launcher state (no project; CONTRACTS §5) and the viewer
// opens or creates one over /api/projects/*. The agent of a project starts in
// the background once the project is open.
import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { AgentCatalog, MOCK_AGENT_ID, agentIdOf, type AgentProvider } from "../acp/index.js";
import { SessionHub } from "./session.js";
import { startServer } from "./server.js";
import { DEFAULT_MAX_LIVE_BRIDGES, DEFAULT_WARM_TTL_MS } from "./bridge-pool.js";
import { UsageLimitsService, UsageLog, UsageService, ruahHome } from "../usage/index.js";
import { probeClaudePlanUsage } from "../usage/claude-probe.js";
import { ProjectsStore } from "../projects/projects-store.js";
import { ChatStore } from "../projects/chat-store.js";
import { ProjectError, ProjectService, type OpenSystemProject } from "../projects/service.js";
import { IntegrationsService } from "../integrations/index.js";

export interface ServeFlags {
  /** Absent = launcher state. */
  repo?: string;
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

export interface ServeHooks {
  /** Opens a folder holding ruah.system.json (multi-repo, src/system/*); default refuses. */
  openSystemProject?: OpenSystemProject;
}

/** RUAH_WARM_TTL_MS overrides the 5-minute keep-alive of agents the hub let go (0 = stop at once). */
function warmTtlMs(): number {
  const raw = process.env.RUAH_WARM_TTL_MS;
  const value = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_WARM_TTL_MS;
}

export async function runServe(flags: ServeFlags, version: string, hooks: ServeHooks = {}): Promise<number> {
  let resolveServe: (code: number) => void = () => {};
  if (flags.repo !== undefined) {
    const root = path.resolve(flags.repo);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      process.stderr.write(`archmap serve: repo directory not found: ${flags.repo}\n`);
      return 2;
    }
  } else if (flags.file !== undefined) {
    process.stderr.write("archmap serve: --file needs a <repo>\n");
    return 2;
  }
  const t0 = Date.now();

  const info = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const debug = (line: string): void => {
    if (process.env.ARCHMAP_DEBUG === "1") process.stderr.write(`${line}\n`);
  };
  const initialRoot = flags.repo !== undefined ? path.resolve(flags.repo) : (process.env.HOME ?? homedir());
  const catalog = new AgentCatalog({ root: initialRoot, clientVersion: version, onStderr: debug }, { mock: flags.mock });
  const agentId = flags.mock ? MOCK_AGENT_ID : agentIdOf(flags.agent);
  const check = catalog.check(agentId);
  if (!check.ok) {
    process.stderr.write(`archmap serve: ${check.message}\n`);
    return 2;
  }
  const home = ruahHome();
  // Usage log in $RUAH_HOME (~/.ruah); the Claude limits probe is a CLI start
  // without a model turn — RUAH_CLAUDE_USAGE_PROBE=0 turns it off.
  let hubRef: SessionHub | undefined;
  const limits = new UsageLimitsService({
    agents: () => catalog.choices(hubRef?.agentId() ?? agentId).available.map(({ id, name, installed }) => ({ id, name, installed })),
    currentAgentId: () => hubRef?.agentId() ?? agentId,
    currentBridge: () => hubRef?.bridge,
    ...(process.env.RUAH_CLAUDE_USAGE_PROBE === "0" ? {} : { probeClaude: () => probeClaudePlanUsage(hubRef?.project()?.root ?? initialRoot) }),
    debug,
  });
  const onError = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const usage = new UsageService(new UsageLog(home), limits, { onError });
  const chats = new ChatStore(home, { onError });
  const hub = new SessionHub(null, null, {
    version,
    links: flags.links,
    debug,
    info,
    agentId,
    agents: catalog,
    usage,
    chats,
    warmTtlMs: warmTtlMs(),
    maxLiveBridges: DEFAULT_MAX_LIVE_BRIDGES,
  });
  hubRef = hub;
  const projects = new ProjectService({
    projects: new ProjectsStore(home, { onError }),
    chats,
    host: hub,
    version,
    info,
    ...(hooks.openSystemProject !== undefined ? { openSystemProject: hooks.openSystemProject } : {}),
  });
  if (flags.repo !== undefined) {
    try {
      await projects.open(flags.repo, flags.file !== undefined ? { file: flags.file } : {});
    } catch (err) {
      process.stderr.write(`archmap serve: ${err instanceof ProjectError || err instanceof Error ? err.message : String(err)}\n`);
      await hub.shutdown();
      return 2;
    }
  }
  const running = await startServer(null, hub, {
    host: flags.host,
    port: flags.port,
    viewerDir: path.resolve(flags.viewer),
    allowOrigins: flags.allowOrigins,
    logger: (line: string) => debug(line),
    usage,
    projects,
    // Follows the hub's current project; null in the launcher state (endpoints answer 409).
    integrations: new IntegrationsService({
      home: ruahHome(),
      project: () => {
        const current = hub.store;
        return current === null ? null : { root: current.root, architecture: current.current() };
      },
    }),
  });

  const startupMs = Date.now() - t0;
  const project = hub.project();
  info(`viewer ${running.url}  project ${project !== null ? project.name : "(none: launcher)"}  agent ${agentId} ${hub.agentState()} (${startupMs} ms)`);

  if (flags.open) {
    const child = spawn("open", [running.url], { stdio: "ignore", detached: true });
    child.unref();
  }

  const shutdown = (): void => {
    void hub.shutdown().then(() => running.close()).then(() => resolveServe(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // serve runs until signalled; the promise resolves only on shutdown.
  return new Promise<number>((resolve) => {
    resolveServe = resolve;
  });
}
