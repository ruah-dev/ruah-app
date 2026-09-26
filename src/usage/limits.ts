// src/usage/limits.ts — GET /api/usage/limits: one entry per agent in the
// catalog. Claude (SDK or ACP adapter — one account) reports real plan
// windows: get_usage on the live query when Claude is the current agent
// (refreshed at most every 60 s), otherwise a short-lived probe query (at most
// every 5 min; still no model turn), plus rate_limit events streamed during
// turns. Other agents are "unknown" unless their traffic streams rate limits.
import type { ProviderLimits, UsageLimits } from "../contracts/usage.js";
import type { AcpBridge, ClaudePlanUsage, RateLimitSample } from "../acp/bridge.js";
import { ClaudeLimitsState, claudeAuthKind, claudeProviderName, type ClaudeLimitsSnapshot } from "./claude-limits.js";

export interface LimitsAgent {
  id: string;
  name: string;
  installed: boolean;
}

export interface UsageLimitsDeps {
  /** The agent catalog as the viewer sees it (AgentCatalog.choices().available). */
  agents(): LimitsAgent[];
  currentAgentId(): string;
  currentBridge(): AcpBridge | undefined;
  /** Short-lived probe for when there is no live Claude query; omit to disable. */
  probeClaude?: () => Promise<ClaudePlanUsage>;
  now?: () => number;
  /** Min interval between get_usage calls on the live query. Default 60 s. */
  liveRefreshMs?: number;
  /** Min interval between short-lived probes. Default 5 min. */
  probeRefreshMs?: number;
  /** How long a request waits for a refresh when nothing is known yet. Default 15 s. */
  firstWaitMs?: number;
  /** How long a request waits for a refresh when a snapshot exists. Default 3 s. */
  refreshWaitMs?: number;
  debug?: (line: string) => void;
}

const CLAUDE_KEY = "claude";
const STALE_MS = 10 * 60_000;

/** Claude through the SDK and through claude-agent-acp share one account, so one set of windows. */
function limitsKey(agentId: string): string {
  return agentId === "claude" || agentId === "claude-acp" ? CLAUDE_KEY : agentId;
}

/** Why a Claude login has no windows (§2.3 note); the account info tells a signed-out CLI from an API key. */
function unsupportedNote(snapshot: ClaudeLimitsSnapshot): string {
  switch (claudeAuthKind(snapshot.account)) {
    case "signed_out":
      return "Claude Code is not signed in: run `claude` and sign in with /login.";
    case "api_key":
      return "Plan usage limits do not apply to an API key.";
    case "third_party":
      return `Plan usage limits do not apply: Claude Code runs through ${claudeProviderName(snapshot.account?.apiProvider) ?? "a third-party provider"}.`;
    case "claude_ai":
    case "token":
      return "Claude Code is signed in but reports no plan usage limits for this login.";
    case "unknown":
      return "No plan usage limits reported: this login uses an API key, Bedrock or Vertex, or is not signed in.";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class UsageLimitsService {
  private readonly states = new Map<string, ClaudeLimitsState>();
  private readonly now: () => number;
  private inflight: Promise<void> | undefined;
  private lastLiveAt = -Infinity;
  private lastProbeAt = -Infinity;
  private lastError: string | undefined;

  constructor(private readonly deps: UsageLimitsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A rate-limit reading streamed during one of `agentId`'s turns. */
  recordRateLimit(agentId: string, info: RateLimitSample): void {
    this.state(limitsKey(agentId)).recordRateLimit(info, new Date(this.now()).toISOString());
  }

  /**
   * The Claude account's plan reading for the per-agent limits (§16): the
   * same throttled refresh as limits(), plus the last refresh error.
   */
  async claudePlan(): Promise<{ snapshot: ClaudeLimitsSnapshot | undefined; error: string | undefined; canProbe: boolean; installed: boolean }> {
    // The catalog decides whether Claude is there at all (no probe when it is not).
    const installed = this.deps.agents().some((agent) => limitsKey(agent.id) === CLAUDE_KEY && agent.installed);
    if (!installed) return { snapshot: undefined, error: undefined, canProbe: false, installed };
    await this.refreshClaude();
    return {
      snapshot: this.states.get(CLAUDE_KEY)?.snapshot(),
      error: this.lastError,
      canProbe: this.liveBridge() !== undefined || this.deps.probeClaude !== undefined,
      installed,
    };
  }

  async limits(): Promise<UsageLimits> {
    const agents = this.deps.agents();
    if (agents.some((agent) => limitsKey(agent.id) === CLAUDE_KEY && agent.installed)) await this.refreshClaude();
    return { providers: agents.map((agent) => this.provider(agent)) };
  }

  private state(key: string): ClaudeLimitsState {
    let state = this.states.get(key);
    if (state === undefined) this.states.set(key, (state = new ClaudeLimitsState()));
    return state;
  }

  private liveBridge(): AcpBridge | undefined {
    const bridge = this.deps.currentBridge();
    return this.deps.currentAgentId() === "claude" && bridge?.claudePlanUsage !== undefined ? bridge : undefined;
  }

  /** Starts a throttled refresh (live get_usage first, probe second) and waits for it a bounded time. */
  private async refreshClaude(): Promise<void> {
    const state = this.state(CLAUDE_KEY);
    if (this.inflight === undefined) {
      const now = this.now();
      const live = this.liveBridge();
      const liveDue = live !== undefined && now - this.lastLiveAt >= (this.deps.liveRefreshMs ?? 60_000);
      const probeDue = this.deps.probeClaude !== undefined && now - this.lastProbeAt >= (this.deps.probeRefreshMs ?? 300_000);
      // The probe is the fallback: only when the live query cannot answer.
      if (liveDue || (live === undefined && probeDue)) {
        const run = this.runRefresh(state, liveDue ? live : undefined, probeDue).finally(() => {
          if (this.inflight === run) this.inflight = undefined;
        });
        this.inflight = run;
      }
    }
    const inflight = this.inflight;
    if (inflight === undefined) return;
    const waitMs = state.snapshot() === undefined ? (this.deps.firstWaitMs ?? 15_000) : (this.deps.refreshWaitMs ?? 3_000);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([inflight, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }

  private async runRefresh(state: ClaudeLimitsState, live: AcpBridge | undefined, probeDue: boolean): Promise<void> {
    let response: ClaudePlanUsage | undefined;
    try {
      if (live?.claudePlanUsage !== undefined) {
        this.lastLiveAt = this.now();
        try {
          response = await live.claudePlanUsage();
        } catch (err) {
          this.deps.debug?.(`claude get_usage failed: ${message(err)}`);
          this.lastError = message(err);
        }
      }
      if (response === undefined && probeDue && this.deps.probeClaude !== undefined) {
        this.lastProbeAt = this.now();
        response = await this.deps.probeClaude();
      }
      if (response !== undefined) {
        state.recordUsageResponse(response, new Date(this.now()).toISOString());
        this.lastError = undefined;
      }
    } catch (err) {
      this.lastError = message(err);
      this.deps.debug?.(`claude usage probe failed: ${this.lastError}`);
    }
  }

  private provider(agent: LimitsAgent): ProviderLimits {
    const base = { agentId: agent.id, name: agent.name };
    if (agent.id === "mock") return { ...base, status: "unknown", windows: [], note: "Scripted demo agent: no usage limits." };
    if (!agent.installed) return { ...base, status: "unavailable", windows: [], note: "Not installed." };
    const key = limitsKey(agent.id);
    const snapshot = this.states.get(key)?.snapshot();
    if (key === CLAUDE_KEY) return this.claudeProvider(base, snapshot);
    if (snapshot !== undefined && snapshot.windows.length > 0) {
      return { ...base, status: "available", windows: [...snapshot.windows], note: `From rate-limit updates in its turns, last at ${snapshot.checkedAt}.` };
    }
    return { ...base, status: "unknown", windows: [], note: `${agent.name} does not report plan usage limits to Ruah.` };
  }

  private claudeProvider(base: { agentId: string; name: string }, snapshot: ClaudeLimitsSnapshot | undefined): ProviderLimits {
    if (snapshot?.unavailable?.reason === "unsupported") {
      return { ...base, status: "unavailable", windows: [], note: unsupportedNote(snapshot) };
    }
    if (snapshot !== undefined && snapshot.windows.length > 0) {
      const age = this.now() - Date.parse(snapshot.checkedAt);
      const stale = !(age < STALE_MS);
      const note = this.lastError !== undefined
        ? `Last known values from ${snapshot.checkedAt}; refresh failed: ${this.lastError}`
        : stale
          ? `Last known values from ${snapshot.checkedAt}.`
          : undefined;
      return { ...base, status: "available", windows: [...snapshot.windows], ...(note !== undefined ? { note } : {}) };
    }
    const note = this.lastError !== undefined
      ? `Could not read Claude usage limits: ${this.lastError}`
      : this.liveBridge() === undefined && this.deps.probeClaude === undefined
        ? "Claude is not the current agent; its limits appear after its next turn."
        : "Usage limits not reported yet.";
    return { ...base, status: "unknown", windows: [], note };
  }
}
