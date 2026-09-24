// Shared model of the infrastructure-as-code detectors (CONTRACTS.md §11).
//
// Detectors (terraform.ts, kubernetes.ts, helm.ts, ansible.ts, docker.ts,
// ci.ts) turn files into InfraItems grouped into InfraGroups, plus InfraLinks
// between them. Everything is plain data: no architecture ids yet — graph.ts
// maps the report onto the architecture (ids, layers, lifted edges,
// workflows). The library has no daemon dependency; `ruah app infra` prints a
// report straight from detectInfra().

import type { ScanContext } from "../types.js";
import { readText } from "../walk.js";

export type InfraTool ="terraform" | "kubernetes" | "kustomize" | "helm" | "ansible" | "compose" | "docker" | "ci";

export const INFRA_TOOLS: readonly InfraTool[] = ["terraform", "kubernetes", "kustomize", "helm", "ansible", "compose", "docker", "ci"];

/** What an item is, independent of the tool. Decides the node type and layer. */
export type InfraCategory =
  | "workload" // k8s Deployment/StatefulSet/DaemonSet, ECS task, container app
  | "job" // CronJob / Job / scheduled task
  | "compute" // VM, droplet, server, ECS service, Cloud Run, app service
  | "function" // Lambda, Cloud Functions, Workers
  | "frontend" // static sites / Pages / Vercel projects
  | "server" // Ansible host group
  | "database"
  | "cache"
  | "storage"
  | "queue"
  | "search"
  | "registry"
  | "cluster"
  | "gateway" // ingress, API gateway
  | "loadbalancer"
  | "dns"
  | "cdn"
  | "firewall"
  | "secret"
  | "monitoring"
  | "pipeline" // CI workflow that builds or deploys
  | "platform" // PaaS a pipeline deploys to (Fly, Vercel, …)
  | "release" // Helm release / HelmChart CR / remote Terraform module
  | "other";

export interface InfraGroup {
  key: string; // unique: "terraform:infra/terraform:aws", "k8s:prod", "helm:charts/api", "ansible:deploy/ansible", "ci:github"
  tool: InfraTool;
  name: string; // display: "Terraform: AWS", "Kubernetes: prod"
  kind: string; // provider | environment | namespace | chart | inventory | pipelines
  path?: string; // directory it lives in
  files: string[];
  settings: Record<string, string>;
  details: string[]; // folded resources and other noise: "aws_iam_role.task (IAM)", "NetworkPolicy default-deny"
  hints: string[];
}

export interface InfraItem {
  key: string; // unique across the report
  group: string; // InfraGroup.key
  tool: InfraTool;
  kind: string; // tool-native kind: aws_db_instance, Deployment, hosts, workflow, …
  address: string; // tool-native address: aws_db_instance.main, prod/Deployment/api
  name: string;
  category: InfraCategory;
  file: string; // repo-relative
  line: number; // 1-based
  settings: Record<string, string>; // key settings, literal values only, never secrets
  details: string[];
  hints: string[]; // names a live cloud resource may carry (linking)
  images: string[]; // container images it runs
  tech: string[];
  infraKind?: string; // INFRA_KINDS key when it is a well-known product (postgres, redis, nginx, …)
  refs?: string[]; // Kubernetes objects it references: "Secret/db", "ConfigMap/app", "host:postgres" (never values)
}

/** One end of a link: another item, a group, a code directory, an image, or a well-known infra kind. */
export type InfraEnd =
  | { item: string }
  | { group: string }
  | { codeDir: string }
  | { codeName: string } // a package / service name (Ansible role, template, release name)
  | { dockerfile: string } // the code a Dockerfile packages
  | { image: string }
  | { infraKind: string };

export interface InfraLink {
  from: InfraEnd;
  to: InfraEnd;
  label: string; // <= 40 chars
  kind: string; // sync | data | async | deploy
  evidence: string[]; // "path:line"
}

export interface DockerfileInfo {
  file: string;
  dir: string;
  line: number;
  base?: string; // runtime (last) stage base image
  stages: string[]; // every FROM image
  expose: string[];
  workdir?: string;
  cmd?: string;
  nameHint?: string; // Dockerfile.api / api.Dockerfile → "api"
  copies: string[]; // COPY / ADD source paths (repo-relative when resolvable)
  filters: string[]; // pnpm --filter / turbo --filter / npm -w names
}

export interface PipelineBuild {
  image?: string; // resolved image repository (tag stripped)
  context?: string; // repo-relative build context
  dockerfile?: string; // repo-relative Dockerfile
  line: number;
}

export interface PipelineDeploy {
  tool: string; // kubectl | kustomize | helm | terraform | ansible | compose | fly | vercel | …
  target: string; // what the command names (path, release, workload)
  line: number;
  targets: InfraEnd[]; // resolved
}

export interface Pipeline {
  itemKey: string;
  provider: "github" | "gitlab";
  file: string;
  name: string;
  triggers: string[];
  builds: PipelineBuild[];
  deploys: PipelineDeploy[];
  registries: string[];
  environments: string[];
}

export interface InfraReport {
  groups: InfraGroup[];
  items: InfraItem[];
  links: InfraLink[];
  dockerfiles: DockerfileInfo[];
  pipelines: Pipeline[];
  filesRead: number;
  truncated: boolean; // a detector hit its file cap
}

export function emptyReport(): InfraReport {
  return { groups: [], items: [], links: [], dockerfiles: [], pipelines: [], filesRead: 0, truncated: false };
}

// ---- small helpers shared by the detectors ----

// Several detectors look at the same YAML files (manifests, playbooks, CI);
// one read per scan. Keyed by the scan context, so nothing outlives a scan.
const TEXT_CACHE = new WeakMap<ScanContext, Map<string, string | null>>();

/** readText (<= 2 MiB, null when unreadable) memoized for the scan. */
export function readCached(ctx: ScanContext, rel: string): string | null {
  let cache = TEXT_CACHE.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    TEXT_CACHE.set(ctx, cache);
  }
  if (cache.has(rel)) return cache.get(rel) ?? null;
  const text = readText(ctx.root, rel);
  cache.set(rel, text);
  return text;
}

/** "ghcr.io/acme/api:1.2@sha256:…" → "ghcr.io/acme/api". */
export function imageRepo(image: string): string {
  const noDigest = image.split("@")[0] ?? image;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

/** "ghcr.io/acme/api:1.2" → "1.2". */
export function imageTag(image: string): string | undefined {
  const noDigest = image.split("@")[0] ?? image;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(colon + 1) : undefined;
}

/** Last path segment of an image repository: "ghcr.io/acme/api" → "api". */
export function imageName(image: string): string {
  const repo = imageRepo(image);
  return repo.slice(repo.lastIndexOf("/") + 1).toLowerCase();
}

/** Registry host of an image, when it names one ("ghcr.io/acme/api" → "ghcr.io"; "nginx" → undefined). */
export function imageRegistry(image: string): string | undefined {
  const repo = imageRepo(image);
  const first = repo.split("/")[0] ?? "";
  return repo.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : undefined;
}

/** Joins a repo-relative dir and a relative path; null when it escapes the repo. */
export function normJoin(dir: string, p: string): string | null {
  if (p.startsWith("/")) return null;
  const parts: string[] = dir === "" ? [] : dir.split("/");
  for (const seg of p.replaceAll("\\", "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Keys that must never carry a value into the map (secret material). */
export const SECRET_KEY_RE = /pass(word)?|secret|token|private|credential|api[_-]?key|access[_-]?key|auth|cert|signing|salt|\bkey$/i;

/** Setting values that look like secrets or are too long to be useful are dropped. */
export function safeSetting(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "" || v.length > 120 || SECRET_KEY_RE.test(key)) return undefined;
  return v;
}

const URL_HOST_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s"']+@)?([A-Za-z0-9][A-Za-z0-9.-]*)/g;
const HOST_PORT_RE = /(?:^|[\s"'=,])([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*):(\d{2,5})\b/g;

/**
 * Host names in a configuration value (env var, ConfigMap entry, values.yaml
 * leaf): URL hosts, `host:port`, and a bare host when the key says so
 * (`*_HOST`, `*_ADDR`, `*_SERVER`). Only names are returned, never the value.
 */
export function hostsIn(value: string, key = ""): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(URL_HOST_RE)) out.push((m[1] ?? "").toLowerCase());
  for (const m of value.matchAll(HOST_PORT_RE)) out.push((m[1] ?? "").toLowerCase());
  if (out.length === 0 && /(_|^)(HOST|HOSTNAME|ADDR|ADDRESS|SERVER|ENDPOINT)$/i.test(key) && /^[a-z][a-z0-9.-]*$/.test(value.trim())) out.push(value.trim().toLowerCase());
  return uniq(out.filter((h) => h !== "" && h !== "localhost" && !/^\d+(\.\d+){3}$/.test(h)));
}

/** First DNS label of an in-cluster host: "api.prod.svc.cluster.local" → "api". */
export function serviceHost(host: string): string {
  return /\.svc(\.|$)/.test(host) || !host.includes(".") ? (host.split(".")[0] ?? host) : host;
}

/** Path segments that hold test data, never deployed infrastructure. */
export function isFixturePath(file: string): boolean {
  return /(^|\/)(fixtures?|__fixtures__|testdata|__tests__|__mocks__|node_modules)(\/|$)/.test(file);
}
