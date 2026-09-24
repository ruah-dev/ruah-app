// src/integrations/cloud/azure.ts — Azure via `az` and its own login
// (`az login`). Subscriptions are the accounts (`az account list` reads the
// local profile, no network). Read-only `list` commands only, always
// `-o json --only-show-errors`, 20 s timeout each; secrets (admin logins,
// keys, connection strings) are never copied. `healthOf` maps native states
// for the live-status work (CONTRACTS.md §10).
import type { CloudResource, CloudResourceType } from "../../contracts/integrations.js";
import { arr, mapLimit, obj, str } from "../exec.js";
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

const PROVIDER = "azure";
export const AZURE_INSTALL = "brew install azure-cli";
export const AZURE_LOGIN = "az login";
const SUBSCRIPTION_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const AUTH_RE = /az login|AADSTS\d+|interactive authentication is needed|refresh token|token.*expired|expired.*token|please run 'az login'|no subscription found/i;
/** Resource provider not registered for the subscription: nothing of that kind exists. */
const EMPTY_RE = /MissingSubscriptionRegistration|is not registered to use namespace/i;
/** The `containerapp` extension is missing (older az without it built in). */
const EXTENSION_RE = /requires the extension ([a-z0-9-]+)|extension ([a-z0-9-]+) is not installed/i;

type Mapper = (json: unknown) => CloudResource[];

const resource = (fields: Parameters<typeof cloudResource>[1]): CloudResource => cloudResource(PROVIDER, fields);

/** "West Europe" (App Service) and "westeurope" (ARM) → "westeurope". */
export function azureRegion(value: unknown): string | undefined {
  const s = str(value);
  return s === undefined ? undefined : s.toLowerCase().replace(/\s+/g, "");
}

/** Portal deep link for an ARM id ("/subscriptions/…/resourceGroups/…/providers/…"). */
export const portalUrl = (id: string): string => `https://portal.azure.com/#resource${id}/overview`;

function arm(
  item: Record<string, unknown>,
  fields: { type: CloudResourceType; service: string; status?: string | undefined; url?: string | undefined },
): CloudResource | undefined {
  const id = str(item.id);
  const name = str(item.name);
  if (id === undefined || name === undefined) return undefined;
  const tags = labelTags(item.tags);
  const rg = str(item.resourceGroup);
  return resource({
    id, type: fields.type, service: fields.service, name, region: azureRegion(item.location), status: fields.status, url: fields.url,
    tags: rg !== undefined && fields.service !== "resource-group" ? { ...tags, "resource-group": rg } : tags,
    consoleUrl: portalUrl(id),
  });
}

const each = (json: unknown, fn: (item: Record<string, unknown>) => CloudResource | undefined): CloudResource[] =>
  objects(json).map(fn).filter((r): r is CloudResource => r !== undefined);

export const mapResourceGroups: Mapper = (json) =>
  each(json, (g) => arm(g, { type: "other", service: "resource-group", status: lowerState(obj(g.properties)?.provisioningState) }));

/** Web apps and function apps (`az webapp list` / `az functionapp list`); kind decides which. */
export const mapWebApps: Mapper = (json) =>
  each(json, (a) => {
    const fn = (str(a.kind) ?? "").includes("functionapp");
    const hosts = arr(a.hostNames).map(str).filter((h): h is string => h !== undefined);
    const fallback = str(a.defaultHostName);
    // A custom domain is what people recognise; the *.azurewebsites.net name otherwise.
    const host = hosts.find((h) => !h.endsWith(".azurewebsites.net")) ?? fallback ?? hosts[0];
    return arm(a, {
      type: fn ? "function" : "app", service: fn ? "functionapp" : "app-service",
      status: lowerState(a.state), url: host !== undefined ? `https://${host}` : undefined,
    });
  });

export const mapContainerApps: Mapper = (json) =>
  each(json, (c) => {
    const p = obj(c.properties) ?? c;
    const fqdn = str(obj(obj(p.configuration)?.ingress)?.fqdn) ?? str(p.latestRevisionFqdn);
    const provisioning = str(p.provisioningState);
    return arm(c, {
      type: "container", service: "container-app",
      status: provisioning === "Failed" ? "failed" : lowerState(p.runningStatus) ?? lowerState(provisioning),
      url: fqdn !== undefined ? `https://${fqdn}` : undefined,
    });
  });

export const mapAks: Mapper = (json) =>
  each(json, (k) => {
    const pools = objects(k.agentPoolProfiles);
    const nodes = pools.reduce((sum, p) => sum + (typeof p.count === "number" ? p.count : 0), 0);
    const power = lowerState(obj(k.powerState)?.code);
    const state = str(k.provisioningState) === "Failed" ? "failed" : power ?? lowerState(k.provisioningState);
    return arm(k, {
      type: "kubernetes", service: "aks",
      status: state !== undefined && pools.length > 0 ? `${state} · ${nodes} ${nodes === 1 ? "node" : "nodes"}` : state,
    });
  });

export const mapSqlServers: Mapper = (json) =>
  each(json, (s) => arm(s, { type: "database", service: "azure-sql", status: lowerState(s.state) }));

export const mapPostgresFlexible: Mapper = (json) =>
  each(json, (s) => arm(s, { type: "database", service: "postgres-flexible", status: lowerState(s.state) }));

export const mapStorageAccounts: Mapper = (json) =>
  each(json, (s) => {
    const provisioning = str(s.provisioningState);
    return arm(s, {
      type: "storage", service: "storage-account",
      status: provisioning === "Succeeded" ? lowerState(s.statusOfPrimary) ?? "succeeded" : lowerState(provisioning),
    });
  });

/** Native Azure state (powerState, state, runningStatus, provisioningState) → live health. */
export function healthOf(state: string | undefined | null): HealthState {
  const s = nativeState(state);
  if (s.length === 0) return "unknown";
  if (["RUNNING", "READY", "SUCCEEDED", "AVAILABLE", "ENABLED", "ONLINE"].includes(s)) return "healthy";
  if (["DEGRADED", "LIMITED", "UNAVAILABLE_PARTIAL"].includes(s)) return "degraded";
  if (["STARTING", "CREATING", "UPDATING", "PROVISIONING", "INPROGRESS", "IN_PROGRESS", "SCALING", "UPGRADING", "MIGRATING", "RESTARTING", "ACCEPTED", "WAITING"].includes(s)) {
    return "deploying";
  }
  if (["STOPPED", "STOPPING", "DEALLOCATED", "DISABLED", "FAILED", "CANCELED", "DELETING", "DROPPING", "UNAVAILABLE", "OFFLINE"].includes(s)) return "down";
  return "unknown";
}

const LISTINGS: Listing<undefined>[] = [
  { service: "resource groups", args: ["group", "list"], map: mapResourceGroups },
  { service: "web apps", args: ["webapp", "list"], map: mapWebApps },
  { service: "function apps", args: ["functionapp", "list"], map: mapWebApps },
  { service: "container apps", args: ["containerapp", "list"], map: mapContainerApps },
  { service: "aks", args: ["aks", "list"], map: mapAks },
  { service: "sql servers", args: ["sql", "server", "list"], map: mapSqlServers },
  { service: "postgres", args: ["postgres", "flexible-server", "list"], map: mapPostgresFlexible },
  { service: "storage", args: ["storage", "account", "list"], map: mapStorageAccounts },
];

export class AzureIntegration extends CliCloudIntegration {
  constructor(deps: CliCloudDeps) {
    super(
      { id: PROVIDER, name: "Azure", bins: ["az"], install: AZURE_INSTALL, login: AZURE_LOGIN, accountNoun: "subscription", accountRe: SUBSCRIPTION_RE, authError: AUTH_RE },
      deps,
    );
  }

  private az(bin: string, args: string[]): Promise<unknown> {
    return this.runJson(bin, [...args, "-o", "json", "--only-show-errors"]);
  }

  protected async session(bin: string): Promise<Session> {
    const subs = objects(await this.az(bin, ["account", "list"]));
    if (subs.length === 0) return { loggedIn: false, reason: "no subscriptions in the az profile" };
    const accounts: { id: string; label: string }[] = [];
    let current: string | undefined;
    let who: string | undefined;
    for (const s of subs) {
      const id = str(s.id);
      if (id === undefined || !SUBSCRIPTION_RE.test(id)) continue;
      const disabled = str(s.state) !== undefined && str(s.state) !== "Enabled";
      accounts.push({ id, label: `${str(s.name) ?? id}${s.isDefault === true ? " (default)" : ""}${disabled ? " — disabled" : ""}` });
      if (s.isDefault === true) {
        current = id;
        who = str(obj(s.user)?.name);
      }
    }
    return { loggedIn: true, who, accounts, current: current ?? accounts[0]?.id };
  }

  protected async collect({ bin, account, errors }: CollectContext): Promise<CloudResource[]> {
    const sub = account !== undefined ? ["--subscription", account] : [];
    const lists = await mapLimit(LISTINGS, 4, async (listing) => {
      try {
        return listing.map(await this.az(bin, [...listing.args, ...sub]), undefined);
      } catch (err) {
        const message = errorText(err, "az failed");
        if (EMPTY_RE.test(message)) return [];
        const ext = EXTENSION_RE.exec(message);
        errors.push(`${listing.service}: ${ext !== null ? `needs an az extension — run: az extension add --name ${ext[1] ?? ext[2] ?? "containerapp"}` : message}`);
        return [];
      }
    });
    // `az webapp list` may include function apps on some versions; keep one copy per ARM id.
    const seen = new Set<string>();
    return lists.flat().filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }
}
