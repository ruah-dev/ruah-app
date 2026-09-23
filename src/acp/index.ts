// src/acp/index.ts — bridge factory for the serve command. Claude Code runs on
// the Claude Agent SDK (the engine t3code uses); Cursor Agent, Grok Build,
// Kiro CLI, OpenCode (and Claude through claude-agent-acp, CLI-only) are ACP agents
// spawned from presets.ts. --mock uses the scripted MockBridge. AgentCatalog is
// what the SessionHub uses to switch agents at runtime (agent.set).
import { systemRootsFor } from "../system/roots.js";
import type { AgentChoiceState, ErrorCode } from "../contracts/ws.js";
import type { AcpBridge, AgentMapTools, BridgeOptions } from "./bridge.js";
import { MockBridge, type MockBridgeOptions } from "./mock-bridge.js";
import { ClaudeSdkBridge } from "./claude-sdk-bridge.js";
import { AcpProcessBridge } from "./acp-bridge.js";
import { AGENTS, agentDefinition, claudeCode, type AgentId } from "./presets.js";

export type { AcpBridge, BridgeOptions, BridgeEvent, TurnHandle } from "./bridge.js";
export { BusyError } from "./bridge.js";
export { MockBridge, type MockBridgeOptions } from "./mock-bridge.js";
export type { AgentId } from "./presets.js";

/** Values of `serve --agent`. "acp" is the historical alias of "claude-acp". */
export const AGENT_PROVIDERS = ["claude", "cursor", "grok", "kiro", "opencode", "claude-acp", "acp"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(value: string): value is AgentProvider {
  return (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function agentIdOf(provider: AgentProvider): AgentId {
  return provider === "acp" ? "claude-acp" : provider;
}

export const MOCK_AGENT_ID = "mock";

type BaseOptions = Omit<BridgeOptions, "preset">;

export type AgentCheck = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** The agents the viewer can pick from, and how to build a bridge for one. */
export class AgentCatalog {
  private installed = new Map<string, boolean>();

  constructor(
    private readonly base: BaseOptions,
    private readonly options: {
      mock?: boolean;
      env?: NodeJS.ProcessEnv;
      /** The ruah_* map tools for a new bridge (CONTRACTS §1.7); absent = agents get no map tools. */
      mapTools?: (agentId: string, root: string) => AgentMapTools;
    } = {},
  ) {
    this.refresh();
  }

  /** Re-probes which agent CLIs are installed. */
  refresh(): void {
    const env = this.options.env ?? process.env;
    this.installed = new Map(AGENTS.map((agent) => [agent.id, agent.id === "claude" || agent.preset(env) !== undefined]));
  }

  choices(currentAgentId: string): AgentChoiceState {
    const available: AgentChoiceState["available"] = [];
    const add = (id: string): void => {
      if (available.some((entry) => entry.id === id)) return;
      if (id === MOCK_AGENT_ID) {
        available.push({ id, name: "Mock agent", installed: true, description: "Scripted demo agent (no model calls)", images: true });
        return;
      }
      const agent = agentDefinition(id);
      if (agent === undefined) return;
      const installed = this.installed.get(agent.id) ?? false;
      available.push({
        id: agent.id,
        name: agent.name,
        installed,
        description: agent.description,
        ...(!installed && agent.installHint !== undefined ? { installHint: agent.installHint } : {}),
        // Claude SDK always takes images; ACP agents are known after initialize (the hub fills that in).
        ...(agent.id === "claude" ? { images: true } : {}),
      });
    };
    if (this.options.mock === true) add(MOCK_AGENT_ID);
    for (const agent of AGENTS) if (agent.listed) add(agent.id);
    // A CLI-only agent (claude-acp) still shows while it is the current one.
    add(currentAgentId);
    return { currentAgentId, available };
  }

  /** Whether `agentId` can be started now (re-probes installation). */
  check(agentId: string): AgentCheck {
    this.refresh();
    if (agentId === MOCK_AGENT_ID && this.options.mock === true) return { ok: true };
    const agent = agentDefinition(agentId);
    if (agent === undefined) return { ok: false, code: "bad_message", message: `unknown agent: ${agentId}` };
    if (this.installed.get(agent.id) !== true) {
      return { ok: false, code: "agent_spawn_failed", message: `${agent.name} is not installed${agent.installHint !== undefined ? ` — ${agent.installHint}` : ""}` };
    }
    return { ok: true };
  }

  /**
   * A new, not yet started bridge whose session cwd is `root` (default: the
   * catalog's root). Throws for an unknown or missing agent.
   */
  create(agentId: string, root?: string): AcpBridge {
    const extra = root !== undefined ? systemRootsFor(root) : [];
    const rooted: BaseOptions = root !== undefined ? { ...this.base, root } : this.base;
    const withDirs: BaseOptions = extra.length > 0 ? { ...rooted, additionalDirectories: extra } : rooted;
    if (agentId === MOCK_AGENT_ID && this.options.mock === true) {
      return new MockBridge({ ...withDirs, preset: { command: "none", args: [] }, chunkDelayMs: 40 });
    }
    const agent = agentDefinition(agentId);
    if (agent === undefined) throw new Error(`unknown agent: ${agentId}`);
    const mapTools = this.options.mapTools?.(agent.id, withDirs.root);
    const base: BaseOptions = mapTools !== undefined ? { ...withDirs, mapTools } : withDirs;
    if (agent.id === "claude") {
      const env = claudeCode().env;
      return new ClaudeSdkBridge({ ...base, preset: { command: "none", args: [], ...(env !== undefined ? { env } : {}) } });
    }
    const preset = agent.preset(this.options.env ?? process.env);
    if (preset === undefined) throw new Error(`${agent.name} is not installed${agent.installHint !== undefined ? ` — ${agent.installHint}` : ""}`);
    return new AcpProcessBridge({ ...base, preset });
  }
}

export function createBridge(opts: BaseOptions & { mock?: boolean; agent?: AgentProvider }): AcpBridge {
  const catalog = new AgentCatalog(opts, { mock: opts.mock === true });
  return catalog.create(opts.mock === true ? MOCK_AGENT_ID : agentIdOf(opts.agent ?? "claude"));
}
