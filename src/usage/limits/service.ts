// src/usage/limits/service.ts — runs the providers, caches each reading for
// its provider's TTL (an explicit refresh still waits minRefreshMs between
// reads, so a hammered refresh button cannot hammer the sources), keeps the
// last good reading when a refresh fails (marked stale), attaches Ruah's
// estimates, and orders agents: signed in first, not installed last.
import type { AgentLimits, AgentLimitsReport, AgentLimitsStatus } from "../../contracts/agent-limits.js";
import type { UsageRecord } from "../log.js";
import { agentLimits, defaultContext, safeMessage, type LimitsContext, type LimitsProvider } from "./common.js";
import { buildEstimates, estimatePeriod, type EstimatePeriod } from "./estimate.js";

export interface AgentLimitsServiceOptions {
  providers: readonly LimitsProvider[];
  context?: Partial<LimitsContext>;
  /** Ruah's usage log, for the per-agent estimates; omit to skip them. */
  records?: () => AsyncIterable<UsageRecord> | Iterable<UsageRecord>;
  /** Minimum age of a reading before an explicit refresh reads again. Default 15 s. */
  minRefreshMs?: number;
  /** Upper bound on one provider read. Default 60 s. */
  readTimeoutMs?: number;
}

export class UnknownAgentError extends Error {
  constructor(readonly agentId: string, readonly known: readonly string[]) {
    super(`unknown agent "${agentId}" (expected ${known.join(", ")})`);
    this.name = "UnknownAgentError";
  }
}

const STATUS_RANK: Record<AgentLimitsStatus, number> = { ok: 0, partial: 1, error: 2, unsupported: 3, not_logged_in: 4, not_installed: 5 };

interface Entry {
  value: AgentLimits;
  at: number;
}

export class AgentLimitsService {
  private readonly ctx: LimitsContext;
  private readonly cache = new Map<string, Entry>();
  private readonly good = new Map<string, AgentLimits>();
  private readonly inflight = new Map<string, Promise<AgentLimits>>();

  constructor(private readonly options: AgentLimitsServiceOptions) {
    this.ctx = defaultContext(options.context);
  }

  get agentIds(): string[] {
    return this.options.providers.map((p) => p.id);
  }

  async report(request: { agentId?: string; refresh?: boolean } = {}): Promise<AgentLimitsReport> {
    const providers =
      request.agentId === undefined ? this.options.providers : this.options.providers.filter((p) => p.id === request.agentId);
    if (request.agentId !== undefined && providers.length === 0) throw new UnknownAgentError(request.agentId, this.agentIds);
    const readings = await Promise.all(providers.map((p) => this.read(p, request.refresh === true)));
    const agents = await this.withEstimates(readings);
    const order = new Map(this.options.providers.map((p, i) => [p.id, i]));
    agents.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (order.get(a.agentId) ?? 99) - (order.get(b.agentId) ?? 99));
    return { checkedAt: new Date(this.ctx.now()).toISOString(), agents };
  }

  private read(provider: LimitsProvider, refresh: boolean): Promise<AgentLimits> {
    const now = this.ctx.now();
    const cached = this.cache.get(provider.id);
    const maxAge = refresh ? (this.options.minRefreshMs ?? 15_000) : provider.ttlMs;
    if (cached !== undefined && now - cached.at < maxAge) return Promise.resolve(cached.value);
    const running = this.inflight.get(provider.id);
    if (running !== undefined) return running;
    const run = this.readFresh(provider).finally(() => this.inflight.delete(provider.id));
    this.inflight.set(provider.id, run);
    return run;
  }

  private async readFresh(provider: LimitsProvider): Promise<AgentLimits> {
    const timeoutMs = this.options.readTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    let value: AgentLimits;
    try {
      value = await Promise.race([
        provider.read(this.ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      value = agentLimits(provider.id, provider.name, "error", {
        checkedAt: new Date(this.ctx.now()).toISOString(),
        source: provider.name,
        reason: `Could not read ${provider.name}'s limits: ${safeMessage(err)}`,
      });
    } finally {
      clearTimeout(timer);
    }
    if (value.status === "ok" && value.stale !== true) this.good.set(provider.id, value);
    else if (value.status === "error") {
      const last = this.good.get(provider.id);
      if (last !== undefined) {
        value = { ...last, stale: true, reason: `Showing the reading from ${last.checkedAt}; the refresh failed: ${value.reason ?? "unknown error"}` };
      }
    }
    this.cache.set(provider.id, { value, at: this.ctx.now() });
    return value;
  }

  private async withEstimates(readings: AgentLimits[]): Promise<AgentLimits[]> {
    if (this.options.records === undefined) return readings;
    const now = this.ctx.now();
    const periods = new Map<string, EstimatePeriod>();
    for (const r of readings) if (r.installed) periods.set(r.agentId, estimatePeriod(r, now));
    if (periods.size === 0) return readings;
    let estimates;
    try {
      estimates = await buildEstimates(this.options.records(), periods, now);
    } catch (err) {
      this.ctx.debug(`usage estimates failed: ${safeMessage(err)}`);
      return readings;
    }
    return readings.map((r) => {
      const estimate = estimates.get(r.agentId);
      return estimate !== undefined ? { ...r, estimate } : r;
    });
  }
}
