// Kubernetes manifests + Kustomize detector.
//
// Every *.yaml / *.yml outside Helm charts is split into documents; documents
// with `apiVersion` + `kind` are Kubernetes objects. Secrets are never parsed:
// only their name and namespace are read, by regex (values stay unread).
//
// Kustomize: kustomization files form a graph (resources / bases / components
// pointing at files or other kustomizations). The ones nothing else references
// are roots — overlays like overlays/prod — and each root is rendered in
// memory: namespace, namePrefix/nameSuffix, images, replicas and
// strategic-merge patches that change replicas or images are applied to the
// extracted objects. A root's environment is its overlays/<env> (envs/,
// environments/, clusters/) segment or an env-like directory name; resources
// of all roots sharing an environment form one group ("Kubernetes: prod").
// Manifests no kustomization renders are grouped by namespace.
//
// Items: workloads (Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod,
// Argo Rollout) and routing (Ingress, Traefik IngressRoute, Gateway API
// HTTPRoute), plus HelmChart / HelmRelease custom resources as releases.
// Services fold into the workloads they select (ports, type); ConfigMaps,
// Secrets, RBAC, policies, … are details. Links: route → workload
// ("host /path") through the Service, workload → workload / infra kind from
// env and ConfigMap host names, workload → code through its image.
import { infraFromImage } from "../detectors/compose.js";
import { parseYaml, splitYamlDocuments, yamlGet, yamlKeys, yamlList, yamlPath, yamlString, type YamlValue } from "../mini-yaml.js";
import type { ScanContext } from "../types.js";
import { dirname } from "../walk.js";
import {
  byString,
  hostsIn,
  imageName,
  imageRepo,
  isFixturePath,
  normJoin,
  readCached,
  safeSetting,
  serviceHost,
  uniq,
  type InfraCategory,
  type InfraGroup,
  type InfraItem,
  type InfraLink,
  type InfraReport,
  type InfraTool,
} from "./model.js";

export const MAX_YAML_FILES = 4_000;
export const MAX_YAML_BYTES = 512 * 1024;

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet", "Rollout", "DeploymentConfig"]);
const ROUTE_KINDS = new Set(["Ingress", "IngressRoute", "HTTPRoute", "Route"]);
const RELEASE_KINDS = new Set(["HelmChart", "HelmRelease", "Application"]);
const ENV_NAMES = new Set(["prod", "production", "prd", "staging", "stage", "stg", "dev", "development", "qa", "uat", "test", "testing", "preview", "sandbox", "demo", "local", "hil", "canary", "live"]);
const KUSTOMIZATION_NAMES = new Set(["kustomization.yaml", "kustomization.yml", "Kustomization"]);
const CLUSTER_KINDS = new Set(["Namespace", "ClusterRole", "ClusterRoleBinding", "CustomResourceDefinition", "StorageClass", "PriorityClass", "PersistentVolume", "ClusterIssuer", "IngressClass", "MutatingWebhookConfiguration", "ValidatingWebhookConfiguration", "APIService"]);

export interface K8sContainer {
  name: string;
  image?: string;
  ports: string[];
  env: { name: string; value?: string }[];
}

/** One Kubernetes object, reduced to what the map needs. */
export interface K8sObj {
  file: string;
  line: number; // 1-based line of the document's `kind:`
  kind: string;
  apiVersion: string;
  name: string;
  namespace?: string;
  labels: Record<string, string>;
  podLabels: Record<string, string>;
  containers: K8sContainer[];
  refs: string[]; // Secret/x, ConfigMap/x, PersistentVolumeClaim/x
  replicas?: string;
  schedule?: string;
  serviceAccount?: string;
  // Service
  serviceType?: string;
  selector?: Record<string, string>;
  servicePorts?: string[];
  // routes
  rules?: { host: string; path: string; service: string; port?: string }[];
  className?: string;
  // ConfigMap: host names in its values (values themselves are not kept)
  configHosts?: string[];
  // HelmChart / HelmRelease / Argo Application
  chart?: string;
  chartRepo?: string;
  chartVersion?: string;
}

function strMap(v: YamlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of yamlKeys(v)) {
    const s = yamlString(yamlGet(v, k));
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function podSpecOf(kind: string, v: YamlValue): YamlValue | undefined {
  if (kind === "Pod") return yamlGet(v, "spec");
  if (kind === "CronJob") return yamlPath(v, "spec", "jobTemplate", "spec", "template", "spec");
  return yamlPath(v, "spec", "template", "spec");
}

/** Parses one manifest file into objects. `lines` lets callers map indices to evidence. */
export function readK8sObjects(file: string, text: string): K8sObj[] {
  const out: K8sObj[] = [];
  const lines = text.split(/\r?\n/);
  for (const doc of splitYamlDocuments(text)) {
    if (!/^kind:\s*\S/m.test(doc.text) || !/^apiVersion:\s*\S/m.test(doc.text)) continue;
    const kindIdx = lines.slice(doc.start, doc.end + 1).findIndex((l) => /^kind:\s*\S/.test(l));
    const line = doc.start + (kindIdx === -1 ? 0 : kindIdx) + 1;
    const kind = /^kind:\s*["']?([A-Za-z0-9]+)/m.exec(doc.text)?.[1] ?? "";
    const apiVersion = /^apiVersion:\s*["']?([^\s"']+)/m.exec(doc.text)?.[1] ?? "";
    if (kind === "Secret" || kind === "SealedSecret" || kind === "ExternalSecret") {
      // Never parse secret material: name + namespace only.
      const meta = /^metadata:\s*$/m.exec(doc.text);
      const tail = meta !== null ? doc.text.slice(meta.index) : "";
      const name = /^\s{1,4}name:\s*["']?([A-Za-z0-9._-]+)/m.exec(tail)?.[1] ?? "";
      const ns = /^\s{1,4}namespace:\s*["']?([A-Za-z0-9._-]+)/m.exec(tail)?.[1];
      out.push({ file, line, kind, apiVersion, name, ...(ns !== undefined ? { namespace: ns } : {}), labels: {}, podLabels: {}, containers: [], refs: [] });
      continue;
    }
    const v = parseYaml(doc.text);
    const meta = yamlGet(v, "metadata");
    const name = yamlString(yamlGet(meta, "name")) ?? "";
    const namespace = yamlString(yamlGet(meta, "namespace"));
    const obj: K8sObj = {
      file,
      line,
      kind,
      apiVersion,
      name,
      ...(namespace !== undefined ? { namespace } : {}),
      labels: strMap(yamlGet(meta, "labels")),
      podLabels: {},
      containers: [],
      refs: [],
    };
    if (WORKLOAD_KINDS.has(kind)) {
      const pod = podSpecOf(kind, v);
      const tmplMeta = kind === "CronJob" ? yamlPath(v, "spec", "jobTemplate", "spec", "template", "metadata") : yamlPath(v, "spec", "template", "metadata");
      obj.podLabels = { ...strMap(yamlPath(v, "spec", "selector", "matchLabels")), ...strMap(yamlGet(tmplMeta, "labels")) };
      const refs = new Set<string>();
      for (const c of [...yamlList(yamlGet(pod, "containers")), ...yamlList(yamlGet(pod, "initContainers"))]) {
        const env: { name: string; value?: string }[] = [];
        for (const e of yamlList(yamlGet(c, "env"))) {
          const en = yamlString(yamlGet(e, "name"));
          if (en === undefined) continue;
          const val = yamlString(yamlGet(e, "value"));
          env.push({ name: en, ...(val !== undefined ? { value: val } : {}) });
          const sk = yamlString(yamlPath(e, "valueFrom", "secretKeyRef", "name"));
          if (sk !== undefined) refs.add(`Secret/${sk}`);
          const ck = yamlString(yamlPath(e, "valueFrom", "configMapKeyRef", "name"));
          if (ck !== undefined) refs.add(`ConfigMap/${ck}`);
        }
        for (const e of yamlList(yamlGet(c, "envFrom"))) {
          const s = yamlString(yamlPath(e, "secretRef", "name"));
          if (s !== undefined) refs.add(`Secret/${s}`);
          const m = yamlString(yamlPath(e, "configMapRef", "name"));
          if (m !== undefined) refs.add(`ConfigMap/${m}`);
        }
        const image = yamlString(yamlGet(c, "image"));
        obj.containers.push({
          name: yamlString(yamlGet(c, "name")) ?? "",
          ...(image !== undefined ? { image } : {}),
          ports: yamlList(yamlGet(c, "ports")).map((p) => yamlString(yamlGet(p, "containerPort")) ?? "").filter((p) => p !== ""),
          env,
        });
      }
      for (const vol of yamlList(yamlGet(pod, "volumes"))) {
        const s = yamlString(yamlPath(vol, "secret", "secretName"));
        if (s !== undefined) refs.add(`Secret/${s}`);
        const m = yamlString(yamlPath(vol, "configMap", "name"));
        if (m !== undefined) refs.add(`ConfigMap/${m}`);
        const p = yamlString(yamlPath(vol, "persistentVolumeClaim", "claimName"));
        if (p !== undefined) refs.add(`PersistentVolumeClaim/${p}`);
      }
      obj.refs = [...refs].sort();
      const replicas = yamlString(yamlPath(v, "spec", "replicas"));
      if (replicas !== undefined) obj.replicas = replicas;
      const schedule = yamlString(yamlPath(v, "spec", "schedule"));
      if (schedule !== undefined) obj.schedule = schedule;
      const sa = yamlString(yamlGet(pod, "serviceAccountName"));
      if (sa !== undefined) obj.serviceAccount = sa;
    } else if (kind === "Service") {
      obj.serviceType = yamlString(yamlPath(v, "spec", "type")) ?? "ClusterIP";
      obj.selector = strMap(yamlPath(v, "spec", "selector"));
      obj.servicePorts = yamlList(yamlPath(v, "spec", "ports")).map((p) => {
        const port = yamlString(yamlGet(p, "port")) ?? "";
        const target = yamlString(yamlGet(p, "targetPort"));
        return target !== undefined && target !== port ? `${port}→${target}` : port;
      }).filter((p) => p !== "");
    } else if (kind === "Ingress") {
      obj.rules = [];
      const cls = yamlString(yamlPath(v, "spec", "ingressClassName")) ?? yamlString(yamlGet(yamlGet(meta, "annotations"), "kubernetes.io/ingress.class"));
      if (cls !== undefined) obj.className = cls;
      for (const r of yamlList(yamlPath(v, "spec", "rules"))) {
        const host = yamlString(yamlGet(r, "host")) ?? "*";
        for (const p of yamlList(yamlPath(r, "http", "paths"))) {
          const svc = yamlString(yamlPath(p, "backend", "service", "name")) ?? yamlString(yamlPath(p, "backend", "serviceName"));
          if (svc === undefined) continue;
          const port = yamlString(yamlPath(p, "backend", "service", "port", "number")) ?? yamlString(yamlPath(p, "backend", "service", "port", "name")) ?? yamlString(yamlPath(p, "backend", "servicePort"));
          obj.rules.push({ host, path: yamlString(yamlGet(p, "path")) ?? "/", service: svc, ...(port !== undefined ? { port } : {}) });
        }
      }
      const def = yamlString(yamlPath(v, "spec", "defaultBackend", "service", "name"));
      if (def !== undefined) obj.rules.push({ host: "*", path: "/", service: def });
    } else if (kind === "IngressRoute") {
      obj.rules = [];
      for (const r of yamlList(yamlPath(v, "spec", "routes"))) {
        const match = yamlString(yamlGet(r, "match")) ?? "";
        const host = /Host\(`([^`]+)`/.exec(match)?.[1] ?? "*";
        const path = /PathPrefix\(`([^`]+)`/.exec(match)?.[1] ?? "/";
        for (const s of yamlList(yamlGet(r, "services"))) {
          const svc = yamlString(yamlGet(s, "name"));
          if (svc !== undefined) obj.rules.push({ host, path, service: svc });
        }
      }
      obj.className = "traefik";
    } else if (kind === "HTTPRoute") {
      obj.rules = [];
      const hosts = yamlList(yamlPath(v, "spec", "hostnames")).map((h) => yamlString(h) ?? "").filter((h) => h !== "");
      for (const r of yamlList(yamlPath(v, "spec", "rules"))) {
        const path = yamlString(yamlPath(yamlList(yamlGet(r, "matches"))[0], "path", "value")) ?? "/";
        for (const b of yamlList(yamlGet(r, "backendRefs"))) {
          const svc = yamlString(yamlGet(b, "name"));
          if (svc !== undefined) for (const host of hosts.length > 0 ? hosts : ["*"]) obj.rules.push({ host, path, service: svc });
        }
      }
    } else if (kind === "ConfigMap") {
      const data = yamlGet(v, "data");
      const hosts: string[] = [];
      for (const k of yamlKeys(data)) {
        const val = yamlString(yamlGet(data, k));
        if (val !== undefined) hosts.push(...hostsIn(val, k));
      }
      obj.configHosts = uniq(hosts);
    } else if (kind === "HelmChart") {
      const chart = yamlString(yamlPath(v, "spec", "chart"));
      if (chart !== undefined) obj.chart = chart;
      const repo = yamlString(yamlPath(v, "spec", "repo"));
      if (repo !== undefined) obj.chartRepo = repo;
      const ver = yamlString(yamlPath(v, "spec", "version"));
      if (ver !== undefined) obj.chartVersion = ver;
      const tns = yamlString(yamlPath(v, "spec", "targetNamespace"));
      if (tns !== undefined) obj.namespace = tns;
    } else if (kind === "HelmRelease") {
      const chart = yamlString(yamlPath(v, "spec", "chart", "spec", "chart"));
      if (chart !== undefined) obj.chart = chart;
      const ver = yamlString(yamlPath(v, "spec", "chart", "spec", "version"));
      if (ver !== undefined) obj.chartVersion = ver;
      const tns = yamlString(yamlPath(v, "spec", "targetNamespace"));
      if (tns !== undefined) obj.namespace = tns;
    } else if (kind === "Application" && apiVersion.startsWith("argoproj.io")) {
      const chart = yamlString(yamlPath(v, "spec", "source", "chart")) ?? yamlString(yamlPath(v, "spec", "source", "path"));
      if (chart !== undefined) obj.chart = chart;
      const repo = yamlString(yamlPath(v, "spec", "source", "repoURL"));
      if (repo !== undefined) obj.chartRepo = repo;
      const tns = yamlString(yamlPath(v, "spec", "destination", "namespace"));
      if (tns !== undefined) obj.namespace = tns;
    }
    out.push(obj);
  }
  return out;
}

// ---------------------------------------------------------------- kustomize

interface Kustomization {
  file: string;
  dir: string;
  resources: string[]; // resolved repo-relative files or dirs
  namespace?: string;
  namePrefix?: string;
  nameSuffix?: string;
  images: { name: string; newName?: string; newTag?: string; digest?: string }[];
  replicas: { name: string; count: string }[];
  patches: string[]; // repo-relative patch files (strategic merge)
  inlinePatches: string[];
  helmCharts: { name: string; repo?: string; version?: string; releaseName?: string; namespace?: string }[];
}

function readKustomization(ctx: ScanContext, file: string): Kustomization | null {
  const text = readCached(ctx, file);
  if (text === null) return null;
  const v = parseYaml(text);
  const dir = dirname(file);
  const refs = (key: string): string[] =>
    yamlList(yamlGet(v, key))
      .map((x) => yamlString(x))
      .filter((x): x is string => x !== undefined && !/^(https?:|git@|github\.com\/|ssh:)/.test(x) && !x.includes("?ref="))
      .map((x) => normJoin(dir, x))
      .filter((x): x is string => x !== null);
  const k: Kustomization = {
    file,
    dir,
    resources: [...refs("resources"), ...refs("bases"), ...refs("components")],
    images: yamlList(yamlGet(v, "images")).map((i) => ({
      name: yamlString(yamlGet(i, "name")) ?? "",
      ...(yamlString(yamlGet(i, "newName")) !== undefined ? { newName: yamlString(yamlGet(i, "newName")) ?? "" } : {}),
      ...(yamlString(yamlGet(i, "newTag")) !== undefined ? { newTag: yamlString(yamlGet(i, "newTag")) ?? "" } : {}),
      ...(yamlString(yamlGet(i, "digest")) !== undefined ? { digest: yamlString(yamlGet(i, "digest")) ?? "" } : {}),
    })).filter((i) => i.name !== ""),
    replicas: yamlList(yamlGet(v, "replicas")).map((r) => ({ name: yamlString(yamlGet(r, "name")) ?? "", count: yamlString(yamlGet(r, "count")) ?? "" })).filter((r) => r.name !== ""),
    patches: [],
    inlinePatches: [],
    helmCharts: yamlList(yamlGet(v, "helmCharts")).map((h) => {
      const repo = yamlString(yamlGet(h, "repo"));
      const version = yamlString(yamlGet(h, "version"));
      const releaseName = yamlString(yamlGet(h, "releaseName"));
      const namespace = yamlString(yamlGet(h, "namespace"));
      return {
        name: yamlString(yamlGet(h, "name")) ?? "",
        ...(repo !== undefined ? { repo } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(releaseName !== undefined ? { releaseName } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
      };
    }).filter((h) => h.name !== ""),
  };
  const ns = yamlString(yamlGet(v, "namespace"));
  if (ns !== undefined) k.namespace = ns;
  const pre = yamlString(yamlGet(v, "namePrefix"));
  if (pre !== undefined) k.namePrefix = pre;
  const suf = yamlString(yamlGet(v, "nameSuffix"));
  if (suf !== undefined) k.nameSuffix = suf;
  for (const p of [...yamlList(yamlGet(v, "patches")), ...yamlList(yamlGet(v, "patchesStrategicMerge"))]) {
    const path = typeof p === "string" ? (p.includes("\n") ? undefined : p) : yamlString(yamlGet(p, "path"));
    const inline = typeof p === "string" && p.includes("\n") ? p : yamlString(yamlGet(p, "patch"));
    if (path !== undefined) {
      const f = normJoin(dir, path);
      if (f !== null) k.patches.push(f);
    } else if (inline !== undefined) k.inlinePatches.push(inline);
  }
  return k;
}

function applyImage(image: string, rules: Kustomization["images"]): string {
  const repo = imageRepo(image);
  const rule = rules.find((r) => r.name === repo || r.name === imageName(image));
  if (rule === undefined) return image;
  const base = rule.newName ?? repo;
  if (rule.digest !== undefined) return `${base}@${rule.digest}`;
  const tag = rule.newTag ?? (image.slice(repo.length + 1) || undefined);
  return tag !== undefined ? `${base}:${tag}` : base;
}

function envOf(dir: string): string | undefined {
  const segs = dir.split("/");
  for (let i = 0; i < segs.length - 1; i++) {
    if (["overlays", "overlay", "envs", "environments", "env", "clusters", "stages"].includes(segs[i] ?? "")) return segs[i + 1];
  }
  const last = segs[segs.length - 1] ?? "";
  return ENV_NAMES.has(last.toLowerCase()) ? last : undefined;
}

// ---------------------------------------------------------------- detector

/** YAML files under a Helm chart (templates, values) are Helm's, not raw manifests. */
export function helmChartDirs(ctx: ScanContext): Set<string> {
  const dirs = new Set<string>();
  for (const f of ctx.fl.files) if (/(^|\/)Chart\.ya?ml$/.test(f) && !isFixturePath(f)) dirs.add(dirname(f));
  return dirs;
}

function inChart(file: string, charts: Set<string>): boolean {
  let d = dirname(file);
  for (;;) {
    if (charts.has(d)) return true;
    if (d === "") return false;
    d = dirname(d);
  }
}

export function detectKubernetes(ctx: ScanContext, report: InfraReport, charts: Set<string>): void {
  const yamlFiles = ctx.fl.files.filter((f) => /\.ya?ml$/.test(f) && !isFixturePath(f) && !inChart(f, charts));
  const kustFiles = ctx.fl.files.filter((f) => KUSTOMIZATION_NAMES.has(f.slice(f.lastIndexOf("/") + 1)) && !isFixturePath(f));
  if (yamlFiles.length > MAX_YAML_FILES) report.truncated = true;
  const objsByFile = new Map<string, K8sObj[]>();
  const kustSet = new Set(kustFiles);
  let read = 0;
  for (const f of yamlFiles.slice(0, MAX_YAML_FILES)) {
    if (kustSet.has(f)) continue;
    const text = readCached(ctx, f);
    read++;
    if (text === null || text.length > MAX_YAML_BYTES || !/^apiVersion:/m.test(text) || !/^kind:/m.test(text)) continue;
    const objs = readK8sObjects(f, text).filter((o) => o.kind !== "Kustomization" && o.kind !== "Component");
    if (objs.length > 0) objsByFile.set(f, objs);
  }
  report.filesRead += read + kustFiles.length;
  const kusts = kustFiles.map((f) => readKustomization(ctx, f)).filter((k): k is Kustomization => k !== null);
  if (objsByFile.size === 0 && kusts.length === 0) return;
  const kustByDir = new Map(kusts.map((k) => [k.dir, k]));
  const referenced = new Set<string>();
  const usedFiles = new Set<string>();
  for (const k of kusts) {
    for (const r of k.resources) {
      if (kustByDir.has(r)) referenced.add(r);
      usedFiles.add(r);
    }
    for (const p of k.patches) usedFiles.add(p);
  }
  const roots = kusts.filter((k) => !referenced.has(k.dir)).sort((a, b) => byString(a.dir, b.dir));

  const patchesOf = (k: Kustomization): K8sObj[] => {
    const out: K8sObj[] = [];
    for (const p of k.patches) {
      const text = readCached(ctx, p);
      if (text !== null) out.push(...readK8sObjects(p, text.includes("apiVersion:") ? text : `apiVersion: v1\n${text}`));
    }
    for (const t of k.inlinePatches) out.push(...readK8sObjects(k.file, t.includes("apiVersion:") ? t : `apiVersion: v1\n${t}`));
    return out;
  };

  const render = (k: Kustomization, depth: number, seen: Set<string>): K8sObj[] => {
    if (depth > 8 || seen.has(k.dir)) return [];
    const next = new Set([...seen, k.dir]);
    let objs: K8sObj[] = [];
    for (const r of k.resources) {
      const sub = kustByDir.get(r);
      if (sub !== undefined) objs.push(...render(sub, depth + 1, next));
      else if (objsByFile.has(r)) objs.push(...(objsByFile.get(r) ?? []).map((o) => ({ ...o, containers: o.containers.map((c) => ({ ...c })) })));
      else {
        // A directory without a kustomization: every manifest directly in it.
        for (const [f, list] of objsByFile) if (dirname(f) === r) objs.push(...list.map((o) => ({ ...o, containers: o.containers.map((c) => ({ ...c })) })));
      }
    }
    for (const h of k.helmCharts) {
      objs.push({ file: k.file, line: 1, kind: "HelmChart", apiVersion: "kustomize", name: h.releaseName ?? h.name, labels: {}, podLabels: {}, containers: [], refs: [], chart: h.name, ...(h.repo !== undefined ? { chartRepo: h.repo } : {}), ...(h.version !== undefined ? { chartVersion: h.version } : {}), ...(h.namespace !== undefined ? { namespace: h.namespace } : {}) });
    }
    // Strategic-merge patches: replicas and container images.
    for (const p of patchesOf(k)) {
      const target = objs.find((o) => o.kind === p.kind && o.name === p.name);
      if (target === undefined) continue;
      if (p.replicas !== undefined) target.replicas = p.replicas;
      for (const pc of p.containers) {
        const tc = target.containers.find((c) => c.name === pc.name);
        if (tc !== undefined && pc.image !== undefined) tc.image = pc.image;
      }
    }
    objs = objs.map((o) => {
      const cluster = /^(Namespace|ClusterRole|ClusterRoleBinding|CustomResourceDefinition|StorageClass|PriorityClass|PersistentVolume)$/.test(o.kind);
      const renamed = /^(Namespace|CustomResourceDefinition)$/.test(o.kind) ? o.name : `${k.namePrefix ?? ""}${o.name}${k.nameSuffix ?? ""}`;
      const out: K8sObj = { ...o, name: renamed };
      if (!cluster && k.namespace !== undefined) out.namespace = k.namespace;
      for (const c of out.containers) if (c.image !== undefined) c.image = applyImage(c.image, k.images);
      const rep = k.replicas.find((r) => r.name === o.name);
      if (rep !== undefined) out.replicas = rep.count;
      if (k.namePrefix !== undefined || k.nameSuffix !== undefined) {
        if (out.rules !== undefined && ROUTE_KINDS.has(out.kind)) {
          out.rules = out.rules.map((r) => ({ ...r, service: `${k.namePrefix ?? ""}${r.service}${k.nameSuffix ?? ""}` }));
        }
        out.refs = out.refs.map((r) => {
          const [kind = "", name = ""] = r.split("/");
          return `${kind}/${k.namePrefix ?? ""}${name}${k.nameSuffix ?? ""}`;
        });
      }
      return out;
    });
    return objs;
  };

  const scan: { obj: K8sObj; group: string; tool: InfraTool; root?: Kustomization }[] = [];
  const groups = new Map<string, InfraGroup>();
  const groupFor = (env: string | undefined, namespace: string | undefined, path: string, file: string): InfraGroup => {
    // A namespace named like an environment joins that environment's group.
    const key = env !== undefined ? `k8s:${env}` : groups.has(`k8s:${namespace ?? "default"}`) ? `k8s:${namespace ?? "default"}` : `k8s:ns:${namespace ?? "default"}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key,
        tool: "kubernetes",
        name: `Kubernetes: ${env ?? namespace ?? "default"}`,
        kind: env !== undefined ? "environment" : "namespace",
        ...(path !== "" ? { path } : {}),
        files: [],
        settings: {},
        details: [],
        hints: env !== undefined ? [env] : [namespace ?? "default"],
      };
      groups.set(key, g);
    }
    if (!g.files.includes(file)) g.files.push(file);
    return g;
  };
  const clusterScoped = (o: K8sObj): boolean => o.namespace === undefined && CLUSTER_KINDS.has(o.kind);
  for (const root of roots) {
    const env = envOf(root.dir);
    const touched = new Set<InfraGroup>();
    const rendered = render(root, 0, new Set());
    // Cluster-scoped objects (Namespace, ClusterRole, CRDs, …) join the root's main group, not "default".
    const counts = new Map<string, number>();
    for (const obj of rendered) if (!clusterScoped(obj)) counts.set(obj.namespace ?? "", (counts.get(obj.namespace ?? "") ?? 0) + 1);
    const mainNs = [...counts].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0]?.[0];
    for (const obj of rendered) {
      const ns = clusterScoped(obj) && mainNs !== undefined && mainNs !== "" ? mainNs : obj.namespace;
      const g = groupFor(env, ns, root.dir, root.file);
      touched.add(g);
      scan.push({ obj, group: g.key, tool: "kustomize", root });
      if (obj.namespace !== undefined) g.settings.namespaces = uniq([...(g.settings.namespaces?.split(", ") ?? []), obj.namespace]).sort().join(", ");
    }
    // Roots rendered into a group (CI `kubectl apply -k <dir>` resolves through these).
    for (const g of touched) g.settings.overlays = uniq([...(g.settings.overlays?.split(", ") ?? []), root.dir]).sort().join(", ");
  }
  for (const [f, list] of [...objsByFile].sort((a, b) => byString(a[0], b[0]))) {
    if (usedFiles.has(f) || usedFiles.has(dirname(f))) continue;
    for (const obj of list) {
      // A workload without containers is a patch applied some other way (kubectl patch), not an object.
      if (WORKLOAD_KINDS.has(obj.kind) && obj.containers.length === 0) continue;
      const g = groupFor(undefined, obj.namespace, dirname(f), f);
      scan.push({ obj, group: g.key, tool: "kubernetes" });
    }
  }

  // Items per group.
  const items: InfraItem[] = [];
  const links: InfraLink[] = [];
  const itemByGroupName = new Map<string, InfraItem>(); // `${group}\0${Kind}/${name}`
  const configHosts = new Map<string, string[]>(); // `${group}\0${name}` → hosts
  const services: { group: string; obj: K8sObj }[] = [];
  for (const { obj, group, tool } of scan) {
    const g = groups.get(group);
    if (g === undefined) continue;
    const ev = `${obj.file}:${obj.line}`;
    if (obj.kind === "Service") {
      services.push({ group, obj });
      continue;
    }
    if (obj.kind === "ConfigMap") {
      configHosts.set(`${group}\u0000${obj.name}`, obj.configHosts ?? []);
      g.details.push(`ConfigMap ${obj.name}`);
      continue;
    }
    if (obj.kind === "Secret" || obj.kind === "SealedSecret" || obj.kind === "ExternalSecret") {
      g.details.push(`${obj.kind} ${obj.name} (values not read)`);
      continue;
    }
    const isWorkload = WORKLOAD_KINDS.has(obj.kind);
    const isRoute = ROUTE_KINDS.has(obj.kind);
    const isRelease = RELEASE_KINDS.has(obj.kind) && obj.chart !== undefined;
    if (!isWorkload && !isRoute && !isRelease) {
      g.details.push(`${obj.kind} ${obj.name}`.trim());
      continue;
    }
    const key = `${group}:${obj.kind}/${obj.name}`;
    if (itemByGroupName.has(`${group}\u0000${obj.kind}/${obj.name}`)) continue;
    const settings: Record<string, string> = {};
    const images = uniq(obj.containers.map((c) => c.image).filter((i): i is string => i !== undefined));
    let category: InfraCategory = isRoute ? "gateway" : isRelease ? "release" : obj.kind === "CronJob" || obj.kind === "Job" ? "job" : "workload";
    let infraKind: string | undefined;
    const tech: string[] = [isRelease ? `Helm chart ${obj.chart ?? ""}`.trim() : `Kubernetes ${obj.kind}`];
    if (isWorkload) {
      if (obj.replicas !== undefined) settings.replicas = obj.replicas;
      if (images[0] !== undefined) settings.image = images.join(", ");
      const ports = uniq(obj.containers.flatMap((c) => c.ports));
      if (ports.length > 0) settings.ports = ports.join(", ");
      if (obj.schedule !== undefined) settings.schedule = obj.schedule;
      if (obj.serviceAccount !== undefined) settings.serviceAccount = obj.serviceAccount;
      // A product image makes a long-running workload that product; a Job / CronJob using it (pg_dump, bootstrap) stays a job.
      const kind = category === "job" ? undefined : images.map((i) => infraFromImage(i)).find((k) => k !== undefined);
      if (kind !== undefined) {
        infraKind = kind.key;
        category = kind.type === "datastore" ? "database" : kind.key === "redis" ? "cache" : kind.type === "queue" ? "queue" : kind.type === "gateway" ? "gateway" : category;
        tech.push(kind.name);
      }
    } else if (isRoute) {
      const hosts = uniq((obj.rules ?? []).map((r) => r.host).filter((h) => h !== "*"));
      if (hosts.length > 0) settings.hosts = hosts.join(", ");
      if (obj.className !== undefined) settings.class = obj.className;
    } else if (obj.chart !== undefined) {
      settings.chart = obj.chart;
      if (obj.chartRepo !== undefined) settings.repo = obj.chartRepo;
      if (obj.chartVersion !== undefined) settings.version = obj.chartVersion;
      const kind = infraFromImage(obj.chart.replace(/^.*\//, "").replace(/^postgresql$/, "postgres").replace(/^mongodb$/, "mongo"));
      if (kind !== undefined) {
        infraKind = kind.key;
        category = kind.type === "datastore" ? "database" : kind.key === "redis" ? "cache" : kind.type === "queue" ? "queue" : kind.type === "gateway" ? "gateway" : category;
      }
    }
    if (obj.namespace !== undefined) settings.namespace = obj.namespace;
    const item: InfraItem = {
      key: `k8s:${key}`,
      group,
      tool,
      kind: obj.kind,
      address: `${obj.namespace ?? "default"}/${obj.kind}/${obj.name}`,
      name: obj.name,
      category,
      file: obj.file,
      line: obj.line,
      settings: Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, safeSetting(k, v)]).filter((e): e is [string, string] => e[1] !== undefined)),
      details: obj.refs.map((r) => (r.startsWith("Secret/") ? `${r.replace("/", " ")} (values not read)` : r.replace("/", " "))),
      hints: uniq([obj.name, `${obj.namespace ?? "default"}/${obj.name}`, `${obj.kind.toLowerCase()}/${obj.name}`, ...Object.entries(obj.labels).filter(([k]) => k === "app" || k === "app.kubernetes.io/name").map(([, v]) => v)]),
      images,
      tech,
      ...(infraKind !== undefined ? { infraKind } : {}),
      ...(obj.refs.length > 0 ? { refs: obj.refs } : {}),
    };
    items.push(item);
    itemByGroupName.set(`${group}\u0000${obj.kind}/${obj.name}`, item);
    for (const img of images) links.push({ from: { item: item.key }, to: { image: img }, label: "runs", kind: "deploy", evidence: [ev] });
    if (infraKind !== undefined) links.push({ from: { item: item.key }, to: { infraKind }, label: "runs", kind: "deploy", evidence: [ev] });
  }

  // Services → the workloads they select.
  const workloadsIn = (group: string): InfraItem[] => items.filter((i) => i.group === group && (i.category !== "gateway" || WORKLOAD_KINDS.has(i.kind)) && i.category !== "release");
  const podLabelsOf = new Map<string, Record<string, string>>();
  for (const { obj, group } of scan) if (WORKLOAD_KINDS.has(obj.kind)) podLabelsOf.set(`${group}\u0000${obj.kind}/${obj.name}`, obj.podLabels);
  const serviceTargets = new Map<string, InfraItem[]>(); // `${group}\0${service}` → workloads
  for (const { group, obj } of services) {
    const sel = obj.selector ?? {};
    const targets = workloadsIn(group).filter((w) => {
      const labels = podLabelsOf.get(`${group}\u0000${w.kind}/${w.name}`) ?? {};
      const entries = Object.entries(sel);
      return entries.length > 0 && entries.every(([k, v]) => labels[k] === v) && (obj.namespace === undefined || w.settings.namespace === undefined || w.settings.namespace === obj.namespace);
    });
    serviceTargets.set(`${group}\u0000${obj.name}`, targets);
    const desc = `Service ${obj.name} (${obj.serviceType ?? "ClusterIP"}${obj.servicePorts?.length ? ` ${obj.servicePorts.join(", ")}` : ""})`;
    if (targets.length === 0) {
      groups.get(group)?.details.push(desc);
      continue;
    }
    for (const t of targets) {
      t.details.push(desc);
      t.hints = uniq([...t.hints, obj.name]);
      t.settings.service = `${obj.serviceType ?? "ClusterIP"}${obj.servicePorts?.length ? ` ${obj.servicePorts.join(", ")}` : ""}`;
    }
  }

  // Routes → workloads through Services.
  for (const route of items.filter((i) => ROUTE_KINDS.has(i.kind))) {
    const obj = scan.find((s) => s.group === route.group && s.obj.kind === route.kind && s.obj.name === route.name)?.obj;
    for (const rule of obj?.rules ?? []) {
      const targets = serviceTargets.get(`${route.group}\u0000${rule.service}`) ?? [];
      const label = `${rule.host === "*" ? "" : rule.host}${rule.path !== "/" ? rule.path : ""}`.slice(0, 40) || "routes";
      for (const t of targets) links.push({ from: { item: route.key }, to: { item: t.key }, label, kind: "sync", evidence: [`${route.file}:${route.line}`] });
      if (targets.length === 0) route.details.push(`→ Service ${rule.service} (not in this repo's manifests)`);
    }
  }

  const configUsers = new Map<string, number>(); // `${group}\0ConfigMap/<name>` → workloads using it
  for (const w of items) for (const r of w.refs ?? []) if (r.startsWith("ConfigMap/")) configUsers.set(`${w.group}\u0000${r}`, (configUsers.get(`${w.group}\u0000${r}`) ?? 0) + 1);
  // Env / ConfigMap hosts → other workloads (through their Service or name) or infra kinds.
  for (const w of items.filter((i) => WORKLOAD_KINDS.has(i.kind))) {
    const obj = scan.find((s) => s.group === w.group && s.obj.kind === w.kind && s.obj.name === w.name)?.obj;
    if (obj === undefined) continue;
    const hosts: { host: string; label: string; ev: string }[] = [];
    const fileLines = (readCached(ctx, w.file) ?? "").split(/\r?\n/);
    const valueLine = (value: string): number => {
      const needle = value.trim().slice(0, 60);
      const i = fileLines.findIndex((l, idx) => idx >= w.line - 1 && l.includes(needle));
      return i === -1 ? w.line : i + 1;
    };
    for (const c of obj.containers) {
      for (const e of c.env) {
        if (e.value === undefined) continue;
        const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(e.value)?.[1];
        const label = scheme === undefined ? "calls" : /^https?$/.test(scheme) ? "HTTP" : /^grpcs?$/.test(scheme) ? "gRPC" : /^wss?$/.test(scheme) ? "WebSocket" : "calls";
        for (const h of hostsIn(e.value, e.name)) hosts.push({ host: h, label, ev: `${w.file}:${valueLine(e.value)}` });
      }
    }
    for (const r of obj.refs) {
      // A ConfigMap shared by many workloads (every service URL in one place) says nothing about who calls whom.
      if (!r.startsWith("ConfigMap/") || (configUsers.get(`${w.group}\u0000${r}`) ?? 0) > 2) continue;
      for (const h of configHosts.get(`${w.group}\u0000${r.slice(10)}`) ?? []) hosts.push({ host: h, label: "calls", ev: `${w.file}:${w.line}` });
    }
    const seen = new Set<string>();
    for (const { host, label, ev } of hosts) {
      const short = serviceHost(host);
      const first = host.split(".")[0] ?? host;
      const targets = serviceTargets.get(`${w.group}\u0000${short}`) ?? serviceTargets.get(`${w.group}\u0000${first}`) ?? workloadsIn(w.group).filter((x) => x.name === short);
      for (const t of targets) {
        if (t.key === w.key || seen.has(t.key)) continue;
        seen.add(t.key);
        links.push({ from: { item: w.key }, to: { item: t.key }, label: t.infraKind !== undefined ? kindLabel(t.infraKind) : label, kind: t.category === "database" ? "data" : t.category === "queue" || t.category === "cache" ? "async" : "sync", evidence: [ev] });
      }
      if (targets.length > 0) continue;
      const kind = infraFromImage(short);
      if (kind !== undefined) {
        if (!seen.has(kind.key)) {
          seen.add(kind.key);
          links.push({ from: { item: w.key }, to: { infraKind: kind.key }, label: kind.label, kind: kind.type === "datastore" ? "data" : kind.type === "queue" ? "async" : "sync", evidence: [ev] });
        }
        continue;
      }
      // Not in these manifests: maybe a code service by name (resolved by the graph).
      if (!seen.has(`code:${short}`)) {
        seen.add(`code:${short}`);
        links.push({ from: { item: w.key }, to: { codeName: short }, label, kind: "sync", evidence: [ev] });
      }
    }
  }

  for (const g of groups.values()) {
    g.details = uniq(g.details).sort(byString);
    g.files.sort(byString);
  }
  for (const it of items) it.details = uniq(it.details).sort(byString);
  report.groups.push(...[...groups.values()].sort((a, b) => byString(a.key, b.key)));
  report.items.push(...items.sort((a, b) => byString(a.key, b.key)));
  report.links.push(...links);
}

function kindLabel(key: string): string {
  const labels: Record<string, string> = { postgres: "sql", mysql: "sql", mongo: "queries", redis: "cache", kafka: "events", rabbitmq: "messages", nats: "messages", elasticsearch: "search", minio: "objects", clickhouse: "sql" };
  return labels[key] ?? "calls";
}

