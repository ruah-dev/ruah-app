// src/integrations/cloud/aws.ts — AWS via the `aws` CLI and its own
// credentials (profiles / SSO). Read-only describe/list calls only, JSON
// output, no pager, 20 s timeout each, per selected region (+ the global
// services once). Pure mappers turn CLI JSON into CloudResource.
import type { CloudResource, CloudResourceType, ConnectBody, IntegrationInfo } from "../../contracts/integrations.js";
import { arr, cliMessage, CliError, IntegrationError, mapLimit, obj, parseJson, resolveBin, str, type Json, type Runner } from "../exec.js";
import type { CloudIntegration, CloudSyncOutcome } from "../registry.js";
import type { SettingsStore } from "../store.js";

const PROVIDER = "aws";
const SETUP_HINT = "brew install awscli && aws configure sso";
const PROFILE_RE = /^[A-Za-z0-9_.@+=,][A-Za-z0-9_.@+=,-]{0,127}$/;
const DEFAULT_REGION = "us-east-1";

export interface AwsContext {
  region: string;
  accountId?: string | undefined;
}

type Mapper = (json: unknown, ctx: AwsContext) => CloudResource[];

const consoleHome = (service: string, region: string): string =>
  `https://${region}.console.aws.amazon.com/${service}/home?region=${region}`;

/** [{Key, Value}] (EC2/RDS/ELB style) or {k: v} (Lambda/API GW style) → record. */
export function awsTags(value: unknown): Record<string, string> | undefined {
  const tags: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const raw of value) {
      const t = obj(raw);
      const key = str(t?.Key) ?? str(t?.key);
      if (key !== undefined) tags[key] = str(t?.Value) ?? str(t?.value) ?? "";
    }
  } else {
    const record = obj(value);
    if (record !== undefined) for (const [k, v] of Object.entries(record)) if (typeof v === "string") tags[k] = v;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function resource(fields: {
  id: string;
  type: CloudResourceType;
  service: string;
  name: string | undefined;
  region?: string | undefined;
  status?: string | undefined;
  tags?: Record<string, string> | undefined;
  consoleUrl?: string | undefined;
}): CloudResource {
  const out: CloudResource = { id: fields.id, provider: PROVIDER, type: fields.type, service: fields.service, name: fields.name ?? fields.id };
  if (fields.region !== undefined) out.region = fields.region;
  if (fields.status !== undefined) out.status = fields.status;
  if (fields.tags !== undefined) out.tags = fields.tags;
  if (fields.consoleUrl !== undefined) out.consoleUrl = fields.consoleUrl;
  return out;
}

function list(json: unknown, key: string): Json[] {
  return arr(obj(json)?.[key]).map(obj).filter((v): v is Json => v !== undefined);
}

export const mapEc2: Mapper = (json, { region }) => {
  const out: CloudResource[] = [];
  for (const reservation of list(json, "Reservations")) {
    const owner = str(reservation.OwnerId);
    for (const i of list(reservation, "Instances")) {
      const id = str(i.InstanceId);
      if (id === undefined) continue;
      const tags = awsTags(i.Tags);
      out.push(resource({
        id: owner !== undefined ? `arn:aws:ec2:${region}:${owner}:instance/${id}` : id,
        type: "compute", service: "ec2", name: tags?.Name ?? id, region,
        status: str(obj(i.State)?.Name), tags,
        consoleUrl: `${consoleHome("ec2", region)}#InstanceDetails:instanceId=${id}`,
      }));
    }
  }
  return out;
};

export const mapEcsClusters: Mapper = (json, { region }) =>
  list(json, "clusters").flatMap((c) => {
    const arn = str(c.clusterArn);
    if (arn === undefined) return [];
    const name = str(c.clusterName);
    return [resource({
      id: arn, type: "container", service: "ecs-cluster", name, region, status: str(c.status)?.toLowerCase(), tags: awsTags(c.tags),
      consoleUrl: `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${name ?? ""}?region=${region}`,
    })];
  });

export const mapEcsServices: Mapper = (json, { region }) =>
  list(json, "services").flatMap((s) => {
    const arn = str(s.serviceArn);
    if (arn === undefined) return [];
    const name = str(s.serviceName);
    const cluster = str(s.clusterArn)?.split("/").pop();
    return [resource({
      id: arn, type: "container", service: "ecs", name, region, status: str(s.status)?.toLowerCase(), tags: awsTags(s.tags),
      consoleUrl: `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${cluster ?? ""}/services/${name ?? ""}?region=${region}`,
    })];
  });

export const mapLambda: Mapper = (json, { region }) =>
  list(json, "Functions").flatMap((f) => {
    const name = str(f.FunctionName);
    if (name === undefined) return [];
    return [resource({
      id: str(f.FunctionArn) ?? name, type: "function", service: "lambda", name, region, status: str(f.State)?.toLowerCase(),
      consoleUrl: `${consoleHome("lambda", region)}#/functions/${encodeURIComponent(name)}`,
    })];
  });

export const mapRds: Mapper = (json, { region }) =>
  list(json, "DBInstances").flatMap((d) => {
    const id = str(d.DBInstanceIdentifier);
    if (id === undefined) return [];
    return [resource({
      id: str(d.DBInstanceArn) ?? id, type: "database", service: `rds/${str(d.Engine) ?? "db"}`, name: id, region,
      status: str(d.DBInstanceStatus), tags: awsTags(d.TagList),
      consoleUrl: `${consoleHome("rds", region)}#database:id=${encodeURIComponent(id)}`,
    })];
  });

export const mapElastiCache: Mapper = (json, { region }) =>
  list(json, "CacheClusters").flatMap((c) => {
    const id = str(c.CacheClusterId);
    if (id === undefined) return [];
    return [resource({
      id: str(c.ARN) ?? id, type: "cache", service: `elasticache/${str(c.Engine) ?? "cache"}`,
      // Replication-group members are "<group>-001"; the group name is what people call it.
      name: str(c.ReplicationGroupId) ?? id, region, status: str(c.CacheClusterStatus),
      consoleUrl: `${consoleHome("elasticache", region)}#/${str(c.Engine) === "memcached" ? "memcached" : "redis"}/${encodeURIComponent(str(c.ReplicationGroupId) ?? id)}`,
    })];
  });

export const mapS3: Mapper = (json) =>
  list(json, "Buckets").flatMap((b) => {
    const name = str(b.Name);
    if (name === undefined) return [];
    const region = str(b.BucketRegion);
    return [resource({ id: `arn:aws:s3:::${name}`, type: "storage", service: "s3", name, region, consoleUrl: `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(name)}` })];
  });

export const mapSqs: Mapper = (json, { region }) =>
  arr(obj(json)?.QueueUrls).flatMap((raw) => {
    const url = str(raw);
    if (url === undefined) return [];
    const match = /^https:\/\/[^/]+\/(\d{12})\/([^/]+)$/.exec(url);
    const name = match?.[2] ?? url.split("/").pop() ?? url;
    return [resource({
      id: match !== null ? `arn:aws:sqs:${region}:${match[1] ?? ""}:${name}` : url, type: "queue", service: "sqs", name, region,
      consoleUrl: `https://${region}.console.aws.amazon.com/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(url)}`,
    })];
  });

export const mapSns: Mapper = (json, { region }) =>
  list(json, "Topics").flatMap((t) => {
    const arn = str(t.TopicArn);
    if (arn === undefined) return [];
    return [resource({
      id: arn, type: "queue", service: "sns", name: arn.split(":").pop() ?? arn, region,
      consoleUrl: `https://${region}.console.aws.amazon.com/sns/v3/home?region=${region}#/topic/${arn}`,
    })];
  });

export const mapApiGatewayRest: Mapper = (json, { region }) =>
  list(json, "items").flatMap((a) => {
    const id = str(a.id);
    if (id === undefined) return [];
    return [resource({
      id: `arn:aws:apigateway:${region}::/restapis/${id}`, type: "gateway", service: "apigateway", name: str(a.name), region, tags: awsTags(a.tags),
      consoleUrl: `https://${region}.console.aws.amazon.com/apigateway/main/apis/${id}/resources?api=${id}&region=${region}`,
    })];
  });

export const mapApiGatewayV2: Mapper = (json, { region }) =>
  list(json, "Items").flatMap((a) => {
    const id = str(a.ApiId);
    if (id === undefined) return [];
    return [resource({
      id: `arn:aws:apigateway:${region}::/apis/${id}`, type: "gateway", service: `apigatewayv2/${(str(a.ProtocolType) ?? "http").toLowerCase()}`,
      name: str(a.Name), region, tags: awsTags(a.Tags),
      consoleUrl: `https://${region}.console.aws.amazon.com/apigateway/main/api-detail?api=${id}&region=${region}`,
    })];
  });

export const mapElbv2: Mapper = (json, { region }) =>
  list(json, "LoadBalancers").flatMap((l) => {
    const arn = str(l.LoadBalancerArn);
    if (arn === undefined) return [];
    return [resource({
      id: arn, type: "loadbalancer", service: `elbv2/${str(l.Type) ?? "application"}`, name: str(l.LoadBalancerName), region,
      status: str(obj(l.State)?.Code),
      consoleUrl: `${consoleHome("ec2", region)}#LoadBalancer:loadBalancerArn=${encodeURIComponent(arn)}`,
    })];
  });

export const mapCloudFront: Mapper = (json) =>
  arr(obj(obj(json)?.DistributionList)?.Items).flatMap((raw) => {
    const d = obj(raw);
    const id = str(d?.Id);
    if (d === undefined || id === undefined) return [];
    const alias = str(arr(obj(d.Aliases)?.Items)[0]);
    return [resource({
      id: str(d.ARN) ?? id, type: "cdn", service: "cloudfront", name: alias ?? str(d.Comment) ?? str(d.DomainName) ?? id,
      status: str(d.Status)?.toLowerCase(), consoleUrl: `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${id}`,
    })];
  });

export const mapRoute53: Mapper = (json) =>
  list(json, "HostedZones").flatMap((z) => {
    const rawId = str(z.Id);
    if (rawId === undefined) return [];
    const id = rawId.replace(/^\/hostedzone\//, "");
    return [resource({
      id: `arn:aws:route53:::hostedzone/${id}`, type: "dns", service: "route53", name: (str(z.Name) ?? id).replace(/\.$/, ""),
      consoleUrl: `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${id}`,
    })];
  });

interface Listing {
  service: string;
  args: string[];
  map: Mapper;
}

const REGIONAL: Listing[] = [
  { service: "ec2", args: ["ec2", "describe-instances"], map: mapEc2 },
  { service: "lambda", args: ["lambda", "list-functions"], map: mapLambda },
  { service: "rds", args: ["rds", "describe-db-instances"], map: mapRds },
  { service: "elasticache", args: ["elasticache", "describe-cache-clusters"], map: mapElastiCache },
  { service: "sqs", args: ["sqs", "list-queues"], map: mapSqs },
  { service: "sns", args: ["sns", "list-topics"], map: mapSns },
  { service: "apigateway", args: ["apigateway", "get-rest-apis"], map: mapApiGatewayRest },
  { service: "apigatewayv2", args: ["apigatewayv2", "get-apis"], map: mapApiGatewayV2 },
  { service: "elbv2", args: ["elbv2", "describe-load-balancers"], map: mapElbv2 },
];

const GLOBAL: Listing[] = [
  { service: "s3", args: ["s3api", "list-buckets"], map: mapS3 },
  { service: "cloudfront", args: ["cloudfront", "list-distributions"], map: mapCloudFront },
  { service: "route53", args: ["route53", "list-hosted-zones"], map: mapRoute53 },
];

const MAX_ECS_CLUSTERS = 50;
const MAX_ECS_SERVICES = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AwsDeps {
  runner: Runner;
  settings: SettingsStore;
  bin?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
}

export class AwsIntegration implements CloudIntegration {
  readonly id = PROVIDER;
  readonly family = "cloud" as const;
  readonly name = "AWS";

  constructor(private readonly deps: AwsDeps) {}

  private bin(): string | undefined {
    return this.deps.bin !== undefined ? this.deps.bin() : resolveBin("aws");
  }

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  enabled(): boolean {
    return this.deps.settings.get(this.id).disabled !== true;
  }

  private base(extra: Partial<IntegrationInfo>): IntegrationInfo {
    return { id: this.id, family: this.family, name: this.name, status: "not_connected", ...extra };
  }

  private async aws(bin: string, args: string[], profile: string | undefined, region?: string): Promise<unknown> {
    const full = [...args, "--output", "json", "--no-cli-pager"];
    if (profile !== undefined) full.push("--profile", profile);
    if (region !== undefined) full.push("--region", region);
    const result = await this.deps.runner(bin, full);
    if (result.code !== 0) throw new IntegrationError(502, cliMessage(result));
    const parsed = parseJson(result.stdout);
    if (parsed === undefined && result.stdout.trim().length > 0) throw new IntegrationError(502, "unexpected (non-JSON) aws output");
    return parsed ?? {};
  }

  async profiles(bin: string): Promise<string[]> {
    const result = await this.deps.runner(bin, ["configure", "list-profiles"]);
    if (result.code !== 0) return [];
    return result.stdout.split("\n").map((l) => l.trim()).filter((l) => PROFILE_RE.test(l));
  }

  private checkProfile(profile: string | undefined): string | undefined {
    if (profile !== undefined && !PROFILE_RE.test(profile)) throw new IntegrationError(400, "invalid AWS profile name");
    return profile;
  }

  private selectedProfile(profiles: readonly string[]): string | undefined {
    const chosen = this.deps.settings.get(this.id).account ?? this.env().AWS_PROFILE;
    if (chosen !== undefined) return chosen;
    if (profiles.includes("default")) return "default";
    return profiles[0];
  }

  private async regions(bin: string, profile: string | undefined): Promise<string[]> {
    const configured = this.deps.settings.get(this.id).regions;
    if (configured !== undefined && configured.length > 0) return configured;
    const fromEnv = this.env().AWS_REGION ?? this.env().AWS_DEFAULT_REGION;
    if (fromEnv !== undefined && fromEnv.length > 0) return [fromEnv];
    try {
      const result = await this.deps.runner(bin, ["configure", "get", "region", ...(profile !== undefined ? ["--profile", profile] : [])]);
      const region = result.stdout.trim();
      if (result.code === 0 && /^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return [region];
    } catch {
      // fall through
    }
    return [DEFAULT_REGION];
  }

  async info(): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.base({ status: "cli_missing", detail: "AWS CLI not installed", setupHint: SETUP_HINT });
    try {
      const profiles = await this.profiles(bin);
      const accounts = profiles.map((p) => ({ id: p, label: p }));
      if (this.deps.settings.get(this.id).disabled === true) {
        return this.base({ status: "not_connected", detail: "disconnected in Ruah (AWS credentials unchanged)", setupHint: "Connect to use your AWS profile", accounts });
      }
      const profile = this.checkProfile(this.selectedProfile(profiles));
      try {
        const identity = obj(await this.aws(bin, ["sts", "get-caller-identity"], profile));
        const regions = await this.regions(bin, profile);
        return this.base({
          status: "connected",
          detail: `profile ${profile ?? "(environment)"} · account ${str(identity?.Account) ?? "?"} · ${regions.join(", ")}`,
          accounts,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "aws failed";
        const expired = /sso|token.*expired|expired.*token/i.test(message);
        const noCreds = /unable to locate credentials|could not be found|no credentials/i.test(message);
        return this.base({
          status: noCreds ? "not_connected" : "error",
          detail: `profile ${profile ?? "(environment)"}: ${message}`,
          setupHint: expired ? `aws sso login${profile !== undefined ? ` --profile ${profile}` : ""}` : noCreds ? "aws configure sso" : SETUP_HINT,
          accounts,
        });
      }
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 400) throw err;
      return this.base({ status: "error", detail: err instanceof Error ? err.message : "aws failed", setupHint: SETUP_HINT });
    }
  }

  async connect(body: ConnectBody): Promise<IntegrationInfo> {
    const bin = this.bin();
    if (bin === undefined) return this.info();
    const { disabled: _disabled, ...rest } = this.deps.settings.get(this.id);
    const next = { ...rest };
    if (body.account !== undefined) {
      this.checkProfile(body.account);
      const profiles = await this.profiles(bin);
      if (!profiles.includes(body.account)) throw new IntegrationError(400, `unknown AWS profile "${body.account}" — run: aws configure sso --profile ${body.account}`);
      next.account = body.account;
    }
    if (body.regions !== undefined) next.regions = [...new Set(body.regions)];
    this.deps.settings.set(this.id, next);
    return this.info();
  }

  async disconnect(): Promise<IntegrationInfo> {
    this.deps.settings.set(this.id, { disabled: true });
    return this.info();
  }

  async sync(options: { account?: string }): Promise<CloudSyncOutcome> {
    const bin = this.bin();
    if (bin === undefined) throw new IntegrationError(424, "AWS CLI not installed — " + SETUP_HINT);
    const profile = this.checkProfile(options.account ?? this.selectedProfile(await this.profiles(bin)));
    const regions = await this.regions(bin, profile);
    const errors: string[] = [];
    const jobs: { listing: Listing; region: string; global: boolean }[] = [
      ...GLOBAL.map((listing) => ({ listing, region: regions[0] ?? DEFAULT_REGION, global: true })),
      ...regions.flatMap((region) => REGIONAL.map((listing) => ({ listing, region, global: false }))),
    ];
    const results = await mapLimit(jobs, 4, async ({ listing, region, global }) => {
      try {
        const json = await this.aws(bin, listing.args, profile, region);
        return listing.map(json, { region });
      } catch (err) {
        errors.push(`${listing.service}${global ? "" : ` ${region}`}: ${err instanceof Error ? err.message : "aws failed"}`);
        return [];
      }
    });
    const ecs = await mapLimit(regions, 2, (region) => this.syncEcs(bin, profile, region, errors));
    return { resources: [...results.flat(), ...ecs.flat()], errors };
  }

  /** ECS needs list → describe per cluster; bounded so a huge account cannot stall the sync. */
  private async syncEcs(bin: string, profile: string | undefined, region: string, errors: string[]): Promise<CloudResource[]> {
    try {
      const arns = arr(obj(await this.aws(bin, ["ecs", "list-clusters"], profile, region))?.clusterArns)
        .map(str)
        .filter((a): a is string => a !== undefined)
        .slice(0, MAX_ECS_CLUSTERS);
      if (arns.length === 0) return [];
      const out: CloudResource[] = [];
      for (const batch of chunks(arns, 100)) {
        out.push(...mapEcsClusters(await this.aws(bin, ["ecs", "describe-clusters", "--include", "TAGS", "--clusters", ...batch], profile, region), { region }));
      }
      for (const cluster of arns) {
        const serviceArns = arr(obj(await this.aws(bin, ["ecs", "list-services", "--cluster", cluster], profile, region))?.serviceArns)
          .map(str)
          .filter((a): a is string => a !== undefined)
          .slice(0, MAX_ECS_SERVICES);
        for (const batch of chunks(serviceArns, 10)) {
          out.push(...mapEcsServices(await this.aws(bin, ["ecs", "describe-services", "--include", "TAGS", "--cluster", cluster, "--services", ...batch], profile, region), { region }));
        }
      }
      return out;
    } catch (err) {
      errors.push(`ecs ${region}: ${err instanceof Error ? err.message : "aws failed"}`);
      return [];
    }
  }
}
