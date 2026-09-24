// CONTRACTS.md §9 live status plumbing: the CloudWatcher loop (fake timers:
// runs only while watched, never overlaps a provider, backs off on failure),
// the IntegrationsService `cloud.updated` events + sync de-duplication, and
// the `cloud.watch` / `cloud.updated` WebSocket messages.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { CloudResource } from "../src/contracts/integrations.js";
import { ClientMessageSchema, ServerMessageSchema } from "../src/contracts/ws.js";
import { cloudFingerprint, diffResources, syncProviders } from "../src/integrations/cloud-sync.js";
import { IntegrationRegistry, IntegrationsService } from "../src/integrations/index.js";
import type { CloudUpdate } from "../src/integrations/index.js";
import { MemorySecretStore } from "../src/integrations/keychain.js";
import type { CloudIntegration, CloudSyncOutcome } from "../src/integrations/registry.js";
import { CloudWatcher } from "../src/integrations/watch.js";
import { attachSession, handleClientMessage, type SessionHub } from "../src/serve/session.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const res = (id: string, provider: string, health?: CloudResource["health"]): CloudResource => ({
  id, provider, type: "app", service: "project", name: id, ...(health !== undefined ? { health } : {}),
});

/** A cloud provider whose sync the test controls. */
class FakeCloud implements CloudIntegration {
  readonly family = "cloud" as const;
  readonly name: string;
  calls = 0;
  outcome: CloudSyncOutcome | Error = { resources: [], errors: [] };
  gate: Promise<void> | undefined;
  constructor(readonly id: string) {
    this.name = id;
  }
  installed = true;
  enabled(): boolean {
    return true;
  }
  available(): boolean {
    return this.installed;
  }
  async info() {
    return { id: this.id, family: this.family, name: this.name, status: "connected" as const };
  }
  async connect() {
    return this.info();
  }
  async disconnect() {
    return this.info();
  }
  async sync(): Promise<CloudSyncOutcome> {
    this.calls += 1;
    if (this.gate !== undefined) await this.gate;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

describe("CloudWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("idle without viewers; syncs every provider at once when watched, then every interval; stops when the last viewer leaves", async () => {
    const synced: string[] = [];
    const w = new CloudWatcher({ providers: () => ["a", "b"], sync: async (id) => (synced.push(id), { ok: true }), intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(synced).toEqual([]); // nobody watching: no background work

    const viewer = {};
    w.watch(viewer, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(synced).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(synced).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(synced).toEqual(["a", "b", "a", "b"]);

    w.watch(viewer, false);
    expect(w.active).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(synced).toHaveLength(4);
  });

  test("two viewers: the loop keeps running until both are gone; re-watching soon after does not re-sync early", async () => {
    let count = 0;
    const w = new CloudWatcher({ providers: () => ["a"], sync: async () => (count++, { ok: true }), intervalMs: 30_000 });
    const page = {};
    const map = {};
    w.watch(page, true);
    w.watch(map, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);
    w.watch(page, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count).toBe(2);
    w.watch(map, false);
    await vi.advanceTimersByTimeAsync(10_000);
    w.watch(map, true); // back on the page 10 s later: the next sync is still 20 s away
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(count).toBe(3);
    w.stop();
  });

  test("never two syncs of one provider at a time, even when a sync outlasts the interval", async () => {
    let running = 0;
    let maxRunning = 0;
    let started = 0;
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const w = new CloudWatcher({
      providers: () => ["slow"],
      intervalMs: 5_000,
      sync: async () => {
        started += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        const gate = deferred<void>();
        gates.push(gate);
        await gate.promise;
        running -= 1;
        return { ok: true };
      },
    });
    w.watch("v", true);
    await vi.advanceTimersByTimeAsync(60_000); // 12 intervals pass while the first sync hangs
    expect(started).toBe(1);
    gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.state("slow")?.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toBe(2);
    expect(maxRunning).toBe(1);
    gates[1]?.resolve();
    w.stop();
  });

  test("per-provider exponential backoff on failures (capped), reset by a success; other providers keep their pace", async () => {
    const calls: { id: string; at: number }[] = [];
    let failB = true;
    const w = new CloudWatcher({
      providers: () => ["a", "b"],
      intervalMs: 10_000,
      maxBackoffMs: 40_000,
      sync: async (id) => {
        calls.push({ id, at: Date.now() });
        if (id === "b" && failB) throw new Error("cluster unreachable");
        return { ok: true };
      },
    });
    const t0 = Date.now();
    w.watch("v", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.state("b")?.failures).toBe(1);
    expect(w.backoffMs(1)).toBe(20_000);
    expect(w.backoffMs(2)).toBe(40_000);
    expect(w.backoffMs(5)).toBe(40_000); // capped
    await vi.advanceTimersByTimeAsync(100_000);
    const at = (id: string) => calls.filter((c) => c.id === id).map((c) => c.at - t0);
    expect(at("a")).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000]);
    expect(at("b")).toEqual([0, 20_000, 60_000, 100_000]); // +20 s, +40 s, +40 s
    failB = false;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(w.state("b")?.failures).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(at("b").slice(-2)).toEqual([140_000, 150_000]); // back to the normal interval
    w.stop();
  });

  test("`ok: false` counts as a failure; a sync from elsewhere (Sync button) postpones the next one", async () => {
    let n = 0;
    const w = new CloudWatcher({ providers: () => ["a"], intervalMs: 10_000, sync: async () => (n++, { ok: false }) });
    w.watch("v", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.state("a")?.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    w.noteSynced("a", true); // manual sync succeeded at t=15 s
    expect(w.state("a")?.failures).toBe(0);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(n).toBe(2);
    w.stop();
  });

  test("providers are re-read on every tick (a provider connected while watching joins)", async () => {
    const ids = ["a"];
    const synced: string[] = [];
    const w = new CloudWatcher({ providers: () => ids, intervalMs: 10_000, sync: async (id) => (synced.push(id), { ok: true }) });
    w.watch("v", true);
    await vi.advanceTimersByTimeAsync(0);
    ids.push("b");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(synced).toEqual(["a", "a", "b"]);
    w.stop();
  });
});

describe("cloud-sync helpers", () => {
  test("syncProviders stamps observedAt, redacts errors and names providers that failed outright", async () => {
    const good = new FakeCloud("good");
    good.outcome = { resources: [res("r1", "good", "healthy")], errors: ["functions: 403 Bearer abcdefghijklmnopqrstuvwxyz0123"] };
    const bad = new FakeCloud("bad");
    bad.outcome = new Error("cluster unreachable");
    const partial = new FakeCloud("partial");
    partial.outcome = { resources: [], errors: ["projects: timeout"] };
    const out = await syncProviders([good, bad, partial], { now: new Date("2026-09-24T12:00:00.000Z") });
    expect(out.resources).toEqual([{ ...res("r1", "good", "healthy"), observedAt: "2026-09-24T12:00:00.000Z" }]);
    expect(out.failed.sort()).toEqual(["bad", "partial"]);
    expect(out.errors.find((e) => e.provider === "good")?.message).not.toContain("abcdefghijklmnop");
  });

  test("fingerprint ignores observedAt and order; diff reports added / removed / health changes", () => {
    const a = [res("x", "p", "healthy"), res("y", "p", "down")];
    const b = [{ ...res("y", "p", "down"), observedAt: "later" }, res("x", "p", "healthy")];
    expect(cloudFingerprint(a)).toBe(cloudFingerprint(b));
    expect(cloudFingerprint(a)).not.toBe(cloudFingerprint([res("x", "p", "degraded"), res("y", "p", "down")]));
    const changes = diffResources(a, [res("x", "p", "deploying"), res("z", "p")]);
    expect(changes.map((c) => [c.kind, c.resource.id, c.before?.health])).toEqual([
      ["changed", "x", "healthy"], ["added", "z", undefined], ["removed", "y", undefined],
    ]);
  });
});

describe("IntegrationsService: cloud.updated events", () => {
  function setup(): { svc: IntegrationsService; a: FakeCloud; b: FakeCloud; updates: CloudUpdate[] } {
    const a = new FakeCloud("a");
    const b = new FakeCloud("b");
    const registry = new IntegrationRegistry().register(a).register(b);
    const root = tempDir();
    const svc = new IntegrationsService({
      home: tempDir(), project: () => ({ root, architecture: null }), secrets: new MemorySecretStore(), registry,
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    });
    const updates: CloudUpdate[] = [];
    svc.onCloudUpdated((u) => updates.push(u));
    return { svc, a, b, updates };
  }

  test("every sync is announced; resources only when something visible changed", async () => {
    const { svc, a, updates } = setup();
    a.outcome = { resources: [res("r1", "a", "healthy")], errors: [] };
    await svc.cloudSync({ providers: ["a"] });
    expect(updates[0]).toMatchObject({ providers: ["a"], failed: [], syncedAt: "2026-09-24T12:00:00.000Z" });
    expect(updates[0]?.resources?.[0]).toMatchObject({ id: "r1", health: "healthy", observedAt: "2026-09-24T12:00:00.000Z" });
    await svc.cloudSync({ providers: ["a"] });
    expect(updates[1]?.resources).toBeUndefined(); // same state: no payload
    a.outcome = { resources: [res("r1", "a", "down")], errors: [] };
    await svc.cloudSync({ providers: ["a"] });
    expect(updates[2]?.resources?.[0]?.health).toBe("down");
    a.outcome = new Error("not logged in");
    await svc.cloudSync({ providers: ["a"] });
    expect(updates[3]).toMatchObject({ failed: ["a"], errors: [{ provider: "a", message: "not logged in" }] });
  });

  test("sync-all skips providers whose CLI is not installed (and drops their old errors); naming one still tries it", async () => {
    const { svc, a, b } = setup();
    a.outcome = { resources: [res("r1", "a", "healthy")], errors: [] };
    b.outcome = new Error("netlify not installed — brew install netlify-cli && netlify login");
    expect((await svc.cloudSync({})).errors).toEqual([{ provider: "b", message: expect.stringContaining("not installed") }]);
    b.installed = false;
    const all = await svc.cloudSync({});
    expect(b.calls).toBe(1);
    expect(all.errors).toEqual([]);
    expect(all.resources.map((r) => r.id)).toEqual(["r1"]);
    const named = await svc.cloudSync({ providers: ["b"] });
    expect(b.calls).toBe(2);
    expect(named.errors.map((e) => e.provider)).toEqual(["b"]);
    // The watch loop's per-provider sync of another provider clears it again.
    expect((await svc.cloudSync({ providers: ["a"] })).errors).toEqual([]);
  });

  test("concurrent syncs of one provider share a single CLI run", async () => {
    const { svc, a } = setup();
    const gate = deferred<void>();
    a.gate = gate.promise;
    a.outcome = { resources: [res("r1", "a")], errors: [] };
    const first = svc.cloudSync({ providers: ["a"] });
    const second = svc.cloudSync({ providers: ["a"] });
    gate.resolve();
    await Promise.all([first, second]);
    expect(a.calls).toBe(1);
    await svc.cloudSync({ providers: ["a"] });
    expect(a.calls).toBe(2);
  });
});

describe("WebSocket: cloud.watch / cloud.updated", () => {
  test("schemas accept the §9 frames", () => {
    expect(ClientMessageSchema.safeParse({ type: "cloud.watch", on: true }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "cloud.watch" }).success).toBe(false);
    const update = { type: "cloud.updated", root: "/r", syncedAt: null, providers: ["vercel"], failed: [], errors: [] };
    expect(ServerMessageSchema.safeParse(update).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...update, resources: [res("x", "vercel", "healthy")] }).success).toBe(true);
  });

  test("cloud.watch registers the socket; closing the socket unregisters it", () => {
    const calls: [unknown, boolean][] = [];
    const cloudWatch = { watch: (viewer: unknown, on: boolean) => void calls.push([viewer, on]) };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: () => {}, close: () => {} }) as unknown as WebSocket;
    const hub = {
      options: { cloudWatch, debug: () => {} },
      sockets: new Set<WebSocket>(),
      activeTurnId: () => undefined,
      sendHello: () => {},
      error: () => {},
    } as unknown as SessionHub;
    handleClientMessage(hub, socket, { type: "cloud.watch", on: true });
    expect(calls).toEqual([[socket, true]]);
    attachSession(hub, socket);
    (socket as unknown as EventEmitter).emit("close");
    expect(calls).toEqual([[socket, true], [socket, false]]);
  });
});
