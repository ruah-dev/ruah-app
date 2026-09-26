// CONTRACTS.md §14 — per-project cloud scope: deterministic evidence from the
// repo (link files, IaC, tags, hosts, names), manual include / exclude in the
// committable `.ruah/cloud.json`, account-limited syncs, multi-repo union, the
// HTTP API (Origin checks) and the `ruah app cloud scope` CLI.
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArchNode } from "../src/contracts/architecture.js";
import type { CloudResource, IntegrationInfo } from "../src/contracts/integrations.js";
import { MockBridge, type MockBridgeOptions } from "../src/acp/mock-bridge.js";
import { runCloud, type CloudCliDeps } from "../src/integrations/cloud-cli.js";
import { syncProviders } from "../src/integrations/cloud-sync.js";
import { DigitalOceanIntegration } from "../src/integrations/cloud/digitalocean.js";
import type { RunOptions, RunResult, Runner } from "../src/integrations/exec.js";
import { IntegrationsService, type CloudUpdate } from "../src/integrations/index.js";
import { IntegrationRegistry, type CloudIntegration, type CloudSyncOutcome } from "../src/integrations/registry.js";
import {
  applyScope,
  collectRepoSignals,
  evaluateScope,
  formatScopeFile,
  hostsInText,
  loadScopeUnits,
  readScopeFile,
  syncAccountPlan,
  updateScopeFile,
  type ScopeUnit,
} from "../src/integrations/scope/index.js";
import {
  parseDoAppSpec,
  parseFirebaserc,
  parseFlyToml,
  parseNetlifyState,
  parseSamconfig,
  parseServerless,
  parseSupabaseConfig,
  parseSupabaseRef,
  parseVercelProject,
  parseVercelRepo,
  parseWrangler,
} from "../src/integrations/scope/signals.js";
import { SettingsStore } from "../src/integrations/store.js";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import { startServer } from "../src/serve/server.js";
import { SessionHub } from "../src/serve/session.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix = "ruah-scope-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const FIXTURE_DO = readFileSync(new URL("./fixtures/scope/do-app.yaml", import.meta.url), "utf8");

const res = (id: string, provider: string, extra: Partial<CloudResource> = {}): CloudResource => ({
  id, provider, type: "app", service: "project", name: id, ...extra,
});

function unit(root: string, extra: Partial<ScopeUnit> = {}): ScopeUnit {
  const file = readScopeFile(root);
  return { root, config: file.config, signals: collectRepoSignals(root), ...extra };
}

function scopeOf(units: ScopeUnit[], resources: CloudResource[], nodes: ArchNode[] = []) {
  return evaluateScope({ units, resources, nodes });
}

// ---- evidence per link file ---------------------------------------------------------

describe("link files → evidence", () => {
  test(".do/app.yaml (real App Platform shape): app name, database cluster, domain zone and hosts; secrets skipped", () => {
    const f = parseDoAppSpec(FIXTURE_DO, ".do/app.yaml");
    expect(f.claims.map((c) => [c.claim, c.confidence])).toEqual([
      [{ kind: "name", provider: "digitalocean", name: "acme-shop", services: ["apps"] }, "proof"],
      [{ kind: "name", provider: "digitalocean", name: "acmeshop.ro", services: ["domains"] }, "proof"],
      [{ kind: "name", provider: "digitalocean", name: "acmeshop.ro", services: ["domains"] }, "proof"],
      [{ kind: "name", provider: "digitalocean", name: "acmeshop.ro", services: ["domains"] }, "proof"],
      [{ kind: "name", provider: "digitalocean", name: "acme-shop-postgres" }, "proof"],
    ]);
    expect(f.claims[0]?.reason).toBe("from .do/app.yaml (app acme-shop)");
    expect(new Set(f.hosts)).toEqual(new Set(["acmeshop.ro", "www.acmeshop.ro", "api.acmeshop.ro"]));
    // deploy templates wrap the spec in `spec:`
    expect(parseDoAppSpec("spec:\n  name: tmpl-app\n", ".do/deploy.template.yaml").claims[0]?.claim).toMatchObject({ name: "tmpl-app" });
  });

  test("supabase config.toml / .temp/project-ref, fly.toml, vercel, netlify, wrangler, firebase, serverless, sam", () => {
    expect(parseSupabaseConfig('project_id = "abcdefghijklmnopqrst"\n[api]\nport = 54321\n', "supabase/config.toml").claims.map((c) => [c.claim, c.confidence])).toEqual([
      [{ kind: "id", provider: "supabase", id: "supabase:project:abcdefghijklmnopqrst" }, "proof"],
      [{ kind: "name", provider: "supabase", name: "abcdefghijklmnopqrst", services: ["project"] }, "likely"],
    ]);
    expect(parseSupabaseRef("qwertyuiopasdfghjklz\n", "supabase/.temp/project-ref").claims[0]?.claim).toEqual({ kind: "id", provider: "supabase", id: "supabase:project:qwertyuiopasdfghjklz" });
    expect(parseSupabaseRef("not a ref!", "x").claims).toEqual([]);
    const fly = parseFlyToml('app = "acme-api"\nprimary_region = "fra"\n', "fly.toml");
    expect(fly.claims[0]?.claim).toEqual({ kind: "id", provider: "fly", id: "fly:app:acme-api" });
    expect(fly.hosts).toEqual(["acme-api.fly.dev"]);
    expect(parseVercelProject('{"projectId":"prj_123","orgId":"team_9"}', ".vercel/project.json").claims[0]?.claim).toEqual({ kind: "id", provider: "vercel", id: "vercel:project:prj_123" });
    expect(parseVercelRepo('{"orgId":"team_9","projects":[{"id":"prj_a","name":"web","directory":"apps/web"},{"id":"prj_b","name":"docs"}]}', ".vercel/repo.json").claims.map((c) => c.claim)).toEqual([
      { kind: "id", provider: "vercel", id: "vercel:project:prj_a" },
      { kind: "id", provider: "vercel", id: "vercel:project:prj_b" },
    ]);
    expect(parseNetlifyState('{"siteId":"site-uuid-1"}', ".netlify/state.json").claims[0]?.claim).toEqual({ kind: "id", provider: "netlify", id: "netlify:site:site-uuid-1" });
    const wr = parseWrangler(
      'name = "edge-api"\naccount_id = "0123456789abcdef0123456789abcdef"\nroutes = [{ pattern = "api.acmeshop.ro/*", zone_name = "acmeshop.ro" }]\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "acme-db"\ndatabase_id = "d1-uuid"\n[[r2_buckets]]\nbinding = "B"\nbucket_name = "acme-assets"\n[env.staging]\nname = "edge-api-staging"\n',
      "workers/edge/wrangler.toml",
    );
    expect(wr.claims.map((c) => c.claim)).toEqual([
      { kind: "name", provider: "cloudflare", name: "edge-api", services: ["workers", "pages"] },
      { kind: "name", provider: "cloudflare", name: "edge-api-staging", services: ["workers", "pages"] },
      { kind: "id", provider: "cloudflare", id: "cf:d1:d1-uuid" },
      { kind: "name", provider: "cloudflare", name: "acme-assets", services: ["r2"] },
    ]);
    expect(wr.hosts).toEqual(["api.acmeshop.ro"]);
    expect(wr.accountHints).toEqual([{ provider: "cloudflare", account: "0123456789abcdef0123456789abcdef" }]);
    expect(parseWrangler('{ // jsonc\n "name": "pages-site", "pages_build_output_dir": "dist", }', "wrangler.jsonc").claims[0]?.claim).toMatchObject({ name: "pages-site" });
    const fb = parseFirebaserc('{"projects":{"default":"acme-prod-123","staging":"acme-stg-123"}}', ".firebaserc");
    expect(fb.claims.map((c) => c.claim)).toEqual([
      { kind: "idPart", provider: "gcp", part: "/projects/acme-prod-123/" },
      { kind: "idPart", provider: "gcp", part: "/projects/acme-stg-123/" },
    ]);
    expect(parseServerless("service: acme-jobs\nprovider:\n  name: aws\n", "serverless.yml").claims.map((c) => c.claim)).toEqual([
      { kind: "namePrefix", provider: "aws", prefix: "acme-jobs-" },
      { kind: "tag", provider: "aws", key: "aws:cloudformation:stack-name", value: "acme-jobs-", prefix: true },
    ]);
    expect(parseServerless("service: ${self:custom.name}\n", "serverless.yml").claims).toEqual([]);
    expect(parseSamconfig('version = 0.1\n[default.deploy.parameters]\nstack_name = "acme-sam"\n', "samconfig.toml").claims[0]?.claim).toEqual({ kind: "tag", provider: "aws", key: "aws:cloudformation:stack-name", value: "acme-sam" });
  });

  test("collectRepoSignals walks link folders (hidden ones too), reads example env files, never real .env / tfvars", () => {
    const repo = tempDir();
    write(repo, ".do/app.yaml", FIXTURE_DO);
    write(repo, "apps/web/.vercel/project.json", '{"projectId":"prj_web"}');
    write(repo, "supabase/config.toml", 'project_id = "acmeshopref123"\n');
    write(repo, "supabase/.temp/project-ref", "acmeshopref123\n");
    write(repo, ".env.example", "PUBLIC_URL=https://shop.acmeshop.ro\nAPI_HOST=api.acmeshop.ro\nLOCAL=http://localhost:3000\n");
    write(repo, ".env", "SECRET_URL=https://secret-host.acmeshop.ro\n");
    write(repo, "infra/terraform.tfvars", 'domain = "tfvars-host.acmeshop.ro"\n');
    write(repo, "node_modules/x/fly.toml", 'app = "not-mine"\n');
    write(repo, "package.json", '{"name":"@acme/shop-monorepo","homepage":"https://acmeshop.ro/about"}');
    const s = collectRepoSignals(repo);
    expect(s.files).toEqual([".do/app.yaml", ".env.example", "apps/web/.vercel/project.json", "package.json", "supabase/.temp/project-ref", "supabase/config.toml"]);
    const hosts = s.hosts.map((h) => h.host);
    expect(hosts).toContain("shop.acmeshop.ro");
    expect(hosts).toContain("api.acmeshop.ro");
    expect(hosts).not.toContain("secret-host.acmeshop.ro");
    expect(hosts).not.toContain("tfvars-host.acmeshop.ro");
    expect(hosts).not.toContain("localhost");
    expect(s.names).toContain("shop-monorepo");
    expect(s.claims.some((c) => c.claim.kind === "id" && c.claim.id === "fly:app:not-mine")).toBe(false);
    expect(hostsInText("see https://Example.com and https://app.acme.io/x, ip http://10.0.0.1")).toEqual(["app.acme.io"]);
  });
});

// ---- matching ---------------------------------------------------------------------

describe("evaluateScope", () => {
  const doApp = res("do:app:1", "digitalocean", { name: "acme-shop", service: "apps", url: "https://acme-shop-x7.ondigitalocean.app" });
  const doDb = res("do:dbaas:2", "digitalocean", { name: "acme-shop-postgres", type: "database", service: "databases/pg" });
  const doZone = res("do:domain:acmeshop.ro", "digitalocean", { name: "acmeshop.ro", type: "dns", service: "domains" });
  const otherApp = res("do:app:9", "digitalocean", { name: "other-client-site", service: "apps" });

  test("proof from .do/app.yaml; other clients' resources stay out", () => {
    const repo = tempDir();
    write(repo, ".do/app.yaml", FIXTURE_DO);
    const scopes = scopeOf([unit(repo)], [doApp, doDb, doZone, otherApp]);
    expect(scopes.get("do:app:1")).toEqual({ in: true, confidence: "proof", reasons: ["from .do/app.yaml (app acme-shop)"] });
    expect(scopes.get("do:dbaas:2")).toMatchObject({ in: true, confidence: "proof" });
    expect(scopes.get("do:domain:acmeshop.ro")).toMatchObject({ in: true, confidence: "proof", reasons: ["from .do/app.yaml (domain acmeshop.ro)", "domain of acmeshop.ro (.do/app.yaml)"] });
    expect(scopes.get("do:app:9")).toEqual({ in: false, reasons: [] });
  });

  test("tags / labels: project=, ruah-project=, DO string tags, k8s part-of and declared namespaces; provider parents are not labels", () => {
    const repo = tempDir("acme-shop-");
    write(repo, "package.json", '{"name":"acme-shop"}');
    const nodes: ArchNode[] = [{ id: "k8s-prod.api", type: "container", name: "api", infra: { tool: "kubernetes", kind: "Deployment", address: "shop-prod/Deployment/api", hints: ["api", "shop-prod/api"] } }];
    const resources = [
      res("arn:1", "aws", { name: "i-1", tags: { Project: "Acme Shop" } }),
      res("do:droplet:1", "digitalocean", { name: "box", tags: { "project:acme-shop": "" } }),
      res("hcloud:server:1", "hetzner", { name: "box2", tags: { "ruah-project": "acme_shop" } }),
      res("k8s:c:x:deployment:w", "kubernetes", { name: "w", region: "x", tags: { "app.kubernetes.io/part-of": "acme-shop" } }),
      res("k8s:c:shop-prod:deployment:api", "kubernetes", { name: "api", region: "shop-prod" }),
      res("k8s:c:default:deployment:api", "kubernetes", { name: "api", region: "default" }),
      res("vercel:deployment:x", "vercel", { name: "x", service: "deployment", tags: { project: "acme-shop" } }),
      res("arn:2", "aws", { name: "i-2", tags: { Project: "someone-else" } }),
    ];
    const s = scopeOf([unit(repo)], resources, nodes);
    expect(s.get("arn:1")).toMatchObject({ in: true, confidence: "proof", reasons: ["tag Project=Acme Shop"] });
    expect(s.get("do:droplet:1")).toMatchObject({ in: true, reasons: ["tag project=acme-shop"] });
    expect(s.get("hcloud:server:1")).toMatchObject({ in: true, reasons: ["tag ruah-project=acme_shop"] });
    expect(s.get("k8s:c:x:deployment:w")).toMatchObject({ in: true, reasons: ["label app.kubernetes.io/part-of=acme-shop"] });
    expect(s.get("k8s:c:shop-prod:deployment:api")).toMatchObject({ in: true, confidence: "proof" });
    expect(s.get("k8s:c:shop-prod:deployment:api")?.reasons[0]).toMatch(/Kubernetes manifests \(shop-prod\/Deployment\/api\)|namespace shop-prod/);
    // Same workload name in another namespace: only "likely" through the bare hint (it runs the repo's manifests' name).
    expect(s.get("k8s:c:default:deployment:api")).toMatchObject({ confidence: "likely" });
    expect(s.get("vercel:deployment:x")?.confidence).not.toBe("proof");
    expect(s.get("arn:2")).toMatchObject({ in: false });
  });

  test("Terraform declarations are proof for their provider only; generic names never are", () => {
    const repo = tempDir();
    const nodes: ArchNode[] = [
      { id: "tf-digitalocean.db", type: "datastore", name: "acme-pg", infra: { tool: "terraform", kind: "digitalocean_database_cluster", address: "digitalocean_database_cluster.main", hints: ["digitalocean_database_cluster.main", "acme-pg"] } },
      { id: "tf-aws.bucket", type: "storage", name: "assets", infra: { tool: "terraform", kind: "aws_s3_bucket", address: "aws_s3_bucket.assets", hints: ["aws_s3_bucket.assets", "acme-assets-bucket", "api"] } },
    ];
    const s = scopeOf([unit(repo)], [
      res("do:dbaas:1", "digitalocean", { name: "acme-pg", type: "database", service: "databases/pg" }),
      res("do:dbaas:2", "digitalocean", { name: "acme-assets-bucket" }), // right name, wrong provider
      res("arn:aws:s3:::acme-assets-bucket", "aws", { name: "acme-assets-bucket", type: "storage", service: "s3" }),
      res("arn:aws:lambda:api", "aws", { name: "api", type: "function", service: "lambda" }),
    ], nodes);
    expect(s.get("do:dbaas:1")).toEqual({ in: true, confidence: "proof", reasons: ["in Terraform (digitalocean_database_cluster.main)"] });
    expect(s.get("do:dbaas:2")?.in).toBe(false);
    expect(s.get("arn:aws:s3:::acme-assets-bucket")).toMatchObject({ in: true, confidence: "proof" });
    expect(s.get("arn:aws:lambda:api")).toMatchObject({ in: true, confidence: "likely" }); // "api": generic → likely, not proof
  });

  test("host names the repo mentions → likely; DNS zones of those hosts → likely", () => {
    const repo = tempDir();
    write(repo, ".env.sample", "NEXT_PUBLIC_SITE_URL=https://www.acmeshop.ro\n");
    write(repo, "docker-compose.yml", "services:\n  web:\n    environment:\n      - API=https://api.acmeshop.ro\n");
    const s = scopeOf([unit(repo)], [
      res("vercel:project:1", "vercel", { name: "storefront", url: "https://acmeshop.ro" }),
      res("cf:zone:acmeshop.ro", "cloudflare", { name: "acmeshop.ro", type: "dns", service: "zone" }),
      res("k8s:c:n:ingress:i", "kubernetes", { name: "i", type: "gateway", hosts: ["api.acmeshop.ro"] }),
      res("vercel:project:2", "vercel", { name: "unrelated", url: "https://unrelated.vercel.app" }),
    ]);
    expect(s.get("vercel:project:1")).toEqual({ in: true, confidence: "likely", reasons: ["host acmeshop.ro in .env.sample"] });
    expect(s.get("cf:zone:acmeshop.ro")).toMatchObject({ in: true, confidence: "likely" });
    expect(s.get("k8s:c:n:ingress:i")).toMatchObject({ in: true, reasons: ["host api.acmeshop.ro in docker-compose.yml"] });
    expect(s.get("vercel:project:2")?.in).toBe(false);
  });

  test("bucket and CDN endpoints the repo mentions → likely (Spaces, S3, Supabase refs)", () => {
    const repo = tempDir();
    write(repo, ".env.example", "CDN=https://acme-static.fra1.cdn.digitaloceanspaces.com\nBUCKET=https://acme-uploads.s3.eu-west-1.amazonaws.com\nSUPABASE_URL=https://abcdefghijklmnop.supabase.co\n");
    const s = scopeOf([unit(repo)], [
      res("do:space:fra1:acme-static", "digitalocean", { name: "acme-static", type: "storage", service: "spaces", region: "fra1" }),
      res("do:cdn:1", "digitalocean", { name: "acme-static.fra1.digitaloceanspaces.com", type: "cdn", service: "cdn" }),
      res("arn:aws:s3:::acme-uploads", "aws", { name: "acme-uploads", type: "storage", service: "s3", region: "eu-west-1" }),
      res("supabase:project:abcdefghijklmnop", "supabase", { name: "db", type: "database" }),
      res("do:space:fra1:other", "digitalocean", { name: "other", type: "storage", service: "spaces", region: "fra1" }),
    ]);
    expect(s.get("do:space:fra1:acme-static")).toMatchObject({ in: true, confidence: "likely" });
    expect(s.get("do:cdn:1")).toMatchObject({ in: true, confidence: "likely" });
    expect(s.get("arn:aws:s3:::acme-uploads")).toMatchObject({ in: true, confidence: "likely" });
    expect(s.get("supabase:project:abcdefghijklmnop")).toMatchObject({ in: true, confidence: "likely" });
    expect(s.get("do:space:fra1:other")?.in).toBe(false);
  });

  test("weak name similarity is a suggestion (not in scope); generic names never suggest", () => {
    const repo = join(tempDir(), "harborpaystore");
    mkdirSync(repo);
    const s = scopeOf([unit(repo)], [
      res("vercel:project:a", "vercel", { name: "harbor-pay-store" }),
      res("vercel:project:b", "vercel", { name: "harborpaystore-admin" }),
      res("vercel:project:c", "vercel", { name: "web" }),
      res("vercel:project:d", "vercel", { name: "solid-pay" }),
    ]);
    const words = scopeOf([unit(repo, { config: { name: "harbor-pay-store", accounts: [], include: [], exclude: [] } })], [
      res("do:dbaas:x", "digitalocean", { name: "harbor-pay-north-postgres" }),
      res("do:dbaas:y", "digitalocean", { name: "solid-pay-postgres" }),
    ]);
    expect(words.get("do:dbaas:x")).toEqual({ in: false, confidence: "weak", reasons: ["name shares harbor, pay with harbor-pay-store"] });
    expect(words.get("do:dbaas:y")?.confidence).toBeUndefined();
    expect(s.get("vercel:project:a")).toEqual({ in: false, confidence: "weak", reasons: ["name looks like harborpaystore"] });
    expect(s.get("vercel:project:b")).toMatchObject({ in: false, confidence: "weak" });
    expect(s.get("vercel:project:c")).toEqual({ in: false, reasons: [] });
    expect(s.get("vercel:project:d")).toEqual({ in: false, reasons: [] });
  });

  test("manual include / exclude / whole account win; children follow their parent", () => {
    const repo = tempDir();
    write(repo, ".vercel/project.json", '{"projectId":"p1"}');
    write(repo, ".ruah/cloud.json", JSON.stringify({
      version: 1,
      accounts: [{ provider: "netlify", account: "client-team", whole: true }],
      include: [{ id: "fly:app:extra", name: "extra" }],
      exclude: ["vercel:project:p1", "vercel:project:p2"],
    }));
    const s = scopeOf([unit(repo)], [
      res("vercel:project:p1", "vercel", { name: "shop" }), // proof, but excluded by the user
      res("vercel:project:p2", "vercel", { name: "admin" }),
      res("vercel:deployment:d1", "vercel", { name: "admin (production)", service: "deployment", tags: { project: "admin" } }),
      res("fly:app:extra", "fly", { name: "extra" }),
      res("fly:volume:v1", "fly", { name: "data", service: "fly/volume", tags: { app: "extra" } }),
      res("netlify:site:1", "netlify", { name: "anything", account: "client-team" }),
      res("netlify:site:2", "netlify", { name: "elsewhere", account: "other-team" }),
      res("supabase:project:ref1", "supabase", { name: "db", type: "database" }),
      res("supabase:function:ref1:hello", "supabase", { name: "hello", type: "function", service: "edge-function" }),
    ]);
    expect(s.get("vercel:project:p1")).toEqual({ in: false, confidence: "manual", reasons: ["removed by you"], excluded: true });
    expect(s.get("vercel:deployment:d1")?.in).toBe(false); // its project was removed
    expect(s.get("fly:app:extra")).toEqual({ in: true, confidence: "manual", reasons: ["added by you"] });
    expect(s.get("fly:volume:v1")).toEqual({ in: true, confidence: "proof", reasons: ["part of extra"] });
    expect(s.get("netlify:site:1")).toEqual({ in: true, confidence: "manual", reasons: ["in account client-team"] });
    expect(s.get("netlify:site:2")?.in).toBe(false);
    expect(s.get("supabase:function:ref1:hello")?.in).toBe(false);
  });

  test("applyScope drops automatic element links of out-of-scope resources, keeps in-scope ones", () => {
    const repo = tempDir();
    write(repo, ".ruah/cloud.json", JSON.stringify({ version: 1, include: ["a"] }));
    const out = applyScope({
      units: [unit(repo)],
      resources: [res("a", "vercel", { name: "api", linkedNodeId: "api", linkSource: "name" }), res("b", "vercel", { name: "api", linkedNodeId: "api", linkSource: "name" })],
      nodes: [{ id: "api", type: "service", name: "api" }],
    });
    expect(out[0]).toMatchObject({ linkedNodeId: "api", scope: { in: true } });
    expect(out[1]?.linkedNodeId).toBeUndefined();
    expect(out[1]?.scope).toEqual({ in: false, reasons: [] });
  });

  test("multi-repo system: union of the repos' scopes with the contributing repo named; the system file's exclude wins", () => {
    const base = tempDir();
    write(base, "web/.vercel/project.json", '{"projectId":"w1"}');
    write(base, "api/fly.toml", 'app = "acme-api"\n');
    write(base, "api/.ruah/cloud.json", JSON.stringify({ version: 1, exclude: ["vercel:project:w1"], accounts: [{ provider: "fly", account: "acme-org" }] }));
    write(base, "platform/ruah.system.json", JSON.stringify({ version: 1, name: "acme", repos: [{ id: "web", path: "../web" }, { id: "api", path: "../api" }] }));
    const units = loadScopeUnits(join(base, "platform"));
    expect(units.map((u) => [u.repo, u.system === true])).toEqual([[undefined, true], ["web", false], ["api", false]]);
    let s = evaluateScope({ units, resources: [res("vercel:project:w1", "vercel"), res("fly:app:acme-api", "fly")], nodes: [] });
    expect(s.get("vercel:project:w1")).toEqual({ in: true, confidence: "proof", reasons: ["web: from .vercel/project.json"] });
    expect(s.get("fly:app:acme-api")).toMatchObject({ in: true, reasons: ["api: from fly.toml (app acme-api)"] });
    expect([...(syncAccountPlan(units) ?? new Map())]).toEqual([["fly", ["acme-org"]]]);
    write(base, "platform/.ruah/cloud.json", JSON.stringify({ version: 1, exclude: ["fly:app:acme-api"] }));
    s = evaluateScope({ units: loadScopeUnits(join(base, "platform")), resources: [res("fly:app:acme-api", "fly")], nodes: [] });
    expect(s.get("fly:app:acme-api")).toMatchObject({ in: false, excluded: true });
  });
});

// ---- the committable file -----------------------------------------------------------

describe(".ruah/cloud.json", () => {
  test("round trip: stable ordering, de-duplicated, exclude wins over include, no file for an empty config", () => {
    const repo = tempDir();
    updateScopeFile(repo, (c) => c);
    expect(existsSync(join(repo, ".ruah", "cloud.json"))).toBe(false);
    updateScopeFile(repo, (c) => ({
      ...c,
      accounts: [{ provider: "vercel", account: "b-team" }, { provider: "digitalocean", account: "client", whole: true }, { provider: "vercel", account: "b-team" }],
      include: [{ id: "z", provider: "vercel", name: "zeta" }, { id: "a", provider: "fly", name: "alpha" }, { id: "x" }],
      exclude: [{ id: "x" }],
    }));
    const text = readFileSync(join(repo, ".ruah", "cloud.json"), "utf8");
    expect(text).toBe(`${JSON.stringify({
      version: 1,
      accounts: [{ provider: "digitalocean", account: "client", whole: true }, { provider: "vercel", account: "b-team" }],
      include: [{ id: "a", provider: "fly", name: "alpha" }, { id: "z", provider: "vercel", name: "zeta" }],
      exclude: [{ id: "x" }],
    }, null, 2)}\n`);
    expect(formatScopeFile(readScopeFile(repo).config)).toBe(text);
    const mtime = statSync(join(repo, ".ruah", "cloud.json")).mtimeMs;
    updateScopeFile(repo, (c) => c); // unchanged → not rewritten
    expect(statSync(join(repo, ".ruah", "cloud.json")).mtimeMs).toBe(mtime);
  });

  test("an invalid file is reported, treated as empty and never overwritten", () => {
    const repo = tempDir();
    write(repo, ".ruah/cloud.json", '{"version": 2, "include": "nope"}');
    const read = readScopeFile(repo);
    expect(read.error).toMatch(/version/);
    expect(read.config).toEqual({ accounts: [], include: [], exclude: [] });
    expect(() => updateScopeFile(repo, (c) => ({ ...c, include: [{ id: "a" }] }))).toThrow(/invalid.*will not overwrite/);
    expect(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8")).toBe('{"version": 2, "include": "nope"}');
    write(repo, ".ruah/cloud.json", "{not json");
    expect(readScopeFile(repo).error).toBe("not valid JSON");
  });
});

// ---- the daemon service: account-limited sync, no writes on read / sync ---------------------

class FakeCloud implements CloudIntegration {
  readonly family = "cloud" as const;
  syncs: (string | undefined)[] = [];
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly byAccount: Record<string, CloudResource[]>,
    private readonly accounts: string[] = Object.keys(byAccount),
  ) {}
  enabled(): boolean {
    return true;
  }
  async info(): Promise<IntegrationInfo> {
    return { id: this.id, family: "cloud", name: this.name, status: "connected", accounts: this.accounts.map((a) => ({ id: a, label: a })) };
  }
  async connect(): Promise<IntegrationInfo> {
    return this.info();
  }
  async disconnect(): Promise<IntegrationInfo> {
    return this.info();
  }
  async sync(options: { account?: string }): Promise<CloudSyncOutcome> {
    this.syncs.push(options.account);
    return { resources: this.byAccount[options.account ?? this.accounts[0] ?? ""] ?? [], errors: [] };
  }
}

function service(root: string, providers: CloudIntegration[], nodes: ArchNode[] = []) {
  const registry = new IntegrationRegistry();
  for (const p of providers) registry.register(p);
  const home = tempDir("ruah-scope-home-");
  const svc = new IntegrationsService({ home, project: () => ({ root, architecture: { version: 1, name: "p", nodes, edges: [], workflows: [] } }), registry, now: () => new Date("2026-09-25T10:00:00.000Z") });
  return { svc, home };
}

describe("IntegrationsService with a scope", () => {
  test("sync reads only the scope's accounts and providers; other providers are not queried", async () => {
    const repo = tempDir();
    write(repo, ".ruah/cloud.json", JSON.stringify({ version: 1, accounts: [{ provider: "vercel", account: "client-a", whole: true }, { provider: "vercel", account: "client-a2" }] }));
    const vercel = new FakeCloud("vercel", "Vercel", {
      "client-a": [res("vercel:project:1", "vercel", { name: "shop" })],
      "client-a2": [res("vercel:project:2", "vercel", { name: "shop-docs" })],
      "client-b": [res("vercel:project:3", "vercel", { name: "other" })],
    });
    const doFake = new FakeCloud("digitalocean", "DigitalOcean", { team: [res("do:app:1", "digitalocean")] });
    const { svc } = service(repo, [vercel, doFake]);
    const result = await svc.cloudSync({});
    expect(vercel.syncs.sort()).toEqual(["client-a", "client-a2"]);
    expect(doFake.syncs).toEqual([]);
    expect(result.resources.map((r) => [r.id, r.account, r.scope?.in])).toEqual([
      ["vercel:project:1", "client-a", true],
      ["vercel:project:2", "client-a2", false],
    ]);
    expect(result.scope).toMatchObject({ configured: true, writable: true, accounts: [{ provider: "vercel", account: "client-a", whole: true }, { provider: "vercel", account: "client-a2" }] });
    expect(svc.watchProviders()).toEqual(["vercel"]);
  });

  test("the real DigitalOcean adapter is only asked for the scope's doctl context", async () => {
    const repo = tempDir();
    write(repo, ".ruah/cloud.json", JSON.stringify({ version: 1, accounts: [{ provider: "digitalocean", account: "client-a" }] }));
    const calls: string[][] = [];
    const runner: Runner = (_file: string, args: readonly string[], _o?: RunOptions): Promise<RunResult> => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    };
    const home = tempDir("ruah-scope-home-");
    const registry = new IntegrationRegistry().register(new DigitalOceanIntegration({ runner, settings: new SettingsStore(home), bin: () => "/fake/doctl" }));
    const svc = new IntegrationsService({ home, project: () => ({ root: repo, architecture: null }), registry, runner });
    await svc.cloudSync({});
    expect(calls.length).toBeGreaterThan(5);
    for (const args of calls) {
      const i = args.indexOf("--context");
      expect(args[i + 1], args.join(" ")).toBe("client-a");
    }
  });

  test("reads and syncs never write .ruah/cloud.json; API edits do (include / exclude / reset / accounts) and push cloud.updated", async () => {
    const repo = tempDir();
    write(repo, ".do/app.yaml", FIXTURE_DO);
    const doFake = new FakeCloud("digitalocean", "DigitalOcean", { team: [
      res("do:app:1", "digitalocean", { name: "acme-shop", service: "apps" }),
      res("do:app:2", "digitalocean", { name: "acme-shop-staging", service: "apps" }),
      res("do:app:3", "digitalocean", { name: "someone-else", service: "apps" }),
    ] });
    const { svc } = service(repo, [doFake]);
    const updates: CloudUpdate[] = [];
    svc.onCloudUpdated((u) => updates.push(u));
    await svc.cloudSync({});
    await svc.cloudResources();
    const info = await svc.cloudScope();
    expect(existsSync(join(repo, ".ruah"))).toBe(false);
    expect(info.counts).toEqual({ in: 1, suggestions: 1, excluded: 0, total: 3 });
    expect(info.evidence[0]?.files).toEqual([".do/app.yaml"]);
    expect(info.resources.map((r) => [r.id, r.scope?.confidence])).toEqual([["do:app:1", "proof"], ["do:app:2", "weak"]]);

    expect(await svc.cloudScopeResource({ resourceId: "do:app:2", action: "include" })).toEqual({ ok: true, scope: { in: true, confidence: "manual", reasons: ["added by you"] } });
    expect(JSON.parse(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8"))).toEqual({ version: 1, include: [{ id: "do:app:2", provider: "digitalocean", name: "acme-shop-staging" }] });
    expect(updates.at(-1)?.resources?.find((r) => r.id === "do:app:2")?.scope?.in).toBe(true);
    await svc.cloudScopeResource({ resourceId: "do:app:1", action: "exclude" });
    expect((await svc.cloudResources()).resources.find((r) => r.id === "do:app:1")?.scope).toMatchObject({ in: false, excluded: true });
    await svc.cloudScopeResource({ resourceId: "do:app:1", action: "reset" });
    expect((await svc.cloudResources()).resources.find((r) => r.id === "do:app:1")?.scope?.in).toBe(true);
    await expect(svc.cloudScopeResource({ resourceId: "nope", action: "include" })).rejects.toMatchObject({ status: 404 });
    const summary = await svc.cloudScopeAccounts({ accounts: [{ provider: "digitalocean", account: "team", whole: true }] });
    expect(summary.accounts).toEqual([{ provider: "digitalocean", account: "team", whole: true }]);
    await expect(svc.cloudScopeAccounts({ accounts: [{ provider: "nope" }] })).rejects.toMatchObject({ status: 400 });
    write(repo, ".ruah/cloud.json", "{broken");
    await expect(svc.cloudScopeResource({ resourceId: "do:app:1", action: "include" })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8")).toBe("{broken");
    expect((await svc.cloudResources()).scope).toMatchObject({ writable: false, files: [{ exists: true, error: "not valid JSON" }] });
  });
});

describe("syncProviders with account lists", () => {
  test("each listed account is synced once, resources stamped with it; errors name the account", async () => {
    const p = new FakeCloud("vercel", "Vercel", { a: [res("vercel:project:1", "vercel")], b: [res("vercel:project:1", "vercel"), res("vercel:project:2", "vercel")] });
    const out = await syncProviders([p], { accountLists: new Map([["vercel", ["a", "b"]]]), now: new Date("2026-09-25T00:00:00Z") });
    expect(p.syncs.sort()).toEqual(["a", "b"]);
    expect(out.resources.map((r) => r.id).sort()).toEqual(["vercel:project:1", "vercel:project:2"]);
    const named = await syncProviders([p], { accounts: { vercel: "b" }, accountLists: new Map([["vercel", ["a"]]]), now: new Date() });
    expect(named.resources.every((r) => r.account === "b")).toBe(true);
  });
});

// ---- HTTP -------------------------------------------------------------------------------

describe("HTTP /api/cloud/scope*", () => {
  async function serve(root: string, svc: IntegrationsService): Promise<string> {
    const archPath = join(root, "architecture.json");
    writeFileSync(archPath, JSON.stringify({ version: 1, name: "f", nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }));
    const store = createArchitectureStore(archPath);
    await store.load();
    cleanups.push(() => store.close());
    const bridge = new MockBridge({ chunkDelayMs: 1 } as MockBridgeOptions);
    const hub = new SessionHub(store, bridge, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock" });
    const server = await startServer(store, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, integrations: svc });
    cleanups.push(() => server.close());
    return server.url;
  }
  const post = (url: string, body: unknown, origin?: string): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) }, body: JSON.stringify(body) });

  test("GET scope; POSTs need a local Origin, validate bodies, and write the file", async () => {
    const repo = tempDir();
    const doFake = new FakeCloud("digitalocean", "DigitalOcean", { team: [res("do:app:1", "digitalocean", { name: "shop" })] });
    const { svc } = service(repo, [doFake]);
    await svc.cloudSync({});
    const url = await serve(repo, svc);
    const got = (await (await fetch(`${url}/api/cloud/scope`)).json()) as { counts: { total: number }; scope: { configured: boolean } };
    expect(got.counts.total).toBe(1);
    expect(got.scope.configured).toBe(false);
    expect((await post(`${url}/api/cloud/scope/resource`, { resourceId: "do:app:1", action: "include" }, "https://evil.example")).status).toBe(403);
    expect((await post(`${url}/api/cloud/scope/accounts`, { accounts: [] }, "https://evil.example")).status).toBe(403);
    expect(existsSync(join(repo, ".ruah", "cloud.json"))).toBe(false);
    expect((await post(`${url}/api/cloud/scope/resource`, { resourceId: "do:app:1", action: "delete-everything" })).status).toBe(400);
    expect((await post(`${url}/api/cloud/scope/accounts`, { accounts: [{ provider: "" }] })).status).toBe(400);
    const ok = await post(`${url}/api/cloud/scope/resource`, { resourceId: "do:app:1", action: "include" }, "http://localhost:5173");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, scope: { in: true, confidence: "manual", reasons: ["added by you"] } });
    const acc = await post(`${url}/api/cloud/scope/accounts`, { accounts: [{ provider: "digitalocean", account: "team" }] });
    expect(acc.status).toBe(200);
    expect(JSON.parse(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8"))).toEqual({
      version: 1, accounts: [{ provider: "digitalocean", account: "team" }], include: [{ id: "do:app:1", provider: "digitalocean", name: "shop" }],
    });
    const list = (await (await fetch(`${url}/api/cloud/resources`)).json()) as { resources: CloudResource[] };
    expect(list.resources[0]?.scope).toEqual({ in: true, confidence: "manual", reasons: ["added by you"] });
  });
});

// ---- CLI --------------------------------------------------------------------------------

describe("ruah app cloud scope (CLI)", () => {
  function harness(providers: CloudIntegration[], extra: Partial<CloudCliDeps> = {}) {
    const registry = new IntegrationRegistry();
    for (const p of providers) registry.register(p);
    let out = "";
    let err = "";
    const deps: CloudCliDeps = {
      home: tempDir("ruah-scope-home-"), registry, out: (t) => void (out += t), err: (t) => void (err += t),
      now: () => new Date("2026-09-25T12:00:00.000Z"), cwd: tempDir(), ...extra,
    };
    return { run: (argv: string[]) => runCloud(argv, deps), out: () => out, err: () => err, clear: () => void ((out = ""), (err = "")) };
  }
  const provider = () => new FakeCloud("digitalocean", "DigitalOcean", {
    team: [
      res("do:app:1", "digitalocean", { name: "acme-shop", service: "apps", health: "healthy" }),
      res("do:app:2", "digitalocean", { name: "acme-shop-preview", service: "apps", health: "down" }),
      res("do:app:3", "digitalocean", { name: "other-client", service: "apps", health: "down" }),
    ],
    other: [res("do:app:9", "digitalocean", { name: "other-team-app" })],
  }, ["team", "other"]);

  test("scope --json: accounts, members with reasons, suggestions; status exit code counts only the repo's resources", async () => {
    const repo = tempDir();
    write(repo, ".do/app.yaml", FIXTURE_DO);
    const h = harness([provider()]);
    expect(await h.run(["scope", "--repo", repo, "--json"])).toBe(0);
    const parsed = JSON.parse(h.out()) as { members: { id: string; reasons: string[] }[]; suggestions: { id: string }[]; counts: Record<string, number>; scope: { accounts: unknown[] } };
    expect(parsed.members.map((m) => [m.id, m.reasons[0]])).toEqual([["do:app:1", "from .do/app.yaml (app acme-shop)"]]);
    expect(parsed.suggestions.map((s) => s.id)).toEqual(["do:app:2"]);
    expect(parsed.counts).toEqual({ in: 1, suggestions: 1, excluded: 0, total: 3 });
    expect(existsSync(join(repo, ".ruah"))).toBe(false);
    h.clear();
    // The other client's app is down, but it is not this repo's: status is 0.
    expect(await h.run(["status", "--repo", repo])).toBe(0);
    expect(h.out()).toMatch(/Scope: .* — 1 of 3 resources · 1 look related/);
    expect(await h.run(["status", "--repo", repo, "--all"])).toBe(1);
  });

  test("scope add / remove / reset and accounts add / remove edit .ruah/cloud.json; the cwd's repo is the default", async () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src"));
    const p = provider();
    const h = harness([p], { cwd: join(repo, "src") });
    expect(await h.run(["scope", "add", "do:app:2"])).toBe(0);
    expect(await h.run(["scope", "remove", "do:app:3"])).toBe(0);
    expect(await h.run(["scope", "accounts", "add", "digitalocean", "team", "--whole"])).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8"))).toEqual({
      version: 1, accounts: [{ provider: "digitalocean", account: "team", whole: true }], include: [{ id: "do:app:2" }], exclude: [{ id: "do:app:3" }],
    });
    h.clear();
    expect(await h.run(["list", "--json"])).toBe(0);
    expect(p.syncs).toEqual(["team"]); // only the scope's account is read
    const listed = JSON.parse(h.out()) as { resources: CloudResource[] };
    expect(listed.resources.map((r) => [r.id, r.scope?.reasons[0]])).toEqual([["do:app:1", "in account team"], ["do:app:2", "added by you"]]);
    expect(await h.run(["scope", "reset", "do:app:3"])).toBe(0);
    expect(await h.run(["scope", "accounts", "remove", "digitalocean", "team"])).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8"))).toEqual({ version: 1, include: [{ id: "do:app:2" }] });
    expect(await h.run(["scope", "accounts", "add", "nope"])).toBe(2);
    expect(await h.run(["scope", "frobnicate"])).toBe(2);
    write(repo, ".ruah/cloud.json", "{broken");
    expect(await h.run(["scope", "add", "x"])).toBe(1);
    expect(h.err()).toMatch(/will not overwrite/);
    expect(readFileSync(join(repo, ".ruah", "cloud.json"), "utf8")).toBe("{broken");
  });

  test("outside any repo: list is the whole account; scope needs --repo", async () => {
    const h = harness([provider()]);
    expect(await h.run(["list", "--json"])).toBe(0);
    expect((JSON.parse(h.out()) as { resources: unknown[] }).resources).toHaveLength(3);
    expect(await h.run(["scope"])).toBe(2);
    expect(h.err()).toContain("not inside a repo");
  });
});
