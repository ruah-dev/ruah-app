// Maps an InfraReport onto the architecture (CONTRACTS.md §11).
//
// - Groups become top-level nodes ("Terraform: AWS", "Kubernetes: prod",
//   "Helm: api", "Ansible", "CI/CD: GitHub Actions"); when there are more than
//   MAX_TOP_GROUPS, the groups of a tool with several go under one node per
//   tool ("Kubernetes") so the top level stays readable.
// - Items become their children: typed by category (datastore, cache,
//   storage, queue, cluster, container, worker, gateway, dns, …), layered
//   edge / services / data / infra.
// - Links become edges with evidence; ends are resolved to nodes: items,
//   groups, code packages (by directory, Dockerfile, image, name) and the
//   top-level infra nodes the rest of the scan made (Postgres, Redis, AWS S3).
//   An edge between nodes on different levels is also lifted to the level
//   where both ends are visible (group → code service "runs").
// - Pipelines become "how it ships" workflows: code → pipeline → registry →
//   the workloads that run the image (or the deploy target).
// - Code nodes packaged by a Dockerfile / compose service get `infra` details.
// Compose services are not re-created (the scanner already made them).
import type { ArchEdge, ArchNode, InfraDetails, Workflow } from "../../contracts/architecture.js";
import { infraFromImage } from "../detectors/compose.js";
import { type IdAllocator, slug } from "../modules.js";
import {
  byString,
  imageName,
  imageRepo,
  uniq,
  type DockerfileInfo,
  type InfraCategory,
  type InfraEnd,
  type InfraGroup,
  type InfraItem,
  type InfraReport,
  type InfraTool,
} from "./model.js";

export const MAX_TOP_GROUPS = 6;
const MAX_DETAILS = 40;
const MAX_SOURCE = 10;

export interface InfraGraphEnv {
  ids: IdAllocator;
  /** Code packages: directory ("" = repo root), node id, declared name. */
  owners: { dir: string; id: string; name: string }[];
  /** Existing nodes (code, compose, infra kinds, externals) — for parents and lifting. */
  nodes: readonly ArchNode[];
  /** INFRA_KINDS key → top-level node id (postgres → "postgres"). */
  infraNodeByKind: ReadonlyMap<string, string>;
  /** EXTERNAL_KINDS key → node id (s3 → "s3"). */
  externalIds: ReadonlyMap<string, string>;
  /** compose service name → node id. */
  composeIds: ReadonlyMap<string, string>;
}

export interface InfraGraph {
  nodes: ArchNode[];
  edges: ArchEdge[];
  workflows: Workflow[];
  /** `infra` details for nodes the rest of the scan made (code packages, compose services). */
  annotations: Map<string, InfraDetails>;
}

const TYPE_OF: Record<InfraCategory, string> = {
  workload: "container", job: "worker", compute: "service", function: "function", frontend: "frontend", server: "server",
  database: "datastore", cache: "cache", storage: "storage", queue: "queue", search: "search", registry: "registry",
  cluster: "cluster", gateway: "gateway", loadbalancer: "loadbalancer", dns: "dns", cdn: "cdn", firewall: "firewall",
  secret: "secret", monitoring: "monitoring", pipeline: "pipeline", platform: "external", release: "service", other: "module",
};

const LAYER_OF: Record<InfraCategory, string> = {
  gateway: "edge", loadbalancer: "edge", dns: "edge", cdn: "edge", firewall: "edge",
  workload: "services", job: "services", compute: "services", function: "services", frontend: "services", server: "services",
  release: "services", platform: "services", pipeline: "services",
  database: "data", cache: "data", storage: "data", queue: "data", search: "data", registry: "data",
  cluster: "infra", secret: "infra", monitoring: "infra", other: "infra",
};

const GROUP_TYPE: Record<InfraTool, string> = {
  terraform: "cloud", kubernetes: "cluster", kustomize: "cluster", helm: "cluster", ansible: "cluster", ci: "pipeline", compose: "cluster", docker: "cluster",
};

const TOOL_NAME: Record<InfraTool, string> = {
  terraform: "Terraform", kubernetes: "Kubernetes", kustomize: "Kustomize", helm: "Helm", ansible: "Ansible", ci: "CI/CD", compose: "Docker Compose", docker: "Docker",
};

function normName(n: string): string {
  return n.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function settingsText(s: Record<string, string>, keys: string[]): string {
  return keys.filter((k) => s[k] !== undefined).map((k) => `${k} ${s[k]}`).join(", ");
}

function describeItem(it: InfraItem, group: InfraGroup): string {
  const where = `${it.file}:${it.line}`;
  const s = it.settings;
  let text: string;
  switch (it.category) {
    case "workload":
    case "job": {
      const runs = s.image !== undefined ? `${s.replicas !== undefined ? `${s.replicas} × ` : ""}${s.image}` : s.replicas !== undefined ? `${s.replicas} replicas` : "";
      text = `${it.tech[0] ?? it.kind} ${it.name} in ${group.name}${runs !== "" ? `: runs ${runs}` : ""}${s.ports !== undefined ? `, ports ${s.ports}` : ""}${s.schedule !== undefined ? `, schedule ${s.schedule}` : ""}${s.service !== undefined ? `, Service ${s.service}` : ""}.`;
      break;
    }
    case "gateway":
      text = `${it.tech[0] ?? it.kind} ${it.name}${s.hosts !== undefined ? ` for ${s.hosts}` : ""}${s.class !== undefined ? ` (${s.class})` : ""}.`;
      break;
    case "server":
      text = `Ansible host group ${it.name}${s.hosts !== undefined ? ` (${s.hosts})` : ""}${s.roles !== undefined ? `; roles ${s.roles}` : ""}.`;
      break;
    case "pipeline":
      text = `${it.tech[0] ?? "CI"} pipeline "${it.name}"${s.triggers !== undefined ? ` on ${s.triggers}` : ""}${s.builds !== undefined ? `; builds ${s.builds}` : ""}${s.deploys !== undefined ? `; deploys with ${s.deploys}` : ""}.`;
      break;
    default: {
      const keys = ["engine", "engine_version", "database_version", "instance_class", "instance_type", "machine_type", "server_type", "node_type", "size", "tier", "allocated_storage", "multi_az", "node_count", "desired_count", "kubernetes_version", "runtime", "region", "location", "chart", "version"];
      const st = settingsText(s, keys);
      text = `${it.tech[0] ?? it.kind} ${it.address}${st !== "" ? ` (${st})` : ""}.`;
    }
  }
  return clip(`${text} Declared in ${where}.`, 400);
}

function describeGroup(g: InfraGroup, items: readonly InfraItem[]): string {
  const count = items.length;
  const n = (c: InfraCategory[]): number => items.filter((i) => c.includes(i.category)).length;
  const what: Record<string, string> = {
    provider: `Terraform root ${g.settings.root ?? ""} — ${count} resource${count === 1 ? "" : "s"}${g.details.length > 0 ? ` (+${g.details.length} folded: IAM, network, attachments)` : ""}`,
    environment: `Kubernetes environment rendered from ${g.settings.overlays ?? "manifests"}: ${count} workload${count === 1 ? "" : "s"} / route${count === 1 ? "" : "s"}`,
    namespace: `Kubernetes manifests in namespace ${g.hints[0] ?? "default"}: ${count} workload${count === 1 ? "" : "s"} / route${count === 1 ? "" : "s"}`,
    chart: `Helm chart ${g.settings.chart ?? ""}${g.settings.version !== undefined ? ` ${g.settings.version}` : ""}: ${count} workload${count === 1 ? "" : "s"} / dependenc${count === 1 ? "y" : "ies"}`,
    inventory: `Ansible playbooks (${g.settings.playbooks ?? ""}): ${count} host group${count === 1 ? "" : "s"} / service${count === 1 ? "" : "s"}`,
    pipelines: `CI/CD: ${n(["pipeline"])} pipeline${n(["pipeline"]) === 1 ? "" : "s"} that build or deploy, ${n(["registry"])} registr${n(["registry"]) === 1 ? "y" : "ies"}, ${n(["platform"])} platform${n(["platform"]) === 1 ? "" : "s"}${g.details.length > 0 ? ` (+${g.details.length} other workflow${g.details.length === 1 ? "" : "s"})` : ""}`,
  };
  return clip(`${what[g.kind] ?? `${g.name}: ${count} items`}.`, 400);
}

function details(item: { details: string[] }): string[] | undefined {
  if (item.details.length === 0) return undefined;
  return item.details.length > MAX_DETAILS ? [...item.details.slice(0, MAX_DETAILS - 1), `… +${item.details.length - MAX_DETAILS + 1} more`] : [...item.details];
}

function infraOf(tool: string, kind: string, source: string[], settings: Record<string, string>, det: string[] | undefined, hints: string[], address?: string): InfraDetails {
  return {
    tool,
    kind,
    ...(address !== undefined ? { address } : {}),
    ...(source.length > 0 ? { source: uniq(source).slice(0, MAX_SOURCE) } : {}),
    ...(Object.keys(settings).length > 0 ? { settings: { ...settings } } : {}),
    ...(det !== undefined ? { details: det } : {}),
    ...(hints.length > 0 ? { hints: uniq(hints).slice(0, 20) } : {}),
  };
}

export function buildInfraGraph(report: InfraReport, env: InfraGraphEnv): InfraGraph {
  const nodes: ArchNode[] = [];
  const annotations = new Map<string, InfraDetails>();

  // ---- code resolution ----
  const owners = [...env.owners].sort((a, b) => b.dir.length - a.dir.length);
  const monorepo = !owners.some((o) => o.dir === "") || owners.length > 1;
  const ownerOfDir = (dir: string): string | undefined => {
    for (const o of owners) {
      if (o.dir === "" && monorepo && owners.length > 1) continue;
      if (o.dir === dir || o.dir === "" || dir.startsWith(`${o.dir}/`)) return o.id;
    }
    return undefined;
  };
  const byName = new Map<string, string[]>();
  for (const o of env.owners) {
    for (const n of uniq([normName(o.name), normName(o.dir.slice(o.dir.lastIndexOf("/") + 1))]).filter((x) => x !== "")) byName.set(n, uniq([...(byName.get(n) ?? []), o.id]));
  }
  const ownerByName = (name: string): string | undefined => {
    const hits = byName.get(normName(name));
    return hits !== undefined && hits.length === 1 ? hits[0] : undefined;
  };
  const dockerOwner = new Map<string, string>();
  const dockerByFile = new Map(report.dockerfiles.map((d) => [d.file, d]));
  const ownerOfDockerfile = (d: DockerfileInfo): string | undefined => {
    const cached = dockerOwner.get(d.file);
    if (cached !== undefined) return cached;
    let id = ownerOfDir(d.dir);
    if (id === undefined && d.nameHint !== undefined) id = ownerByName(d.nameHint);
    if (id === undefined) {
      const fromCopies = uniq(d.copies.map((c) => env.owners.find((o) => o.dir !== "" && (c === o.dir || c.startsWith(`${o.dir}/`)))?.id).filter((x): x is string => x !== undefined));
      if (fromCopies.length === 1) id = fromCopies[0];
    }
    if (id === undefined) {
      const fromFilters = uniq(d.filters.map((f) => ownerByName(f.replace(/\.\.\.$/, "")) ?? ownerOfDir(f)).filter((x): x is string => x !== undefined));
      if (fromFilters.length === 1) id = fromFilters[0];
    }
    if (id !== undefined) dockerOwner.set(d.file, id);
    return id;
  };
  // Images built from known code: pipelines and compose.
  const imageOwner = new Map<string, string>();
  for (const p of report.pipelines) {
    for (const b of p.builds) {
      if (b.image === undefined || b.image.includes("*")) continue;
      const df = b.dockerfile !== undefined ? dockerByFile.get(b.dockerfile) : b.context !== undefined ? dockerByFile.get(b.context === "" || b.context === "." ? "Dockerfile" : `${b.context}/Dockerfile`) : undefined;
      const id = (df !== undefined ? ownerOfDockerfile(df) : undefined) ?? (b.context !== undefined && b.context !== "compose" ? ownerOfDir(b.context === "." ? "" : b.context) : undefined);
      if (id !== undefined) imageOwner.set(imageRepo(b.image), id);
    }
  }
  for (const it of report.items.filter((i) => i.tool === "compose")) {
    const build = it.settings.build;
    const img = it.images[0];
    if (build === undefined || img === undefined) continue;
    const id = ownerOfDir(build === "." ? "" : build);
    if (id !== undefined) imageOwner.set(imageRepo(img), id);
  }
  const composeImage = new Map<string, string>();
  const composeCode = new Set<string>();
  for (const it of report.items.filter((i) => i.tool === "compose" && i.infraKind === undefined)) {
    const id = env.composeIds.get(it.name);
    if (id === undefined) continue;
    composeCode.add(normName(it.name));
    const img = it.images[0];
    if (img !== undefined) composeImage.set(imageRepo(img), id);
  }
  const ownerOfImage = (image: string): string | undefined => {
    if (image.includes("*") && !image.includes("/")) return undefined;
    const repo = imageRepo(image);
    const exact = imageOwner.get(repo);
    if (exact !== undefined) return exact;
    const name = imageName(image);
    if (name === "" || name === "*") return undefined;
    const viaIndex = uniq([...imageOwner].filter(([r]) => imageName(r) === name).map(([, id]) => id));
    if (viaIndex.length === 1) return viaIndex[0];
    if (infraFromImage(image) !== undefined) return undefined; // postgres, redis, nginx: products, not code
    // A compose service running the same image (or named like it) stands for that service.
    const composeHit = composeImage.get(repo) ?? (composeCode.has(name) ? env.composeIds.get(name) : undefined);
    return ownerByName(name) ?? composeHit;
  };

  // ---- groups ----
  const itemsByGroup = new Map<string, InfraItem[]>();
  for (const it of report.items) itemsByGroup.set(it.group, [...(itemsByGroup.get(it.group) ?? []), it]);
  const groups = report.groups.filter((g) => g.tool !== "compose" && ((itemsByGroup.get(g.key)?.length ?? 0) > 0 || g.details.length > 0)).sort((a, b) => byString(a.key, b.key));
  const toolCount = new Map<string, number>();
  const toolOf = (g: InfraGroup): string => (g.tool === "kustomize" ? "kubernetes" : g.tool);
  for (const g of groups) toolCount.set(toolOf(g), (toolCount.get(toolOf(g)) ?? 0) + 1);
  const umbrella = new Map<string, string>(); // tool → node id
  if (groups.length > MAX_TOP_GROUPS) {
    for (const [tool, n] of [...toolCount].sort((a, b) => byString(a[0], b[0]))) {
      if (n < 2) continue;
      const id = env.ids.take(slug(tool === "terraform" ? "terraform" : tool === "kubernetes" ? "kubernetes" : tool));
      umbrella.set(tool, id);
      const gs = groups.filter((g) => toolOf(g) === tool);
      nodes.push({
        id,
        type: GROUP_TYPE[tool as InfraTool] ?? "cluster",
        name: TOOL_NAME[tool as InfraTool] ?? tool,
        tech: [TOOL_NAME[tool as InfraTool] ?? tool],
        layer: "infra",
        description: clip(`${gs.length} ${TOOL_NAME[tool as InfraTool] ?? tool} groups: ${gs.map((g) => g.name).join(", ")}.`, 400),
        files: uniq(gs.flatMap((g) => g.files)).slice(0, 20),
        infra: infraOf(tool, "tool", [], {}, undefined, []),
      });
    }
  }
  const groupNode = new Map<string, string>();
  const groupBase = (g: InfraGroup): string => {
    switch (g.tool) {
      case "terraform": return `tf-${g.settings.provider ?? "cloud"}${g.name.includes(" (") ? `-${slug(g.settings.root ?? "")}` : ""}`;
      case "kubernetes": case "kustomize": return `k8s-${g.hints[0] ?? "default"}`;
      case "helm": return `helm-${g.settings.chart ?? "chart"}`;
      case "ansible": return g.path !== undefined && groups.filter((x) => x.tool === "ansible").length > 1 ? `ansible-${g.path}` : "ansible";
      case "ci": return g.key === "ci:github" ? "ci" : "ci-gitlab";
      default: return g.key;
    }
  };
  for (const g of groups) {
    const id = env.ids.take(slug(groupBase(g)));
    groupNode.set(g.key, id);
    const items = itemsByGroup.get(g.key) ?? [];
    const parent = umbrella.get(toolOf(g));
    nodes.push({
      id,
      type: GROUP_TYPE[g.tool],
      name: g.name,
      tech: [TOOL_NAME[g.tool]],
      ...(g.path !== undefined ? { path: g.path } : {}),
      layer: "infra",
      ...(parent !== undefined ? { parent } : {}),
      description: describeGroup(g, items),
      files: g.files.slice(0, 20),
      infra: infraOf(g.tool, g.kind, g.files.map((f) => `${f}:1`), g.settings, details(g), g.hints),
    });
  }

  // ---- items ----
  const itemNode = new Map<string, string>();
  for (const g of groups) {
    const gid = groupNode.get(g.key) ?? "";
    for (const it of [...(itemsByGroup.get(g.key) ?? [])].sort((a, b) => byString(a.key, b.key))) {
      const id = env.ids.take(`${gid}.${slug(it.name)}`.slice(0, 64));
      itemNode.set(it.key, id);
      nodes.push({
        id,
        type: TYPE_OF[it.category],
        name: it.name,
        tech: it.tech.slice(0, 3),
        path: it.file,
        layer: LAYER_OF[it.category],
        parent: gid,
        description: describeItem(it, g),
        files: [it.file],
        infra: infraOf(it.tool, it.kind, [`${it.file}:${it.line}`], it.settings, details(it), it.hints, it.address),
      });
    }
  }

  // ---- links → edges ----
  const composeNodes = [...env.composeIds.values()];
  const resolveEnd = (e: InfraEnd): string[] => {
    if ("item" in e) {
      const n = itemNode.get(e.item);
      if (n !== undefined) return [n];
      if (e.item.startsWith("compose:")) {
        const c = env.composeIds.get(e.item.slice(8));
        return c !== undefined ? [c] : [];
      }
      return [];
    }
    if ("group" in e) {
      const n = groupNode.get(e.group);
      return n !== undefined ? [n] : [];
    }
    if ("codeDir" in e) {
      const o = ownerOfDir(e.codeDir);
      if (o !== undefined) return [o];
      const df = dockerByFile.get(e.codeDir === "" ? "Dockerfile" : `${e.codeDir}/Dockerfile`);
      const d = df !== undefined ? ownerOfDockerfile(df) : undefined;
      return d !== undefined ? [d] : [];
    }
    if ("dockerfile" in e) {
      const df = dockerByFile.get(e.dockerfile);
      const d = df !== undefined ? ownerOfDockerfile(df) : ownerOfDir(e.dockerfile.slice(0, Math.max(0, e.dockerfile.lastIndexOf("/"))));
      return d !== undefined ? [d] : [];
    }
    if ("codeName" in e) {
      if (e.codeName === "compose") return composeNodes.slice(0, 8);
      const o = ownerByName(e.codeName) ?? (composeCode.has(normName(e.codeName)) ? env.composeIds.get(e.codeName) : undefined);
      return o !== undefined ? [o] : [];
    }
    if ("image" in e) {
      const o = ownerOfImage(e.image);
      return o !== undefined ? [o] : [];
    }
    const k = e.infraKind;
    const n = env.infraNodeByKind.get(k) ?? env.externalIds.get(k) ?? (k === "s3" ? env.infraNodeByKind.get("minio") : undefined);
    return n !== undefined ? [n] : [];
  };
  const edges = new Map<string, ArchEdge>();
  const addEdge = (from: string, to: string, label: string, kind: string, evidence: string[]): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${label}`;
    const prev = edges.get(key);
    if (prev !== undefined) {
      prev.evidence = uniq([...(prev.evidence ?? []), ...evidence]).sort(byString).slice(0, 10);
      return;
    }
    edges.set(key, { from, to, label: clip(label, 40), kind, source: "scan", ...(evidence.length > 0 ? { evidence: uniq(evidence).sort(byString).slice(0, 10) } : {}) });
  };
  for (const l of report.links) {
    const froms = resolveEnd(l.from);
    const tos = resolveEnd(l.to);
    for (const f of froms) for (const t of tos) addEdge(f, t, l.label, l.kind, l.evidence);
  }

  // A pair linked by "runs" does not also need "deploys" / "configures" (Ansible role and template names).
  const runsPairs = new Set([...edges.values()].filter((e) => e.label === "runs").map((e) => `${e.from}\u0000${e.to}`));
  for (const [k, e] of edges) if ((e.label === "deploys" || e.label === "configures") && runsPairs.has(`${e.from}\u0000${e.to}`)) edges.delete(k);

  // ---- lift edges to the level where both ends are visible ----
  const parentOf = new Map<string, string | undefined>();
  for (const n of [...env.nodes, ...nodes]) parentOf.set(n.id, n.parent);
  const chain = (id: string): string[] => {
    const out = [id];
    let cur = parentOf.get(id);
    for (let i = 0; cur !== undefined && i < 12; i++) {
      out.unshift(cur);
      cur = parentOf.get(cur);
    }
    return out; // root-most first
  };
  for (const e of [...edges.values()]) {
    const a = chain(e.from);
    const b = chain(e.to);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const fa = a[i];
    const tb = b[i];
    if (fa === undefined || tb === undefined || (fa === e.from && tb === e.to)) continue;
    addEdge(fa, tb, e.label ?? "", e.kind ?? "sync", e.evidence ?? []);
  }

  // ---- annotations: code packaged by Dockerfiles, compose services ----
  const docsByOwner = new Map<string, DockerfileInfo[]>();
  for (const d of report.dockerfiles) {
    const o = ownerOfDockerfile(d);
    if (o !== undefined) docsByOwner.set(o, [...(docsByOwner.get(o) ?? []), d]);
  }
  for (const [id, docs] of docsByOwner) {
    const d = docs[0];
    if (d === undefined) continue;
    const settings: Record<string, string> = {};
    if (d.base !== undefined) settings.base = d.base;
    if (d.expose.length > 0) settings.expose = d.expose.join(", ");
    if (d.workdir !== undefined) settings.workdir = d.workdir;
    if (d.cmd !== undefined) settings.cmd = d.cmd;
    if (docs.length > 1) settings.dockerfiles = docs.map((x) => x.file).join(", ");
    const images = [...imageOwner].filter(([, o]) => o === id).map(([r]) => r).sort();
    if (images.length > 0) settings.images = images.join(", ");
    annotations.set(id, infraOf("docker", "Dockerfile", docs.map((x) => `${x.file}:${x.line}`), settings, undefined, images.map(imageName)));
  }
  for (const it of report.items.filter((i) => i.tool === "compose")) {
    const id = env.composeIds.get(it.name);
    if (id === undefined) continue;
    const prev = annotations.get(id);
    if (prev !== undefined) {
      annotations.set(id, { ...prev, source: uniq([...(prev.source ?? []), `${it.file}:${it.line}`]).slice(0, MAX_SOURCE), settings: { ...(prev.settings ?? {}), compose: it.name } });
    } else {
      annotations.set(id, infraOf("compose", "service", [`${it.file}:${it.line}`], it.settings, undefined, [it.name], it.address));
    }
  }

  // ---- workflows: how it ships ----
  const workflows: Workflow[] = [];
  const wfIds = new Set<string>();
  const groupIds = new Set([...groupNode.values(), ...umbrella.values()]);
  const edgeList = [...edges.values()];
  const runs = (node: string, code: string): boolean => edgeList.some((e) => e.from === node && e.to === code && e.label === "runs");
  const childrenOf = (id: string): string[] => nodes.filter((n) => n.parent === id).map((n) => n.id);
  const nameOf = (id: string): string => nodes.find((n) => n.id === id)?.name ?? env.nodes.find((n) => n.id === id)?.name ?? id;
  for (const p of report.pipelines) {
    const pid = itemNode.get(p.itemKey);
    if (pid === undefined) continue;
    const codeIds = uniq(edgeList.filter((e) => e.from === pid && e.label === "builds").map((e) => e.to).filter((t) => !itemNode.has(t) && !nodes.some((n) => n.id === t))).sort();
    const registries = uniq(edgeList.filter((e) => e.from === pid && e.label === "pushes").map((e) => e.to));
    const targets = uniq(p.deploys.flatMap((d) => d.targets.flatMap(resolveEnd)));
    const tools = uniq(p.deploys.map((d) => (d.tool === "platform" ? d.target : d.tool)));
    const describe = (what: string): string => clip(`${p.name} (${p.file})${what}${tools.length > 0 ? `; deploys with ${tools.join(", ")}` : ""}.`, 400);
    const push = (base: string, name: string, description: string, steps: string[]): void => {
      const s = uniq(steps);
      if (s.length < 2) return;
      let id = slug(base).slice(0, 60);
      for (let n = 2; wfIds.has(id); n++) id = `${slug(base).slice(0, 56)}-${n}`;
      wfIds.add(id);
      workflows.push({ id, name, description, steps: s, source: "scan" });
    };
    for (const code of codeIds) {
      // The workloads in the deploy targets that run this code; else the targets themselves.
      const expanded = targets.flatMap((t) => [t, ...childrenOf(t), ...childrenOf(t).flatMap(childrenOf)]);
      const running = uniq(expanded.filter((t) => !groupIds.has(t) && runs(t, code)));
      const images = uniq(p.builds.map((b) => b.image).filter((i): i is string => i !== undefined && !i.includes("*") && ownerOfImage(i) === code));
      push(`ship-${nameOf(code)}`, `Ship ${nameOf(code)}`, describe(` builds ${images.length > 0 ? images.join(", ") : "the image"}`), [code, pid, ...registries.slice(0, 1), ...(running.length > 0 ? running.slice(0, 4) : targets.slice(0, 4))]);
    }
    if (codeIds.length === 0 && targets.length > 0) push(`deploy-${p.name}`, `Deploy: ${p.name}`, describe(""), [pid, ...targets.slice(0, 5)]);
  }

  return { nodes, edges: [...edges.values()], workflows, annotations };
}
