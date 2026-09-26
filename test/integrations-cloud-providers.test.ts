// CONTRACTS.md §9: the Vercel, Supabase, Kubernetes, Netlify and Hetzner
// adapters (CLI JSON fixtures → CloudResource + health), the health mapping
// of the existing DigitalOcean / AWS adapters, and the read-only guarantees.
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudResourceSchema, CloudSyncBodySchema, KNOWN_CLOUD_PROVIDERS, type CloudResource } from "../src/contracts/integrations.js";
import * as awsMod from "../src/integrations/cloud/aws.js";
import * as azure from "../src/integrations/cloud/azure.js";
import { withLiveHealth } from "../src/integrations/cloud/cli-kit.js";
import * as cloudflare from "../src/integrations/cloud/cloudflare.js";
import * as fly from "../src/integrations/cloud/fly.js";
import * as gcp from "../src/integrations/cloud/gcp.js";
import * as railway from "../src/integrations/cloud/railway.js";
import * as doMod from "../src/integrations/cloud/digitalocean.js";
import * as hcloud from "../src/integrations/cloud/hetzner.js";
import * as k8s from "../src/integrations/cloud/kubernetes.js";
import * as netlify from "../src/integrations/cloud/netlify.js";
import * as supabase from "../src/integrations/cloud/supabase.js";
import * as vercel from "../src/integrations/cloud/vercel.js";
import type { RunOptions, RunResult, Runner } from "../src/integrations/exec.js";
import { formatSummary, healthFrom, summarizeHealth, workloadHealth } from "../src/integrations/health.js";
import { IntegrationsService } from "../src/integrations/index.js";
import { syncable } from "../src/integrations/registry.js";
import { SettingsStore } from "../src/integrations/store.js";

const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/integrations/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const vercelFx = fx("vercel");
const supabaseFx = fx("supabase");
const k8sFx = fx("kubernetes");
const netlifyFx = fx("netlify");
const hcloudFx = fx("hcloud");
const doFx = fx("doctl");
const awsFx = fx("aws");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function settingsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-cloud-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function settings(): SettingsStore {
  return new SettingsStore(settingsDir());
}

const ok = (value: unknown): RunResult => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

type Call = { args: string[]; options: RunOptions | undefined };
function fakeRunner(handler: (args: readonly string[]) => RunResult): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = ((_file: string, args: readonly string[], options?: RunOptions) => {
    calls.push({ args: [...args], options });
    return Promise.resolve(handler(args));
  }) as Runner & { calls: Call[] };
  runner.calls = calls;
  return runner;
}

const byName = (list: CloudResource[], name: string): CloudResource => {
  const found = list.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no resource named ${name}`);
  return found;
};
const allValid = (list: CloudResource[]): void => {
  for (const r of list) expect(CloudResourceSchema.safeParse(r).success, JSON.stringify(r)).toBe(true);
};

// ---- shared health helpers -------------------------------------------------------

describe("health helpers", () => {
  test("table lookup is case-insensitive; unknown states map to unknown; no status → no health", () => {
    const table = { running: "healthy", off: "down" } as const;
    expect(healthFrom("RUNNING", table)).toBe("healthy");
    expect(healthFrom("rebooting-ish", table)).toBe("unknown");
    expect(healthFrom(undefined, table)).toBeUndefined();
  });

  test("workload rule: ready vs desired, rollouts, crash loops, scaled to zero", () => {
    expect(workloadHealth({ ready: 3, desired: 3 }).health).toBe("healthy");
    expect(workloadHealth({ ready: 2, desired: 3 })).toEqual({ health: "degraded", detail: "2/3 ready" });
    expect(workloadHealth({ ready: 0, desired: 2 }).health).toBe("down");
    expect(workloadHealth({ ready: 0, desired: 2, updating: true }).health).toBe("deploying");
    expect(workloadHealth({ ready: 0, desired: 2, updating: true, crashLoop: 1 }).health).toBe("down");
    expect(workloadHealth({ ready: 3, desired: 3, updating: true })).toEqual({ health: "deploying", detail: "3/3 ready · rolling out" });
    expect(workloadHealth({ ready: 3, desired: 3, crashLoop: 1 }).health).toBe("degraded");
    expect(workloadHealth({ ready: 2, desired: 2, stalled: true, updating: true })).toEqual({ health: "degraded", detail: "2/2 ready · rollout stalled" });
    expect(workloadHealth({ ready: 0, desired: 0 })).toEqual({ health: "unknown", detail: "scaled to 0" });
  });

  test("summary counts and the strip text", () => {
    const s = summarizeHealth([{ health: "healthy" }, { health: "healthy" }, { health: "down" }, { health: "deploying" }, {}]);
    expect(s).toEqual({ healthy: 2, degraded: 0, down: 1, deploying: 1, unknown: 0, total: 4 });
    expect(formatSummary(s)).toBe("2 running · 1 down · 1 deploying");
    expect(formatSummary(summarizeHealth([]))).toBe("no live status");
  });
});

describe("existing providers get health too", () => {
  test("DigitalOcean: droplets, apps (deploying wins), databases, kubernetes, load balancers", () => {
    expect(doMod.mapDroplets(doFx.droplets).map((d) => [d.name, d.health])).toEqual([["invoices-api", "healthy"], ["worker-1", "down"]]);
    const apps = doMod.mapApps(doFx.apps);
    expect(apps[0]).toMatchObject({ health: "healthy", url: "https://web-app.ondigitalocean.app" });
    expect(apps[1]).toMatchObject({ health: "deploying", healthDetail: "building" });
    expect(doMod.appHealth("ACTIVE", "DEPLOYING")).toEqual({ health: "deploying", detail: "deploying · previous version live" });
    expect(doMod.appHealth("ERROR", undefined)).toEqual({ health: "down" });
    expect(doMod.mapDatabases(doFx.databases).map((d) => d.health)).toEqual(["healthy", "deploying", "healthy"]);
    expect(doMod.mapKubernetes(doFx.kubernetes)[0]?.health).toBe("healthy");
    expect(doMod.mapLoadBalancers(doFx.loadBalancers)[0]?.health).toBe("healthy");
    expect(doMod.mapDomains(doFx.domains)[0]?.health).toBeUndefined(); // inventory only
  });

  test("AWS: ec2, rds, elasticache, elbv2, cloudfront; ECS services by running/desired tasks", () => {
    const ctx = { region: "eu-central-1" };
    expect(awsMod.mapEc2(awsFx.ec2, ctx).map((i) => i.health)).toEqual(["healthy", "down"]);
    expect(awsMod.mapRds(awsFx.rds, ctx)[0]?.health).toBe("healthy");
    expect(awsMod.mapElastiCache(awsFx.elasticache, ctx)[0]?.health).toBe("healthy");
    expect(awsMod.mapElbv2(awsFx.elbv2, ctx)[0]?.health).toBe("healthy");
    expect(awsMod.mapCloudFront(awsFx.cloudfront, ctx)[0]?.health).toBe("healthy");
    expect(awsMod.mapLambda(awsFx.lambda, ctx)[0]?.health).toBeUndefined(); // list-functions has no State
    const base = { serviceArn: "arn:aws:ecs:eu-central-1:1:service/prod/api", serviceName: "api", clusterArn: "arn:aws:ecs:eu-central-1:1:cluster/prod", status: "ACTIVE" };
    const [steady] = awsMod.mapEcsServices({ services: [{ ...base, runningCount: 2, desiredCount: 2, deployments: [{ rolloutState: "COMPLETED" }] }] }, ctx);
    expect(steady).toMatchObject({ health: "healthy", replicas: { ready: 2, desired: 2 }, healthDetail: "2/2 running" });
    const [rolling] = awsMod.mapEcsServices({ services: [{ ...base, runningCount: 2, desiredCount: 2, deployments: [{}, {}] }] }, ctx);
    expect(rolling?.health).toBe("deploying");
    const [dead] = awsMod.mapEcsServices({ services: [{ ...base, runningCount: 0, desiredCount: 2, deployments: [{ rolloutState: "COMPLETED" }] }] }, ctx);
    expect(dead?.health).toBe("down");
  });
});

// ---- Vercel ------------------------------------------------------------------------

describe("Vercel", () => {
  const deployments = [...vercel.parseDeployments(vercelFx.deployments), ...vercel.parseDeployments(vercelFx.deploymentsOldSite)];

  test("deployments: state, target, branch; items without url are skipped", () => {
    expect(deployments).toHaveLength(10);
    expect(deployments[0]).toEqual({
      url: "web-app-7f3k2-acme.vercel.app", project: "web-app", state: "READY", target: "production", createdAt: 1790195091995, branch: "main",
    });
    expect(deployments[1]?.target).toBe("preview");
  });

  test("project health from the newest production deployment", () => {
    const projects = vercel.mapProjects(vercelFx.projects, deployments, "acme");
    expect(projects.map((p) => [p.name, p.health, p.status])).toEqual([
      ["web-app", "healthy", "ready"],
      ["invoices-api", "degraded", "error"], // failed, older READY still live
      ["docs", "deploying", "building"],
      ["landing", "down", "error"], // failed, nothing READY (the CANCELED one does not count)
      ["old-site", "healthy", "ready"],
    ]);
    expect(byName(projects, "invoices-api").healthDetail).toBe("latest production deployment failed · previous one still live");
    expect(byName(projects, "docs").healthDetail).toBe("building · previous production deployment still live");
    expect(byName(projects, "web-app")).toMatchObject({
      id: "vercel:project:prj_web", type: "app", service: "project", url: "https://web-app.example.com",
      consoleUrl: "https://vercel.com/acme/web-app", tags: { team: "acme" },
    });
    // No deployment data at all → unknown, not a guess.
    expect(vercel.mapProjects({ projects: [{ id: "p", name: "quiet", latestProductionUrl: "https://q.dev" }] }, [], "acme")[0]).toMatchObject({
      health: "unknown", healthDetail: "no recent production deployment listed",
    });
    allValid(projects);
  });

  test("newest production + preview deployment per project, no health (the project carries it); domains", () => {
    const rows = vercel.mapDeployments(deployments, "acme");
    expect(rows.find((r) => r.name === "web-app (preview)")).toMatchObject({
      status: "building", url: "https://web-app-git-feature-acme.vercel.app", tags: { project: "web-app", target: "preview", branch: "feature/search" },
      createdAt: new Date(1790196000000).toISOString(),
    });
    expect(rows.filter((r) => r.name === "web-app (production)")).toHaveLength(1);
    expect(rows.every((r) => r.health === undefined)).toBe(true);
    const domains = vercel.mapDomains(vercelFx.domains, "acme");
    expect(domains[0]).toMatchObject({ id: "vercel:domain:example.com", type: "dns", tags: { registrar: "Third Party", team: "acme" } });
    allValid([...rows, ...domains]);
    expect(JSON.stringify([...rows, ...domains])).not.toContain("dev@example.com");
  });

  function vercelRunner(options: { allFlag?: boolean; loggedOut?: boolean } = {}): ReturnType<typeof fakeRunner> {
    return fakeRunner((args) => {
      if (options.loggedOut === true) return fail("Error: No existing credentials found. Please run `vercel login` or pass \"--token\"");
      const cmd = args.filter((a) => !a.startsWith("-") && a !== "json" && a !== "acme").slice(0, 2).join(" ");
      if (args[0] === "whoami") return ok(vercelFx.whoami);
      if (cmd === "teams list") return ok(vercelFx.teams);
      if (cmd === "projects list") return ok(vercelFx.projects);
      if (cmd === "domains list") return ok(vercelFx.domains);
      if (args[0] === "list" && args.includes("--all")) return options.allFlag === false ? fail("Error: unknown or unexpected option: --all") : ok(vercelFx.deployments);
      if (args[0] === "list" && args[1] === "old-site") return ok(vercelFx.deploymentsOldSite);
      if (args[0] === "list") return ok({ deployments: [] });
      return fail(`unexpected: ${args.join(" ")}`);
    });
  }

  test("sync: only listing commands, JSON, --scope, neutral cwd + closed stdin; per-project listing for projects the cross-project list missed", async () => {
    const runner = vercelRunner();
    const i = new vercel.VercelIntegration({ runner, settings: settings(), bin: () => "/fake/vercel" });
    const out = await i.sync({ account: "acme" });
    expect(out.errors).toEqual([]);
    for (const { args, options } of runner.calls) {
      expect(["whoami", "teams", "projects", "list", "domains"]).toContain(args[0]);
      expect(args).toEqual(expect.arrayContaining(["--format", "json", "--scope", "acme"]));
      expect(options?.input).toBe("");
      expect(options?.cwd).toBe(tmpdir());
    }
    expect(runner.calls.filter((c) => c.args[0] === "list" && !c.args.includes("--all")).map((c) => c.args[1])).toEqual(["old-site"]);
    expect(out.resources.filter((r) => r.service === "project")).toHaveLength(5);
    expect(out.resources.filter((r) => r.service === "domain")).toHaveLength(2);
    allValid(out.resources);
  });

  test("an older CLI without `list --all` falls back to per-project listings", async () => {
    const runner = vercelRunner({ allFlag: false });
    const out = await new vercel.VercelIntegration({ runner, settings: settings(), bin: () => "/fake/vercel" }).sync({});
    expect(out.errors).toEqual([]);
    expect(runner.calls.filter((c) => c.args[0] === "list" && !c.args.includes("--all"))).toHaveLength(5);
  });

  test("info: teams as accounts, current first; logged out → not_connected with `vercel login`; missing → cli_missing + brew", async () => {
    const i = new vercel.VercelIntegration({ runner: vercelRunner(), settings: settings(), bin: () => "/fake/vercel" });
    const info = await i.info();
    expect(info).toMatchObject({ id: "vercel", family: "cloud", status: "connected", detail: "vercel: dev-user · team acme" });
    expect(info.accounts).toEqual([{ id: "acme", label: "Acme (current)" }, { id: "side-gig", label: "Side gig" }]);
    expect(JSON.stringify(info)).not.toContain("dev@example.com");

    const out = new vercel.VercelIntegration({ runner: vercelRunner({ loggedOut: true }), settings: settings(), bin: () => "/fake/vercel" });
    expect(await out.info()).toMatchObject({ status: "not_connected", setupHint: "vercel login" });

    const missing = new vercel.VercelIntegration({ runner: vercelRunner(), settings: settings(), bin: () => undefined });
    expect(await missing.info()).toMatchObject({ status: "cli_missing", detail: "vercel not installed", setupHint: "brew install vercel-cli && vercel login" });
    await expect(missing.sync({})).rejects.toMatchObject({ status: 424 });
  });

  test("connect validates the team against `teams list` and rejects flag-shaped names", async () => {
    const store = settings();
    const i = new vercel.VercelIntegration({ runner: vercelRunner(), settings: store, bin: () => "/fake/vercel" });
    await expect(i.connect({ account: "--token=x" })).rejects.toThrow(/invalid Vercel team/);
    await expect(i.connect({ account: "nope" })).rejects.toThrow(/unknown Vercel team/);
    await i.connect({ account: "side-gig" });
    expect(store.get("vercel")).toEqual({ account: "side-gig" });
    await i.disconnect();
    expect(i.enabled()).toBe(false);
  });
});

// ---- Supabase ----------------------------------------------------------------------

describe("Supabase", () => {
  test("projects: status → health, org tag, dashboard URL; the database host is never copied", () => {
    const { projects, resources } = supabase.parseProjects(supabaseFx.projects);
    expect(projects.map((p) => p.ref)).toEqual(["abcdefghijklmnopqrst", "pausedpausedpausedpa", "otherotherotherother"]);
    expect(resources.map((r) => [r.name, r.health, r.healthDetail])).toEqual([
      ["invoices-db", "healthy", undefined],
      ["old-demo", "down", "paused"],
      ["side-app", "degraded", "some services are unhealthy"],
    ]);
    expect(resources[0]).toMatchObject({
      id: "supabase:project:abcdefghijklmnopqrst", type: "database", service: "project", region: "eu-central-1", status: "active_healthy",
      consoleUrl: "https://supabase.com/dashboard/project/abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co",
      tags: { org: "acme-org" },
    });
    expect(JSON.stringify(resources)).not.toContain("db.abcdefghijklmnopqrst");
    allValid(resources);
  });

  test("edge functions and preview branches (the default branch is skipped)", () => {
    const project = supabase.parseProjects(supabaseFx.projects).projects[0]!;
    const fns = supabase.mapFunctions(supabaseFx.functions, project);
    expect(fns.map((f) => [f.name, f.health])).toEqual([["send-email", "healthy"], ["old-hook", "degraded"]]);
    expect(fns[0]).toMatchObject({ type: "function", service: "edge-function", healthDetail: "version 7", url: "https://abcdefghijklmnopqrst.supabase.co/functions/v1/send-email" });
    const branches = supabase.mapBranches(supabaseFx.branches, project);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ name: "invoices-db:feature-billing", health: "down", tags: { branch: "feature/billing" } });
    expect(supabase.mapBranches(null, project)).toEqual([]); // `branches list -o json` prints null when there are none
    allValid([...fns, ...branches]);
  });

  test("sync: org filter; functions/branches only for active projects via --project-ref; missing branching is not an error", async () => {
    const runner = fakeRunner((args) => {
      const key = `${args[0]} ${args[1]}`;
      if (key === "orgs list") return ok(supabaseFx.orgs);
      if (key === "projects list") return ok(supabaseFx.projects);
      if (key === "functions list") return ok(supabaseFx.functions);
      if (key === "branches list") return fail("Branching is not enabled for this project.");
      return fail(`unexpected ${key}`);
    });
    const i = new supabase.SupabaseIntegration({ runner, settings: settings(), bin: () => "/fake/supabase" });
    const out = await i.sync({ account: "acme-org" });
    expect(out.errors).toEqual([]);
    expect(out.resources.map((r) => r.name).sort()).toEqual(["invoices-db", "old-demo", "old-hook", "send-email"]);
    const detailCalls = runner.calls.filter((c) => c.args[0] === "functions" || c.args[0] === "branches");
    expect(detailCalls.map((c) => c.args)).toEqual([
      ["functions", "list", "--project-ref", "abcdefghijklmnopqrst", "-o", "json"],
      ["branches", "list", "--project-ref", "abcdefghijklmnopqrst", "-o", "json"],
    ]);
    for (const c of runner.calls) {
      expect(c.args[1]).toBe("list");
      // The CLI writes supabase/.temp/ into its cwd: never the daemon's (a user's repo).
      expect(c.options?.cwd).toBe(supabase.SUPABASE_WORKDIR);
      expect(c.options?.input).toBe("");
    }
  });

  test("logged out → not_connected with `supabase login`; missing CLI → brew hint", async () => {
    const runner = fakeRunner(() => fail("Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable."));
    const i = new supabase.SupabaseIntegration({ runner, settings: settings(), bin: () => "/fake/supabase" });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "supabase login" });
    const missing = new supabase.SupabaseIntegration({ runner, settings: settings(), bin: () => undefined });
    expect(await missing.info()).toMatchObject({ status: "cli_missing", setupHint: "brew install supabase/tap/supabase && supabase login" });
  });
});

// ---- Kubernetes ----------------------------------------------------------------------

describe("Kubernetes", () => {
  const ctx = { context: "prod", pods: k8s.summarizePods(k8sFx.pods) };

  test("pods are summarized per owning workload (ReplicaSet → Deployment, Job → CronJob)", () => {
    expect(ctx.pods.get("Deployment/prod/invoices-api")).toEqual({ running: 3, pending: 0, crashLoop: 0, restarts: 1 });
    expect(ctx.pods.get("Deployment/prod/web-app")).toEqual({ running: 2, pending: 0, crashLoop: 1, restarts: 14 });
    expect(ctx.pods.get("Deployment/staging/worker")).toEqual({ running: 0, pending: 0, crashLoop: 2, restarts: 0 });
    expect(ctx.pods.get("Deployment/prod/notify")).toEqual({ running: 0, pending: 1, crashLoop: 0, restarts: 0 });
    expect(ctx.pods.get("StatefulSet/prod/postgres")).toEqual({ running: 1, pending: 0, crashLoop: 0, restarts: 2 });
    expect(ctx.pods.get("CronJob/prod/cleanup")).toEqual({ running: 0, pending: 0, crashLoop: 0, restarts: 3 });
  });

  test("deployments: ready/desired replicas, rollouts, crash loops, stalled rollouts; system namespaces skipped", () => {
    const d = k8s.mapDeployments(k8sFx.deployments, ctx);
    expect(d.map((r) => [r.name, r.health])).toEqual([
      ["invoices-api", "healthy"], ["web-app", "degraded"], ["worker", "down"], ["notify", "deploying"], ["checkout", "degraded"], ["idle", "unknown"],
    ]);
    expect(byName(d, "invoices-api")).toMatchObject({
      id: "k8s:prod:prod:deployment:invoices-api", type: "container", service: "deployment", region: "prod", status: "3/3 ready",
      replicas: { ready: 3, desired: 3 }, pods: { running: 3, pending: 0, crashLoop: 0, restarts: 1 },
      healthDetail: "3/3 ready · 1 restart", tags: { app: "invoices-api", "ruah-node": "api" },
    });
    expect(byName(d, "web-app").healthDetail).toBe("2/3 ready · 1 crash-looping · 14 restarts");
    expect(byName(d, "worker").healthDetail).toBe("0/2 ready · 2 crash-looping");
    expect(byName(d, "notify").healthDetail).toBe("2/2 ready · rolling out · 1 pending");
    expect(byName(d, "checkout").healthDetail).toBe("2/2 ready · rollout stalled");
    expect(byName(d, "idle").healthDetail).toBe("scaled to 0");
    allValid(d);
  });

  test("statefulsets, daemonsets, cronjobs", () => {
    expect(k8s.mapStatefulSets(k8sFx.statefulsets, ctx)[0]).toMatchObject({ name: "postgres", service: "statefulset", health: "healthy", healthDetail: "1/1 ready · 2 restarts" });
    expect(k8s.mapDaemonSets(k8sFx.daemonsets, ctx)[0]).toMatchObject({ name: "log-agent", region: "monitoring", health: "healthy", replicas: { ready: 3, desired: 3 } });
    const cron = k8s.mapCronJobs(k8sFx.cronjobs, ctx);
    expect(cron.map((c) => [c.name, c.health, c.healthDetail, c.status])).toEqual([
      ["nightly-report", "healthy", "last run succeeded", "0 2 * * *"],
      ["cleanup", "degraded", "last run did not succeed · 3 restarts", "0 3 * * *"],
      ["archive", "unknown", "suspended", "suspended"],
    ]);
  });

  test("services (type + ports; only LoadBalancers have health) and ingresses (hosts, url, address)", () => {
    const svc = k8s.mapServices(k8sFx.services, ctx);
    expect(svc.map((s) => s.name)).toEqual(["invoices-api", "edge", "pending-lb"]); // default/kubernetes skipped
    expect(byName(svc, "invoices-api")).toMatchObject({ type: "other", status: "ClusterIP 80→8080/TCP" });
    expect(byName(svc, "invoices-api").health).toBeUndefined();
    expect(byName(svc, "edge")).toMatchObject({ type: "loadbalancer", health: "healthy", hosts: ["a1b2c3.elb.eu-central-1.amazonaws.com"] });
    expect(byName(svc, "pending-lb")).toMatchObject({ health: "deploying", healthDetail: "waiting for an external address" });
    const ing = k8s.mapIngresses(k8sFx.ingresses, ctx);
    expect(ing[0]).toMatchObject({ type: "gateway", hosts: ["app.example.com", "www.example.com"], url: "https://app.example.com", health: "healthy" });
    expect(ing[1]).toMatchObject({ url: "http://api.staging.example.com", health: "deploying", healthDetail: "no address yet" });
    allValid([...svc, ...ing]);
  });

  function kubectl(handler?: (args: readonly string[]) => RunResult | undefined): ReturnType<typeof fakeRunner> {
    return fakeRunner((args) => {
      const custom = handler?.(args);
      if (custom !== undefined) return custom;
      if (args[0] === "config" && args[1] === "get-contexts") return ok(k8sFx.contexts as string);
      if (args[0] === "config" && args[1] === "current-context") return ok(k8sFx.currentContext as string);
      if (args[0] === "version") return ok(k8sFx.version);
      if (args[0] === "get") return ok(k8sFx[args[1] ?? ""] ?? { items: [] });
      return fail(`unexpected ${args.join(" ")}`);
    });
  }

  test("sync: only get/version/config reads, --context=<ctx>, --all-namespaces, request timeout", async () => {
    const runner = kubectl();
    const i = new k8s.KubernetesIntegration({ runner, settings: settings(), bin: () => "/fake/kubectl" });
    const out = await i.sync({});
    expect(out.errors).toEqual([]);
    expect(out.resources).toHaveLength(6 + 1 + 1 + 3 + 3 + 2);
    const eks = "arn:aws:eks:eu-central-1:123456789012:cluster/prod";
    for (const { args } of runner.calls) {
      expect(["get", "config", "version"]).toContain(args[0]);
      if (args[0] === "config") expect(["get-contexts", "current-context"]).toContain(args[1]);
      if (args[0] === "get") {
        expect(args).toEqual(expect.arrayContaining(["--all-namespaces", "-o", "json", "--request-timeout=10s", `--context=${eks}`]));
      }
    }
    expect(out.resources[0]?.id.startsWith(`k8s:${eks}:`)).toBe(true);
  });

  test("an unreachable cluster fails the whole provider once; a forbidden kind is a per-kind error", async () => {
    const klog = 'E0924 21:42:14.677673   70707 memcache.go:265] "Unhandled Error" err="couldn\'t get current server API group list: dial tcp 127.0.0.1:61531: connect: connection refused"';
    const refused = `${klog}\n${klog}\nThe connection to the server 127.0.0.1:61531 was refused - did you specify the right host or port?`;
    const down = new k8s.KubernetesIntegration({ runner: kubectl((a) => (a[0] === "get" || a[0] === "version" ? fail(refused) : undefined)), settings: settings(), bin: () => "/fake/kubectl" });
    await expect(down.sync({})).rejects.toThrow(/^The connection to the server 127\.0\.0\.1:61531 was refused/);
    expect(k8s.stripKlog(klog)).toBe(klog); // nothing else left: keep it
    expect(await down.info()).toMatchObject({ status: "error", detail: expect.stringContaining("cluster unreachable") });

    const rbac = new k8s.KubernetesIntegration({
      runner: kubectl((a) => (a[0] === "get" && a[1] === "cronjobs" ? fail('Error from server (Forbidden): cronjobs.batch is forbidden: User "dev" cannot list resource "cronjobs"') : undefined)),
      settings: settings(), bin: () => "/fake/kubectl",
    });
    const out = await rbac.sync({});
    expect(out.errors).toEqual([expect.stringMatching(/^cronjobs: Error from server \(Forbidden\)/)]);
    expect(out.resources.some((r) => r.service === "deployment")).toBe(true);
  });

  test("info: contexts as accounts (current flagged), server version; connect validates the context", async () => {
    const store = settings();
    const i = new k8s.KubernetesIntegration({ runner: kubectl(), settings: store, bin: () => "/fake/kubectl" });
    const info = await i.info();
    expect(info).toMatchObject({ status: "connected", detail: "context arn:aws:eks:eu-central-1:123456789012:cluster/prod · server v1.31.4-eks-2d5f260" });
    expect(info.accounts?.map((a) => a.label)).toEqual(["kind-dev", "arn:aws:eks:eu-central-1:123456789012:cluster/prod (current)"]);
    await i.connect({ account: "kind-dev" });
    expect(store.get("kubernetes")).toEqual({ account: "kind-dev" });
    await expect(i.connect({ account: "--kubeconfig=/tmp/x" })).rejects.toThrow(/invalid Kubernetes context/);
    const missing = new k8s.KubernetesIntegration({ runner: kubectl(), settings: settings(), bin: () => undefined });
    expect(await missing.info()).toMatchObject({ status: "cli_missing", setupHint: expect.stringContaining("brew install kubectl") });
  });

  test("kubectl without any context is not set up, not a cluster that is down (no localhost:8080 call)", async () => {
    const refused = "The connection to the server localhost:8080 was refused - did you specify the right host or port?";
    const runner = kubectl((a) => {
      if (a[0] === "config" && a[1] === "get-contexts") return ok("");
      if (a[0] === "config" && a[1] === "current-context") return fail("error: current-context is not set");
      if (a[0] === "version" || a[0] === "get") return fail(refused);
      return undefined;
    });
    const i = new k8s.KubernetesIntegration({ runner, settings: settings(), bin: () => "/fake/kubectl" });
    const info = await i.info();
    expect(info).toMatchObject({ status: "not_connected", detail: "no contexts in your kubeconfig", setupHint: expect.stringContaining("kubectl config use-context") });
    expect(runner.calls.some((c) => c.args[0] === "version")).toBe(false);
  });
});

// ---- Netlify -----------------------------------------------------------------------------

describe("Netlify", () => {
  const deploys = netlifyFx.deploys as Record<string, Record<string, unknown>[]>;

  test("site health: published deploy + newest deploy", () => {
    expect(netlify.netlifySiteHealth({ id: "d", state: "ready" }, { state: "ready" })).toEqual({ health: "healthy" });
    expect(netlify.netlifySiteHealth({ id: "d" }, { state: "building" })).toEqual({ health: "deploying", detail: "building · published deploy still live" });
    expect(netlify.netlifySiteHealth(undefined, { state: "enqueued" })).toEqual({ health: "deploying", detail: "enqueued" });
    expect(netlify.netlifySiteHealth({ id: "d" }, { state: "error" }).health).toBe("degraded");
    expect(netlify.netlifySiteHealth(undefined, { state: "error" }).health).toBe("down");
    expect(netlify.netlifySiteHealth(undefined, undefined)).toEqual({ health: "down", detail: "nothing published" });
  });

  test("sites map to apps with URL, custom domains, admin URL; build env never copied", () => {
    const sites = (netlifyFx.sites as Record<string, unknown>[]).map((s) => netlify.mapSite(s, deploys[String(s.id)]?.[0])).filter((s): s is CloudResource => s !== undefined);
    expect(sites.map((s) => [s.name, s.health])).toEqual([["marketing", "healthy"], ["docs", "degraded"], ["blog", "deploying"], ["side-project", "healthy"]]);
    expect(sites[0]).toMatchObject({
      id: "netlify:site:1a2b3c4d-0000-4000-8000-000000000001", type: "app", service: "site", url: "https://www.example.com",
      hosts: ["www.example.com", "example.com"], consoleUrl: "https://app.netlify.com/sites/marketing", tags: { team: "acme" },
    });
    expect(sites[1]?.healthDetail).toContain("Build script returned non-zero exit code: 2");
    expect(JSON.stringify(sites)).not.toContain("should-not-appear");
    allValid(sites);
  });

  test("sync through `netlify api` (read operations only), team filter, one deploy per site", async () => {
    const runner = fakeRunner((args) => {
      if (args[0] !== "api") return fail("unexpected");
      const data = args[3] !== undefined ? (JSON.parse(args[3]) as Record<string, unknown>) : {};
      switch (args[1]) {
        case "getCurrentUser": return ok(netlifyFx.user);
        case "listAccountsForUser": return ok(netlifyFx.accounts);
        case "listSites": return ok(netlifyFx.sites);
        case "listSiteDeploys": return ok(deploys[String(data.site_id)] ?? []);
        default: return fail(`unexpected ${args[1] ?? ""}`);
      }
    });
    const i = new netlify.NetlifyIntegration({ runner, settings: settings(), bin: () => "/fake/netlify" });
    const out = await i.sync({ account: "acme" });
    expect(out.resources.map((r) => r.name)).toEqual(["marketing", "docs", "blog"]);
    for (const { args, options } of runner.calls) {
      expect(["getCurrentUser", "listAccountsForUser", "listSites", "listSiteDeploys"]).toContain(args[1]);
      expect(options?.cwd).toBe(tmpdir());
    }
    const perSite = runner.calls.filter((c) => c.args[1] === "listSiteDeploys").map((c) => JSON.parse(c.args[3] ?? "{}") as { per_page: number });
    expect(perSite.every((d) => d.per_page === 1)).toBe(true);
    const info = await i.info();
    expect(info).toMatchObject({ status: "connected", detail: "netlify: devuser" });
    expect(JSON.stringify(info)).not.toContain("dev@example.com");
  });

  test("not installed → cli_missing with the brew command; logged out → netlify login", async () => {
    const missing = new netlify.NetlifyIntegration({ runner: fakeRunner(() => ok([])), settings: settings(), bin: () => undefined });
    expect(await missing.info()).toMatchObject({ id: "netlify", status: "cli_missing", detail: "netlify not installed", setupHint: "brew install netlify-cli && netlify login" });
    const out = new netlify.NetlifyIntegration({ runner: fakeRunner(() => fail("Not logged in. Please log in to run this command.")), settings: settings(), bin: () => "/fake/netlify" });
    expect(await out.info()).toMatchObject({ status: "not_connected", setupHint: "netlify login" });
  });
});

// ---- Hetzner Cloud -------------------------------------------------------------------------

describe("Hetzner Cloud", () => {
  test("servers (status → health, labels, no IPs), load balancers (target checks), volumes", () => {
    const servers = hcloud.mapServers(hcloudFx.servers);
    expect(servers.map((s) => [s.name, s.region, s.health])).toEqual([["invoices-api", "fsn1", "healthy"], ["worker-1", "nbg1", "down"]]);
    expect(servers[0]).toMatchObject({ id: "hcloud:server:42", type: "compute", tags: { "ruah-node": "api", env: "prod" }, healthDetail: "cx22" });
    expect(JSON.stringify(servers)).not.toContain("198.51.100.20");
    const lbs = hcloud.mapLoadBalancers(hcloudFx.loadBalancers);
    expect(lbs[0]).toMatchObject({ health: "degraded", healthDetail: "1 target · 1/2 checks healthy", hosts: ["203.0.113.9"] });
    expect(lbs[1]).toMatchObject({ health: "unknown", healthDetail: "no targets" });
    expect(hcloud.mapVolumes(hcloudFx.volumes)[0]).toMatchObject({ type: "storage", status: "available · 50 GB", tags: { "ruah-node": "db" } });
    allValid([...servers, ...lbs]);
  });

  test("contexts from the text table or JSON", () => {
    expect(hcloud.parseContexts(hcloudFx.contextsText as string)).toEqual([
      { id: "acme-prod", label: "acme-prod", current: true },
      { id: "acme-staging", label: "acme-staging", current: false },
    ]);
    expect(hcloud.parseContexts("ACTIVE   NAME\n*        acme-prod\n")).toEqual([{ id: "acme-prod", label: "acme-prod", current: true }]);
    expect(hcloud.parseContexts(JSON.stringify(hcloudFx.contextsJson)).map((c) => c.current)).toEqual([true, false]);
  });

  test("sync: list commands with -o json and --context; not installed → brew hint", async () => {
    const runner = fakeRunner((args) => {
      if (args[0] === "context") return ok(hcloudFx.contextsText as string);
      const key = `${args[0]} ${args[1]}`;
      if (key === "server list") return ok(hcloudFx.servers);
      if (key === "load-balancer list") return ok(hcloudFx.loadBalancers);
      if (key === "volume list") return ok(hcloudFx.volumes);
      if (key === "location list") return ok(hcloudFx.locations);
      return fail(`unexpected ${key}`);
    });
    const i = new hcloud.HetznerIntegration({ runner, settings: settings(), bin: () => "/fake/hcloud" });
    const out = await i.sync({});
    expect(out.resources).toHaveLength(2 + 2 + 1);
    for (const { args } of runner.calls.filter((c) => c.args[0] !== "context")) {
      expect(args[1]).toBe("list");
      expect(args).toEqual(expect.arrayContaining(["-o", "json", "--context", "acme-prod"]));
    }
    expect(await i.info()).toMatchObject({ status: "connected", detail: "hcloud context acme-prod" });
    const missing = new hcloud.HetznerIntegration({ runner, settings: settings(), bin: () => undefined });
    expect(await missing.info()).toMatchObject({ status: "cli_missing", detail: "hcloud not installed", setupHint: "brew install hcloud && hcloud context create <project>" });
  });
});

// ---- batch B (§10) wired into live health, one quietness gate, sync body limit --------------

describe("§10 providers in live health", () => {
  const base = (provider: string, service: string, status: string | undefined): CloudResource => ({
    id: `${provider}:${service}`, provider, type: "app", service, name: service, ...(status !== undefined ? { status } : {}),
  });

  test("withLiveHealth applies each adapter's healthOf to the native state; detail + machine counts", () => {
    expect(withLiveHealth(base("gcp", "cloud-run", "ready"), (s) => gcp.healthOf(s))).toMatchObject({ health: "healthy" });
    expect(withLiveHealth(base("gcp", "gke", "running · 3 nodes"), (s) => gcp.healthOf(s))).toMatchObject({ health: "healthy", healthDetail: "3 nodes" });
    expect(withLiveHealth(base("azure", "app-service", "stopped"), (s) => azure.healthOf(s)).health).toBe("down");
    expect(withLiveHealth(base("cloudflare", "pages", "deploying"), (s) => cloudflare.healthOf(s)).health).toBe("deploying");
    expect(withLiveHealth(base("railway", "railway/service", "crashed"), (s) => railway.healthOf(s)).health).toBe("down");
    expect(withLiveHealth(base("fly", "fly/app", "deployed · 1/3 machines started · fra"), (s) => fly.healthOf(s))).toMatchObject({
      health: "healthy", replicas: { ready: 1, desired: 3 }, healthDetail: "1/3 machines started · fra",
    });
    // No status (buckets, topics, KV) and resource groups: no health.
    expect(withLiveHealth(base("gcp", "gcs", undefined), (s) => gcp.healthOf(s)).health).toBeUndefined();
    expect(withLiveHealth(base("azure", "resource-group", "succeeded"), (s) => azure.healthOf(s)).health).toBeUndefined();
  });

  test("a synced §10 adapter sets health on its resources (so the strip and `cloud status` count it)", async () => {
    const runner = fakeRunner((args) => {
      if (args[0] === "auth" && args[1] === "whoami") return ok({ email: "dev@example.com" });
      if (args[0] === "orgs") return ok({ acme: "Acme" });
      if (args[0] === "apps") return ok([{ Name: "api", Status: "suspended", Organization: { Slug: "acme" }, Hostname: "api.fly.dev" }]);
      return ok([]);
    });
    const out = await new fly.FlyIntegration({ runner, settings: settings(), bin: () => "/fake/fly" }).sync({});
    expect(out.resources.find((r) => r.name === "api")?.health).toBe("down");
  });

  test("one gate for sync-all / the watch loop: not installed, logged out or disconnected → not syncable", async () => {
    const loggedOut = new vercel.VercelIntegration({
      runner: fakeRunner(() => fail("Error: No existing credentials found. Please run vercel login")), settings: settings(), bin: () => "/fake/vercel",
    });
    expect(syncable(loggedOut)).toBe(true); // unknown until info() looked
    await loggedOut.info();
    expect(syncable(loggedOut)).toBe(false);
    expect(syncable(new vercel.VercelIntegration({ runner: fakeRunner(() => ok({})), settings: settings(), bin: () => undefined }))).toBe(false);
    expect(syncable(new gcp.GcpIntegration({ runner: fakeRunner(() => ok({})), settings: settings(), bin: () => undefined }))).toBe(false);
  });

  test("a sync body may name every registered cloud provider", () => {
    const svc = new IntegrationsService({ home: settingsDir(), project: () => null });
    const ids = svc.registry.cloud().map((c) => c.id);
    expect([...ids].sort()).toEqual([...KNOWN_CLOUD_PROVIDERS].sort());
    expect(CloudSyncBodySchema.safeParse({ providers: ids }).success).toBe(true);
  });
});
