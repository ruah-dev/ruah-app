// src/serve/bridge-pool.ts — warm pool (keep-alive cache) of agent bridges,
// keyed by (project root, agent id). The SessionHub uses one bridge at a
// time; the one it lets go (agent.set, project switch) stays alive for
// `ttlMs` so switching back is instant (no CLI start, same agent session).
// At most `maxLive` bridges run: acquiring a new one first evicts the oldest
// idle bridge. ttlMs 0 = stop on release (the pre-pool behaviour). The pool
// also keeps each bridge's last-known status (agent/session/modes/models),
// merged across events, so a re-acquired bridge is described at once.
import type { AcpBridge, BridgeEvent } from "../acp/bridge.js";
import type { AgentState, ModeState, ModelState } from "../contracts/ws.js";

export const DEFAULT_WARM_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_LIVE_BRIDGES = 2;

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
      warm.releasedAt = undefined;
      this.options.debug?.(`bridge pool: reuse ${agentId} @ ${root}`);
      return { entry: warm, fresh: false };
    }
    const bridge = this.options.create(agentId, root);
    this.makeRoom(this.options.maxLive - 1);
    const entry = this.track(root, agentId, bridge);
    entry.status = { state: "starting" };
    return { entry, fresh: true };
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
    entry.releasedAt = this.options.now?.() ?? Date.now();
    const unhealthy = entry.status.state === "error" || entry.status.state === "stopped";
    if (this.options.ttlMs <= 0 || unhealthy) return this.evict(entry, unhealthy ? "not running" : "released");
    this.clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!entry.inUse) void this.evict(entry, "idle ttl expired");
    }, this.options.ttlMs);
    entry.timer.unref?.();
    this.makeRoom(this.options.maxLive);
    return Promise.resolve();
  }

  /** Stops every bridge (daemon shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries].map((entry) => this.evict(entry, "shutdown")));
  }

  // ----- internals -----

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

  /** Evicts idle bridges, oldest release first, until at most `limit` are live. */
  private makeRoom(limit: number): void {
    const idle = this.entries.filter((e) => !e.inUse).sort((a, b) => (a.releasedAt ?? 0) - (b.releasedAt ?? 0));
    let live = this.entries.length;
    for (const entry of idle) {
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
