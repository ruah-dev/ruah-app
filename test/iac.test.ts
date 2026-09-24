// Infrastructure as code in the map (CONTRACTS.md §11): the fixture monorepo
// test/fixtures/scan/infra-mono (two services with Dockerfiles, a Helm chart,
// raw manifests + a kustomize base with prod/staging overlays, Terraform with
// a local Postgres module + bucket + EKS + DNS/LB, an Ansible playbook with an
// inventory, a GitHub Actions deploy workflow) → groups, typed children,
// edges with evidence, "how it ships" workflows; secrets never read; rescans
// keep hand edits; the CLI, the per-project daemon option, linking, context
// packs and draw.io; and a performance guard.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Architecture, ArchNode } from "../src/contracts/architecture.js";
import type { CloudResource } from "../src/contracts/integrations.js";
import { validateArchitecture } from "../src/contracts/validate.js";
import { buildContextPack } from "../src/context/pack.js";
import { ArchIndex } from "../src/context/graph.js";
import { toDrawio } from "../src/export/drawio.js";
import { linkResourceWithSource, matchNodeByInfraHints } from "../src/integrations/linking.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { ProjectsStore } from "../src/projects/projects-store.js";
import { ProjectStateStore } from "../src/projects/project-state.js";
import { ProjectService } from "../src/projects/service.js";
import { MockBridge } from "../src/acp/mock-bridge.js";
import type { AcpBridge } from "../src/acp/bridge.js";
import { SessionHub } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { parseHcl } from "../src/scan/iac/hcl.js";
import { parseDockerfile } from "../src/scan/iac/docker.js";
import { readK8sObjects } from "../src/scan/iac/kubernetes.js";
import { detectInfra } from "../src/scan/iac/index.js";
import { infraView } from "../src/scan/iac/run-infra.js";
import { splitYamlDocuments } from "../src/scan/mini-yaml.js";
import { listFiles } from "../src/scan/walk.js";
import { scanRepo } from "../src/scan/index.js";
import { main } from "../src/cli.js";

const ROOT = join(import.meta.dirname, "fixtures", "scan", "infra-mono");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-iac-"));
  cpSync(ROOT, dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function node(arch: Architecture, id: string): ArchNode {
  const n = arch.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`missing node ${id}`);
  return n;
}

function edge(arch: Architecture, from: string, to: string, label: string) {
  const e = arch.edges.find((x) => x.from === from && x.to === to && x.label === label);
  if (e === undefined) throw new Error(`missing edge ${from} -> ${to} [${label}]`);
  return e;
}

const kids = (arch: Architecture, parent: string): string[] => arch.nodes.filter((n) => n.parent === parent).map((n) => n.id).sort();

describe("scanRepo: infrastructure-as-code monorepo", () => {
  const arch = scanRepo(ROOT);

  test("valid, and the top level stays readable: code + one node per IaC group", () => {
    const r = validateArchitecture(arch, ROOT);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.warnings).toEqual([]);
    expect(arch.nodes.filter((n) => n.parent === undefined).map((n) => n.id).sort()).toEqual([
      "ansible", "api", "ci", "helm-api", "k8s-prod", "k8s-staging", "postgres", "redis", "s3", "tf-aws", "worker",
    ]);
    expect(arch.layers).toContain("infra");
    for (const id of ["ansible", "ci", "helm-api", "k8s-prod", "k8s-staging", "tf-aws"]) expect(node(arch, id).layer).toBe("infra");
  });

  test("Terraform: resources typed, noise folded, module inputs resolved", () => {
    expect(node(arch, "tf-aws")).toMatchObject({ type: "cloud", name: "Terraform: AWS", path: "infra/terraform" });
    expect(kids(arch, "tf-aws")).toEqual(["tf-aws.acme-assets", "tf-aws.acme-prod", "tf-aws.acme-prod-db", "tf-aws.acme-public", "tf-aws.acme.dev"]);
    expect(node(arch, "tf-aws.acme-prod-db")).toMatchObject({
      type: "datastore",
      layer: "data",
      path: "infra/terraform/modules/postgres/main.tf",
      infra: {
        tool: "terraform",
        kind: "aws_db_instance",
        address: "module.db.aws_db_instance.this",
        source: ["infra/terraform/modules/postgres/main.tf:6"],
        settings: { engine: "postgres", engine_version: "16.3", instance_class: "db.t4g.medium", allocated_storage: "50", multi_az: "true" },
      },
    });
    expect(node(arch, "tf-aws.acme-prod-db").infra?.hints).toContain("acme-prod-db");
    expect(node(arch, "tf-aws.acme-prod")).toMatchObject({ type: "cluster", infra: { kind: "aws_eks_cluster", settings: { version: "1.30" } } });
    expect(node(arch, "tf-aws.acme-prod").infra?.details).toEqual(["aws_eks_node_group.default"]);
    expect(node(arch, "tf-aws.acme-assets")).toMatchObject({ type: "storage", infra: { details: ["aws_s3_bucket_versioning.assets"] } });
    expect(node(arch, "tf-aws.acme-assets").infra?.hints).toEqual(["aws_s3_bucket.assets", "acme-assets"]);
    expect(node(arch, "tf-aws.acme.dev").type).toBe("dns");
    expect(node(arch, "tf-aws.acme-public").type).toBe("loadbalancer");
    // IAM, network, random_*, data sources: details of the group, not nodes.
    expect(node(arch, "tf-aws").infra?.details).toEqual([
      "aws_iam_role.eks",
      "aws_iam_role_policy_attachment.eks_cluster",
      "aws_subnet.private",
      "aws_vpc.main",
      "module.db.aws_db_subnet_group.this",
      "random_password.db",
      "reads data.aws_iam_policy_document.eks_assume",
    ]);
    // DNS record + LB listener glue: zone → load balancer.
    expect(edge(arch, "tf-aws.acme.dev", "tf-aws.acme-public", "resolves").evidence).toEqual(["infra/terraform/main.tf:144"]);
    expect(edge(arch, "tf-aws.acme-prod-db", "postgres", "runs").kind).toBe("deploy");
    expect(edge(arch, "tf-aws.acme-assets", "s3", "runs").source).toBe("scan");
  });

  test("Kubernetes: kustomize overlays rendered per environment, raw manifests joined by namespace", () => {
    expect(node(arch, "k8s-prod")).toMatchObject({ type: "cluster", name: "Kubernetes: prod", infra: { kind: "environment", settings: { namespaces: "prod", overlays: "deploy/k8s/overlays/prod" } } });
    expect(kids(arch, "k8s-prod")).toEqual(["k8s-prod.nightly-cleanup", "k8s-prod.public", "k8s-prod.redis", "k8s-prod.worker"]);
    expect(kids(arch, "k8s-staging")).toEqual(["k8s-staging.stg-nightly-cleanup", "k8s-staging.stg-worker"]);
    // images transformer + strategic-merge replicas patch (prod), replicas transformer + namePrefix (staging)
    expect(node(arch, "k8s-prod.worker")).toMatchObject({
      type: "container",
      infra: { tool: "kustomize", kind: "Deployment", address: "prod/Deployment/worker", source: ["deploy/k8s/base/worker.yaml:2"], settings: { replicas: "4", image: "ghcr.io/acme/worker:1.4.0", namespace: "prod", service: "ClusterIP 9090" } },
    });
    expect(node(arch, "k8s-staging.stg-worker").infra?.settings).toMatchObject({ replicas: "1", image: "ghcr.io/acme/worker:latest", namespace: "staging" });
    expect(node(arch, "k8s-prod.nightly-cleanup")).toMatchObject({ type: "worker", infra: { kind: "CronJob", settings: { schedule: "0 3 * * *" } } });
    expect(node(arch, "k8s-prod.redis")).toMatchObject({ type: "cache", tech: ["Kubernetes StatefulSet", "Redis"] });
    expect(node(arch, "k8s-prod.worker").infra?.details).toEqual(["ConfigMap worker-config", "Secret db-credentials (values not read)", "Service worker-metrics (ClusterIP 9090)"]);
    expect(node(arch, "k8s-prod").infra?.details).toEqual(["ConfigMap worker-config", "Secret registry-pull (values not read)"]);
    // Workload → code by image; ingress host → Service → workload; env host → the Redis Service's StatefulSet.
    expect(edge(arch, "k8s-prod.worker", "worker", "runs").evidence).toEqual(["deploy/k8s/base/worker.yaml:2"]);
    expect(edge(arch, "k8s-prod.public", "k8s-prod.worker", "jobs.acme.dev/metrics").kind).toBe("sync");
    expect(edge(arch, "k8s-prod.worker", "k8s-prod.redis", "cache").evidence).toEqual(["deploy/k8s/base/worker.yaml:30"]);
    // envFrom Secret db-credentials is written by Terraform from module.db.address.
    expect(edge(arch, "k8s-prod.worker", "tf-aws.acme-prod-db", "sql").evidence).toEqual(["deploy/k8s/base/worker.yaml:2", "infra/terraform/main.tf:99"]);
    // ConfigMap URL http://api.prod.svc… → the api code service.
    expect(edge(arch, "k8s-prod.worker", "api", "calls").kind).toBe("sync");
  });

  test("Helm: templates' kinds + values, dependency, ingress", () => {
    expect(kids(arch, "helm-api")).toEqual(["helm-api.api", "helm-api.api.acme.dev", "helm-api.redis"]);
    expect(node(arch, "helm-api")).toMatchObject({ name: "Helm: api", infra: { kind: "chart", settings: { chart: "api", version: "0.3.1", appVersion: "1.4.0", valuesFiles: "values-prod.yaml" } } });
    expect(node(arch, "helm-api.api")).toMatchObject({ type: "container", infra: { tool: "helm", kind: "Deployment", settings: { replicas: "3", image: "ghcr.io/acme/api:1.4.0", ports: "8080", service: "ClusterIP 80" } } });
    expect(node(arch, "helm-api.redis")).toMatchObject({ type: "cache", infra: { kind: "dependency", settings: { chart: "redis", version: "19.6.0" } } });
    expect(edge(arch, "helm-api.api", "api", "runs").evidence).toEqual(["deploy/charts/api/values.yaml:4"]);
    expect(edge(arch, "helm-api.api.acme.dev", "helm-api.api", "api.acme.dev").kind).toBe("sync");
    expect(edge(arch, "helm-api.api", "helm-api.redis", "cache").kind).toBe("async");
    expect(edge(arch, "helm-api.redis", "redis", "runs").kind).toBe("deploy");
  });

  test("Ansible: host groups from the inventory, roles as details, what they run", () => {
    expect(kids(arch, "ansible")).toEqual(["ansible.db", "ansible.nginx-web", "ansible.postgres-db", "ansible.web"]);
    expect(node(arch, "ansible.web")).toMatchObject({
      type: "server",
      infra: { tool: "ansible", kind: "hosts", settings: { hosts: "2: edge-1.acme.dev, edge-2.acme.dev", roles: "nginx, api", become: "true" } },
    });
    expect(node(arch, "ansible.web").infra?.details).toEqual(["play \"Edge proxies\"", "role api", "role nginx", "template api.conf.j2"]);
    expect(node(arch, "ansible.nginx-web")).toMatchObject({ type: "gateway", name: "nginx (web)" });
    expect(node(arch, "ansible.postgres-db")).toMatchObject({ type: "datastore", name: "Postgres (db)" });
    expect(edge(arch, "ansible.web", "api", "runs").evidence).toEqual(["ansible/site.yml:4"]);
    // "runs" (docker_container image) supersedes the role / template name matches.
    expect(arch.edges.filter((e) => e.from === "ansible.web" && e.to === "api").map((e) => e.label)).toEqual(["runs"]);
    expect(edge(arch, "ansible.postgres-db", "postgres", "runs").kind).toBe("deploy");
  });

  test("CI: the deploy pipeline, its registry, what it builds and deploys", () => {
    expect(kids(arch, "ci")).toEqual(["ci.deploy", "ci.ghcr.io-acme"]);
    expect(node(arch, "ci")).toMatchObject({ type: "pipeline", path: ".github/workflows", infra: { details: ["ci.yml (CI: 1 job, no build or deploy)"] } });
    expect(node(arch, "ci.deploy").infra?.settings).toMatchObject({
      triggers: "push main; workflow_dispatch",
      builds: "ghcr.io/acme/api, ghcr.io/acme/worker",
      environments: "production",
    });
    expect(node(arch, "ci.ghcr.io-acme").type).toBe("registry");
    expect(edge(arch, "ci.deploy", "api", "builds").evidence).toEqual([".github/workflows/deploy.yml:26"]);
    expect(edge(arch, "ci.deploy", "worker", "builds").evidence).toEqual([".github/workflows/deploy.yml:33"]);
    for (const target of ["helm-api", "k8s-prod", "tf-aws"]) expect(edge(arch, "ci.deploy", target, "deploys").kind).toBe("deploy");
    expect(edge(arch, "ci.deploy", "ansible.web", "deploys").evidence).toEqual([".github/workflows/deploy.yml:54"]);
  });

  test("how it ships: scanned workflows code → pipeline → registry → workloads", () => {
    expect(arch.workflows).toEqual([
      {
        id: "ship-api",
        name: "Ship api",
        description: "Deploy (.github/workflows/deploy.yml) builds ghcr.io/acme/api; deploys with helm, kustomize, terraform, ansible.",
        steps: ["api", "ci.deploy", "ci.ghcr.io-acme", "helm-api.api", "ansible.web"],
        source: "scan",
      },
      {
        id: "ship-worker",
        name: "Ship worker",
        description: "Deploy (.github/workflows/deploy.yml) builds ghcr.io/acme/worker; deploys with helm, kustomize, terraform, ansible.",
        steps: ["worker", "ci.deploy", "ci.ghcr.io-acme", "k8s-prod.nightly-cleanup", "k8s-prod.worker"],
        source: "scan",
      },
    ]);
  });

  test("edges are lifted to the level where both ends are visible", () => {
    expect(edge(arch, "k8s-prod", "worker", "runs").evidence).toEqual(["deploy/k8s/base/cleanup-cronjob.yaml:2", "deploy/k8s/base/worker.yaml:2"]);
    expect(edge(arch, "k8s-prod", "tf-aws", "sql").kind).toBe("data");
    expect(edge(arch, "ci", "helm-api", "deploys").kind).toBe("deploy");
    expect(arch.edges.every((e) => e.source === "scan")).toBe(true);
  });

  test("code packages carry their Dockerfile", () => {
    expect(node(arch, "api").infra).toEqual({
      tool: "docker",
      kind: "Dockerfile",
      source: ["services/api/Dockerfile:2"],
      settings: { base: "node:22-alpine", expose: "8080", workdir: "/app", cmd: "node dist/index.js", images: "ghcr.io/acme/api" },
      hints: ["api"],
    });
  });

  test("never reads state files, tfvars, Secret data, inventory vars or group_vars", () => {
    const json = JSON.stringify(arch);
    for (const secret of ["FIXTURE-STATE-SECRET", "FIXTURE-TFVARS-SECRET", "RklYVFVSRS1TRUNSRVQtRE8tTk9ULUxFQUs", "FIXTURE-INVENTORY-SECRET", "FIXTURE-GROUPVARS-SECRET", "FIXTURE-DEFAULT-PASSWORD", "set-by-secret", "fixture_state_only"]) {
      expect(json.includes(secret), secret).toBe(false);
    }
    const report = JSON.stringify(detectInfra({ root: ROOT, fl: listFiles(ROOT) }));
    for (const secret of ["FIXTURE-STATE-SECRET", "FIXTURE-TFVARS-SECRET", "RklYVFVSRS1TRUNSRVQt", "FIXTURE-INVENTORY-SECRET", "FIXTURE-GROUPVARS-SECRET", "FIXTURE-DEFAULT-PASSWORD"]) {
      expect(report.includes(secret), secret).toBe(false);
    }
  });

  test("deterministic, and fast (performance guard)", () => {
    expect(JSON.stringify(scanRepo(ROOT))).toBe(JSON.stringify(arch));
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      scanRepo(ROOT);
      runs.push(performance.now() - t);
    }
    expect(Math.min(...runs)).toBeLessThan(500);
  });

  test("infra: false (scan --no-infra, the per-project option) leaves only the code map", () => {
    const plain = scanRepo(ROOT, { infra: false });
    expect(plain.nodes.some((n) => n.infra !== undefined)).toBe(false);
    expect(plain.workflows).toEqual([]);
    expect(plain.nodes.filter((n) => n.parent === undefined).map((n) => n.id).sort()).toEqual(["api", "postgres", "redis", "s3", "worker"]);
  });
});

describe("rescans keep hand edits", () => {
  test("descriptions, positions, user links and workflows survive; scanned workflows are replaced; removed IaC disappears", () => {
    const dir = tmpCopy();
    const first = scanRepo(dir);
    const edited: Architecture = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === "tf-aws.acme-prod-db" ? { ...n, description: "The primary database.", notes: "Failover drill in Q4.", x: 999, y: 111 } : n)),
      edges: [...first.edges, { from: "k8s-prod.worker", to: "tf-aws.acme-assets", label: "exports", kind: "data", source: "manual" }],
      workflows: [
        ...first.workflows.map((w) => (w.id === "ship-api" ? { ...w, steps: [...w.steps].reverse() } : w)),
        { id: "nightly", name: "Nightly export", steps: ["k8s-prod.nightly-cleanup", "tf-aws.acme-assets"] },
      ],
    };
    const again = scanRepo(dir, { previous: edited });
    expect(node(again, "tf-aws.acme-prod-db")).toMatchObject({ description: "The primary database.", notes: "Failover drill in Q4.", x: 999, y: 111 });
    expect(edge(again, "k8s-prod.worker", "tf-aws.acme-assets", "exports").source).toBe("manual");
    // The scanned "ship-api" is refreshed from the scan, not kept in its edited order; the hand-written workflow stays.
    expect(again.workflows.map((w) => w.id)).toEqual(["nightly", "ship-api", "ship-worker"]);
    expect(again.workflows.find((w) => w.id === "ship-api")?.steps[0]).toBe("api");

    // Remove the S3 bucket from main.tf (the file stays): its node and the user link to it go.
    const tf = join(dir, "infra/terraform/main.tf");
    writeFileSync(tf, readFileSync(tf, "utf8").replace(/resource "aws_s3_bucket" "assets" \{[\s\S]*?\n\}\n/, "").replace(/resource "aws_s3_bucket_versioning" "assets" \{[\s\S]*?\n\}\n\}\n/, ""));
    const third = scanRepo(dir, { previous: again });
    expect(third.nodes.some((n) => n.id === "tf-aws.acme-assets")).toBe(false);
    expect(third.edges.some((e) => e.to === "tf-aws.acme-assets")).toBe(false);
    expect(third.workflows.map((w) => w.id)).toEqual(["ship-api", "ship-worker"]); // "nightly" lost a step
    expect(node(third, "tf-aws.acme-prod-db").description).toBe("The primary database.");
    expect(validateArchitecture(third, dir).ok).toBe(true);

    // Turning IaC off removes the scanned IaC elements but keeps elements people drew.
    const drawn: Architecture = { ...third, nodes: [...third.nodes, { id: "vpn", type: "gateway", name: "VPN", parent: "tf-aws", origin: "user" }] };
    const off = scanRepo(dir, { previous: drawn, infra: false });
    expect(off.nodes.filter((n) => n.infra !== undefined && n.infra.tool !== "docker").map((n) => n.id)).toEqual([]);
    expect(node(off, "vpn").parent).toBeUndefined();
    expect(off.workflows).toEqual([]);
  });
});

describe("parsers", () => {
  test("HCL: blocks, labels, one-line bodies, heredocs, jsonencode, comments, literals", () => {
    const blocks = parseHcl(`
# comment
resource "aws_ecs_task_definition" "api" {
  family = "api" // trailing
  container_definitions = jsonencode([{
    name  = "api"
    image = "ghcr.io/acme/api:1.0" # inline
  }])
  user_data = <<-EOF
    #!/bin/sh
    echo "}"
  EOF
  lifecycle { ignore_changes = [tags] }
  count = 2
  name = "\${var.env}-api"
}
/* block
   comment */
module "db" { source = "./modules/db" }
`);
    expect(blocks.map((b) => [b.type, ...b.labels])).toEqual([["resource", "aws_ecs_task_definition", "api"], ["module", "db"]]);
    const r = blocks[0];
    expect(r?.line).toBe(3);
    expect(r?.attrs.family).toMatchObject({ value: "api", line: 4 });
    expect(r?.attrs.container_definitions?.raw).toContain('image = "ghcr.io/acme/api:1.0"');
    expect(r?.attrs.user_data?.raw).toContain('echo "}"');
    expect(r?.attrs.count?.value).toBe("2");
    expect(r?.attrs.name?.value).toBeUndefined(); // template, not a literal
    expect(r?.blocks.map((b) => b.type)).toEqual(["lifecycle"]);
    expect(blocks[1]?.attrs.source?.value).toBe("./modules/db");
  });

  test("multi-document YAML with source lines; Secrets are read by name only", () => {
    const text = "---\n# c\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: n\ndata:\n  k: c2VjcmV0\n...\n";
    expect(splitYamlDocuments(text).map((d) => [d.start, d.end])).toEqual([[1, 5], [8, 14]]);
    const objs = readK8sObjects("x.yaml", text);
    expect(objs.map((o) => [o.kind, o.name, o.line])).toEqual([["ConfigMap", "a", 4], ["Secret", "s", 10]]);
    expect(objs[1]).toMatchObject({ namespace: "n", refs: [] });
    expect(JSON.stringify(objs)).not.toContain("c2VjcmV0");
  });

  test("Dockerfile: runtime stage, ports, name hint, copies, workspace filters", () => {
    const d = parseDockerfile(
      "docker/Dockerfile.api",
      "FROM node:22 AS deps\nRUN pnpm install --filter @acme/api...\nFROM deps AS build\nCOPY apps/api ./apps/api\nFROM gcr.io/distroless/nodejs22\nCOPY --from=build /app /app\nEXPOSE 3000/tcp 9090\nCMD [\"dist/main.js\"]\n",
    );
    expect(d).toMatchObject({ base: "gcr.io/distroless/nodejs22", stages: ["node:22", "gcr.io/distroless/nodejs22"], expose: ["3000", "9090"], nameHint: "api", copies: ["apps/api"], filters: ["@acme/api"], cmd: "dist/main.js", line: 1 });
  });
});

describe("linking live cloud resources to IaC nodes", () => {
  const arch = scanRepo(ROOT);
  const res = (name: string, type: CloudResource["type"], tags?: Record<string, string>): CloudResource => ({
    id: `id-${name}`,
    provider: "aws",
    type,
    service: "x",
    name,
    ...(tags !== undefined ? { tags } : {}),
  });

  test("an RDS instance links by its identifier; a bucket by its Name tag", () => {
    expect(linkResourceWithSource(res("acme-prod-db", "database"), arch.nodes, {})).toEqual({ nodeId: "tf-aws.acme-prod-db", source: "name" });
    expect(linkResourceWithSource(res("arn-bucket-x", "storage", { Name: "acme-assets" }), arch.nodes, {})).toEqual({ nodeId: "tf-aws.acme-assets", source: "name" });
  });

  test("an ambiguous name (code service + workload) goes to the node whose type fits", () => {
    // "worker" is the code package and the prod Deployment: a container resource is the Deployment.
    expect(linkResourceWithSource(res("worker", "container"), arch.nodes, {})?.nodeId).toBe("k8s-prod.worker");
    // namespace/name hint picks the staging workload.
    expect(matchNodeByInfraHints(res("stg-worker", "kubernetes", { namespace: "staging" }), arch.nodes)).toBe("k8s-staging.stg-worker");
    // A resource of an unrelated type stays unlinked rather than guessing.
    expect(linkResourceWithSource(res("worker", "dns"), arch.nodes, {})).toBeUndefined();
  });

  test("tags and manual links still win", () => {
    expect(linkResourceWithSource(res("acme-prod-db", "database", { "ruah:node": "api" }), arch.nodes, {})).toEqual({ nodeId: "api", source: "tag" });
    expect(linkResourceWithSource(res("acme-prod-db", "database"), arch.nodes, { "id-acme-prod-db": null })).toBeUndefined();
  });
});

describe("context pack and draw.io carry the IaC specs", () => {
  const arch = scanRepo(ROOT);

  test("context pack: kind, declaration lines, settings, folded items", () => {
    const pack = buildContextPack(new ArchIndex(arch, ROOT), "tf-aws.acme-prod-db", ROOT);
    expect(pack).toContain("node: acme-prod-db (datastore) id=tf-aws.acme-prod-db");
    expect(pack).toContain("infra: terraform aws_db_instance module.db.aws_db_instance.this");
    expect(pack).toContain("declared in: infra/terraform/modules/postgres/main.tf:6");
    expect(pack).toContain("settings: engine=postgres; engine_version=16.3; instance_class=db.t4g.medium; allocated_storage=50; multi_az=true");
    expect(pack).toContain("folded: kubernetes_secret.db");
    const code = buildContextPack(new ArchIndex(scanRepo(ROOT, { infra: false }), ROOT), "worker", ROOT);
    expect(code).not.toContain("infra:");
  });

  test("draw.io: element properties and an Infrastructure table", () => {
    const xml = toDrawio(arch);
    expect(xml).toContain('infra="kustomize Deployment prod/Deployment/worker"');
    expect(xml).toContain('declaredIn="deploy/k8s/base/worker.yaml:2"');
    expect(xml).toContain("replicas: 4");
    expect(xml).toContain("Infrastructure as code");
    const plain = toDrawio(scanRepo(ROOT, { infra: false }));
    expect(plain).not.toContain("Infrastructure as code");
  });
});

describe("ruah app infra (CLI)", () => {
  async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const ow = process.stdout.write.bind(process.stdout);
    const ew = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
    try {
      const code = await main(argv);
      return { code, out: out.join(""), err: err.join("") };
    } finally {
      process.stdout.write = ow;
      process.stderr.write = ew;
    }
  }

  test("text report: groups, workloads, how it ships, links; nothing written", async () => {
    const dir = tmpCopy();
    const r = await capture(["infra", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Terraform: AWS  [tf-aws]  infra/terraform");
    expect(r.out).toMatch(/datastore\s+acme-prod-db\s+aws_db_instance\s+infra\/terraform\/modules\/postgres\/main\.tf:6/);
    expect(r.out).toContain("Ship worker: worker → Deploy (CI/CD: GitHub Actions) → ghcr.io/acme (CI/CD: GitHub Actions) → nightly-cleanup (Kubernetes: prod) → worker (Kubernetes: prod)");
    expect(r.out).toContain("worker (Kubernetes: prod) → acme-prod-db (Terraform: AWS) [sql]");
    expect(r.err).toMatch(/elements, \d+ links, 2 workflows in \d+ ms \(nothing written\)/);
    expect(() => readFileSync(join(dir, "architecture.json"))).toThrow();
  });

  test("--json and --kind filter; bad input", async () => {
    const r = await capture(["infra", ROOT, "--json", "--kind", "terraform"]);
    expect(r.code).toBe(0);
    const view = JSON.parse(r.out) as ReturnType<typeof infraView>;
    expect(view.kinds).toEqual(["terraform"]);
    expect(new Set(view.nodes.map((n) => n.infra?.tool))).toEqual(new Set(["terraform"]));
    expect(view.nodes.map((n) => n.id)).toContain("tf-aws.acme-prod-db");
    const k8s = JSON.parse((await capture(["infra", ROOT, "--json", "--kind", "k8s,helm"])).out) as ReturnType<typeof infraView>;
    expect(new Set(k8s.nodes.map((n) => n.infra?.tool))).toEqual(new Set(["kustomize", "kubernetes", "helm"]));
    expect((await capture(["infra", ROOT, "--kind", "pulumi"])).code).toBe(2);
    expect((await capture(["infra"])).code).toBe(2);
    expect((await capture(["infra", join(ROOT, "nope")])).code).toBe(2);
  });

  test("scan --no-infra writes the code-only map", async () => {
    const dir = tmpCopy();
    const out = join(dir, "architecture.json");
    expect((await capture(["scan", dir, "--no-infra", "--out", out])).code).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8")) as Architecture;
    expect(written.nodes.some((n) => n.infra !== undefined)).toBe(false);
    expect((await capture(["scan", dir, "--out", out])).code).toBe(0);
    expect((JSON.parse(readFileSync(out, "utf8")) as Architecture).nodes.some((n) => n.id === "tf-aws")).toBe(true);
  });
});

describe("daemon: per-project scan option", () => {
  test("state.json keeps scan.infra next to the active chat", () => {
    const home = mkdtempSync(join(tmpdir(), "ruah-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new ProjectStateStore(home);
    expect(store.scanOptions("abcdef012345")).toEqual({ infra: true });
    store.setActiveChat("abcdef012345", "chat-1");
    expect(store.setScanOptions("abcdef012345", { infra: false })).toEqual({ infra: false });
    const fresh = new ProjectStateStore(home);
    expect(fresh.scanOptions("abcdef012345")).toEqual({ infra: false });
    expect(fresh.activeChat("abcdef012345")).toBe("chat-1");
  });

  test("GET/POST /api/projects/scan-options drive first-open scans and rescans", async () => {
    const home = mkdtempSync(join(tmpdir(), "ruah-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const chats = new ChatStore(home);
    const agents = {
      choices: (currentAgentId: string) => ({ currentAgentId, available: [{ id: "mock", name: "Mock", installed: true }] }),
      check: () => ({ ok: true as const }),
      create: (_agentId: string, root?: string): AcpBridge => new MockBridge({ root: root ?? "/", preset: { command: "none", args: [] }, clientVersion: "0", chunkDelayMs: 1 }),
    };
    const hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {}, agentId: "mock", agents, chats });
    const projects = new ProjectService({ projects: new ProjectsStore(home), chats, host: hub, version: "0.0.0-test", watch: false });
    const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, projects });
    cleanups.push(async () => {
      await hub.shutdown();
      await server.close();
    });
    const url = server.url;
    const post = (p: string, body: unknown, origin?: string) =>
      fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) }, body: JSON.stringify(body) });

    expect((await fetch(`${url}/api/projects/scan-options`)).status).toBe(409); // nothing open
    const dir = tmpCopy();
    expect((await post("/api/projects/open", { path: dir })).status).toBe(200);
    const arch = async (): Promise<Architecture> => (await (await fetch(`${url}/api/architecture`)).json()) as Architecture;
    expect((await arch()).nodes.some((n) => n.id === "tf-aws")).toBe(true); // first-open scan: default on

    const got = (await (await fetch(`${url}/api/projects/scan-options`)).json()) as { projectId: string; options: { infra: boolean } };
    expect(got.options).toEqual({ infra: true });
    expect((await post("/api/projects/scan-options", { infra: false }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/projects/scan-options", { infra: "no" })).status).toBe(400);
    expect((await post("/api/projects/scan-options", { id: "ffffffffffff", infra: false })).status).toBe(404);
    const set = await post("/api/projects/scan-options", { infra: false });
    expect(await set.json()).toEqual({ projectId: got.projectId, options: { infra: false } });
    expect((await post("/api/rescan", {})).status).toBe(200);
    expect((await arch()).nodes.some((n) => n.infra !== undefined && n.infra.tool !== "docker")).toBe(false);
    expect(new ProjectStateStore(home).scanOptions(got.projectId)).toEqual({ infra: false });

    await post("/api/projects/scan-options", { id: got.projectId, infra: true });
    expect((await post("/api/rescan", {})).status).toBe(200);
    expect((await arch()).nodes.some((n) => n.id === "k8s-prod.worker")).toBe(true);
  });
});

describe("infraView", () => {
  test("filters by tool and leaves out lifted group-level copies of links", () => {
    const arch = scanRepo(ROOT);
    const v = infraView(arch, ROOT, ["ansible"]);
    expect(v.nodes.map((n) => n.id).sort()).toEqual(["ansible", "ansible.db", "ansible.nginx-web", "ansible.postgres-db", "ansible.web"]);
    expect(v.edges.some((e) => e.from === "ansible")).toBe(false);
    expect(v.workflows.map((w) => w.id)).toEqual(["ship-api"]);
  });
});
