// Multi-repo systems (docs/MULTI-REPO.md): ruah.system.json, the federated
// system architecture over test/fixtures/system/ (web, invoices-api,
// notify-worker, infra), cross-repo edges with evidence, determinism,
// hand-edit preservation, suggestion parsing, and the `ruah app system` CLI.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Architecture } from "../src/contracts/architecture.js";
import { validateArchitecture } from "../src/contracts/validate.js";
import { main } from "../src/cli.js";
import {
  acceptSuggestion,
  buildSystemArchitecture,
  detectCrossRepoSignals,
  loadSystem,
  parseSuggestions,
  parseSystemFile,
  resolveSystemPath,
  suggestConnections,
  SystemFileError,
  type SuggestSystem,
} from "../src/system/index.js";
import { listFiles } from "../src/scan/walk.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "system");
const REPLIES = join(FIXTURE, "agent-replies");

function tmpCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-system-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function top(arch: Architecture): string[] {
  return arch.nodes.filter((n) => n.parent === undefined).map((n) => n.id);
}

function topEdges(arch: Architecture): string[] {
  const ids = new Set(top(arch));
  return arch.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => `${e.from} -> ${e.to} [${e.label ?? ""}]`);
}

function edge(arch: Architecture, from: string, to: string, label: string) {
  const e = arch.edges.find((x) => x.from === from && x.to === to && x.label === label);
  if (e === undefined) throw new Error(`missing edge ${from} -> ${to} [${label}]`);
  return e;
}

function node(arch: Architecture, id: string) {
  const n = arch.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`missing node ${id}`);
  return n;
}

function expectValid(arch: Architecture): void {
  const r = validateArchitecture(arch, null);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  expect(r.warnings).toEqual([]);
  for (const n of arch.nodes) {
    expect(typeof n.x, n.id).toBe("number");
    expect(typeof n.y, n.id).toBe("number");
  }
}

describe("ruah.system.json", () => {
  test("parses, resolves repo roots relative to the file", () => {
    const sys = loadSystem(FIXTURE);
    expect(sys.name).toBe("acme-platform");
    expect(sys.repos.map((r) => r.id)).toEqual(["web", "invoices-api", "notify-worker", "infra"]);
    expect(sys.repos[0]?.root).toBe(join(FIXTURE, "web"));
    expect(loadSystem(join(FIXTURE, "ruah.system.json")).file).toBe(sys.file);
  });

  test("rejects bad ids, duplicates, wrong version", () => {
    const base = { version: 1, name: "x", repos: [{ id: "web", path: "../web" }] };
    expect(parseSystemFile(base).repos).toHaveLength(1);
    expect(() => parseSystemFile({ ...base, repos: [{ id: "Web", path: "w" }] })).toThrow(SystemFileError);
    expect(() => parseSystemFile({ ...base, repos: [{ id: "a_b", path: "w" }] })).toThrow(/repo id/);
    expect(() => parseSystemFile({ ...base, repos: [{ id: "web", path: "a" }, { id: "web", path: "b" }] })).toThrow(/duplicate repo id: web/);
    expect(() => parseSystemFile({ ...base, version: 2 })).toThrow(SystemFileError);
    expect(() => parseSystemFile({ ...base, repos: [{ id: "web", path: "" }] })).toThrow(SystemFileError);
  });

  test("resolveSystemPath maps <repoId>/<path> to the repo, refuses escapes", () => {
    const sys = loadSystem(FIXTURE);
    expect(resolveSystemPath(sys, "web/src/api.js")).toMatchObject({ repoId: "web", rel: "src/api.js", abs: join(FIXTURE, "web", "src", "api.js") });
    expect(resolveSystemPath(sys, "infra")).toMatchObject({ repoId: "infra", rel: "" });
    expect(resolveSystemPath(sys, "billing/x.js")).toBeNull();
    expect(resolveSystemPath(sys, "../web/src/api.js")).toBeNull();
    expect(resolveSystemPath(sys, "web/../../etc/passwd")).toBeNull();
  });
});

describe("contract: namespaced ids and edge provenance", () => {
  const base = (id: string): unknown => ({ version: 1, name: "s", nodes: [{ id, type: "service", name: "a" }], edges: [], workflows: [] });
  test("ids may carry one <repoId>: namespace", () => {
    expect(validateArchitecture(base("web:api")).ok).toBe(true);
    expect(validateArchitecture(base("web:api.routes")).ok).toBe(true);
    expect(validateArchitecture(base("Web:api")).ok).toBe(false);
    expect(validateArchitecture(base("a:b:c")).ok).toBe(false);
    expect(validateArchitecture(base("web.x:api")).ok).toBe(false);
  });
  test("edge source/evidence and node repo are optional fields", () => {
    const arch = {
      version: 1,
      name: "s",
      nodes: [
        { id: "a", type: "service", name: "a", repo: "a" },
        { id: "b", type: "service", name: "b" },
      ],
      edges: [{ from: "a", to: "b", source: "manual", evidence: ["a/x.js:1"] }],
      workflows: [],
    };
    const r = validateArchitecture(arch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.edges[0]).toMatchObject({ source: "manual", evidence: ["a/x.js:1"] });
  });
});

describe("buildSystemArchitecture: fixture polyrepo", () => {
  const { architecture: arch, repos } = buildSystemArchitecture(FIXTURE);

  test("validates; every node laid out", () => {
    expectValid(arch);
    expect(arch.name).toBe("acme-platform");
    expect(arch.generatedBy).toMatch(/^ruah app system /);
    expect(arch.generatedAt).toBeUndefined();
  });

  test("top level: one node per repo plus deduplicated shared infra", () => {
    expect(top(arch)).toEqual(["web", "invoices-api", "notify-worker", "infra", "kafka", "postgres", "resend"]);
    expect(node(arch, "web")).toMatchObject({ type: "frontend", layer: "frontend", repo: "web", path: "web", tech: ["JavaScript", "React 19", "Vite"] });
    expect(node(arch, "invoices-api")).toMatchObject({
      type: "service",
      layer: "services",
      description: "Invoices API: creates invoices, stores them in Postgres and publishes invoice events.",
    });
    expect(node(arch, "notify-worker")).toMatchObject({ type: "worker", layer: "workers" });
    expect(node(arch, "infra")).toMatchObject({ type: "infra", layer: "infra", tech: ["Docker Compose", "Terraform", "Kubernetes"] });
    // postgres: `db: postgres:16` in infra's compose + `pg` in invoices-api → one node.
    expect(node(arch, "postgres")).toMatchObject({ type: "datastore", layer: "data", tech: ["Postgres 16"] });
    expect(node(arch, "postgres").repo).toBeUndefined();
    expect(node(arch, "kafka")).toMatchObject({ type: "queue", tech: ["Kafka 3"], description: "Shared queue, used by invoices-api, notify-worker; deployed by infra." });
    expect(node(arch, "resend")).toMatchObject({ type: "external", layer: "external" });
    expect(arch.nodes.filter((n) => n.parent === undefined && /db|postgres/.test(n.id))).toHaveLength(1);
    expect(repos.map((r) => [r.id, r.source, r.type])).toEqual([
      ["web", "scan", "frontend"],
      ["invoices-api", "scan", "service"],
      ["notify-worker", "scan", "worker"],
      ["infra", "scan", "infra"],
    ]);
  });

  test("children: each repo's own architecture, namespaced", () => {
    const children = arch.nodes.filter((n) => n.parent === "invoices-api").map((n) => n.id).sort();
    expect(children).toEqual(["invoices-api:acme-invoices-api", "invoices-api:kafka", "invoices-api:postgres"]);
    expect(node(arch, "invoices-api:acme-invoices-api")).toMatchObject({ repo: "invoices-api", path: "invoices-api/src" });
    expect(node(arch, "invoices-api:acme-invoices-api").files?.every((f) => f.startsWith("invoices-api/"))).toBe(true);
    expect(arch.nodes.filter((n) => n.parent === "infra").map((n) => n.id).sort()).toEqual([
      "infra:db", "infra:infra", "infra:invoices-api", "infra:kafka", "infra:notify-worker", "infra:web",
    ]);
    for (const n of arch.nodes) if (n.parent !== undefined) expect(n.id.startsWith(`${n.repo}:`), n.id).toBe(true);
    expect(edge(arch, "invoices-api:acme-invoices-api", "invoices-api:postgres", "sql").source).toBe("scan");
  });

  test("cross-repo edges from compose, k8s, terraform, config, topics and packages", () => {
    expect(topEdges(arch)).toEqual([
      "infra -> invoices-api [deploys]",
      "infra -> kafka [deploys]",
      "infra -> notify-worker [deploys]",
      "infra -> postgres [deploys]",
      "infra -> web [deploys]",
      "invoices-api -> kafka [events]",
      "invoices-api -> notify-worker [invoice.created]",
      "invoices-api -> postgres [sql]",
      "notify-worker -> invoices-api [HTTP]",
      "notify-worker -> invoices-api [depends on]",
      "notify-worker -> kafka [events]",
      "notify-worker -> resend [API]",
      "web -> invoices-api [HTTP]",
    ]);
    for (const e of arch.edges) expect(e.source).toBe("scan");
    // env in the compose `web` block + depends_on + the literal in the source.
    expect(edge(arch, "web", "invoices-api", "HTTP")).toMatchObject({
      kind: "sync",
      evidence: ["infra/docker-compose.yml:7", "infra/docker-compose.yml:9", "web/src/api.js:1"],
    });
    expect(edge(arch, "invoices-api", "notify-worker", "invoice.created")).toMatchObject({
      kind: "event",
      evidence: ["invoices-api/src/events.js:9", "notify-worker/src/index.js:9"],
    });
    expect(edge(arch, "notify-worker", "invoices-api", "depends on").evidence).toEqual(["notify-worker/package.json:10"]);
    // k8s env value in a Deployment of notify-worker, cluster-internal host.
    expect(edge(arch, "notify-worker", "invoices-api", "HTTP").evidence).toEqual(["infra/k8s/notify-worker.yaml:14"]);
    expect(edge(arch, "infra", "web", "deploys").evidence).toEqual(["infra/docker-compose.yml:2", "infra/terraform/main.tf:5"]);
    expect(edge(arch, "invoices-api", "postgres", "sql").evidence).toEqual([
      "infra/docker-compose.yml:14",
      "infra/docker-compose.yml:17",
      "invoices-api/config/default.json:3",
      "invoices-api/package.json:13",
    ]);
  });

  test(".env.example URLs become evidence", () => {
    const dir = tmpCopy();
    // Written at test time (not committed): a plain example env file.
    writeFileSync(join(dir, "web", ".env.example"), "# local dev\nINVOICES_URL=http://invoices-api:8080\n");
    writeFileSync(join(dir, "notify-worker", "worker.env"), "INVOICES_API_HOST=invoices-api\n");
    const a = buildSystemArchitecture(dir).architecture;
    expect(edge(a, "web", "invoices-api", "HTTP").evidence).toContain("web/.env.example:2");
    // A bare host (no scheme) is a generic "calls" signal, folded into the
    // HTTP edge of the same pair (from the k8s manifest).
    expect(edge(a, "notify-worker", "invoices-api", "HTTP").evidence).toEqual(["infra/k8s/notify-worker.yaml:14", "notify-worker/worker.env:1"]);
    expect(a.edges.some((e) => e.label === "calls")).toBe(false);
  });

  test("deterministic: same bytes on every run and from another location", () => {
    const again = buildSystemArchitecture(FIXTURE).architecture;
    expect(JSON.stringify(again)).toBe(JSON.stringify(arch));
    const moved = buildSystemArchitecture(tmpCopy()).architecture;
    expect(JSON.stringify(moved)).toBe(JSON.stringify(arch));
  });

  test("reuses a repo's own architecture.json when present and valid", () => {
    const dir = tmpCopy();
    const own: Architecture = {
      version: 1,
      name: "web",
      nodes: [
        { id: "app", type: "frontend", name: "Web app", path: "src", description: "Hand-written.", tech: ["React"] },
        { id: "checkout", type: "module", name: "Checkout", parent: "app", path: "src/main.jsx" },
      ],
      edges: [],
      workflows: [],
    };
    writeFileSync(join(dir, "web", "architecture.json"), JSON.stringify(own));
    const r = buildSystemArchitecture(dir);
    expect(r.repos[0]).toMatchObject({ id: "web", source: "architecture.json", nodes: 2 });
    expect(node(r.architecture, "web")).toMatchObject({ description: "Hand-written.", type: "frontend" });
    expect(node(r.architecture, "web:checkout")).toMatchObject({ parent: "web:app", path: "web/src/main.jsx" });
    expectValid(r.architecture);
    // An invalid one is ignored with a warning.
    writeFileSync(join(dir, "web", "architecture.json"), "{\"version\":1}");
    const bad = buildSystemArchitecture(dir);
    expect(bad.repos[0]?.source).toBe("scan");
    expect(bad.repos[0]?.warning).toMatch(/invalid/);
  });

  test("a missing repo directory becomes a placeholder node", () => {
    const dir = tmpCopy();
    writeFileSync(
      join(dir, "ruah.system.json"),
      JSON.stringify({ version: 1, name: "x", repos: [{ id: "web", path: "web" }, { id: "gone", path: "../nope" }] }),
    );
    const r = buildSystemArchitecture(dir);
    expect(r.repos[1]).toMatchObject({ id: "gone", source: "missing" });
    expect(node(r.architecture, "gone").description).toBe("Repo not found at ../nope.");
    expectValid(r.architecture);
  });
});

describe("re-scan merges hand edits", () => {
  test("manual and suggested edges, descriptions, positions and hand nodes survive; stale scan edges go", () => {
    const first = buildSystemArchitecture(FIXTURE).architecture;
    const edited: Architecture = structuredClone(first);
    node(edited, "invoices-api").description = "Owns invoices. Talk to #billing.";
    node(edited, "invoices-api").notes = "SLA 99.9%";
    Object.assign(node(edited, "web"), { x: 999, y: 555 });
    edited.nodes.push({ id: "stripe-account", type: "external", name: "Stripe account", layer: "external" });
    edited.edges.push(
      { from: "web", to: "notify-worker", label: "SSE" }, // hand-written, no source
      { from: "invoices-api", to: "stripe-account", label: "charges", source: "manual" },
      { from: "notify-worker", to: "postgres", label: "reads", source: "suggested", evidence: ["notify-worker/src/index.js:12"] },
      { from: "web", to: "postgres", label: "stale", source: "scan" },
      { from: "web", to: "ghost", label: "dangling", source: "manual" },
    );
    const next = buildSystemArchitecture(FIXTURE, { previous: edited }).architecture;
    expectValid(next);
    expect(node(next, "invoices-api")).toMatchObject({ description: "Owns invoices. Talk to #billing.", notes: "SLA 99.9%" });
    expect(node(next, "web")).toMatchObject({ x: 999, y: 555 });
    expect(node(next, "stripe-account").type).toBe("external");
    expect(edge(next, "web", "notify-worker", "SSE").source).toBe("manual");
    expect(edge(next, "invoices-api", "stripe-account", "charges").source).toBe("manual");
    expect(edge(next, "notify-worker", "postgres", "reads")).toMatchObject({ source: "suggested", evidence: ["notify-worker/src/index.js:12"] });
    expect(next.edges.some((e) => e.label === "stale" || e.label === "dangling")).toBe(false);
    // All scan edges are back, exactly once.
    expect(next.edges.filter((e) => e.source === "scan")).toEqual(first.edges);
  });

  test("a generated node that disappears is not kept as a hand node", () => {
    const first = buildSystemArchitecture(FIXTURE).architecture;
    const edited: Architecture = structuredClone(first);
    edited.nodes.push({ id: "redis", type: "queue", name: "Redis", files: ["infra/docker-compose.yml"] });
    edited.nodes.push({ id: "old:thing", type: "module", name: "Thing", repo: "old", parent: "invoices-api" });
    const next = buildSystemArchitecture(FIXTURE, { previous: edited }).architecture;
    expect(next.nodes.some((n) => n.id === "redis" || n.id === "old:thing")).toBe(false);
  });
});

describe("topic heuristics across libraries", () => {
  function repo(root: string, id: string, deps: Record<string, string>, files: Record<string, string>) {
    const dir = join(root, id);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, dependencies: deps }));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return { id, root: dir, fl: listFiles(dir, { useGit: false }) };
  }

  test("amqplib, bullmq, NATS wildcards, SNS/SQS, Pub/Sub; gated by messaging deps", () => {
    const root = mkdtempSync(join(tmpdir(), "ruah-topics-"));
    const pub = repo(root, "orders", { amqplib: "1", bullmq: "5", nats: "2", "@aws-sdk/client-sns": "3", "@google-cloud/pubsub": "4" }, {
      "src/pub.js": [
        'channel.publish("orders", "order.placed", Buffer.from(body));',
        'const q = new Queue("emails", { connection });',
        'nc.publish("orders.eu.created", data);',
        "await sns.send(new PublishCommand({",
        '  TopicArn: "arn:aws:sns:eu-west-1:123:order-shipped",',
        "}));",
        'await pubsub.topic("order-audit").publishMessage({ data });',
      ].join("\n"),
    });
    const sub = repo(root, "mailer", { amqplib: "1", bullmq: "5", nats: "2", "@aws-sdk/client-sqs": "3", "@google-cloud/pubsub": "4" }, {
      "src/sub.js": [
        'await channel.bindQueue(q.queue, "orders", "order.placed");',
        'new Worker("emails", async (job) => send(job.data));',
        'nc.subscribe("orders.*.created");',
        "await sqs.send(new ReceiveMessageCommand({",
        '  QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123/order-shipped",',
        "}));",
        'pubsub.topic("order-audit").subscription("mailer-audit");',
      ].join("\n"),
    });
    const noDeps = repo(root, "ui", { react: "19" }, { "src/x.js": 'bus.subscribe("emails");\n' });
    const r = detectCrossRepoSignals([pub, sub, noDeps]);
    const labels = r.signals
      .filter((s) => "repo" in s.from && "repo" in s.to)
      .map((s) => `${"repo" in s.from ? s.from.repo : ""} -> ${"repo" in s.to ? s.to.repo : ""} [${s.label}]`);
    expect(labels).toEqual([
      "orders -> mailer [emails]",
      "orders -> mailer [order-audit]",
      "orders -> mailer [order-shipped]",
      "orders -> mailer [order.placed]",
      "orders -> mailer [orders]",
      "orders -> mailer [orders.eu.created]",
    ]);
    expect(r.repoTypes.get("ui")?.consumesTopics).toBe(false);
    expect(r.repoTypes.get("mailer")?.consumesTopics).toBe(true);
  });
});

describe("suggestions", () => {
  const sys = loadSystem(FIXTURE);
  const arch = buildSystemArchitecture(sys).architecture;
  const system: SuggestSystem = { name: sys.name, architecture: arch, repos: sys.repos };

  test("validates the agent's JSON: unknown nodes, self-edges, evidence, range, duplicates", () => {
    const raw = readFileSync(join(REPLIES, "mixed.md"), "utf8");
    const { suggestions, rejected } = parseSuggestions(raw, system);
    expect(suggestions).toEqual([
      {
        from: "web",
        to: "notify-worker",
        label: "HTTP",
        kind: "sync",
        confidence: 0.7,
        evidence: ["web/src/api.js:4", "web/src/main.jsx:5"],
        reason: "fetch to the worker's health endpoint",
      },
      { from: "invoices-api", to: "resend", confidence: 0.55, evidence: ["invoices-api/src/events.js:8"] },
    ]);
    const reasons = rejected.map((r) => r.reason);
    expect(reasons).toEqual([
      "duplicate of existing edge web -> invoices-api [HTTP]",
      "unknown node: billing",
      "self-edge",
      "no valid evidence (<repoId>/<path>:<line> of an existing file)",
      "confidence out of range: 1.5",
      expect.stringMatching(/^invalid edge: confidence/),
    ]);
  });

  test("bare arrays, prose answers, minConfidence, evidence without roots", () => {
    const bare = readFileSync(join(REPLIES, "bare-array.txt"), "utf8");
    expect(parseSuggestions(bare, system).suggestions).toHaveLength(1);
    expect(parseSuggestions(bare, system, { minConfidence: 0.5 }).rejected[0]?.reason).toBe("confidence 0.3 below 0.5");
    const prose = parseSuggestions(readFileSync(join(REPLIES, "prose.txt"), "utf8"), system);
    expect(prose.suggestions).toEqual([]);
    expect(prose.rejected[0]?.reason).toBe("no JSON object in the agent's answer");
    // Without repo roots the on-disk check is skipped, the format check stays.
    const noRoots: SuggestSystem = { ...system, repos: sys.repos.map((r) => ({ id: r.id })) };
    const r = parseSuggestions('{"edges":[{"from":"web","to":"kafka","confidence":0.5,"evidence":["web/nowhere.js:4000"]}]}', noRoots);
    expect(r.suggestions[0]?.evidence).toEqual(["web/nowhere.js:4000"]);
  });

  test("suggestConnections: prompt lists services + known edges; accepted edges survive re-scan", async () => {
    let seen = "";
    const result = await suggestConnections(system, async (prompt) => {
      seen = prompt;
      return readFileSync(join(REPLIES, "mixed.md"), "utf8");
    });
    expect(result.prompt).toBe(seen);
    expect(seen).toContain('multi-repo system "acme-platform"');
    expect(seen).toContain("- invoices-api (service) [JavaScript, Express 4]: Invoices API");
    expect(seen).toContain("- web -> invoices-api [HTTP]");
    expect(seen).toContain("Do not edit, create, or delete any file");
    expect(seen).not.toContain("invoices-api:acme-invoices-api");
    expect(result.suggestions).toHaveLength(2);
    const accepted = acceptSuggestion(arch, result.suggestions[0]!);
    expect(edge(accepted, "web", "notify-worker", "HTTP")).toMatchObject({ source: "suggested", evidence: ["web/src/api.js:4", "web/src/main.jsx:5"] });
    expect(acceptSuggestion(accepted, result.suggestions[0]!)).toBe(accepted);
    const rescanned = buildSystemArchitecture(sys, { previous: accepted }).architecture;
    expect(edge(rescanned, "web", "notify-worker", "HTTP").source).toBe("suggested");
    // Asking again: the accepted edge is now a known edge → rejected as duplicate.
    const again = parseSuggestions(readFileSync(join(REPLIES, "mixed.md"), "utf8"), { ...system, architecture: rescanned });
    expect(again.suggestions.map((s) => s.to)).toEqual(["resend"]);
  });
});

describe("ruah app system CLI", () => {
  test("init, add, scan, re-scan", async () => {
    const dir = tmpCopy();
    const platform = join(dir, "platform");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(["system", "init", "platform", "--repo", "web=web", "--repo", "invoices-api=invoices-api", "--name", "acme"])).toBe(0);
      const file = JSON.parse(readFileSync(join(platform, "ruah.system.json"), "utf8"));
      expect(file).toEqual({
        version: 1,
        name: "acme",
        repos: [
          { id: "web", path: "../web" },
          { id: "invoices-api", path: "../invoices-api" },
        ],
      });
      expect(await main(["system", "init", "platform", "--repo", "web=web"])).toBe(2);
      expect(await main(["system", "add", "platform", "notify-worker=notify-worker"])).toBe(0);
      expect(await main(["system", "add", "platform", `infra=${join(dir, "infra")}`])).toBe(0);
      expect(await main(["system", "add", "platform", "web=web"])).toBe(2);
      expect(await main(["system", "add", "platform", "Bad=web"])).toBe(2);
      expect(await main(["system", "add", "platform", "x=does-not-exist"])).toBe(2);
      expect(loadSystem(platform).repos.map((r) => `${r.id}=${r.path}`)).toEqual([
        "web=../web", "invoices-api=../invoices-api", "notify-worker=../notify-worker", "infra=../infra",
      ]);

      expect(await main(["system", "scan", "platform"])).toBe(0);
      const out = join(platform, "architecture.json");
      const arch = JSON.parse(readFileSync(out, "utf8")) as Architecture;
      expect(arch.name).toBe("acme");
      expect(typeof arch.generatedAt).toBe("string");
      expectValid(arch);
      expect(topEdges(arch)).toContain("invoices-api -> notify-worker [invoice.created]");

      // Hand edit, re-scan: kept.
      arch.edges.push({ from: "web", to: "notify-worker", label: "SSE", source: "manual" });
      writeFileSync(out, JSON.stringify(arch));
      expect(await main(["system", "scan", "platform"])).toBe(0);
      const again = JSON.parse(readFileSync(out, "utf8")) as Architecture;
      expect(edge(again, "web", "notify-worker", "SSE").source).toBe("manual");

      const custom = join(dir, "elsewhere", "sys.json");
      expect(await main(["system", "scan", "platform", "--out", custom])).toBe(0);
      expect(JSON.parse(readFileSync(custom, "utf8")).nodes.length).toBe(again.nodes.length);
      expect(await main(["system", "scan", "nowhere"])).toBe(2);
      expect(await main(["system", "frobnicate"])).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
});
