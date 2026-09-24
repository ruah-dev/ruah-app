// src/integrations/cloud/gcp.ts — Google Cloud via `gcloud` and its own login
// (`gcloud auth login`). Accounts are "<configuration>/<project>" for every
// gcloud configuration that names a project, plus the other projects the
// active login can see ("<project>"). Read-only `list` commands only, always
// `--format=json --quiet` (no prompts), 20 s timeout each. Pure mappers turn
// gcloud JSON into CloudResource; `healthOf` maps native states for the
// live-status work (CONTRACTS.md §10).
import type { CloudResource } from "../../contracts/integrations.js";
import { mapLimit, obj, str } from "../exec.js";
import {
  CliCloudIntegration,
  cloudResource,
  errorText,
  labelTags,
  lowerState,
  nativeState,
  objects,
  type CliCloudDeps,
  type CollectContext,
  type HealthState,
  type Listing,
  type Session,
} from "./cli-kit.js";

const PROVIDER = "gcp";
const CONSOLE = "https://console.cloud.google.com";
export const GCP_INSTALL = "brew install --cask gcloud-cli";
export const GCP_LOGIN = "gcloud auth login";
/** "<configuration>/<project>" or "<project>" (domain-scoped "example.com:proj" allowed). */
const ACCOUNT_RE = /^([a-z0-9][a-z0-9_-]{0,63}\/)?[a-z0-9][a-z0-9.:-]{0,99}$/;
const AUTH_RE = /gcloud auth login|reauthenticat|refresh(ing)? (your current )?auth tokens?|invalid_grant|no credentialed accounts|not logged in|login required|UNAUTHENTICATED/i;
/** The API is off for the project: nothing of that kind can exist, not an error. */
const API_OFF_RE = /has not been used in project|SERVICE_DISABLED|is disabled|API \[[^\]]+\] not enabled|not enabled on project|accessNotConfigured/i;

export interface GcpContext {
  project: string;
}

type Mapper = (json: unknown, ctx: GcpContext) => CloudResource[];

const resource = (fields: Parameters<typeof cloudResource>[1]): CloudResource => cloudResource(PROVIDER, fields);

/** Labels GCP adds itself (goog-*, cloud.googleapis.com/*, deployment-tool) are not user tags. */
const internalLabel = (key: string): boolean => key.startsWith("goog-") || key.includes("googleapis.com") || key === "deployment-tool";
const gcpTags = (value: unknown): Record<string, string> | undefined => labelTags(value, internalLabel);

/** Last path segment of a full resource name ("projects/p/topics/t" → "t"). */
const lastSegment = (name: string): string => name.split("/").pop() ?? name;
/** "projects/p/locations/us-central1/functions/f" → "us-central1". */
const locationOf = (name: string): string | undefined => /\/locations\/([^/]+)/.exec(name)?.[1];

/**
 * Cloud Run state from the Ready condition and the latest revision:
 * "ready" when the latest created revision is the ready one, "deploying"
 * while a newer revision is rolling out, "failed" when Ready is False.
 */
export function cloudRunState(ready: string | undefined, latestCreated: string | undefined, latestReady: string | undefined): string | undefined {
  if (ready === "False" || ready === "CONDITION_FAILED") return "failed";
  if (latestCreated !== undefined && latestCreated !== latestReady) return "deploying";
  if (ready === "True" || ready === "CONDITION_SUCCEEDED") return "ready";
  if (ready === "Unknown" || ready === "CONDITION_PENDING" || ready === "CONDITION_RECONCILING") return "deploying";
  return undefined;
}

export const mapCloudRun: Mapper = (json, { project }) =>
  objects(json).flatMap((s) => {
    const meta = obj(s.metadata);
    // gcloud prints Knative v1 objects; the v2 API shape ({ name: "projects/…/services/x", uri }) is accepted too.
    const fullName = str(s.name);
    const name = str(meta?.name) ?? (fullName !== undefined ? lastSegment(fullName) : undefined);
    if (name === undefined) return [];
    const labels = obj(meta?.labels) ?? obj(s.labels);
    const region = str(labels?.["cloud.googleapis.com/location"]) ?? (fullName !== undefined ? locationOf(fullName) : undefined) ?? str(s.region);
    const status = obj(s.status);
    const ready = objects(status?.conditions).find((c) => c.type === "Ready");
    const terminal = obj(s.terminalCondition);
    const latestReady = str(status?.latestReadyRevisionName) ?? (str(s.latestReadyRevision) !== undefined ? lastSegment(str(s.latestReadyRevision)!) : undefined);
    const latestCreated = str(status?.latestCreatedRevisionName) ?? (str(s.latestCreatedRevision) !== undefined ? lastSegment(str(s.latestCreatedRevision)!) : undefined);
    const state = cloudRunState(str(ready?.status) ?? str(terminal?.state), latestCreated, latestReady);
    return [resource({
      id: `//run.googleapis.com/projects/${project}/locations/${region ?? "-"}/services/${name}`,
      type: "container", service: "cloud-run", name, region,
      status: state === "deploying" && latestCreated !== undefined ? `deploying · ${latestCreated}` : state,
      url: str(status?.url) ?? str(obj(status?.address)?.url) ?? str(s.uri),
      tags: gcpTags(labels),
      consoleUrl: `${CONSOLE}/run/detail/${region ?? "-"}/${encodeURIComponent(name)}/metrics?project=${project}`,
    })];
  });

export const mapGke: Mapper = (json, { project }) =>
  objects(json).flatMap((c) => {
    const name = str(c.name);
    if (name === undefined) return [];
    const location = str(c.location) ?? str(c.zone);
    const state = lowerState(c.status);
    const nodeCount = typeof c.currentNodeCount === "number" ? c.currentNodeCount : undefined;
    const autopilot = obj(c.autopilot)?.enabled === true;
    return [resource({
      id: `//container.googleapis.com/projects/${project}/locations/${location ?? "-"}/clusters/${name}`,
      type: "kubernetes", service: autopilot ? "gke-autopilot" : "gke", name, region: location,
      status: state !== undefined && nodeCount !== undefined ? `${state} · ${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}` : state,
      tags: gcpTags(c.resourceLabels),
      consoleUrl: `${CONSOLE}/kubernetes/clusters/details/${location ?? "-"}/${encodeURIComponent(name)}/details?project=${project}`,
    })];
  });

/** "POSTGRES_15" → "postgres", "MYSQL_8_0" → "mysql", "SQLSERVER_2019_STANDARD" → "sqlserver". */
function sqlEngine(version: string | undefined): string {
  const head = (version ?? "").split("_")[0]?.toLowerCase();
  return head !== undefined && head.length > 0 ? head : "db";
}

export const mapCloudSql: Mapper = (json, { project }) =>
  objects(json).flatMap((d) => {
    const name = str(d.name);
    if (name === undefined) return [];
    const settings = obj(d.settings);
    const raw = str(d.state);
    // RUNNABLE with activation policy NEVER is a stopped instance.
    const state = raw === "RUNNABLE" ? (str(settings?.activationPolicy) === "NEVER" ? "stopped" : "running") : lowerState(raw);
    return [resource({
      id: `//sqladmin.googleapis.com/projects/${project}/instances/${name}`,
      type: "database", service: `cloud-sql/${sqlEngine(str(d.databaseVersion))}`, name, region: str(d.region), status: state,
      tags: gcpTags(settings?.userLabels),
      consoleUrl: `${CONSOLE}/sql/instances/${encodeURIComponent(name)}/overview?project=${project}`,
    })];
  });

export const mapFunctions: Mapper = (json, { project }) =>
  objects(json).flatMap((f) => {
    const full = str(f.name);
    if (full === undefined) return [];
    const name = lastSegment(full);
    const region = locationOf(full);
    const gen2 = str(f.environment) === "GEN_2" || obj(f.serviceConfig) !== undefined;
    return [resource({
      id: `//cloudfunctions.googleapis.com/${full}`,
      type: "function", service: gen2 ? "cloud-functions/gen2" : "cloud-functions", name, region,
      status: lowerState(f.state) ?? lowerState(f.status),
      url: str(obj(f.serviceConfig)?.uri) ?? str(f.url) ?? str(obj(f.httpsTrigger)?.url),
      tags: gcpTags(f.labels),
      consoleUrl: `${CONSOLE}/functions/details/${region ?? "-"}/${encodeURIComponent(name)}?project=${project}${gen2 ? "&env=gen2" : ""}`,
    })];
  });

export const mapPubsubTopics: Mapper = (json, { project }) =>
  objects(json).flatMap((t) => {
    const full = str(t.name);
    if (full === undefined) return [];
    const name = lastSegment(full);
    return [resource({
      id: `//pubsub.googleapis.com/${full}`, type: "queue", service: "pubsub", name, tags: gcpTags(t.labels),
      consoleUrl: `${CONSOLE}/cloudpubsub/topic/detail/${encodeURIComponent(name)}?project=${project}`,
    })];
  });

export const mapBuckets: Mapper = (json, { project }) =>
  objects(json).flatMap((b) => {
    const name = str(b.name) ?? str(b.storage_url)?.replace(/^gs:\/\//, "").replace(/\/$/, "");
    if (name === undefined || name.length === 0) return [];
    return [resource({
      id: `//storage.googleapis.com/projects/_/buckets/${name}`, type: "storage", service: "gcs", name,
      region: (str(b.location) ?? str(b.Location))?.toLowerCase(), tags: gcpTags(b.labels ?? b.default_labels),
      consoleUrl: `${CONSOLE}/storage/browser/${encodeURIComponent(name)}?project=${project}`,
    })];
  });

/**
 * Native GCP state → live health. Accepts Cloud Run condition states,
 * GKE/Cloud SQL/Functions enum values and this adapter's own status strings
 * ("ready", "deploying · rev", "running · 3 nodes").
 */
export function healthOf(state: string | undefined | null): HealthState {
  const s = nativeState(state);
  if (s.length === 0) return "unknown";
  if (["READY", "RUNNING", "RUNNABLE", "ACTIVE", "TRUE", "CONDITION_SUCCEEDED"].includes(s)) return "healthy";
  if (["DEGRADED", "MAINTENANCE", "UNKNOWN_STATE"].includes(s)) return "degraded";
  if (["PROVISIONING", "RECONCILING", "PENDING_CREATE", "DEPLOYING", "DEPLOY_IN_PROGRESS", "CONDITION_PENDING", "CONDITION_RECONCILING", "UNKNOWN", "PENDING_UPDATE"].includes(s)) {
    return "deploying";
  }
  if (["ERROR", "FAILED", "STOPPED", "STOPPING", "SUSPENDED", "OFFLINE", "FALSE", "CONDITION_FAILED", "DELETING", "DELETE_IN_PROGRESS"].includes(s)) return "down";
  return "unknown";
}

const LISTINGS: Listing<GcpContext>[] = [
  { service: "cloud run", args: ["run", "services", "list"], map: mapCloudRun },
  { service: "gke", args: ["container", "clusters", "list"], map: mapGke },
  { service: "cloud sql", args: ["sql", "instances", "list"], map: mapCloudSql },
  { service: "functions", args: ["functions", "list"], map: mapFunctions },
  { service: "pubsub", args: ["pubsub", "topics", "list"], map: mapPubsubTopics },
  { service: "storage", args: ["storage", "buckets", "list"], map: mapBuckets },
];

/** "<configuration>/<project>" → both parts; "<project>" → the active configuration. */
export function parseGcpAccount(account: string): { configuration?: string; project: string } {
  const slash = account.indexOf("/");
  return slash === -1 ? { project: account } : { configuration: account.slice(0, slash), project: account.slice(slash + 1) };
}

export class GcpIntegration extends CliCloudIntegration {
  constructor(deps: CliCloudDeps) {
    super(
      { id: PROVIDER, name: "Google Cloud", bins: ["gcloud"], install: GCP_INSTALL, login: GCP_LOGIN, accountNoun: "project", accountRe: ACCOUNT_RE, authError: AUTH_RE, healthOf: (state) => healthOf(state) },
      deps,
    );
  }

  private gcloud(bin: string, args: string[], configuration?: string): Promise<unknown> {
    return this.runJson(bin, [...args, "--format=json", "--quiet", ...(configuration !== undefined ? ["--configuration", configuration] : [])]);
  }

  protected async session(bin: string): Promise<Session> {
    const auth = objects(await this.gcloud(bin, ["auth", "list"]));
    const active = auth.find((a) => str(a.status) === "ACTIVE");
    if (active === undefined) return { loggedIn: false, reason: "no credentialed accounts" };
    const configs = objects(await this.gcloud(bin, ["config", "configurations", "list"]).catch(() => []));
    const accounts: { id: string; label: string }[] = [];
    let current: string | undefined;
    for (const c of configs) {
      const name = str(c.name);
      const project = str(obj(obj(c.properties)?.core)?.project);
      if (name === undefined || project === undefined) continue;
      const id = `${name}/${project}`;
      if (!ACCOUNT_RE.test(id)) continue;
      accounts.push({ id, label: `${project} (${name})` });
      if (c.is_active === true) current = id;
    }
    // Other projects the active login can see (network; best effort, bounded).
    const projects = objects(await this.gcloud(bin, ["projects", "list", "--limit=50"]).catch(() => []));
    for (const p of projects) {
      const id = str(p.projectId);
      if (id === undefined || !ACCOUNT_RE.test(id) || accounts.some((a) => a.id.endsWith(`/${id}`))) continue;
      accounts.push({ id, label: str(p.name) !== undefined && str(p.name) !== id ? `${str(p.name)!} (${id})` : id });
    }
    const who = str(active.account);
    if (current === undefined) {
      return { loggedIn: true, who, accounts, problem: { detail: "no Google Cloud project selected", hint: "gcloud config set project PROJECT_ID" } };
    }
    return { loggedIn: true, who, accounts, current };
  }

  protected describe(session: Extract<Session, { loggedIn: true }>, account: string | undefined): string {
    const project = account !== undefined ? parseGcpAccount(account).project : undefined;
    return [session.who, project !== undefined ? `project ${project}` : undefined].filter(Boolean).join(" · ");
  }

  protected async collect({ bin, account, errors }: CollectContext): Promise<CloudResource[]> {
    if (account === undefined) return [];
    const { configuration, project } = parseGcpAccount(account);
    const lists = await mapLimit(LISTINGS, 3, async (listing) => {
      try {
        return listing.map(await this.gcloud(bin, [...listing.args, "--project", project], configuration), { project });
      } catch (err) {
        const message = errorText(err, "gcloud failed");
        if (API_OFF_RE.test(message)) return [];
        errors.push(`${listing.service}: ${message}`);
        return [];
      }
    });
    return lists.flat();
  }
}

