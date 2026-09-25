// src/integrations/watch.ts — CONTRACTS.md §9 watch mode: re-sync the
// enabled cloud providers on an interval, but only while someone watches (a
// viewer on the Cloud page or with "Show on map" on, or `ruah app cloud
// watch`). One timer; per provider: never two syncs at once, and exponential
// backoff after a sync that failed outright. No daemon dependency: the sync
// and the provider list are callbacks.

export const DEFAULT_WATCH_INTERVAL_MS = 45_000;
export const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;

export interface CloudWatcherOptions {
  /** Provider ids to keep fresh; re-read on every tick (connect/disconnect apply at once). */
  providers: () => readonly string[];
  /** One provider's sync; `ok: false` (or a throw) counts as a failure for backoff. */
  sync: (providerId: string) => Promise<{ ok: boolean }>;
  /**
   * Whose schedule applies (the open project's root): per-provider backoff and next-sync times are
   * kept per key, so a project switch does not inherit the previous project's backoff or wait.
   */
  key?: () => string;
  intervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  onError?: (providerId: string, err: unknown) => void;
}

export interface ProviderWatchState {
  /** Consecutive failed syncs (0 = healthy schedule). */
  failures: number;
  /** Epoch ms of the next sync. */
  nextAt: number;
  running: boolean;
}

export class CloudWatcher {
  private readonly viewers = new Set<unknown>();
  private readonly states = new Map<string, ProviderWatchState>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CloudWatcherOptions) {
    this.intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS);
    this.maxBackoffMs = Math.max(this.intervalMs, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.now = options.now ?? Date.now;
  }

  /** True while at least one viewer watches. */
  get active(): boolean {
    return this.viewers.size > 0;
  }

  get watchers(): number {
    return this.viewers.size;
  }

  /** A viewer (socket, CLI, …) starts or stops watching; the loop runs while any does. */
  watch(viewer: unknown, on: boolean): void {
    const wasActive = this.active;
    if (on) this.viewers.add(viewer);
    else this.viewers.delete(viewer);
    if (!wasActive && this.active) this.schedule(0);
    if (wasActive && !this.active) this.clear();
  }

  /** The open project changed: its providers follow their own schedule (fresh ones are due now). */
  projectChanged(): void {
    if (this.active) this.schedule();
  }

  /** Stops the loop and forgets every viewer (daemon shutdown). */
  stop(): void {
    this.viewers.clear();
    this.clear();
  }

  state(providerId: string): ProviderWatchState | undefined {
    const s = this.states.get(this.stateKey(providerId));
    return s !== undefined ? { ...s } : undefined;
  }

  /** A sync that happened elsewhere (the Sync button) counts: the next one waits a full interval. */
  noteSynced(providerId: string, ok: boolean): void {
    const s = this.stateOf(providerId);
    if (s.running) return;
    this.finish(s, ok);
    if (this.active) this.schedule();
  }

  /** Delay after `failures` consecutive failures: interval · 2^failures, capped. */
  backoffMs(failures: number): number {
    return failures <= 0 ? this.intervalMs : Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(failures, 20));
  }

  private stateKey(id: string): string {
    const key = this.options.key?.();
    return key === undefined ? id : `${key}\u0000${id}`;
  }

  private stateOf(id: string): ProviderWatchState {
    const key = this.stateKey(id);
    let s = this.states.get(key);
    if (s === undefined) {
      s = { failures: 0, nextAt: 0, running: false };
      this.states.set(key, s);
    }
    return s;
  }

  private finish(s: ProviderWatchState, ok: boolean): void {
    s.failures = ok ? 0 : s.failures + 1;
    s.nextAt = this.now() + this.backoffMs(s.failures);
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Arms the one timer for the earliest due provider (or `delay` when given). */
  private schedule(delay?: number): void {
    this.clear();
    if (!this.active) return;
    let wait = delay;
    if (wait === undefined) {
      const now = this.now();
      const due = this.options.providers().map((id) => this.stateOf(id)).filter((s) => !s.running).map((s) => s.nextAt);
      wait = due.length > 0 ? Math.max(0, Math.min(...due) - now) : this.intervalMs;
    }
    this.timer = setTimeout(() => this.tick(), wait);
  }

  private tick(): void {
    this.timer = undefined;
    if (!this.active) return;
    const now = this.now();
    for (const id of this.options.providers()) {
      const s = this.stateOf(id);
      if (s.running || s.nextAt > now) continue;
      s.running = true;
      void this.options
        .sync(id)
        .then(
          (result) => result.ok,
          (err: unknown) => {
            this.options.onError?.(id, err);
            return false;
          },
        )
        .then((ok) => {
          s.running = false;
          this.finish(s, ok);
          if (this.active) this.schedule();
        });
    }
    this.schedule();
  }
}
