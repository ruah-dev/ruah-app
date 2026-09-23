// src/serve/bridge-pool.ts — warm pool (keep-alive cache) of agent bridges,
// keyed by (project root, agent id). The SessionHub uses one bridge at a
// time (the current one, `inUse`); the one it lets go (agent.set, project
// switch) stays alive for `ttlMs` so switching back is instant (no CLI start,
// same agent session), and `prewarm` starts bridges speculatively (agent
// picker open, agents used in the project before) so switching *to* them is
// instant too. At most `maxLive` bridges run: the least recently used warm
// bridge is evicted first; the current bridge never is. ttlMs 0 = stop on
// release (the pre-pool behaviour). `start` is single-flight per bridge, so
// a switch to a bridge that is still starting attaches to that start. The
// pool also keeps each bridge's last-known status (agent/session/modes/
// models), merged across events, so a re-acquired bridge is described at once.
import type { AcpBridge, BridgeEvent } from "../acp/bridge.js";
import type { AgentState, ModeState, ModelState } from "../contracts/ws.js";

export const DEFAULT_WARM_TTL_MS = 15 * 60_000;
export const DEFAULT_MAX_LIVE_BRIDGES = 4;

export interface BridgeStatus {
  state: AgentState;
  agent?: { name: string; version: string };
  sessionId?: string;
  modes?: ModeState;
  models?: ModelState;
  error?: string;
}

export interface PooledBridge {
  readonly root: string;
  readonly agentId: string;
  readonly bridge: AcpBridge;
  /** Merged last-known status. */
  status: BridgeStatus;
  /** Chat whose conversation the bridge's session holds; undefined = not bound yet, null = no chat. */
  chatId: string | null | undefined;
  /** A turn ran on the current session (it is no longer empty). */
  used: boolean;
  inUse: boolean;
  releasedAt: number | undefined;
  /** Last time the hub used, released, pre-warmed or touched it (LRU order). */
  lastUsedAt: number;
  /** Started by prewarm() and not taken by the hub yet. */
  speculative: boolean;
  /** The in-flight start() (single-flight; see BridgePool.start). */
  starting: Promise<void> | undefined;
  /** Saved model / mode being applied to a new session (prompts wait for it). */
  configuring: Promise<void> | undefined;
  /** Session id the saved model / mode were last applied to (once per session). */
  configuredSession: string | undefined;
  timer: NodeJS.Timeout | undefined;
  unsubscribe: () => void;
}

export interface BridgePoolOptions {
  create(agentId: string, root: string): AcpBridge;
  /** Every event of every live bridge, after the pool updated the entry's status. */
  onEvent(entry: PooledBridge, event: BridgeEvent): void;
  ttlMs: number;
  maxLive: number;
  debug?: (line: string) => void;
  now?: () => number;
}

/** Folds a status event into the snapshot: fields are only sent when they change. */
export function mergeStatus(previous: BridgeStatus, event: Extract<BridgeEvent, { type: "status" }>): BridgeStatus {
  const { agent, sessionId, modes, models } = previous;
  return {
    state: event.state,
    ...(agent !== undefined ? { agent } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(modes !== undefined ? { modes } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(event.agent !== undefined ? { agent: event.agent } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.modes !== undefined ? { modes: event.modes } : {}),
    ...(event.models !== undefined ? { models: event.models } : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
  };
}

export class BridgePool {
  private readonly entries: PooledBridge[] = [];

  constructor(private readonly options: BridgePoolOptions) {}

  /** Live bridges (in use or warm). */
  get size(): number {
    return this.entries.length;
  }

  list(): readonly PooledBridge[] {
    return this.entries;
  }

  find(root: string, agentId: string): PooledBridge | undefined {
    return this.entries.find((e) => e.root === root && e.agentId === agentId);
  }

  /**
   * The warm bridge for (root, agentId), or a new one (not started; `fresh`).
   * Throws when the factory does (unknown / missing agent); nothing is evicted then.
   */
  acquire(root: string, agentId: string): { entry: PooledBridge; fresh: boolean } {
    const warm = this.find(root, agentId);
    if (warm !== undefined) {
      this.clearTimer(warm);
      warm.inUse = true;
      warm.speculative = false;
      warm.releasedAt = undefined;
      warm.lastUsedAt = this.now();
      this.options.debug?.(`bridge pool: reuse ${agentId} @ ${root} (${warm.status.state})`);
      return { entry: warm, fresh: false };
    }
    const bridge = this.options.create(agentId, root);
    this.makeRoom(this.options.maxLive - 1);
    const entry = this.track(root, agentId, bridge);
    entry.status = { state: "starting" };
    return { entry, fresh: true };
  }

  /**
   * A warm (not in use) bridge for (root, agentId) for pre-warming: the live
   * one (touched: its TTL restarts), or a new, not started one (`fresh`).
   * Undefined when the pool is full and making room would evict a warm bridge
   * of the same project (speculation never displaces speculation) or the
   * current one. Throws when the factory does.
   */
  prewarm(root: string, agentId: string): { entry: PooledBridge; fresh: boolean } | undefined {
    const live = this.find(root, agentId);
    if (live !== undefined) {
      if (!live.inUse) this.park(live);
      return { entry: live, fresh: false };
    }
    if (this.entries.length >= this.options.maxLive) {
      const victim = this.lru().find((e) => e.root !== root);
      if (victim === undefined) return undefined;
      void this.evict(victim, "pool cap (pre-warm)");
    }
    const bridge = this.options.create(agentId, root);
    const entry = this.track(root, agentId, bridge);
    entry.status = { state: "starting" };
    entry.speculative = true;
    this.park(entry);
    return { entry, fresh: true };
  }

  /** Starts the bridge once: a start already in flight is shared (a switch attaches to a pre-warm). */
  start(entry: PooledBridge): Promise<void> {
    if (entry.starting !== undefined) return entry.starting;
    const starting = entry.bridge.start().finally(() => {
      if (entry.starting === starting) entry.starting = undefined;
    });
    entry.starting = starting;
    return starting;
  }

  /** Stops and forgets a bridge that is not in use (e.g. a failed pre-warm). */
  discard(entry: PooledBridge, why: string): Promise<void> {
    if (entry.inUse) return Promise.resolve();
    return this.evict(entry, why);
  }

  /** Adds an existing (possibly already started) bridge as in use. */
  adopt(root: string, agentId: string, bridge: AcpBridge): PooledBridge {
    const entry = this.track(root, agentId, bridge);
    const state = bridge.status();
    entry.status = { state: state === "stopped" ? "starting" : state };
    return entry;
  }

  /**
   * The hub no longer uses `entry`. With a TTL it stays warm (stopped when the
   * TTL runs out or it is evicted); without one it is stopped now and the
   * promise resolves once it is.
   */
  release(entry: PooledBridge): Promise<void> {
    if (!this.entries.includes(entry)) return Promise.resolve();
    entry.inUse = false;
    const unhealthy = (entry.status.state === "error" || entry.status.state === "stopped") && entry.starting === undefined;
    if (this.options.ttlMs <= 0 || unhealthy) return this.evict(entry, unhealthy ? "not running" : "released");
    this.park(entry);
    this.makeRoom(this.options.maxLive);
    return Promise.resolve();
  }

  /** Stops every bridge (daemon shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries].map((entry) => this.evict(entry, "shutdown")));
  }

  // ----- internals -----

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Not in use: stamps it, (re)starts its idle TTL. */
  private park(entry: PooledBridge): void {
    entry.inUse = false;
    entry.releasedAt = this.now();
    entry.lastUsedAt = entry.releasedAt;
    this.clearTimer(entry);
    if (this.options.ttlMs <= 0) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!entry.inUse) void this.evict(entry, "idle ttl expired");
    }, this.options.ttlMs);
    entry.timer.unref?.();
  }

  /** Warm (not in use) bridges, least recently used first. */
  private lru(): PooledBridge[] {
    return this.entries.filter((e) => !e.inUse).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  private track(root: string, agentId: string, bridge: AcpBridge): PooledBridge {
    const entry: PooledBridge = {
      root,
      agentId,
      bridge,
      status: { state: "stopped" },
      chatId: undefined,
      used: false,
      inUse: true,
      releasedAt: undefined,
      lastUsedAt: this.now(),
      speculative: false,
      starting: undefined,
      configuring: undefined,
      configuredSession: undefined,
      timer: undefined,
      unsubscribe: () => {},
    };
    entry.unsubscribe = bridge.on((event) => {
      if (event.type === "status") entry.status = mergeStatus(entry.status, event);
      if (event.type === "turn_finished") entry.used = true;
      this.options.onEvent(entry, event);
    });
    this.entries.push(entry);
    this.options.debug?.(`bridge pool: new ${agentId} @ ${root} (${this.entries.length} live)`);
    return entry;
  }

  /** Evicts warm bridges, least recently used first, until at most `limit` are live (never the current one). */
  private makeRoom(limit: number): void {
    let live = this.entries.length;
    for (const entry of this.lru()) {
      if (live <= limit) break;
      live -= 1;
      void this.evict(entry, "pool cap");
    }
  }

  private async evict(entry: PooledBridge, why: string): Promise<void> {
    const index = this.entries.indexOf(entry);
    if (index === -1) return;
    this.entries.splice(index, 1);
    this.clearTimer(entry);
    this.options.debug?.(`bridge pool: stop ${entry.agentId} @ ${entry.root} (${why})`);
    try {
      await entry.bridge.stop();
    } catch (err) {
      this.options.debug?.(`bridge pool: stopping ${entry.agentId} failed: ${(err as Error).message}`);
    } finally {
      // After stop, so its final turn_finished (usage, stored turn) still arrives.
      entry.unsubscribe();
    }
  }

  private clearTimer(entry: PooledBridge): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}
