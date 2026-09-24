// Cloud providers batch B (CONTRACTS.md §10): Google Cloud, Azure, Cloudflare,
// Railway, Fly.io. Realistic CLI output fixtures, a fake exec — no real CLI,
// no network, no daemon.
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudResourceSchema, IntegrationInfoSchema, type CloudResource } from "../src/contracts/integrations.js";
import * as azure from "../src/integrations/cloud/azure.js";
import { looseJson, parseTextTable, type CliCloudIntegration } from "../src/integrations/cloud/cli-kit.js";
import * as cf from "../src/integrations/cloud/cloudflare.js";
import * as fly from "../src/integrations/cloud/fly.js";
import * as gcp from "../src/integrations/cloud/gcp.js";
import * as railway from "../src/integrations/cloud/railway.js";
import { CliError, type RunOptions, type RunResult, type Runner } from "../src/integrations/exec.js";
import { cloudBatchB, IntegrationRegistry, registerCloudBatchB } from "../src/integrations/registry.js";
import { SettingsStore } from "../src/integrations/store.js";

const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/integrations/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const gfx = fx("gcloud");
const afx = fx("az");
const wfx = fx("wrangler");
const rfx = fx("railway");
const ffx = fx("flyctl");
const text = (value: unknown): string => value as string;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-cloudb-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (value: unknown): RunResult => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

interface Call {
  file: string;
  args: string[];
  options: RunOptions | undefined;
}
function fakeRunner(handler: (args: readonly string[], options: RunOptions | undefined) => RunResult): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = ((file: string, args: readonly string[], options?: RunOptions) => {
    calls.push({ file, args: [...args], options });
    return Promise.resolve(handler(args, options));
  }) as Runner & { calls: Call[] };
  runner.calls = calls;
  return runner;
}
/** The command words before the first flag ("run services list --format=json" → "run services list"). */
const cmd = (args: readonly string[]): string => {
  const i = args.findIndex((a) => a.startsWith("-"));
  return (i === -1 ? args : args.slice(0, i)).join(" ");
};

function expectValid(resources: CloudResource[]): void {
  for (const r of resources) expect(CloudResourceSchema.safeParse(r).success, r.id).toBe(true);
  const json = JSON.stringify(resources);
  for (const secret of ["SECRETPASSWORD", "should-not-appear", "203.0.113.20", "198.51.100.30", "LS0tLS1CRUdJTi"]) expect(json).not.toContain(secret);
}

// ---- fake CLIs ---------------------------------------------------------------------------

function gcloudRunner(overrides: Record<string, RunResult> = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((args) => {
    const c = cmd(args);
    if (overrides[c] !== undefined) return overrides[c];
    switch (c) {
      case "auth list": return ok(gfx.authList);
      case "config configurations list": return ok(gfx.configurations);
      case "projects list": return ok(gfx.projects);
      case "run services list": return ok(gfx.run);
      case "container clusters list": return ok(gfx.gke);
      case "sql instances list": return ok(gfx.sql);
      case "functions list": return fail("ERROR: (gcloud.functions.list) API [cloudfunctions.googleapis.com] not enabled on project [acme-prod].");
      case "pubsub topics list": return ok(gfx.topics);
      case "storage buckets list": return ok(gfx.buckets);
      default: return fail(`unexpected: ${c}`);
    }
  });
}

function azRunner(overrides: Record<string, RunResult> = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((args) => {
    const c = cmd(args);
    if (overrides[c] !== undefined) return overrides[c];
    switch (c) {
      case "account list": return ok(afx.accounts);
      case "group list": return ok(afx.groups);
      case "webapp list": return ok(afx.webapps);
      case "functionapp list": return ok(afx.functionapps);
      case "containerapp list": return fail("ERROR: The command requires the extension containerapp. It will be installed first.");
      case "aks list": return ok(afx.aks);
      case "sql server list": return ok(afx.sqlservers);
      case "postgres flexible-server list": return ok(afx.postgres);
      case "storage account list": return ok(afx.storage);
      default: return fail(`unexpected: ${c}`);
    }
  });
}

function wranglerRunner(overrides: Record<string, RunResult> = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((args) => {
    const c = cmd(args);
    if (overrides[c] !== undefined) return overrides[c];
    switch (c) {
      case "whoami": return ok(text(wfx.whoami));
      case "d1 list": return ok(wfx.d1);
      case "kv namespace list": return ok(text(wfx.kv));
      case "r2 bucket list": return ok(text(wfx.r2));
      case "queues list": return ok(text(wfx.queues));
      case "pages project list": return ok(wfx.pagesProjects);
      case "pages deployment list": {
        const project = args[args.indexOf("--project-name") + 1];
        return ok(project === "web-app" ? wfx.pagesDeploymentsWeb : wfx.pagesDeploymentsDocs);
      }
      case "deployments list": {
        const name = args[args.indexOf("--name") + 1];
        return name === "invoices-api" ? ok(wfx.deploymentsApi) : fail("✘ [ERROR] A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]");
      }
      default: return fail(`unexpected: ${c}`);
    }
  });
}

function railwayRunner(overrides: Record<string, RunResult> = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((args, options) => {
    const c = cmd(args);
    if (overrides[c] !== undefined) return overrides[c];
    switch (c) {
      case "whoami": return ok(text(rfx.whoami));
      case "list": return ok(rfx.list);
      case "status": return options?.cwd !== undefined ? ok(rfx.status) : fail("No linked project found. Run railway link to connect to a project");
      default: return fail(`unexpected: ${c}`);
    }
  });
}

function flyRunner(overrides: Record<string, RunResult> = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((args) => {
    const c = cmd(args);
    if (overrides[c] !== undefined) return overrides[c];
    const app = args[args.indexOf("--app") + 1];
    switch (c) {
      case "auth whoami": return ok(ffx.whoami);
      case "orgs list": return ok(ffx.orgs);
      case "apps list": return ok(ffx.apps);
      case "postgres list": return ok(ffx.postgres);
      case "machines list": return app === "acme-db" ? ok(ffx.machinesDb) : app === "old-worker" ? ok([]) : ok(ffx.machinesApi);
      case "volumes list": return app === "invoices-api" ? ok(ffx.volumesApi) : ok([]);
      case "mpg list": return fail("Error: unknown command \"mpg\" for \"flyctl\"");
      default: return fail(`unexpected: ${c}`);
    }
  });
}

// ---- Google Cloud ------------------------------------------------------------------------

describe("Google Cloud mappers", () => {
  const ctx = { project: "acme-prod" };

  test("Cloud Run: latest revision ready state, url, user labels as tags, full resource name", () => {
    const r = gcp.mapCloudRun(gfx.run, ctx);
    expect(r[0]).toEqual({
      id: "//run.googleapis.com/projects/acme-prod/locations/europe-west1/services/invoices-api", provider: "gcp", type: "container",
      service: "cloud-run", name: "invoices-api", region: "europe-west1", status: "ready", url: "https://invoices-api-abc123-ew.a.run.app",
      tags: { "ruah-node": "api", team: "billing" },
      consoleUrl: "https://console.cloud.google.com/run/detail/europe-west1/invoices-api/metrics?project=acme-prod",
    });
    expect(r[1]?.status).toBe("deploying · web-app-00004-new");
    expect(r[2]?.status).toBe("failed");
    expect(gcp.cloudRunState("True", "a", "a")).toBe("ready");
    expect(gcp.cloudRunState("CONDITION_SUCCEEDED", undefined, undefined)).toBe("ready");
  });

  test("GKE (status + node count), Cloud SQL (engine, stopped via activation policy), Functions gen1/gen2, Pub/Sub, GCS", () => {
    expect(gcp.mapGke(gfx.gke, ctx).map((c) => [c.name, c.service, c.status, c.region])).toEqual([
      ["prod-cluster", "gke", "running · 3 nodes", "europe-west1"],
      ["autopilot-1", "gke-autopilot", "provisioning · 1 node", "us-central1"],
    ]);
    expect(gcp.mapCloudSql(gfx.sql, ctx).map((d) => [d.service, d.status, d.tags])).toEqual([
      ["cloud-sql/postgres", "running", { tier: "data" }],
      ["cloud-sql/mysql", "stopped", undefined],
    ]);
    const fns = gcp.mapFunctions(gfx.functions, ctx);
    expect(fns[0]).toMatchObject({ name: "resize-image", service: "cloud-functions/gen2", region: "europe-west1", status: "active", url: "https://resize-image-abc123-ew.a.run.app", tags: { owner: "media" } });
    expect(fns[1]).toMatchObject({ name: "legacy-hook", service: "cloud-functions", status: "active", url: "https://us-central1-acme-prod.cloudfunctions.net/legacy-hook" });
    expect(gcp.mapPubsubTopics(gfx.topics, ctx)[0]).toMatchObject({ id: "//pubsub.googleapis.com/projects/acme-prod/topics/invoice-created", name: "invoice-created", type: "queue", tags: { "ruah-node": "bus" } });
    expect(gcp.mapBuckets(gfx.buckets, ctx).map((b) => [b.name, b.region])).toEqual([["acme-uploads", "europe-west1"], ["acme-backups", "eu"]]);
  });

  test("garbage maps to nothing; everything matches the contract and leaks no secrets", () => {
    for (const m of [gcp.mapCloudRun, gcp.mapGke, gcp.mapCloudSql, gcp.mapFunctions, gcp.mapPubsubTopics, gcp.mapBuckets]) {
      expect(m(null, ctx)).toEqual([]);
      expect(m({ items: 1 }, ctx)).toEqual([]);
      expect(m([1, "x", null, {}], ctx)).toEqual([]);
    }
    expectValid([
      ...gcp.mapCloudRun(gfx.run, ctx), ...gcp.mapGke(gfx.gke, ctx), ...gcp.mapCloudSql(gfx.sql, ctx),
      ...gcp.mapFunctions(gfx.functions, ctx), ...gcp.mapPubsubTopics(gfx.topics, ctx), ...gcp.mapBuckets(gfx.buckets, ctx),
    ]);
  });

  test("healthOf", () => {
    expect(gcp.healthOf("ready")).toBe("healthy");
    expect(gcp.healthOf("running · 3 nodes")).toBe("healthy");
    expect(gcp.healthOf("RUNNABLE")).toBe("healthy");
    expect(gcp.healthOf("deploying · web-app-00004")).toBe("deploying");
    expect(gcp.healthOf("PROVISIONING")).toBe("deploying");
    expect(gcp.healthOf("DEGRADED")).toBe("degraded");
    expect(gcp.healthOf("failed")).toBe("down");
    expect(gcp.healthOf("stopped")).toBe("down");
    expect(gcp.healthOf(undefined)).toBe("unknown");
    expect(gcp.healthOf("weird")).toBe("unknown");
  });
});

describe("Google Cloud integration", () => {
  test("info: configurations + visible projects as accounts, active configuration selected", async () => {
    const i = new gcp.GcpIntegration({ runner: gcloudRunner(), settings: new SettingsStore(tempDir()), bin: () => "/fake/gcloud" });
    const info = await i.info();
    expect(info).toMatchObject({ id: "gcp", name: "Google Cloud", status: "connected", detail: "me@example.com · project acme-prod", installCommand: gcp.GCP_INSTALL, loginCommand: "gcloud auth login" });
    expect(info.accounts?.map((a) => a.id)).toEqual(["default/acme-prod", "staging/acme-staging", "acme-sandbox"]);
    expect(IntegrationInfoSchema.safeParse(info).success).toBe(true);
  });

  test("sync: read-only list calls with --format=json --quiet --project; disabled APIs are not errors", async () => {
    const runner = gcloudRunner();
    const i = new gcp.GcpIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/gcloud" });
    await i.connect({ account: "staging/acme-staging" });
    const out = await i.sync({});
    for (const c of runner.calls) {
      expect(c.args).toContain("--format=json");
      expect(c.args).toContain("--quiet");
      expect(c.args.some((a) => /^(create|delete|deploy|update|set|enable)$/.test(a))).toBe(false);
    }
    const listing = runner.calls.find((c) => cmd(c.args) === "run services list")!;
    expect(listing.args).toEqual(["run", "services", "list", "--project", "acme-staging", "--format=json", "--quiet", "--configuration", "staging"]);
    expect(out.errors).toEqual([]);
    expect(out.resources).toHaveLength(3 + 2 + 2 + 2 + 2);
    expect(gcp.parseGcpAccount("acme-sandbox")).toEqual({ project: "acme-sandbox" });
  });

  test("not logged in: no credentialed accounts → not_connected with the login command", async () => {
    const runner = gcloudRunner({ "auth list": { code: 0, stdout: "[]", stderr: "No credentialed accounts." } });
    const i = new gcp.GcpIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/gcloud" });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "gcloud auth login", loginCommand: "gcloud auth login" });
    expect(i.enabled()).toBe(false);
    await expect(i.sync({})).rejects.toThrow(/not logged in — run: gcloud auth login/);
  });

  test("expired credentials on every listing collapse into one login error", async () => {
    const expired = fail("ERROR: (gcloud.run.services.list) There was a problem refreshing your current auth tokens: Reauthentication failed. Please run:\n  $ gcloud auth login");
    const runner = gcloudRunner(Object.fromEntries(["run services list", "container clusters list", "sql instances list", "functions list", "pubsub topics list", "storage buckets list"].map((k) => [k, expired])));
    const i = new gcp.GcpIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/gcloud" });
    await expect(i.sync({})).rejects.toThrow(/credentials expired or missing — run: gcloud auth login/);
    expect(i.enabled()).toBe(false);
  });

  test("logged in without a project → not_connected with `gcloud config set project`", async () => {
    const runner = gcloudRunner({ "config configurations list": ok([{ is_active: true, name: "default", properties: { core: { account: "me@example.com" } } }]), "projects list": ok([]) });
    const i = new gcp.GcpIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/gcloud" });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "gcloud config set project PROJECT_ID" });
  });
});

// ---- Azure -------------------------------------------------------------------------------

describe("Azure mappers", () => {
  test("web apps + function apps: kind, state, custom hostname url, portal link, region normalised", () => {
    const r = azure.mapWebApps([...(afx.webapps as unknown[]), ...(afx.functionapps as unknown[])]);
    expect(r[0]).toEqual({
      id: "/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/acme-prod/providers/Microsoft.Web/sites/web-app", provider: "azure",
      type: "app", service: "app-service", name: "web-app", region: "westeurope", status: "running", url: "https://www.example.com",
      tags: { "ruah-node": "web", "resource-group": "acme-prod" },
      consoleUrl: "https://portal.azure.com/#resource/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/acme-prod/providers/Microsoft.Web/sites/web-app/overview",
    });
    expect(r[1]).toMatchObject({ name: "old-site", status: "stopped", region: "northeurope", url: "https://old-site.azurewebsites.net" });
    expect(r[2]).toMatchObject({ name: "billing-jobs", type: "function", service: "functionapp" });
  });

  test("container apps, AKS (power state + node count), SQL, Postgres flexible, storage, resource groups", () => {
    expect(azure.mapContainerApps(afx.containerapps)[0]).toMatchObject({ type: "container", status: "running", url: "https://invoices-api.happyhill-1234.westeurope.azurecontainerapps.io", tags: { "ruah:node": "api" } });
    expect(azure.mapAks(afx.aks)[0]).toMatchObject({ type: "kubernetes", service: "aks", status: "running · 5 nodes" });
    expect(azure.mapSqlServers(afx.sqlservers)[0]).toMatchObject({ type: "database", service: "azure-sql", status: "ready" });
    expect(azure.mapPostgresFlexible(afx.postgres)[0]).toMatchObject({ service: "postgres-flexible", status: "stopped", region: "westeurope" });
    expect(azure.mapStorageAccounts(afx.storage)[0]).toMatchObject({ type: "storage", status: "available" });
    expect(azure.mapResourceGroups(afx.groups)[0]).toMatchObject({ type: "other", service: "resource-group", status: "succeeded", tags: { env: "prod" } });
    const json = JSON.stringify([...azure.mapSqlServers(afx.sqlservers), ...azure.mapPostgresFlexible(afx.postgres), ...azure.mapWebApps(afx.webapps)]);
    expect(json).not.toContain("should-not-appear");
    expect(json).not.toContain("SECRETPASSWORD");
  });

  test("garbage maps to nothing; contract-valid", () => {
    for (const m of [azure.mapWebApps, azure.mapContainerApps, azure.mapAks, azure.mapSqlServers, azure.mapStorageAccounts, azure.mapResourceGroups]) {
      expect(m(null)).toEqual([]);
      expect(m([{ name: "no-id" }, 3])).toEqual([]);
    }
    expectValid([...azure.mapWebApps(afx.webapps), ...azure.mapContainerApps(afx.containerapps), ...azure.mapAks(afx.aks), ...azure.mapStorageAccounts(afx.storage)]);
  });

  test("healthOf", () => {
    expect(azure.healthOf("Running")).toBe("healthy");
    expect(azure.healthOf("running · 5 nodes")).toBe("healthy");
    expect(azure.healthOf("Succeeded")).toBe("healthy");
    expect(azure.healthOf("Updating")).toBe("deploying");
    expect(azure.healthOf("Degraded")).toBe("degraded");
    expect(azure.healthOf("Stopped")).toBe("down");
    expect(azure.healthOf("Failed")).toBe("down");
    expect(azure.healthOf("")).toBe("unknown");
  });
});

describe("Azure integration", () => {
  test("info: subscriptions as accounts, default one selected", async () => {
    const i = new azure.AzureIntegration({ runner: azRunner(), settings: new SettingsStore(tempDir()), bin: () => "/fake/az" });
    const info = await i.info();
    expect(info).toMatchObject({ status: "connected", detail: "me@example.com · subscription Acme Production (default)", loginCommand: "az login", installCommand: "brew install azure-cli" });
    expect(info.accounts).toEqual([
      { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", label: "Acme Production (default)" },
      { id: "ffffffff-0000-1111-2222-333333333333", label: "Acme Dev — disabled" },
    ]);
  });

  test("sync: --subscription, -o json, missing extension becomes an actionable per-service error", async () => {
    const runner = azRunner();
    const i = new azure.AzureIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/az" });
    const out = await i.sync({ account: "ffffffff-0000-1111-2222-333333333333" });
    for (const c of runner.calls.filter((x) => cmd(x.args) !== "account list")) {
      expect(c.args).toEqual(expect.arrayContaining(["--subscription", "ffffffff-0000-1111-2222-333333333333", "-o", "json", "--only-show-errors"]));
      expect(c.args).toContain("list");
    }
    expect(out.errors).toEqual(["container apps: needs an az extension — run: az extension add --name containerapp"]);
    expect(out.resources).toHaveLength(1 + 2 + 1 + 1 + 1 + 1 + 1);
    await expect(i.sync({ account: "--debug" })).rejects.toThrow(/invalid Azure subscription/);
  });

  test("not logged in: empty profile → not_connected with `az login`; quiet afterwards", async () => {
    const i = new azure.AzureIntegration({ runner: azRunner({ "account list": { code: 0, stdout: "[]", stderr: 'WARNING: Please run "az login" to access your accounts.' } }), settings: new SettingsStore(tempDir()), bin: () => "/fake/az" });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "az login" });
    expect(i.enabled()).toBe(false);
  });
});

// ---- Cloudflare --------------------------------------------------------------------------

describe("Cloudflare parsing", () => {
  const ctx = { account: "0123456789abcdef0123456789abcdef" };

  test("whoami: accounts from the table, e-mail, logged-out text", () => {
    expect(cf.parseWhoami(text(wfx.whoami))).toEqual({
      loggedIn: true, email: "me@example.com",
      accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Me@example.com's Account" }, { id: "fedcba9876543210fedcba9876543210", name: "Acme Inc" }],
    });
    expect(cf.parseWhoami(text(wfx.whoamiLoggedOut))).toEqual({ loggedIn: false, accounts: [] });
    expect(cf.parseWhoami(JSON.stringify({ loggedIn: true, email: "a@b.c", accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "X" }] })).accounts).toHaveLength(1);
  });

  test("text tables and banner-prefixed JSON", () => {
    expect(parseTextTable(text(wfx.queues)).map((r) => r.Name)).toEqual(["events-bus", "dead-letter"]);
    expect(looseJson(text(wfx.kv))).toEqual([{ id: "0f2ac74b498b48028cb68387c421e279", title: "SESSIONS", supports_url_encoding: true }]);
  });

  test("D1, KV, R2 (text), Queues (table), Pages (JSON rows or table) with latest deployment", () => {
    expect(cf.mapD1(wfx.d1, ctx)[0]).toEqual({
      id: "cf:d1:5c1d2e3f-0000-4000-8000-000000000001", provider: "cloudflare", type: "database", service: "d1", name: "invoices-db",
      consoleUrl: "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/d1/databases/5c1d2e3f-0000-4000-8000-000000000001",
    });
    expect(cf.mapKv(looseJson(text(wfx.kv)), ctx)[0]).toMatchObject({ name: "SESSIONS", service: "kv", type: "storage" });
    expect(cf.mapR2(text(wfx.r2), ctx).map((b) => b.name)).toEqual(["acme-assets", "acme-backups"]);
    expect(cf.mapR2(JSON.stringify([{ name: "old-style", creation_date: "x" }]), ctx).map((b) => b.name)).toEqual(["old-style"]);
    expect(cf.mapQueues(text(wfx.queues), ctx).map((q) => [q.name, q.status])).toEqual([["events-bus", "active"], ["dead-letter", "no consumers"]]);
    const latest = new Map([["web-app", cf.latestPagesDeployment(JSON.stringify(wfx.pagesDeploymentsWeb))!]]);
    expect(latest.get("web-app")).toEqual({ status: "deployed", url: "https://a1c2d3e4.web-app-7x9.pages.dev", environment: "production" });
    expect(cf.mapPagesProjects(JSON.stringify(wfx.pagesProjects), ctx, latest)[0]).toMatchObject({ name: "web-app", type: "app", service: "pages", status: "deployed", url: "https://www.example.com" });
    expect(cf.mapPagesProjects(text(wfx.pagesProjectsTable), ctx)[0]).toMatchObject({ name: "web-app", url: "https://www.example.com" });
    expect(cf.pagesDeploymentState("Building")).toBe("deploying");
    expect(cf.pagesDeploymentState("Failure")).toBe("failed");
    expect(cf.dashUrl(undefined, "pages/view/x")).toBe("https://dash.cloudflare.com/?to=/:account/pages/view/x");
  });

  test("wrangler.toml: name, route tables + strings, [env.*] names and routes; vars never read", () => {
    const workers = cf.workersFromConfig(text(wfx.wranglerToml), "wrangler.toml");
    expect(workers).toEqual([
      { name: "invoices-api", routes: ["api.example.com/*", "api.example.org/v1/*"] },
      { name: "invoices-api-staging", routes: ["staging-api.example.com/*"], environment: "staging" },
      { name: "invoices-preview", routes: ["preview.example.com/*"], environment: "preview" },
    ]);
    expect(JSON.stringify(workers)).not.toContain("should-not-appear");
  });

  test("wrangler.jsonc: comments and trailing commas", () => {
    expect(cf.workersFromConfig(text(wfx.wranglerJsonc), "wrangler.jsonc")).toEqual([
      { name: "cron-worker", routes: [] },
      { name: "cron-worker-production", routes: ["cron.example.com/*"], environment: "production" },
    ]);
    expect(cf.routeUrl("api.example.org/v1/*")).toBe("https://api.example.org/v1");
    expect(cf.routeUrl("*.example.com/*")).toBeUndefined();
    expect(cf.latestWorkerDeployment(wfx.deploymentsApi)).toBe("2024-09-20T10:00:00.000000Z");
  });

  test("healthOf", () => {
    expect(cf.healthOf("deployed")).toBe("healthy");
    expect(cf.healthOf("success")).toBe("healthy");
    expect(cf.healthOf("deploying")).toBe("deploying");
    expect(cf.healthOf("no consumers")).toBe("degraded");
    expect(cf.healthOf("failed")).toBe("down");
    expect(cf.healthOf(null)).toBe("unknown");
  });
});

describe("Cloudflare integration", () => {
  test("sync: account via CLOUDFLARE_ACCOUNT_ID from a neutral cwd; Workers from the project's wrangler files", async () => {
    const root = tempDir();
    writeFileSync(join(root, "wrangler.toml"), text(wfx.wranglerToml));
    mkdirSync(join(root, "workers", "cron"), { recursive: true });
    writeFileSync(join(root, "workers", "cron", "wrangler.jsonc"), text(wfx.wranglerJsonc));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "wrangler.toml"), 'name = "not-mine"\n');
    expect(cf.findWranglerConfigs(root).map((f) => f.slice(root.length))).toEqual(["/wrangler.toml", "/workers/cron/wrangler.jsonc"]);

    const runner = wranglerRunner();
    const settings = new SettingsStore(tempDir());
    const i = new cf.CloudflareIntegration({ runner, settings, bin: () => "/fake/wrangler", env: {} });
    await i.connect({ account: "fedcba9876543210fedcba9876543210" });
    const out = await i.sync({ project: { root } });
    expect(out.errors).toEqual([]);
    for (const c of runner.calls.filter((x) => cmd(x.args) !== "whoami")) {
      expect(c.options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe("fedcba9876543210fedcba9876543210");
      expect(c.options?.cwd).toBe(tmpdir());
    }
    const byService = (s: string): string[] => out.resources.filter((r) => r.service === s).map((r) => r.name);
    expect(byService("workers")).toEqual(["invoices-api"]); // the others are declared but not deployed
    expect(byService("pages")).toEqual(["web-app", "docs"]);
    expect(out.resources.find((r) => r.name === "docs")?.status).toBe("deploying");
    const worker = out.resources.find((r) => r.service === "workers")!;
    expect(worker).toMatchObject({ url: "https://api.example.com", tags: { routes: "api.example.com/*, api.example.org/v1/*", "deployed-at": "2024-09-20T10:00:00.000000Z" } });
    expect(out.resources).toHaveLength(1 + 1 + 2 + 2 + 2 + 1);
    expectValid(out.resources);
  });

  test("no project → no Workers, no config reads; older wrangler without --json falls back to tables", async () => {
    const runner = wranglerRunner({ "pages project list": fail("✘ [ERROR] Unknown argument: json") });
    // An older wrangler: `pages project list --json` is rejected, the plain table works.
    const wrapped: Runner = async (file, args, options) => {
      if (cmd(args) === "pages project list" && !args.includes("--json")) return ok(text(wfx.pagesProjectsTable));
      return runner(file, args, options);
    };
    const i = new cf.CloudflareIntegration({ runner: wrapped, settings: new SettingsStore(tempDir()), bin: () => "/fake/wrangler", env: {} });
    const out = await i.sync({});
    expect(out.resources.some((r) => r.service === "workers")).toBe(false);
    expect(out.resources.filter((r) => r.service === "pages").map((r) => r.name)).toEqual(["web-app"]);
    expect(runner.calls.some((c) => cmd(c.args) === "deployments list")).toBe(false);
  });

  test("not logged in → not_connected with `wrangler login`, sync refuses with one message", async () => {
    const i = new cf.CloudflareIntegration({ runner: wranglerRunner({ whoami: ok(text(wfx.whoamiLoggedOut)) }), settings: new SettingsStore(tempDir()), bin: () => "/fake/wrangler", env: {} });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "wrangler login", installCommand: "brew install cloudflare-wrangler" });
    await expect(i.sync({})).rejects.toThrow(/not logged in — run: wrangler login/);
  });
});

// ---- Railway -----------------------------------------------------------------------------

describe("Railway", () => {
  test("list --json: one resource per service (environments as a tag), plugins as databases", () => {
    const projects = railway.railwayProjects(rfx.list);
    expect(projects.map((p) => railway.workspaceOf(p))).toEqual([{ id: "ws-acme", name: "Acme Inc" }, { id: "personal", name: "Personal" }]);
    const r = projects.flatMap(railway.mapRailwayProject);
    expect(r.map((x) => [x.name, x.type, x.service, x.tags])).toEqual([
      ["invoices-api", "app", "railway/service", { project: "acme", environments: "production, staging" }],
      ["Postgres", "database", "railway/postgres", { project: "acme", environments: "production, staging" }],
      ["bot", "app", "railway/service", { project: "side-project", environments: "production" }],
      ["Redis", "cache", "railway/redis", { project: "side-project" }],
    ]);
    expect(railway.railwayProjects({ projects: { edges: [{ node: { id: "p", name: "n" } }] } })).toHaveLength(1);
  });

  test("status --json: service × environment with latest deployment status, domain url, console link", () => {
    const r = railway.mapRailwayProject(rfx.status as Record<string, unknown>);
    expect(r[0]).toEqual({
      id: "railway:service:svc-api:env-prod", provider: "railway", type: "app", service: "railway/service", name: "invoices-api",
      region: "europe-west4-drams3a", status: "success", url: "https://api.example.com", tags: { project: "acme", environment: "production" },
      consoleUrl: "https://railway.com/project/prj-1111/service/svc-api?environmentId=env-prod",
    });
    expect(r[1]).toMatchObject({ status: "crashed", tags: { environment: "staging" }, url: "https://invoices-api-staging.up.railway.app" });
    expect(r[2]).toMatchObject({ name: "Postgres", type: "database", service: "railway/postgres", status: "success" });
    expectValid(r);
  });

  test("sync: linked project's status merged in (cwd = project root); workspace filter", async () => {
    const runner = railwayRunner();
    const i = new railway.RailwayIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/railway" });
    const info = await i.info();
    expect(info).toMatchObject({ status: "connected", detail: "jane@example.com · all workspaces" });
    expect(info.accounts).toEqual([{ id: "ws-acme", label: "Acme Inc" }, { id: "personal", label: "Personal" }]);
    const root = tempDir();
    const out = await i.sync({ account: "ws-acme", project: { root } });
    expect(out.errors).toEqual([]);
    expect(out.resources.map((r) => `${r.name}:${r.status ?? "-"}`)).toEqual(["invoices-api:success", "invoices-api:crashed", "Postgres:success"]);
    expect(runner.calls.find((c) => cmd(c.args) === "status")?.options?.cwd).toBe(root);
    const standalone = await i.sync({});
    expect(standalone.resources).toHaveLength(4); // no project → no status call result, list only
  });

  test("not logged in → not_connected with `railway login`", async () => {
    const i = new railway.RailwayIntegration({ runner: railwayRunner({ whoami: fail("Unauthorized. Please login with `railway login`") }), settings: new SettingsStore(tempDir()), bin: () => "/fake/railway" });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "railway login", installCommand: "brew install railway" });
  });

  test("healthOf", () => {
    expect(railway.healthOf("SUCCESS")).toBe("healthy");
    expect(railway.healthOf("sleeping")).toBe("healthy");
    expect(railway.healthOf("BUILDING")).toBe("deploying");
    expect(railway.healthOf("crashed")).toBe("down");
    expect(railway.healthOf("FAILED")).toBe("down");
    expect(railway.healthOf("SKIPPED")).toBe("degraded");
    expect(railway.healthOf(undefined)).toBe("unknown");
  });
});

// ---- Fly.io ------------------------------------------------------------------------------

describe("Fly.io", () => {
  test("orgs in both CLI shapes; machines summarized (destroyed ignored)", () => {
    expect(fly.parseOrgs(ffx.orgs)).toEqual([{ slug: "personal", name: "Jane Doe" }, { slug: "acme", name: "Acme Inc" }]);
    expect(fly.parseOrgs(ffx.orgsArray).map((o) => o.slug)).toEqual(["acme", "personal"]);
    expect(fly.summarizeMachines(ffx.machinesApi)).toEqual({ total: 3, started: 2, stopped: 1, regions: ["fra", "iad"] });
    expect(fly.appStatus("deployed", fly.summarizeMachines(ffx.machinesApi))).toBe("deployed · 2/3 machines started · fra, iad");
  });

  test("sync: apps with machine summary + url, postgres apps as databases, volumes; unknown mpg command is quiet", async () => {
    const runner = flyRunner();
    const i = new fly.FlyIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/flyctl" });
    const info = await i.info();
    expect(info).toMatchObject({ status: "connected", detail: "me@example.com · all orgs", loginCommand: "fly auth login", installCommand: "brew install flyctl" });
    expect(info.accounts?.map((a) => a.id)).toEqual(["personal", "acme"]);
    const out = await i.sync({ account: "acme" });
    expect(out.errors).toEqual([]);
    for (const c of runner.calls) {
      expect(c.args).toContain("--json");
      expect(["list", "whoami"]).toContain(c.args[1]);
    }
    expect(runner.calls.find((c) => cmd(c.args) === "apps list")?.args).toEqual(["apps", "list", "--json", "--org", "acme"]);
    const api = out.resources.find((r) => r.name === "invoices-api")!;
    expect(api).toEqual({
      id: "fly:app:invoices-api", provider: "fly", type: "app", service: "fly/app", name: "invoices-api", region: "fra",
      status: "deployed · 2/3 machines started · fra, iad", url: "https://invoices-api.fly.dev", tags: { org: "acme" }, consoleUrl: "https://fly.io/apps/invoices-api",
    });
    expect(out.resources.find((r) => r.name === "acme-db")).toMatchObject({ type: "database", service: "fly/postgres" });
    expect(out.resources.find((r) => r.service === "fly/volume")).toMatchObject({ name: "data", status: "created · 10 GB", region: "fra", tags: { app: "invoices-api" } });
    expect(out.resources.some((r) => r.name === "old-worker")).toBe(false); // other org
    expect(out.resources).toHaveLength(3);
    expectValid(out.resources);
  });

  test("managed postgres (newer flyctl)", () => {
    expect(fly.mapManagedPostgres(ffx.mpg)[0]).toMatchObject({ id: "fly:mpg:mpg-abc123", type: "database", service: "fly/managed-postgres", status: "ready", region: "iad" });
  });

  test("falls back to `fly` when only that binary exists; not logged in → `fly auth login`", async () => {
    const runner = flyRunner({ "auth whoami": fail("Error: no access token available. Please login with 'flyctl auth login'") });
    const i = new fly.FlyIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/fly" });
    expect(await i.info()).toMatchObject({ status: "not_connected", setupHint: "fly auth login" });
    expect(i.enabled()).toBe(false);
  });

  test("healthOf", () => {
    expect(fly.healthOf("deployed · 2/3 machines started · fra")).toBe("healthy");
    expect(fly.healthOf("started", "machine")).toBe("healthy");
    expect(fly.healthOf("created", "machine")).toBe("deploying");
    expect(fly.healthOf("created", "volume")).toBe("healthy");
    expect(fly.healthOf("pending")).toBe("deploying");
    expect(fly.healthOf("suspended")).toBe("down");
    expect(fly.healthOf("stopped", "machine")).toBe("down");
    expect(fly.healthOf("")).toBe("unknown");
  });
});

// ---- standalone, not installed, quiet ------------------------------------------------------

describe("batch B adapters standalone (no daemon, no project)", () => {
  const runners: Record<string, () => ReturnType<typeof fakeRunner>> = {
    gcp: gcloudRunner, azure: azRunner, cloudflare: wranglerRunner, railway: railwayRunner, fly: flyRunner,
  };

  test("each adapter works from the factory with only a fake exec + settings", async () => {
    for (const id of Object.keys(runners)) {
      const runner = runners[id]!();
      const [adapter] = cloudBatchB({ runner, settings: new SettingsStore(tempDir()), bin: () => `/fake/${id}`, env: {} }).filter((a) => a.id === id);
      expect(adapter, id).toBeDefined();
      const info = await adapter!.info(null);
      expect(info.status, id).toBe("connected");
      expect(adapter!.enabled(), id).toBe(true);
      const out = await adapter!.sync({});
      expect(out.resources.length, id).toBeGreaterThan(0);
      expect(out.resources.every((r) => r.provider === id), id).toBe(true);
      expectValid(out.resources);
    }
  });

  test("registry wiring: the five ids, registered once", () => {
    const registry = registerCloudBatchB(new IntegrationRegistry(), { runner: fakeRunner(() => ok([])), settings: new SettingsStore(tempDir()), bin: () => undefined });
    expect(registry.cloud().map((c) => [c.id, c.name])).toEqual([
      ["gcp", "Google Cloud"], ["azure", "Azure"], ["cloudflare", "Cloudflare"], ["railway", "Railway"], ["fly", "Fly.io"],
    ]);
    expect(() => registerCloudBatchB(registry, { runner: fakeRunner(() => ok([])), settings: new SettingsStore(tempDir()) })).toThrow(/already registered/);
  });

  test("not installed: cli_missing with the exact install + login commands, zero CLI calls, disabled for sync-all", async () => {
    const runner = fakeRunner(() => ok([]));
    const expected: Record<string, [string, string]> = {
      gcp: ["brew install --cask gcloud-cli", "gcloud auth login"],
      azure: ["brew install azure-cli", "az login"],
      cloudflare: ["brew install cloudflare-wrangler", "wrangler login"],
      railway: ["brew install railway", "railway login"],
      fly: ["brew install flyctl", "fly auth login"],
    };
    for (const adapter of cloudBatchB({ runner, settings: new SettingsStore(tempDir()), bin: () => undefined })) {
      const [install, login] = expected[adapter.id]!;
      const info = await adapter.info(null);
      expect(info).toMatchObject({ status: "cli_missing", installCommand: install, loginCommand: login, setupHint: `${install} && ${login}` });
      expect(info.detail).toMatch(/is not installed$/);
      expect(IntegrationInfoSchema.safeParse(info).success).toBe(true);
      expect(adapter.enabled()).toBe(false);
      await expect(adapter.sync({})).rejects.toThrow(/not installed/);
    }
    expect(runner.calls).toEqual([]);
  });

  test("a CLI that vanished between checks (ENOENT) reads as cli_missing, not an error", async () => {
    const runner: Runner = () => Promise.reject(new CliError("gcloud is not installed", "missing"));
    const i = new gcp.GcpIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/gcloud" });
    expect((await i.info()).status).toBe("cli_missing");
  });

  test("disconnect: no CLI calls while disabled, sync-all skips it; connect re-enables", async () => {
    const runner = azRunner();
    const i: CliCloudIntegration = new azure.AzureIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/az" });
    const off = await i.disconnect();
    expect(off).toMatchObject({ status: "not_connected", detail: "disconnected in Ruah (az login unchanged)" });
    expect(runner.calls).toEqual([]);
    expect(i.enabled()).toBe(false);
    const on = await i.connect({});
    expect(on.status).toBe("connected");
    expect(i.enabled()).toBe(true);
    await expect(i.connect({ account: "11111111-1111-1111-1111-111111111111" })).rejects.toThrow(/unknown Azure subscription/);
  });
});
