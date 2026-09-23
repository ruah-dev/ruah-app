import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Architecture } from "../src/contracts/architecture.js";
import { CloudResourceSchema } from "../src/contracts/integrations.js";
import * as awsMod from "../src/integrations/cloud/aws.js";
import * as doMod from "../src/integrations/cloud/digitalocean.js";
import type { RunResult, Runner } from "../src/integrations/exec.js";
import { IntegrationRegistry, IntegrationsService } from "../src/integrations/index.js";
import { linkResources, matchNodeByName, nodeIdFromTags, normalizeName } from "../src/integrations/linking.js";
import { MemorySecretStore } from "../src/integrations/keychain.js";
import { projectIdOf, SettingsStore } from "../src/integrations/store.js";

const doFx = JSON.parse(readFileSync(new URL("./fixtures/integrations/doctl.json", import.meta.url), "utf8")) as Record<string, unknown>;
const awsFx = JSON.parse(readFileSync(new URL("./fixtures/integrations/aws.json", import.meta.url), "utf8")) as Record<string, unknown>;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-int-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Assembled at runtime so the source never contains a token-shaped string.
const FAKE_DO_TOKEN = ["dop", "_v1_", "0123456789abcdef".repeat(4)].join("");
const ok = (value: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

function fakeRunner(handler: (args: readonly string[]) => RunResult): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((_file: string, args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve(handler(args));
  }) as Runner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

const arch: Architecture = {
  version: 1,
  name: "acme",
  nodes: [
    { id: "api", type: "service", name: "invoices-api" },
    { id: "web", type: "frontend", name: "web-app" },
    { id: "gateway", type: "gateway", name: "api-gateway" },
    { id: "db", type: "datastore", name: "postgres" },
    { id: "bus", type: "queue", name: "events-bus" },
  ],
  edges: [],
  workflows: [],
};

describe("DigitalOcean mappers", () => {
  test("droplets: DO URN, region slug, string tags, console URL; items without id skipped", () => {
    const r = doMod.mapDroplets(doFx.droplets);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      id: "do:droplet:101", provider: "digitalocean", type: "compute", service: "droplet", name: "invoices-api",
      region: "fra1", status: "active", tags: { prod: "", "ruah:node:api": "" }, consoleUrl: "https://cloud.digitalocean.com/droplets/101",
    });
    expect(JSON.stringify(r)).not.toContain("203.0.113.10");
  });

  test("apps: spec name, deployment phase lower-cased", () => {
    const r = doMod.mapApps(doFx.apps);
    expect(r.map((a) => [a.id, a.name, a.status, a.region])).toEqual([
      ["do:app:a1b2c3", "web-app", "active", "fra"],
      ["do:app:d4e5f6", "Billing_Jobs", "building", undefined],
    ]);
  });

  test("databases: engine picks the type; connection secrets never copied", () => {
    const r = doMod.mapDatabases(doFx.databases);
    expect(r.map((d) => [d.type, d.service])).toEqual([
      ["database", "databases/pg"],
      ["cache", "databases/valkey"],
      ["queue", "databases/kafka"],
    ]);
    expect(r[0]?.tags).toEqual({ tier: "data" });
    expect(JSON.stringify(r)).not.toContain("SECRETPASSWORD");
  });

  test("kubernetes, load balancers, domains, volumes, cdn, spaces, functions, registry", () => {
    expect(doMod.mapKubernetes(doFx.kubernetes)[0]).toMatchObject({ type: "kubernetes", status: "running", tags: { k8s: "", "ruah-node": "api" } });
    expect(doMod.mapLoadBalancers(doFx.loadBalancers)[0]).toMatchObject({ type: "loadbalancer", region: "fra1", tags: { web: "" } });
    expect(doMod.mapDomains(doFx.domains)[0]).toMatchObject({ id: "do:domain:example.com", type: "dns" });
    expect(doMod.mapVolumes(doFx.volumes)[0]).toMatchObject({ type: "storage", service: "volumes" });
    expect(doMod.mapCdns(doFx.cdns)).toHaveLength(2);
    expect(doMod.spacesFromCdns(doFx.cdns)).toEqual([
      expect.objectContaining({ id: "do:space:fra1:assets-bucket", service: "spaces", name: "assets-bucket", region: "fra1" }),
    ]);
    const fn = doMod.mapFunctions(doFx.functions);
    expect(fn[0]).toMatchObject({ id: "do:functions:fn-ns-1", type: "function", name: "hooks" });
    expect(JSON.stringify(fn)).not.toContain("SUPERSECRETKEY");
    expect(doMod.mapRegistry(doFx.registry)[0]).toMatchObject({ id: "do:registry:acme", service: "registry" });
    expect(doMod.mapRegistry({})).toEqual([]);
  });

  test("garbage input maps to nothing instead of throwing", () => {
    for (const mapper of [doMod.mapDroplets, doMod.mapApps, doMod.mapDatabases, doMod.mapKubernetes, doMod.mapCdns, doMod.mapFunctions]) {
      expect(mapper(null)).toEqual([]);
      expect(mapper({ not: "a list" })).toEqual([]);
      expect(mapper([1, "x", null])).toEqual([]);
    }
  });

  test("every mapped resource matches the contract schema", () => {
    const all = [
      ...doMod.mapDroplets(doFx.droplets), ...doMod.mapApps(doFx.apps), ...doMod.mapDatabases(doFx.databases),
      ...doMod.mapKubernetes(doFx.kubernetes), ...doMod.mapLoadBalancers(doFx.loadBalancers), ...doMod.mapDomains(doFx.domains),
      ...doMod.mapVolumes(doFx.volumes), ...doMod.mapCdns(doFx.cdns), ...doMod.mapFunctions(doFx.functions), ...doMod.mapRegistry(doFx.registry),
    ];
    for (const r of all) expect(CloudResourceSchema.safeParse(r).success).toBe(true);
  });
});

describe("DigitalOcean integration", () => {
  function doRunner(): ReturnType<typeof fakeRunner> {
    return fakeRunner((args) => {
      const firstFlag = args.findIndex((a) => a.startsWith("-"));
      const cmd = (firstFlag === -1 ? args : args.slice(0, firstFlag)).join(" ");
      switch (cmd) {
        case "auth list": return ok([{ name: "default", current: true }, { name: "staging", current: false }]);
        case "account get": return ok({ email: "me@example.com", status: "active", team: { name: "Acme" } });
        case "compute droplet list": return ok(doFx.droplets);
        case "apps list": return ok(doFx.apps);
        case "databases list": return ok(doFx.databases);
        case "kubernetes cluster list": return ok(doFx.kubernetes);
        case "compute load-balancer list": return fail(`Error: GET https://api.digitalocean.com/v2/load_balancers: 403 Bearer ${FAKE_DO_TOKEN} forbidden`);
        case "compute domain list": return ok(doFx.domains);
        case "compute volume list": return ok([]);
        case "compute cdn list": return ok(doFx.cdns);
        case "serverless namespaces list": return ok(doFx.functions);
        case "registry get": return { code: 1, stdout: JSON.stringify({ errors: [{ detail: "GET …/v2/registry: 404 registry does not exist" }] }), stderr: "" };
        default: return fail(`unexpected: ${cmd}`);
      }
    });
  }

  test("info: connected with the current context; contexts listed as accounts", async () => {
    const runner = doRunner();
    const i = new doMod.DigitalOceanIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/doctl" });
    const info = await i.info();
    expect(info).toMatchObject({ id: "digitalocean", family: "cloud", status: "connected", detail: "doctl context: default · team Acme" });
    expect(info.accounts?.map((a) => a.id)).toEqual(["default", "staging"]);
    expect(runner.calls.find((c) => c[0] === "account")).toEqual(["account", "get", "-o", "json", "--context", "default"]);
  });

  test("info: cli_missing with setup hint when doctl is absent", async () => {
    const i = new doMod.DigitalOceanIntegration({ runner: fakeRunner(() => ok([])), settings: new SettingsStore(tempDir()), bin: () => undefined });
    expect(await i.info()).toMatchObject({ status: "cli_missing", setupHint: "brew install doctl && doctl auth init" });
  });

  test("connect picks a context (validated), disconnect disables without touching doctl", async () => {
    const runner = doRunner();
    const settings = new SettingsStore(tempDir());
    const i = new doMod.DigitalOceanIntegration({ runner, settings, bin: () => "/fake/doctl" });
    await expect(i.connect({ account: "nope" })).rejects.toThrow(/unknown doctl context/);
    await expect(i.connect({ account: "--config=/etc/x" })).rejects.toThrow(/invalid doctl context/);
    await i.connect({ account: "staging" });
    expect(settings.get("digitalocean")).toEqual({ account: "staging" });
    const off = await i.disconnect();
    expect(off.status).toBe("not_connected");
    expect(i.enabled()).toBe(false);
    expect(runner.calls.some((c) => c.includes("logout") || c.includes("remove"))).toBe(false);
  });

  test("sync: only list/get commands, JSON output; per-service errors redacted; missing registry is not an error", async () => {
    const runner = doRunner();
    const i = new doMod.DigitalOceanIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/doctl" });
    const out = await i.sync({});
    for (const call of runner.calls) {
      expect(["list", "get"]).toContain(call.find((a) => a === "list" || a === "get"));
      expect(call).toContain("json");
    }
    expect(out.resources.length).toBe(2 + 2 + 3 + 1 + 1 + 2 + 1 + 1); // droplets apps dbs k8s domains cdn spaces functions (no registry)
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/^load balancers: .*403/);
    expect(out.errors[0]).not.toContain("dop_v1_");
  });
});

describe("AWS mappers", () => {
  const ctx = { region: "eu-central-1" };

  test("ec2: ARN from owner, Name tag as name, tags record", () => {
    const r = awsMod.mapEc2(awsFx.ec2, ctx);
    expect(r[0]).toEqual({
      id: "arn:aws:ec2:eu-central-1:123456789012:instance/i-0abc", provider: "aws", type: "compute", service: "ec2", name: "invoices-api",
      region: "eu-central-1", status: "running", tags: { Name: "invoices-api", "ruah:node": "api" },
      consoleUrl: "https://eu-central-1.console.aws.amazon.com/ec2/home?region=eu-central-1#InstanceDetails:instanceId=i-0abc",
    });
    expect(r[1]?.name).toBe("i-0def");
    expect(JSON.stringify(r)).not.toContain("198.51.100.7");
  });

  test("ecs, lambda, rds, elasticache", () => {
    expect(awsMod.mapEcsClusters(awsFx.ecsClusters, ctx)[0]).toMatchObject({ type: "container", service: "ecs-cluster", name: "prod", status: "active", tags: { team: "core" } });
    expect(awsMod.mapEcsServices(awsFx.ecsServices, ctx)[0]).toMatchObject({
      type: "container", service: "ecs", name: "web-app",
      consoleUrl: "https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/prod/services/web-app?region=eu-central-1",
    });
    const lambda = awsMod.mapLambda(awsFx.lambda, ctx);
    expect(lambda[0]).toMatchObject({ id: "arn:aws:lambda:eu-central-1:123456789012:function:resize-image", type: "function" });
    expect(JSON.stringify(lambda)).not.toContain("should-not-appear");
    expect(awsMod.mapRds(awsFx.rds, ctx)[0]).toMatchObject({ type: "database", service: "rds/postgres", name: "postgres", status: "available", tags: { env: "prod" } });
    expect(awsMod.mapElastiCache(awsFx.elasticache, ctx)[0]).toMatchObject({ type: "cache", service: "elasticache/redis", name: "sessions" });
  });

  test("s3, sqs, sns, api gateway v1/v2, elbv2, cloudfront, route53", () => {
    expect(awsMod.mapS3(awsFx.s3, ctx)[0]).toMatchObject({ id: "arn:aws:s3:::acme-uploads", type: "storage", region: "eu-central-1" });
    expect(awsMod.mapSqs(awsFx.sqs, ctx)[0]).toMatchObject({ id: "arn:aws:sqs:eu-central-1:123456789012:events-bus", name: "events-bus", type: "queue" });
    expect(awsMod.mapSns(awsFx.sns, ctx)[0]).toMatchObject({ name: "invoice-created", service: "sns" });
    expect(awsMod.mapApiGatewayRest(awsFx.apigateway, ctx)[0]).toMatchObject({ id: "arn:aws:apigateway:eu-central-1::/restapis/abc123", type: "gateway", tags: { "ruah-node": "gateway" } });
    expect(awsMod.mapApiGatewayV2(awsFx.apigatewayv2, ctx)[0]).toMatchObject({ service: "apigatewayv2/websocket", name: "ws-api" });
    expect(awsMod.mapElbv2(awsFx.elbv2, ctx)[0]).toMatchObject({ type: "loadbalancer", service: "elbv2/application", status: "active" });
    expect(awsMod.mapCloudFront(awsFx.cloudfront, ctx)[0]).toMatchObject({ type: "cdn", name: "cdn.example.com", status: "deployed" });
    expect(awsMod.mapRoute53(awsFx.route53, ctx)[0]).toMatchObject({ id: "arn:aws:route53:::hostedzone/Z123", name: "example.com", type: "dns" });
  });

  test("garbage input maps to nothing", () => {
    for (const mapper of [awsMod.mapEc2, awsMod.mapLambda, awsMod.mapRds, awsMod.mapS3, awsMod.mapSqs, awsMod.mapCloudFront, awsMod.mapRoute53]) {
      expect(mapper(null, ctx)).toEqual([]);
      expect(mapper([], ctx)).toEqual([]);
      expect(mapper({ Reservations: "x", Functions: [null], Buckets: [1] }, ctx)).toEqual([]);
    }
  });
});

describe("AWS integration", () => {
  function awsRunner(): ReturnType<typeof fakeRunner> {
    return fakeRunner((args) => {
      const key = `${args[0] ?? ""} ${args[1] ?? ""}`;
      switch (key) {
        case "configure list-profiles": return { code: 0, stdout: "default\nprod-sso\n", stderr: "" };
        case "configure get": return { code: 0, stdout: "eu-central-1\n", stderr: "" };
        case "sts get-caller-identity": return ok({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/me" });
        case "ec2 describe-instances": return ok(awsFx.ec2);
        case "lambda list-functions": return ok(awsFx.lambda);
        case "rds describe-db-instances": return fail("An error occurred (AccessDenied) aws_secret_access_key=abcd1234SECRET");
        case "elasticache describe-cache-clusters": return ok(awsFx.elasticache);
        case "sqs list-queues": return { code: 0, stdout: "", stderr: "" }; // no queues → empty output
        case "sns list-topics": return ok(awsFx.sns);
        case "apigateway get-rest-apis": return ok(awsFx.apigateway);
        case "apigatewayv2 get-apis": return ok(awsFx.apigatewayv2);
        case "elbv2 describe-load-balancers": return ok(awsFx.elbv2);
        case "s3api list-buckets": return ok(awsFx.s3);
        case "cloudfront list-distributions": return ok(awsFx.cloudfront);
        case "route53 list-hosted-zones": return ok(awsFx.route53);
        case "ecs list-clusters": return ok({ clusterArns: ["arn:aws:ecs:eu-central-1:123456789012:cluster/prod"] });
        case "ecs describe-clusters": return ok(awsFx.ecsClusters);
        case "ecs list-services": return ok({ serviceArns: ["arn:aws:ecs:eu-central-1:123456789012:service/prod/web-app"] });
        case "ecs describe-services": return ok(awsFx.ecsServices);
        default: return fail(`unexpected ${key}`);
      }
    });
  }

  test("cli_missing with the install hint when aws is absent", async () => {
    const i = new awsMod.AwsIntegration({ runner: fakeRunner(() => ok({})), settings: new SettingsStore(tempDir()), bin: () => undefined });
    expect(await i.info()).toMatchObject({ id: "aws", status: "cli_missing", detail: "AWS CLI not installed", setupHint: "brew install awscli && aws configure sso" });
  });

  test("info: profiles as accounts, identity + region in detail", async () => {
    const i = new awsMod.AwsIntegration({ runner: awsRunner(), settings: new SettingsStore(tempDir()), bin: () => "/fake/aws", env: {} });
    const info = await i.info();
    expect(info).toMatchObject({ status: "connected", detail: "profile default · account 123456789012 · eu-central-1" });
    expect(info.accounts?.map((a) => a.id)).toEqual(["default", "prod-sso"]);
  });

  test("info: expired SSO → error with `aws sso login` hint", async () => {
    const runner = fakeRunner((args) =>
      args[0] === "configure" ? { code: 0, stdout: "prod-sso\n", stderr: "" } : fail("Error when retrieving token from sso: Token has expired and refresh failed"),
    );
    const i = new awsMod.AwsIntegration({ runner, settings: new SettingsStore(tempDir()), bin: () => "/fake/aws", env: {} });
    expect(await i.info()).toMatchObject({ status: "error", setupHint: "aws sso login --profile prod-sso" });
  });

  test("sync: read-only describe/list calls with --profile/--region, partial failures redacted", async () => {
    const runner = awsRunner();
    const settings = new SettingsStore(tempDir());
    const i = new awsMod.AwsIntegration({ runner, settings, bin: () => "/fake/aws", env: {} });
    await i.connect({ account: "prod-sso", regions: ["eu-central-1"] });
    const out = await i.sync({});
    const verbs = runner.calls.filter((c) => !["configure", "sts"].includes(c[0] ?? "")).map((c) => c[1] ?? "");
    for (const verb of verbs) expect(verb).toMatch(/^(describe|list|get)-/);
    const ec2Call = runner.calls.find((c) => c[0] === "ec2");
    expect(ec2Call).toEqual(["ec2", "describe-instances", "--output", "json", "--no-cli-pager", "--profile", "prod-sso", "--region", "eu-central-1"]);
    expect(out.resources.map((r) => r.service).sort()).toEqual(
      ["apigateway", "apigatewayv2/websocket", "cloudfront", "ec2", "ec2", "ecs", "ecs-cluster", "elasticache/redis", "elbv2/application", "lambda", "route53", "s3", "sns"].sort(),
    );
    expect(out.errors).toEqual([expect.stringMatching(/^rds eu-central-1: An error occurred \(AccessDenied\)/)]);
    expect(out.errors.join(" ")).not.toContain("abcd1234SECRET");
  });

  test("connect rejects unknown or flag-shaped profiles", async () => {
    const i = new awsMod.AwsIntegration({ runner: awsRunner(), settings: new SettingsStore(tempDir()), bin: () => "/fake/aws", env: {} });
    await expect(i.connect({ account: "other" })).rejects.toThrow(/unknown AWS profile/);
    await expect(i.connect({ account: "--endpoint-url=http://evil" })).rejects.toThrow(/invalid AWS profile/);
  });
});

describe("linking cloud resources to elements", () => {
  const base = { provider: "digitalocean", type: "compute" as const, service: "droplet" };

  test("normalizeName / tags / name matching", () => {
    expect(normalizeName("Invoices_API ")).toBe("invoices-api");
    expect(nodeIdFromTags({ "ruah:node": "api" })).toBe("api");
    expect(nodeIdFromTags({ "ruah-node": "db" })).toBe("db");
    expect(nodeIdFromTags({ "ruah:node:web": "" })).toBe("web");
    expect(nodeIdFromTags({ prod: "" })).toBeUndefined();
    expect(matchNodeByName("invoices-api", arch.nodes)).toBe("api"); // node name
    expect(matchNodeByName("api", arch.nodes)).toBe("api"); // node id
    expect(matchNodeByName("Web_App", arch.nodes)).toBe("web"); // normalized
    expect(matchNodeByName("unknown", arch.nodes)).toBeUndefined();
    const ambiguous = [...arch.nodes, { id: "api-2", type: "service", name: "Invoices API" }];
    expect(matchNodeByName("invoices api", ambiguous)).toBeUndefined();
  });

  test("precedence: manual (incl. explicit null) > tag > name; unknown node ids ignored", () => {
    const resources = [
      { ...base, id: "r1", name: "invoices-api" },
      { ...base, id: "r2", name: "whatever", tags: { "ruah:node": "db" } },
      { ...base, id: "r3", name: "invoices-api", tags: { "ruah:node": "db" } },
      { ...base, id: "r4", name: "web-app" },
      { ...base, id: "r5", name: "x", tags: { "ruah:node": "ghost" } },
      { ...base, id: "r6", name: "events-bus", linkedNodeId: "stale" },
    ];
    const linked = linkResources(resources, arch.nodes, { r1: "bus", r4: null });
    expect(linked.map((r) => r.linkedNodeId)).toEqual(["bus", "db", "db", undefined, undefined, "bus"]);
  });
});

describe("IntegrationsService cloud endpoints", () => {
  function service(home: string, root: string, runner: Runner): IntegrationsService {
    return new IntegrationsService({
      home,
      project: () => ({ root, architecture: arch }),
      runner,
      secrets: new MemorySecretStore(),
      now: () => new Date("2026-09-23T10:00:00.000Z"),
    });
  }

  test("sync caches per project in ~/.ruah/projects/<id>/cloud.json; manual links persist and survive re-sync", async () => {
    const home = tempDir();
    const root = tempDir();
    const runner = fakeRunner((args) => {
      const cmd = args.filter((a) => !a.startsWith("-") && a !== "json").join(" ");
      if (cmd === "compute droplet list") return ok(doFx.droplets);
      if (cmd === "auth list") return ok([{ name: "default", current: true }]);
      return ok([]);
    });
    const registry = new IntegrationRegistry().register(
      new doMod.DigitalOceanIntegration({ runner, settings: new SettingsStore(home), bin: () => "/fake/doctl" }),
    );
    const svc = new IntegrationsService({
      home, project: () => ({ root, architecture: arch }), runner, secrets: new MemorySecretStore(), registry,
      now: () => new Date("2026-09-23T10:00:00.000Z"),
    });

    const result = await svc.cloudSync({ providers: ["digitalocean"] });
    expect(result.syncedAt).toBe("2026-09-23T10:00:00.000Z");
    expect(result.resources.find((r) => r.id === "do:droplet:101")?.linkedNodeId).toBe("api"); // tag ruah:node:api
    const cacheFile = join(home, "projects", projectIdOf(root), "cloud.json");
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toMatchObject({ version: 1, syncedAt: "2026-09-23T10:00:00.000Z" });

    await svc.cloudLink({ resourceId: "do:droplet:102", nodeId: "bus" });
    await expect(svc.cloudLink({ resourceId: "do:droplet:102", nodeId: "nope" })).rejects.toThrow(/unknown element/);
    await expect(svc.cloudLink({ resourceId: "missing", nodeId: "bus" })).rejects.toThrow(/unknown resource/);
    expect((await svc.cloudResources()).resources.find((r) => r.id === "do:droplet:102")?.linkedNodeId).toBe("bus");

    const again = await svc.cloudSync({ providers: ["digitalocean"] });
    expect(again.resources.find((r) => r.id === "do:droplet:102")?.linkedNodeId).toBe("bus");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).manualLinks).toEqual({ "do:droplet:102": "bus" });
  });

  test("unknown / non-cloud providers are rejected; no project → 409", async () => {
    const svc = service(tempDir(), tempDir(), fakeRunner(() => ok([])));
    await expect(svc.cloudSync({ providers: ["nope"] })).rejects.toMatchObject({ status: 404 });
    await expect(svc.cloudSync({ providers: ["jira"] })).rejects.toMatchObject({ status: 400 });
    const none = new IntegrationsService({ home: tempDir(), project: () => null, runner: fakeRunner(() => ok([])), secrets: new MemorySecretStore() });
    await expect(none.cloudSync({})).rejects.toMatchObject({ status: 409 });
    expect(await none.cloudResources()).toEqual({ resources: [], syncedAt: null, errors: [] });
  });
});
