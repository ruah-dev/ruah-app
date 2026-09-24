// `ruah app cloud providers|list|status|watch` (CONTRACTS.md §9.6): no
// daemon, no project; registry-driven; exit codes for scripts; `--repo`
// linking; `watch` prints health transitions (fake timers).
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudResource, IntegrationInfo } from "../src/contracts/integrations.js";
import { runCloud, type CloudCliDeps } from "../src/integrations/cloud-cli.js";
import { IntegrationRegistry } from "../src/integrations/registry.js";
import type { CloudIntegration, CloudSyncOutcome } from "../src/integrations/registry.js";
import { main } from "../src/cli.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.useRealTimers();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-cloud-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const res = (id: string, provider: string, extra: Partial<CloudResource> = {}): CloudResource => ({
  id, provider, type: "app", service: "project", name: id, ...extra,
});

class FakeCloud implements CloudIntegration {
  readonly family = "cloud" as const;
  syncs: (string | undefined)[] = [];
  constructor(
    readonly id: string,
    readonly name: string,
    public infoValue: Partial<IntegrationInfo>,
    public outcome: CloudSyncOutcome | Error = { resources: [], errors: [] },
    private readonly on = true,
  ) {}
  enabled(): boolean {
    return this.on;
  }
  async info(): Promise<IntegrationInfo> {
    return { id: this.id, family: "cloud", name: this.name, status: "connected", ...this.infoValue };
  }
  async connect(): Promise<IntegrationInfo> {
    return this.info();
  }
  async disconnect(): Promise<IntegrationInfo> {
    return this.info();
  }
  async sync(options: { account?: string }): Promise<CloudSyncOutcome> {
    this.syncs.push(options.account);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

function harness(providers: FakeCloud[], extra: Partial<CloudCliDeps> = {}) {
  const registry = new IntegrationRegistry();
  for (const p of providers) registry.register(p);
  let out = "";
  let err = "";
  const deps: CloudCliDeps = {
    home: tempDir(), registry, out: (t) => void (out += t), err: (t) => void (err += t),
    now: () => new Date("2026-09-24T12:00:00.000Z"), ...extra,
  };
  return { run: (argv: string[]) => runCloud(argv, deps), out: () => out, err: () => err, clear: () => void ((out = ""), (err = "")) };
}

const vercel = (outcome?: CloudSyncOutcome | Error) =>
  new FakeCloud("vercel", "Vercel", { detail: "vercel: dev · team acme", accounts: [{ id: "acme", label: "Acme" }] }, outcome ?? {
    resources: [
      res("vercel:project:web", "vercel", { name: "web-app", health: "healthy" }),
      res("vercel:project:api", "vercel", { name: "invoices-api", health: "degraded", healthDetail: "latest production deployment failed · previous one still live" }),
      res("vercel:domain:example.com", "vercel", { name: "example.com", type: "dns", service: "domain" }),
    ],
    errors: [],
  });
const k8s = (outcome?: CloudSyncOutcome | Error) =>
  new FakeCloud("kubernetes", "Kubernetes", { detail: "context prod" }, outcome ?? {
    resources: [
      res("k8s:prod:prod:deployment:api", "kubernetes", { name: "api", type: "container", service: "deployment", region: "prod", health: "down", healthDetail: "0/3 ready · 3 crash-looping" }),
      res("k8s:prod:prod:deployment:web", "kubernetes", { name: "web", type: "container", service: "deployment", region: "prod", health: "healthy" }),
    ],
    errors: [],
  });
const netlifyMissing = () => new FakeCloud("netlify", "Netlify", { status: "cli_missing", detail: "netlify not installed", setupHint: "brew install netlify-cli && netlify login" });

describe("ruah app cloud providers", () => {
  test("every registered cloud provider with its state and the fix command", async () => {
    const h = harness([vercel(), netlifyMissing(), new FakeCloud("supabase", "Supabase", { status: "not_connected", detail: "Access token not provided", setupHint: "supabase login" })]);
    expect(await h.run(["providers"])).toBe(0);
    const text = h.out();
    expect(text).toMatch(/Vercel\s+vercel\s+connected\s+vercel: dev · team acme/);
    expect(text).toMatch(/Netlify\s+netlify\s+not installed\s+fix: brew install netlify-cli && netlify login/);
    expect(text).toMatch(/Supabase\s+supabase\s+not logged in\s+Access token not provided — fix: supabase login/);
  });

  test("--json is the IntegrationInfo list", async () => {
    const h = harness([vercel(), netlifyMissing()]);
    expect(await h.run(["providers", "--json"])).toBe(0);
    const parsed = JSON.parse(h.out()) as { providers: IntegrationInfo[] };
    expect(parsed.providers.map((p) => [p.id, p.status])).toEqual([["vercel", "connected"], ["netlify", "cli_missing"]]);
  });
});

describe("ruah app cloud list", () => {
  test("connected providers only (not installed ones are skipped quietly), grouped with a health summary", async () => {
    const missing = netlifyMissing();
    const h = harness([vercel(), missing, k8s()]);
    expect(await h.run(["list"])).toBe(0);
    expect(missing.syncs).toEqual([]);
    expect(h.out()).toContain("Vercel (3 · 1 running · 1 degraded)");
    expect(h.out()).toMatch(/invoices-api\s+project\s+global\s+▲ degraded · latest production deployment failed/);
    expect(h.out()).toContain("Kubernetes (2 · 1 running · 1 down)");
  });

  test("--provider/--account reach the adapter; --json is a CloudSyncResult with observedAt", async () => {
    const v = vercel();
    const h = harness([v, k8s()]);
    expect(await h.run(["list", "--provider", "vercel", "--account", "acme", "--json"])).toBe(0);
    expect(v.syncs).toEqual(["acme"]);
    const parsed = JSON.parse(h.out()) as { resources: CloudResource[]; errors: unknown[] };
    expect(parsed.resources).toHaveLength(3);
    expect(parsed.resources[0]?.observedAt).toBe("2026-09-24T12:00:00.000Z");
  });

  test("--repo links resources to that repo's map elements (read-only)", async () => {
    const repo = tempDir();
    writeFileSync(join(repo, "architecture.json"), JSON.stringify({ version: 1, name: "acme", nodes: [{ id: "web", type: "frontend", name: "web-app" }], edges: [], workflows: [] }));
    const h = harness([vercel()]);
    expect(await h.run(["list", "--repo", repo, "--json"])).toBe(0);
    const parsed = JSON.parse(h.out()) as { resources: CloudResource[] };
    expect(parsed.resources.find((r) => r.name === "web-app")).toMatchObject({ linkedNodeId: "web", linkSource: "name" });
    h.clear();
    expect(await h.run(["list", "--repo", repo])).toBe(0);
    expect(h.out()).toMatch(/web-app .*→ web-app/);
  });

  test("usage errors exit 2: unknown provider, --account without one provider, bad flags", async () => {
    const h = harness([vercel(), k8s()]);
    expect(await h.run(["list", "--provider", "nope"])).toBe(2);
    expect(h.err()).toContain('unknown provider "nope"');
    expect(await h.run(["list", "--account", "x"])).toBe(2);
    expect(await h.run(["list", "--frobnicate"])).toBe(2);
    expect(await h.run(["dance"])).toBe(2);
    expect(await h.run(["watch", "--interval", "1"])).toBe(2);
  });

  test("a named provider that is not usable exits 1 with the fix", async () => {
    const h = harness([netlifyMissing()]);
    expect(await h.run(["list", "--provider", "netlify"])).toBe(1);
    expect(h.err()).toContain("Netlify: not installed — fix: brew install netlify-cli && netlify login");
  });
});

describe("ruah app cloud status", () => {
  test("summary + needs-attention list; exit 1 when anything is down", async () => {
    const h = harness([vercel(), k8s()]);
    expect(await h.run(["status"])).toBe(1);
    expect(h.out()).toContain("Cloud: 2 running · 1 degraded · 1 down");
    expect(h.out()).toMatch(/✗ down\s+Kubernetes\s+prod\/api \(deployment\)\s+0\/3 ready · 3 crash-looping/);
    // down sorts before degraded
    expect(h.out().indexOf("✗ down")).toBeLessThan(h.out().indexOf("▲ degraded"));
  });

  test("exit 0 when all is up; 3 when a provider could not be read; 3 when none is connected", async () => {
    expect(await harness([vercel({ resources: [res("a", "vercel", { health: "healthy" })], errors: [] })]).run(["status"])).toBe(0);

    const broken = harness([vercel({ resources: [res("a", "vercel", { health: "healthy" })], errors: [] }), k8s(new Error("cluster unreachable"))]);
    expect(await broken.run(["status"])).toBe(3);
    expect(broken.err()).toContain("Kubernetes: cluster unreachable");

    const none = harness([netlifyMissing()]);
    expect(await none.run(["status"])).toBe(3);
    expect(none.err()).toContain("No cloud provider connected");
  });

  test("an enabled provider in the error state (cluster unreachable at info) is reported, not skipped", async () => {
    const cluster = new FakeCloud("kubernetes", "Kubernetes", { status: "error", detail: "context prod: cluster unreachable" });
    const h = harness([vercel({ resources: [res("a", "vercel", { health: "healthy" })], errors: [] }), cluster]);
    expect(await h.run(["status"])).toBe(3);
    expect(h.err()).toContain("Kubernetes: context prod: cluster unreachable");
    expect(cluster.syncs).toEqual([]);
  });

  test("--json carries the summary, per-provider summaries, unhealthy resources and the exit code", async () => {
    const h = harness([vercel(), k8s()]);
    expect(await h.run(["status", "--json"])).toBe(1);
    const parsed = JSON.parse(h.out()) as { summary: { down: number }; providers: { id: string }[]; unhealthy: CloudResource[]; exitCode: number };
    expect(parsed.summary.down).toBe(1);
    expect(parsed.providers.map((p) => p.id)).toEqual(["vercel", "kubernetes"]);
    expect(parsed.unhealthy.map((r) => r.name).sort()).toEqual(["api", "invoices-api"]);
    expect(parsed.exitCode).toBe(1);
  });
});

describe("ruah app cloud watch", () => {
  test("first poll prints a snapshot per provider, later polls print transitions; stops on abort", async () => {
    vi.useFakeTimers();
    const v = vercel({ resources: [res("vercel:project:web", "vercel", { name: "web-app", health: "healthy", status: "ready" })], errors: [] });
    const controller = new AbortController();
    const h = harness([v], { signal: controller.signal, intervalMs: 10_000, now: () => new Date() });
    const done = h.run(["watch"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out()).toMatch(/Vercel: 1 resources · 1 running/);
    v.outcome = { resources: [res("vercel:project:web", "vercel", { name: "web-app", health: "deploying", status: "building", healthDetail: "building · previous production deployment still live" })], errors: [] };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.out()).toMatch(/Vercel {2}◐ web-app \(project\) healthy → deploying · building · previous production deployment still live/);
    const before = v.syncs.length;
    controller.abort();
    expect(await done).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(v.syncs.length).toBe(before); // nothing polls after Ctrl-C
  });

  test("--json prints one object per line", async () => {
    vi.useFakeTimers();
    const v = vercel({ resources: [res("a", "vercel", { health: "healthy" })], errors: [] });
    const controller = new AbortController();
    const h = harness([v], { signal: controller.signal, intervalMs: 10_000, now: () => new Date() });
    const done = h.run(["watch", "--json"]);
    await vi.advanceTimersByTimeAsync(0);
    v.outcome = { resources: [], errors: [] };
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    await done;
    const lines = h.out().trim().split("\n").map((l) => JSON.parse(l) as { type: string; kind?: string });
    expect(lines.map((l) => l.type)).toEqual(["snapshot", "change"]);
    expect(lines[1]?.kind).toBe("removed");
  });
});

test("`ruah app cloud` is wired into the CLI entry point", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await main(["cloud", "help"])).toBe(0);
    expect(write.mock.calls.map((c) => String(c[0])).join("")).toContain("ruah app cloud providers");
  } finally {
    write.mockRestore();
  }
});
