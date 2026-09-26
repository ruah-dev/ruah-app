// src/integrations/cloud/kubernetes.ts — Kubernetes via `kubectl` and the
// user's kubeconfig; contexts are the accounts. Read-only: `config
// get-contexts` / `config current-context` (no cluster call, no credentials
// read), `version` and `get <kind> --all-namespaces -o json`, always with
// `--context=<ctx>` and `--request-timeout`. Workloads (deployments,
// statefulsets, daemonsets, cronjobs) carry ready/desired replicas and a pod
// summary; pods themselves are never rows (CONTRACTS.md §9).
import type { CloudResource } from "../../contracts/integrations.js";
import { arr, cliMessage, IntegrationError, mapLimit, obj, str, type Json } from "../exec.js";
import { workloadHealth } from "../health.js";
import { CliCloudAdapter, cloudResource, type CheckResult, type CliAccount } from "./cli-adapter.js";

const PROVIDER = "kubernetes";
const REQUEST_TIMEOUT = "--request-timeout=10s";
/** Cluster plumbing, not the user's services. */
const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease"]);
/** Container waiting reasons that mean "this pod will not come up by itself". */
const CRASH_REASONS = new Set([
  "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName", "RunContainerError",
]);

export interface PodSummary {
  running: number;
  pending: number;
  crashLoop: number;
  restarts: number;
}

const KLOG_LINE = /^[EIWF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\S+:\d+\]/;

/** Drops klog-formatted lines; keeps everything when nothing else is left. */
export function stripKlog(stderr: string): string {
  const kept = stderr.split("\n").filter((line) => !KLOG_LINE.test(line.trim()));
  return kept.some((l) => l.trim().length > 0) ? kept.join("\n") : stderr;
}

const meta = (item: Json): { name: string | undefined; namespace: string; labels: Record<string, string> | undefined } => {
  const m = obj(item.metadata);
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(m?.labels) ?? {})) if (typeof v === "string") labels[k] = v;
  return { name: str(m?.name), namespace: str(m?.namespace) ?? "default", labels: Object.keys(labels).length > 0 ? labels : undefined };
};

const items = (json: unknown): Json[] => arr(obj(json)?.items).map(obj).filter((i): i is Json => i !== undefined);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** "Deployment/<ns>/<name>"-style key of the workload that owns a pod. */
export function podOwnerKey(pod: Json): string | undefined {
  const { namespace, labels } = meta(pod);
  const owners = arr(obj(pod.metadata)?.ownerReferences).map(obj);
  const owner = owners.find((o) => o?.controller === true) ?? owners[0];
  const kind = str(owner?.kind);
  const name = str(owner?.name);
  if (kind === undefined || name === undefined) return undefined;
  if (kind === "ReplicaSet") {
    const hash = labels?.["pod-template-hash"];
    const deployment = hash !== undefined && name.endsWith(`-${hash}`) ? name.slice(0, -(hash.length + 1)) : name.replace(/-[a-z0-9]{5,10}$/, "");
    return `Deployment/${namespace}/${deployment}`;
  }
  if (kind === "Job") return `CronJob/${namespace}/${name.replace(/-\d+$/, "")}`;
  return `${kind}/${namespace}/${name}`;
}

/** Pods counted per owning workload: running / pending / crash-looping + container restarts. */
export function summarizePods(json: unknown): Map<string, PodSummary> {
  const out = new Map<string, PodSummary>();
  for (const pod of items(json)) {
    const key = podOwnerKey(pod);
    if (key === undefined) continue;
    const status = obj(pod.status);
    const phase = str(status?.phase);
    const containers = [...arr(status?.initContainerStatuses), ...arr(status?.containerStatuses)].map(obj);
    const crashing = containers.some((c) => CRASH_REASONS.has(str(obj(obj(c?.state)?.waiting)?.reason) ?? ""));
    const s = out.get(key) ?? { running: 0, pending: 0, crashLoop: 0, restarts: 0 };
    s.restarts += containers.reduce((sum, c) => sum + num(c?.restartCount), 0);
    if (crashing) s.crashLoop += 1;
    else if (phase === "Running") s.running += 1;
    else if (phase === "Pending") s.pending += 1;
    out.set(key, s);
  }
  return out;
}

interface Ctx {
  context: string;
  pods: Map<string, PodSummary>;
}

function podDetail(p: PodSummary | undefined): string {
  if (p === undefined) return "";
  const parts: string[] = [];
  if (p.pending > 0) parts.push(`${p.pending} pending`);
  if (p.restarts > 0) parts.push(`${p.restarts} restart${p.restarts === 1 ? "" : "s"}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function workload(
  item: Json, kind: "Deployment" | "StatefulSet" | "DaemonSet", service: string, ctx: Ctx,
  state: { ready: number; desired: number; updating: boolean; stalled?: boolean },
): CloudResource | undefined {
  const { name, namespace, labels } = meta(item);
  if (name === undefined || SYSTEM_NAMESPACES.has(namespace)) return undefined;
  const pods = ctx.pods.get(`${kind}/${namespace}/${name}`);
  const w = workloadHealth({ ...state, crashLoop: pods?.crashLoop ?? 0 });
  return cloudResource(PROVIDER, {
    id: `k8s:${ctx.context}:${namespace}:${service}:${name}`, type: "container", service, name, region: namespace,
    status: `${state.ready}/${state.desired} ready`, tags: labels,
    health: w.health, healthDetail: `${w.detail}${podDetail(pods)}`,
    replicas: { ready: state.ready, desired: state.desired }, pods,
  });
}

const generationBehind = (item: Json): boolean => num(obj(item.status)?.observedGeneration, Infinity) < num(obj(item.metadata)?.generation, 0);

export function mapDeployments(json: unknown, ctx: Ctx): CloudResource[] {
  return items(json).flatMap((d) => {
    const spec = obj(d.spec);
    const status = obj(d.status);
    const desired = num(spec?.replicas, 1);
    const updated = num(status?.updatedReplicas);
    const conditions = arr(status?.conditions).map(obj);
    const stalled = conditions.some((c) => str(c?.type) === "Progressing" && str(c?.reason) === "ProgressDeadlineExceeded");
    const updating = generationBehind(d) || updated < desired || num(status?.replicas) > desired;
    const r = workload(d, "Deployment", "deployment", ctx, { ready: num(status?.readyReplicas), desired, updating, stalled });
    return r !== undefined ? [r] : [];
  });
}

export function mapStatefulSets(json: unknown, ctx: Ctx): CloudResource[] {
  return items(json).flatMap((s) => {
    const status = obj(s.status);
    const desired = num(obj(s.spec)?.replicas, 1);
    const revisionChanging = str(status?.updateRevision) !== undefined && str(status?.currentRevision) !== str(status?.updateRevision);
    const updating = generationBehind(s) || (revisionChanging && num(status?.updatedReplicas) < desired);
    const r = workload(s, "StatefulSet", "statefulset", ctx, { ready: num(status?.readyReplicas), desired, updating });
    return r !== undefined ? [r] : [];
  });
}

export function mapDaemonSets(json: unknown, ctx: Ctx): CloudResource[] {
  return items(json).flatMap((d) => {
    const status = obj(d.status);
    const desired = num(status?.desiredNumberScheduled);
    const updating = generationBehind(d) || num(status?.updatedNumberScheduled, desired) < desired;
    const r = workload(d, "DaemonSet", "daemonset", ctx, { ready: num(status?.numberReady), desired, updating });
    return r !== undefined ? [r] : [];
  });
}

export function mapCronJobs(json: unknown, ctx: Ctx): CloudResource[] {
  return items(json).flatMap((c) => {
    const { name, namespace, labels } = meta(c);
    if (name === undefined || SYSTEM_NAMESPACES.has(namespace)) return [];
    const spec = obj(c.spec);
    const status = obj(c.status);
    const pods = ctx.pods.get(`CronJob/${namespace}/${name}`);
    const lastSchedule = Date.parse(str(status?.lastScheduleTime) ?? "");
    const lastSuccess = Date.parse(str(status?.lastSuccessfulTime) ?? "");
    const active = arr(status?.active).length;
    let health: CloudResource["health"];
    let detail: string;
    if (spec?.suspend === true) [health, detail] = ["unknown", "suspended"];
    else if (active > 0) [health, detail] = [(pods?.crashLoop ?? 0) > 0 ? "degraded" : "healthy", `${active} job${active === 1 ? "" : "s"} running`];
    else if (Number.isNaN(lastSchedule)) [health, detail] = ["unknown", "never ran"];
    else if (!Number.isNaN(lastSuccess) && lastSuccess >= lastSchedule) [health, detail] = ["healthy", "last run succeeded"];
    else [health, detail] = ["degraded", "last run did not succeed"];
    return [cloudResource(PROVIDER, {
      id: `k8s:${ctx.context}:${namespace}:cronjob:${name}`, type: "container", service: "cronjob", name, region: namespace,
      status: spec?.suspend === true ? "suspended" : str(spec?.schedule), tags: labels, health, healthDetail: `${detail}${podDetail(pods)}`, pods,
    })];
  });
}

function ingressHosts(status: Json | undefined): string[] {
  return arr(obj(obj(status)?.loadBalancer)?.ingress).flatMap((i) => {
    const host = str(obj(i)?.hostname) ?? str(obj(i)?.ip);
    return host !== undefined ? [host] : [];
  });
}

export function mapServices(json: unknown, ctx: Ctx): CloudResource[] {
  return items(json).flatMap((s) => {
    const { name, namespace, labels } = meta(s);
    // The API server's own service in every cluster.
    if (name === undefined || SYSTEM_NAMESPACES.has(namespace) || (namespace === "default" && name === "kubernetes")) return [];
    const spec = obj(s.spec);
    const type = str(spec?.type) ?? "ClusterIP";
    const ports = arr(spec?.ports).map(obj).flatMap((p) => {
      const port = str(p?.port);
      if (port === undefined) return [];
      const target = str(p?.targetPort);
      return [`${port}${target !== undefined && target !== port ? `→${target}` : ""}/${str(p?.protocol) ?? "TCP"}`];
    });
    const external = type === "LoadBalancer" ? ingressHosts(obj(s.status)) : type === "ExternalName" ? [str(spec?.externalName) ?? ""].filter(Boolean) : [];
    return [cloudResource(PROVIDER, {
      id: `k8s:${ctx.context}:${namespace}:service:${name}`, type: type === "LoadBalancer" ? "loadbalancer" : "other", service: "service", name, region: namespace,
      status: `${type}${ports.length > 0 ? ` ${ports.join(", ")}` : ""}`, tags: labels, hosts: external,
      // Only a LoadBalancer has a state of its own: waiting for / holding an external address.
      ...(type === "LoadBalancer"
        ? external.length > 0 ? { health: "healthy" as const } : { health: "deploying" as const, healthDetail: "waiting for an external address" }
        : {}),
    })];
  });
}

export function mapIngresses(json: unknown, ctx: Ctx): CloudResource[] {
  return items(json).flatMap((i) => {
    const { name, namespace, labels } = meta(i);
    if (name === undefined || SYSTEM_NAMESPACES.has(namespace)) return [];
    const spec = obj(i.spec);
    const hosts = arr(spec?.rules).map((r) => str(obj(r)?.host)).filter((h): h is string => h !== undefined);
    const tlsHosts = new Set(arr(spec?.tls).flatMap((t) => arr(obj(t)?.hosts).map(str)));
    const first = hosts[0];
    const address = ingressHosts(obj(i.status));
    return [cloudResource(PROVIDER, {
      id: `k8s:${ctx.context}:${namespace}:ingress:${name}`, type: "gateway", service: "ingress", name, region: namespace,
      status: str(spec?.ingressClassName) ?? "ingress", tags: labels, hosts,
      url: first !== undefined && !first.includes("*") ? `${tlsHosts.has(first) ? "https" : "http"}://${first}` : undefined,
      health: address.length > 0 ? "healthy" : "deploying", healthDetail: address.length > 0 ? `address ${address.join(", ")}` : "no address yet",
    })];
  });
}

const KINDS: { kind: string; map: (json: unknown, ctx: Ctx) => CloudResource[] }[] = [
  { kind: "deployments", map: mapDeployments },
  { kind: "statefulsets", map: mapStatefulSets },
  { kind: "daemonsets", map: mapDaemonSets },
  { kind: "cronjobs", map: mapCronJobs },
  { kind: "services", map: mapServices },
  { kind: "ingresses", map: mapIngresses },
];

export class KubernetesIntegration extends CliCloudAdapter {
  readonly id = PROVIDER;
  readonly name = "Kubernetes";
  protected readonly binName = "kubectl";
  protected readonly setupHint = "brew install kubectl && kubectl config use-context <context>";
  // EKS ARNs (arn:aws:eks:…:cluster/x), GKE (gke_p_z_c), kind-x, user@cluster.
  protected readonly accountPattern = /^[A-Za-z0-9_.@:/][A-Za-z0-9_.@:/+=,-]{0,252}$/;
  protected readonly accountNoun = "context";
  protected override runOptions = { input: "" };

  private contextArgs(context: string | undefined): string[] {
    return context !== undefined ? [`--context=${context}`] : [];
  }

  /** kubectl logs klog lines ("E0924 22:15:38.08 39648 memcache.go:265] …") before the real message. */
  protected override async run(bin: string, args: string[]): Promise<string> {
    const result = await this.deps.runner(bin, args, this.runOptions);
    if (result.code !== 0) throw new IntegrationError(502, cliMessage({ ...result, stderr: stripKlog(result.stderr) }));
    return result.stdout;
  }

  protected async accounts(bin: string): Promise<CliAccount[]> {
    const names = (await this.run(bin, ["config", "get-contexts", "-o", "name"])).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    let current: string | undefined;
    try {
      current = (await this.run(bin, ["config", "current-context"])).trim();
    } catch {
      // no current context set
    }
    return names.filter((n) => this.accountPattern.test(n)).map((n) => ({ id: n, label: n, current: n === current }));
  }

  protected async check(bin: string, account: string | undefined): Promise<CheckResult> {
    const hint = `kubectl${account !== undefined ? ` --context ${account}` : ""} cluster-info`;
    if (account === undefined) {
      // No context at all (kubectl installed, no kubeconfig): not set up — not a cluster that is
      // down. kubectl would try localhost:8080 and fail on every status read.
      let contexts: CliAccount[] | undefined;
      try {
        contexts = await this.accounts(bin);
      } catch {
        contexts = undefined; // an unreadable kubeconfig: the version call below says why
      }
      if (contexts !== undefined && contexts.length === 0) {
        return {
          ok: false, status: "not_connected",
          detail: "no contexts in your kubeconfig",
          setupHint: "add a cluster (e.g. `aws eks update-kubeconfig`, `gcloud container clusters get-credentials`, `kind create cluster`), then: kubectl config use-context <context>",
        };
      }
    }
    try {
      const version = obj(await this.json(bin, ["version", "-o", "json", "--request-timeout=5s", ...this.contextArgs(account)]));
      const server = str(obj(version?.serverVersion)?.gitVersion);
      return { ok: true, detail: `context ${account ?? "(current)"}${server !== undefined ? ` · server ${server}` : ""}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "kubectl failed";
      const auth = /unauthori[sz]ed|forbidden|credentials|must be logged in|token|expired/i.test(message);
      const unreachable = /refused|unable to connect|no such host|timeout|i\/o timeout|deadline/i.test(message);
      return {
        ok: false, status: auth ? "not_connected" : "error",
        detail: `context ${account ?? "(current)"}: ${unreachable ? `cluster unreachable (${message})` : message}`,
        setupHint: auth ? `log in to the cluster's provider, then: ${hint}` : hint,
      };
    }
  }

  protected async list(bin: string, account: string | undefined, errors: string[]): Promise<CloudResource[]> {
    const context = account ?? "current";
    const get = (kind: string): Promise<unknown> => this.json(bin, ["get", kind, "--all-namespaces", "-o", "json", REQUEST_TIMEOUT, ...this.contextArgs(account)]);
    const failures: string[] = [];
    let pods = new Map<string, PodSummary>();
    try {
      pods = summarizePods(await get("pods"));
    } catch (err) {
      failures.push(`pods: ${err instanceof Error ? err.message : "kubectl failed"}`);
    }
    const lists = await mapLimit(KINDS, 3, async ({ kind, map }) => {
      try {
        return map(await get(kind), { context, pods });
      } catch (err) {
        const message = err instanceof Error ? err.message : "kubectl failed";
        // Old clusters without an API group (e.g. networking.k8s.io/v1 ingresses) have none of that kind.
        if (!/doesn't have a resource type/i.test(message)) failures.push(`${kind}: ${message}`);
        return [];
      }
    });
    // Every call failed the same way (cluster down, expired login): one provider-level error.
    if (failures.length === KINDS.length + 1) throw new IntegrationError(502, failures[0]?.replace(/^pods: /, "") ?? "kubectl failed");
    errors.push(...failures);
    return lists.flat();
  }
}
