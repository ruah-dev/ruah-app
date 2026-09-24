// src/serve/run-serve.ts — the `ruah app serve [<repo>]` entry point: hub +
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
import { AttachmentStore } from "../projects/attachment-store.js";
import { SettingsStore } from "../projects/settings-store.js";
import { ProjectError, ProjectService, type OpenSystemProject } from "../projects/service.js";
import { IntegrationsService } from "../integrations/index.js";
import { CloudWatcher, DEFAULT_WATCH_INTERVAL_MS } from "../integrations/watch.js";
import { EnginesService } from "../engines/index.js";
import { makeOpenSystemProject } from "../system/open.js";
import { MapOpsService } from "./map-ops.js";
import { DEFAULT_IDLE_MS, DEFAULT_SCROLLBACK_BYTES, TerminalManager } from "../terminal/manager.js";
import { TerminalGateway } from "../terminal/gateway.js";
import { originAllowed } from "./server.js";

export interface ServeFlags {
  /** Absent = launcher state. */
  repo?: string;
  file?: string;
  port: number;
  host: string;
  viewer: string;
  mock: boolean;
  /** Absent = the saved default agent (settings.json), else Claude Code. */
  agent?: AgentProvider;
  allowOrigins: string[];
  links: boolean;
  open: boolean;
  /** Terminals on a non-loopback --host (off by default: a terminal is a shell for whoever reaches the port). */
  allowRemoteTerminal?: boolean;
}

export interface ServeHooks {
  /** Opens a folder holding ruah.system.json (multi-repo, src/system/*); default refuses. */
  openSystemProject?: OpenSystemProject;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const value = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/** RUAH_WARM_TTL_MS overrides the 15-minute keep-alive of warm agents (0 = stop at once, no pre-warming). */
function warmTtlMs(): number {
  return envInt("RUAH_WARM_TTL_MS", DEFAULT_WARM_TTL_MS, 0);
}

/** RUAH_MAX_LIVE_AGENTS overrides the cap of 4 live agent processes (current + warm). */
function maxLiveAgents(): number {
  return envInt("RUAH_MAX_LIVE_AGENTS", DEFAULT_MAX_LIVE_BRIDGES, 1);
}

export async function runServe(flags: ServeFlags, version: string, hooks: ServeHooks = {}): Promise<number> {
  let resolveServe: (code: number) => void = () => {};
  if (flags.repo !== undefined) {
    const root = path.resolve(flags.repo);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      process.stderr.write(`ruah app serve: repo directory not found: ${flags.repo}\n`);
      return 2;
    }
  } else if (flags.file !== undefined) {
    process.stderr.write("ruah app serve: --file needs a <repo>\n");
    return 2;
  }
  const t0 = Date.now();

  const info = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const debug = (line: string): void => {
    if (process.env.RUAH_DEBUG === "1") process.stderr.write(`${line}\n`);
  };
  const initialRoot = flags.repo !== undefined ? path.resolve(flags.repo) : (process.env.HOME ?? homedir());
  let hubRef: SessionHub | undefined;
  // Agents edit the open project's map through the ruah_* tools (CONTRACTS §1.7); RUAH_MAP_TOOLS=0 turns them off.
  const mapOps = process.env.RUAH_MAP_TOOLS === "0" ? undefined : new MapOpsService(() => hubRef, { version });
  const catalog = new AgentCatalog(
    { root: initialRoot, clientVersion: version, onStderr: debug },
    { mock: flags.mock, ...(mapOps !== undefined ? { mapTools: (agentId: string, root: string) => mapOps.toolsFor({ agentId, root }) } : {}) },
  );
  const home = ruahHome();
  const settings = new SettingsStore(home, { onError: (line) => process.stderr.write(`${line}\n`) });
  // --agent wins; else the saved default agent when it is installed; else Claude Code.
  const saved = settings.get().defaultAgentId;
  const agentId = flags.mock
    ? MOCK_AGENT_ID
    : flags.agent !== undefined
      ? agentIdOf(flags.agent)
      : saved !== undefined && catalog.check(saved).ok
        ? saved
        : "claude";
  const check = catalog.check(agentId);
  if (!check.ok) {
    process.stderr.write(`ruah app serve: ${check.message}\n`);
    return 2;
  }
  // Usage log in $RUAH_HOME (~/.ruah); the Claude limits probe is a CLI start
  // without a model turn — RUAH_CLAUDE_USAGE_PROBE=0 turns it off.
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
  const usage = new UsageService(new UsageLog(home), limits, {
    onError,
    workflows: () => {
      const arch = hubRef?.store?.current();
      return arch?.workflows.map((w) => ({ id: w.id, steps: w.steps }));
    },
  });
  const chats = new ChatStore(home, { onError });
  const attachments = new AttachmentStore(home);
  const engines = new EnginesService({
    root: () => hubRef?.project()?.root ?? null,
    architecture: () => hubRef?.store?.current() ?? null,
    debug,
    cli: {
      workspaceRoot: process.env.RUAH_WORKSPACE?.trim() || undefined,
    },
  });
  // Follows the hub's current project; null in the launcher state (endpoints answer 409).
  const integrations = new IntegrationsService({
    home: ruahHome(),
    project: () => {
      const current = hubRef?.store ?? null;
      return current === null ? null : { root: current.root, architecture: current.current() };
    },
  });
  // CONTRACTS §9 watch mode: re-sync enabled cloud providers only while a viewer is on the
  // Cloud page or shows cloud on the map (RUAH_CLOUD_WATCH=0 turns it off).
  const cloudWatch = process.env.RUAH_CLOUD_WATCH === "0" ? undefined : new CloudWatcher({
    providers: () => ((hubRef?.store ?? null) !== null ? integrations.registry.cloud().filter((c) => c.enabled()).map((c) => c.id) : []),
    sync: async (id) => {
      const result = await integrations.cloudSync({ providers: [id] });
      return { ok: !result.errors.some((e) => e.provider === id) || result.resources.some((r) => r.provider === id) };
    },
    intervalMs: envInt("RUAH_CLOUD_WATCH_MS", DEFAULT_WATCH_INTERVAL_MS, 1000),
    onError: (id, err) => debug(`cloud watch ${id}: ${(err as Error).message}`),
  });
  const hub = new SessionHub(null, null, {
    version,
    links: flags.links,
    debug,
    info,
    agentId,
    agents: catalog,
    usage,
    engines,
    chats,
    attachments,
    settings,
    ...(mapOps !== undefined ? { mapOps } : {}),
    ...(cloudWatch !== undefined ? { cloudWatch } : {}),
    warmTtlMs: warmTtlMs(),
    maxLiveBridges: maxLiveAgents(),
    // The scripted mock must not start real agent CLIs behind the user's back.
    prewarm: !flags.mock && process.env.RUAH_PREWARM !== "0",
  });
  hubRef = hub;
  integrations.onCloudUpdated((update) => {
    // Syncs from the Sync button count for the watch schedule too.
    for (const id of update.providers) cloudWatch?.noteSynced(id, !update.failed.includes(id));
    hub.broadcast({ type: "cloud.updated", ...update });
  });
  const projects = new ProjectService({
    projects: new ProjectsStore(home, { onError }),
    chats,
    host: hub,
    version,
    info,
    // Multi-repo systems (src/system/open.ts) unless a caller injects its own hook.
    openSystemProject: hooks.openSystemProject ?? makeOpenSystemProject(version),
  });
  if (flags.repo !== undefined) {
    try {
      await projects.open(flags.repo, flags.file !== undefined ? { file: flags.file } : {});
    } catch (err) {
      process.stderr.write(`ruah app serve: ${err instanceof ProjectError || err instanceof Error ? err.message : String(err)}\n`);
      await hub.shutdown();
      return 2;
    }
  }
  // Integrated terminal (CONTRACTS §7): PTYs per project, killed with the daemon.
  const terminals = new TerminalManager({
    version,
    project: () => {
      const info = hub.project();
      return info === null ? null : { id: info.id, name: info.name, root: info.root, store: hub.store };
    },
    idleMs: envInt("RUAH_TERMINAL_IDLE_MS", DEFAULT_IDLE_MS, 0),
    scrollbackBytes: envInt("RUAH_TERMINAL_SCROLLBACK_BYTES", DEFAULT_SCROLLBACK_BYTES, 4096),
  });
  process.once("exit", () => terminals.hangUpAll());
  const terminal = new TerminalGateway({
    manager: terminals,
    host: flags.host,
    allowRemote: flags.allowRemoteTerminal === true,
    originAllowed: (origin) => originAllowed(origin, flags.allowOrigins),
    logger: debug,
  });
  const running = await startServer(null, hub, {
    host: flags.host,
    port: flags.port,
    viewerDir: path.resolve(flags.viewer),
    allowOrigins: flags.allowOrigins,
    logger: (line: string) => debug(line),
    usage,
    projects,
    terminal,
    engines,
    ...(mapOps !== undefined ? { mapOps } : {}),
    integrations,
  });

  mapOps?.setDaemonUrl(running.url);
  const startupMs = Date.now() - t0;
  const project = hub.project();
  info(`viewer ${running.url}  project ${project !== null ? project.name : "(none: launcher)"}  agent ${agentId} ${hub.agentState()} (${startupMs} ms)`);

  if (flags.open) {
    const child = spawn("open", [running.url], { stdio: "ignore", detached: true });
    child.unref();
  }

  const shutdown = (): void => {
    cloudWatch?.stop();
    void Promise.all([hub.shutdown(), terminals.shutdown()])
      .then(() => running.close())
      .then(() => resolveServe(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Started by the desktop app: exit when that process is gone, even if it
  // crashed or was force-quit without stopping us (otherwise we would keep
  // the port and the next launch would find a stale daemon).
  const parentPid = Number.parseInt(process.env.RUAH_PARENT_PID ?? "", 10);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const watch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(watch);
        info("desktop app is gone; stopping");
        shutdown();
      }
    }, 2000);
    watch.unref();
  }

  // serve runs until signalled; the promise resolves only on shutdown.
  return new Promise<number>((resolve) => {
    resolveServe = resolve;
  });
}
