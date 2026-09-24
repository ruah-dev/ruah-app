// Terraform / OpenTofu detector (*.tf, *.tf.json). Never reads state files
// (terraform.tfstate*) or variable files (*.tfvars): both hold secrets.
//
// Roots are directories with .tf files that no other configuration uses as a
// local module (directories under a `modules/` segment are libraries and only
// count when instantiated). Each root is instantiated recursively through its
// local `module` blocks (addresses `module.db.aws_db_instance.this`); remote
// modules become one item each, classified by their source.
//
// Resources map onto categories (database, storage, cluster, dns, …). Noise
// — IAM, networking, random_*, null_resource, policy attachments — is folded
// into the owning item's `details` (when it references exactly one item) or
// the group's. References between resources (`aws_db_instance.main.address`
// in an ECS task, a module input, an output) become links; "glue" resources
// (LB listeners / target groups, DNS records, API routes) connect the items
// around them (zone → load balancer → instances). Groups are per root and
// provider: "Terraform: AWS".
import { INFRA_KINDS } from "../detectors/compose.js";
import type { ScanContext } from "../types.js";
import { dirname } from "../walk.js";
import { blockText, findAttr, parseHcl, parseHclJson, type HclAttr, type HclBlock } from "./hcl.js";
import {
  byString,
  isFixturePath,
  normJoin,
  readCached,
  safeSetting,
  uniq,
  type InfraCategory,
  type InfraGroup,
  type InfraItem,
  type InfraLink,
  type InfraReport,
} from "./model.js";

export const MAX_TF_FILES = 3_000;
const MAX_MODULE_DEPTH = 6;

type Fold = "glue" | "attach" | "noise";
interface TfClass {
  category?: InfraCategory; // node
  fold?: Fold; // folded instead
  label?: string; // folded: what it is ("IAM", "network")
  tech?: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  aws: "AWS", google: "GCP", "google-beta": "GCP", azurerm: "Azure", azuread: "Azure AD", digitalocean: "DigitalOcean",
  hcloud: "Hetzner Cloud", cloudflare: "Cloudflare", kubernetes: "Kubernetes", helm: "Helm", linode: "Linode",
  vultr: "Vultr", scaleway: "Scaleway", oci: "Oracle Cloud", fly: "Fly.io", vercel: "Vercel", railway: "Railway",
  render: "Render", netlify: "Netlify", heroku: "Heroku", github: "GitHub", datadog: "Datadog", mongodbatlas: "MongoDB Atlas",
  neon: "Neon", supabase: "Supabase", upstash: "Upstash", confluent: "Confluent", docker: "Docker", openstack: "OpenStack",
};

// Folded regardless of provider.
const NOISE_RE =
  /^(random_|null_resource$|terraform_data$|time_|local_|tls_|archive_|external$|http$)|_(iam_|role_|policy|policies)|_iam$|_(vpc|subnet|route|route_table|internet_gateway|nat_gateway|eip|network_interface|network_acl|vpc_endpoint|security_group|security_group_rule|key_pair|ssh_key|project|project_resources|resource_group|user_assigned_identity|role_assignment|service_account|service_account_key|project_service|network|subnetwork|router|router_nat|reserved_ip|floating_ip|primary_ip|placement_group|log_group|log_stream|metric_alarm|alarm|dashboard|acm_certificate|acm_certificate_validation|certificate|volume_attachment|ssh_keys?)(_|$)|^(kubernetes_(namespace|service_account|role|role_binding|cluster_role|cluster_role_binding|network_policy|limit_range|resource_quota|priority_class|storage_class|persistent_volume_claim|pod_disruption_budget|horizontal_pod_autoscaler)(_v\d)?)$/;

const GLUE_RE =
  /_(lb_listener|lb_listener_rule|lb_target_group|lb_target_group_attachment|alb_listener|alb_target_group|route53_record|dns_record|dns_record_set|record_set|record|api_gateway_(integration|route|stage|deployment|resource|method)|apigatewayv2_(integration|route|stage|deployment)|load_balancer_(service|target|network)|target_group_attachment|cloudfront_origin_access_(identity|control))(_|$)|^(cloudflare_record|digitalocean_record|google_dns_record_set|aws_route53_record|kubernetes_service(_v1)?)$/;

// Explicit node classes (checked before the generic suffix rules).
const TYPE_CLASS: [RegExp, TfClass][] = [
  // databases
  [/^aws_(db_instance|rds_cluster|docdb_cluster|neptune_cluster)$/, { category: "database", tech: "AWS RDS" }],
  [/^aws_dynamodb_table$/, { category: "database", tech: "DynamoDB" }],
  [/^aws_redshift_cluster$/, { category: "database", tech: "Redshift" }],
  [/^aws_(opensearch|elasticsearch)_domain$/, { category: "search", tech: "OpenSearch" }],
  [/^aws_elasticache_(cluster|replication_group|serverless_cache)$/, { category: "cache", tech: "ElastiCache" }],
  [/^aws_(sqs_queue)$/, { category: "queue", tech: "SQS" }],
  [/^aws_sns_topic$/, { category: "queue", tech: "SNS" }],
  [/^aws_(kinesis_stream|msk_cluster|mq_broker)$/, { category: "queue" }],
  [/^aws_s3_bucket$/, { category: "storage", tech: "S3" }],
  [/^aws_efs_file_system$/, { category: "storage", tech: "EFS" }],
  [/^aws_ecr_repository$/, { category: "registry", tech: "ECR" }],
  [/^aws_eks_cluster$/, { category: "cluster", tech: "EKS" }],
  [/^aws_ecs_cluster$/, { category: "cluster", tech: "ECS" }],
  [/^aws_ecs_service$/, { category: "compute", tech: "ECS service" }],
  [/^aws_ecs_task_definition$/, { category: "workload", tech: "ECS task" }],
  [/^aws_instance$/, { category: "compute", tech: "EC2" }],
  [/^aws_(autoscaling_group)$/, { category: "compute", tech: "EC2 ASG" }],
  [/^aws_lambda_function$/, { category: "function", tech: "Lambda" }],
  [/^aws_apprunner_service$/, { category: "compute", tech: "App Runner" }],
  [/^aws_(lb|alb|elb)$/, { category: "loadbalancer", tech: "AWS ELB" }],
  [/^aws_(api_gateway_rest_api|apigatewayv2_api)$/, { category: "gateway", tech: "API Gateway" }],
  [/^aws_cloudfront_distribution$/, { category: "cdn", tech: "CloudFront" }],
  [/^aws_route53_zone$/, { category: "dns", tech: "Route 53" }],
  [/^aws_(secretsmanager_secret|kms_key)$/, { category: "secret" }],
  [/^aws_wafv2_web_acl$/, { category: "firewall", tech: "WAF" }],
  [/^aws_eks_(node_group|addon|fargate_profile)$|^aws_rds_cluster_instance$|^aws_db_(subnet_group|parameter_group|option_group)$|^aws_elasticache_(subnet_group|parameter_group)$|^aws_s3_bucket_\w+$|^aws_sqs_queue_policy$|^aws_sns_topic_(subscription|policy)$|^aws_ecr_lifecycle_policy$|^aws_secretsmanager_secret_version$|^aws_kms_alias$|^aws_launch_template$|^aws_lambda_permission$|^aws_cloudwatch_event_(rule|target)$|^aws_appautoscaling_\w+$/, { fold: "attach" }],
  // Google
  [/^google_sql_database_instance$/, { category: "database", tech: "Cloud SQL" }],
  [/^google_(spanner_instance|bigtable_instance|firestore_database|alloydb_cluster)$/, { category: "database" }],
  [/^google_bigquery_dataset$/, { category: "database", tech: "BigQuery" }],
  [/^google_redis_instance$/, { category: "cache", tech: "Memorystore" }],
  [/^google_storage_bucket$/, { category: "storage", tech: "GCS" }],
  [/^google_pubsub_topic$/, { category: "queue", tech: "Pub/Sub" }],
  [/^google_container_cluster$/, { category: "cluster", tech: "GKE" }],
  [/^google_cloud_run_(v2_)?service$/, { category: "compute", tech: "Cloud Run" }],
  [/^google_cloud_run_v2_job$/, { category: "job", tech: "Cloud Run job" }],
  [/^google_cloudfunctions2?_function$/, { category: "function", tech: "Cloud Functions" }],
  [/^google_compute_instance(_group_manager)?$/, { category: "compute", tech: "Compute Engine" }],
  [/^google_artifact_registry_repository$/, { category: "registry", tech: "Artifact Registry" }],
  [/^google_dns_managed_zone$/, { category: "dns", tech: "Cloud DNS" }],
  [/^google_compute_(global_forwarding_rule|forwarding_rule|url_map|target_https_proxy|target_http_proxy)$/, { category: "loadbalancer", tech: "Cloud Load Balancing" }],
  [/^google_secret_manager_secret$/, { category: "secret" }],
  [/^google_(sql_database|sql_user|container_node_pool|pubsub_subscription|storage_bucket_\w+|secret_manager_secret_version|compute_backend_service|compute_health_check|compute_managed_ssl_certificate|cloud_run_\w*iam\w*)$/, { fold: "attach" }],
  // Azure
  [/^azurerm_(postgresql_flexible_server|postgresql_server|mysql_flexible_server|mysql_server|mssql_server|cosmosdb_account)$/, { category: "database" }],
  [/^azurerm_redis_cache$/, { category: "cache", tech: "Azure Cache for Redis" }],
  [/^azurerm_storage_account$/, { category: "storage", tech: "Azure Storage" }],
  [/^azurerm_(servicebus_namespace|servicebus_queue|servicebus_topic|eventhub|eventhub_namespace)$/, { category: "queue" }],
  [/^azurerm_kubernetes_cluster$/, { category: "cluster", tech: "AKS" }],
  [/^azurerm_(container_app|linux_web_app|windows_web_app|app_service|linux_virtual_machine|windows_virtual_machine|virtual_machine|container_group)$/, { category: "compute" }],
  [/^azurerm_(function_app|linux_function_app|windows_function_app)$/, { category: "function", tech: "Azure Functions" }],
  [/^azurerm_(static_web_app|static_site)$/, { category: "frontend" }],
  [/^azurerm_container_registry$/, { category: "registry", tech: "ACR" }],
  [/^azurerm_(dns_zone|private_dns_zone)$/, { category: "dns", tech: "Azure DNS" }],
  [/^azurerm_(lb|application_gateway)$/, { category: "loadbalancer" }],
  [/^azurerm_(api_management)$/, { category: "gateway", tech: "API Management" }],
  [/^azurerm_(cdn_profile|cdn_frontdoor_profile|frontdoor)$/, { category: "cdn" }],
  [/^azurerm_key_vault$/, { category: "secret", tech: "Key Vault" }],
  [/^azurerm_(postgresql_flexible_server_\w+|mssql_database|kubernetes_cluster_node_pool|storage_container|key_vault_secret|service_plan|app_service_plan)$/, { fold: "attach" }],
  // DigitalOcean
  [/^digitalocean_database_cluster$/, { category: "database", tech: "DO Managed Database" }],
  [/^digitalocean_kubernetes_cluster$/, { category: "cluster", tech: "DOKS" }],
  [/^digitalocean_droplet$/, { category: "compute", tech: "Droplet" }],
  [/^digitalocean_app$/, { category: "compute", tech: "App Platform" }],
  [/^digitalocean_spaces_bucket$/, { category: "storage", tech: "Spaces" }],
  [/^digitalocean_container_registry$/, { category: "registry", tech: "DOCR" }],
  [/^digitalocean_loadbalancer$/, { category: "loadbalancer", tech: "DO Load Balancer" }],
  [/^digitalocean_domain$/, { category: "dns", tech: "DO DNS" }],
  [/^digitalocean_cdn$/, { category: "cdn" }],
  [/^digitalocean_(database_\w+|kubernetes_node_pool|volume|spaces_bucket_\w+|firewall|monitor_alert|container_registry_docker_credentials)$/, { fold: "attach" }],
  // Hetzner
  [/^hcloud_server$/, { category: "compute", tech: "Hetzner server" }],
  [/^hcloud_load_balancer$/, { category: "loadbalancer", tech: "Hetzner LB" }],
  [/^hcloud_(volume|server_network|rdns|firewall_attachment|firewall|load_balancer_\w+)$/, { fold: "attach" }],
  // Cloudflare
  [/^cloudflare_zone$/, { category: "dns", tech: "Cloudflare" }],
  [/^cloudflare_(worker_script|workers_script|worker)$/, { category: "function", tech: "Cloudflare Workers" }],
  [/^cloudflare_pages_project$/, { category: "frontend", tech: "Cloudflare Pages" }],
  [/^cloudflare_r2_bucket$/, { category: "storage", tech: "R2" }],
  [/^cloudflare_(ruleset|page_rule|zone_settings_override|worker_route|workers_route|tunnel|tunnel_config|access_\w+|filter|firewall_rule)$/, { fold: "attach" }],
  // Kubernetes / Helm providers
  [/^kubernetes_(deployment|stateful_set|daemonset|daemon_set)(_v1)?$/, { category: "workload" }],
  [/^kubernetes_(cron_job|job)(_v1)?$/, { category: "job" }],
  [/^kubernetes_ingress(_v1)?$/, { category: "gateway", tech: "Ingress" }],
  [/^kubernetes_(secret|config_map)(_v1)?$/, { fold: "attach" }],
  [/^helm_release$/, { category: "release", tech: "Helm" }],
  // PaaS
  [/^vercel_project$/, { category: "frontend", tech: "Vercel" }],
  [/^fly_app$/, { category: "compute", tech: "Fly.io" }],
  [/^(railway_service|render_service|render_web_service|heroku_app|netlify_site)$/, { category: "compute" }],
  [/^(mongodbatlas_cluster|mongodbatlas_advanced_cluster|neon_project|supabase_project|planetscale_database)$/, { category: "database" }],
  [/^upstash_redis_database$/, { category: "cache", tech: "Upstash Redis" }],
  [/^confluent_kafka_cluster$/, { category: "queue", tech: "Confluent Kafka" }],
  [/^docker_container$/, { category: "workload", tech: "Docker" }],
  [/^docker_image$/, { fold: "attach", label: "image" }],
];

function classify(type: string): TfClass {
  for (const [re, c] of TYPE_CLASS) if (re.test(type)) return c;
  if (GLUE_RE.test(type)) return { fold: "glue" };
  if (NOISE_RE.test(type)) return { fold: "noise" };
  // Generic fallbacks on the type's shape, so unknown providers still read well.
  const t = type.replace(/^[a-z0-9]+_/, "_");
  if (/_(db|database|rds|sql|postgres(ql)?|mysql|mongo\w*)(_(instance|cluster|server))?$/.test(t)) return { category: "database" };
  if (/_(redis|memcached|cache)(_\w+)?$/.test(t)) return { category: "cache" };
  if (/_bucket$/.test(t)) return { category: "storage" };
  if (/_(queue|topic|stream)$/.test(t)) return { category: "queue" };
  if (/_(kubernetes|k8s)_cluster$|_cluster$/.test(t)) return { category: "cluster" };
  if (/_(function|lambda)$/.test(t)) return { category: "function" };
  if (/_(instance|server|droplet|virtual_machine|vm|app|service)$/.test(t)) return { category: "compute" };
  if (/_(zone|domain)$/.test(t)) return { category: "dns" };
  if (/_(load_?balancer|lb)$/.test(t)) return { category: "loadbalancer" };
  if (/_(registry|repository)$/.test(t)) return { category: "registry" };
  return { fold: "noise" };
}

// Remote module sources → category ("terraform-aws-modules/rds/aws").
function classifyModuleSource(source: string): TfClass {
  const s = source.toLowerCase();
  if (/(^|[/-])(rds|aurora|sql|postgres|mysql|db|database|dynamodb)([/-]|$)/.test(s)) return { category: "database" };
  if (/(^|[/-])(eks|gke|aks|kubernetes|k8s|doks)([/-]|$)/.test(s)) return { category: "cluster" };
  if (/(^|[/-])(s3|bucket|gcs|storage)([/-]|$)/.test(s)) return { category: "storage" };
  if (/(^|[/-])(redis|elasticache|memorystore)([/-]|$)/.test(s)) return { category: "cache" };
  if (/(^|[/-])(sqs|sns|pubsub|kafka|msk|queue)([/-]|$)/.test(s)) return { category: "queue" };
  if (/(^|[/-])(alb|elb|lb|load-balancer)([/-]|$)/.test(s)) return { category: "loadbalancer" };
  if (/(^|[/-])(lambda|function|functions)([/-]|$)/.test(s)) return { category: "function" };
  if (/(^|[/-])(ecs|ec2|instance|vm|cloud-run|app-service)([/-]|$)/.test(s)) return { category: "compute" };
  if (/(^|[/-])(ecr|registry)([/-]|$)/.test(s)) return { category: "registry" };
  if (/(^|[/-])(route53|dns|zone)([/-]|$)/.test(s)) return { category: "dns" };
  if (/(^|[/-])(cloudfront|cdn)([/-]|$)/.test(s)) return { category: "cdn" };
  if (/(^|[/-])(vpc|network|subnet|security-group|iam|kms|acm)([/-]|$)/.test(s)) return { fold: "noise", label: "module" };
  return { category: "release", tech: "Terraform module" };
}

function providerOf(type: string): string {
  if (type === "helm_release") return "kubernetes";
  const p = type.slice(0, type.indexOf("_") === -1 ? type.length : type.indexOf("_"));
  return p === "google-beta" ? "google" : p;
}

function moduleSourceProvider(source: string): string | undefined {
  const m = /terraform-([a-z0-9]+)-modules|\/(aws|google|azurerm|digitalocean|hcloud|cloudflare|kubernetes)(\/|$|\?)|^(aws|google|azurerm)[-_]/i.exec(source);
  return (m?.[1] ?? m?.[2] ?? m?.[4])?.toLowerCase();
}

// Attribute names worth showing (literal values only; SECRET_KEY_RE applies on top).
const SETTING_KEYS = [
  "engine", "engine_version", "database_version", "instance_class", "instance_type", "machine_type", "server_type", "vm_size",
  "node_type", "tier", "sku_name", "size", "allocated_storage", "storage_type", "multi_az", "num_cache_nodes", "node_count",
  "min_size", "max_size", "desired_size", "desired_count", "min_node_count", "max_node_count", "replicas",
  "cpu", "memory", "memory_size", "timeout", "runtime", "handler", "image", "image_uri", "kubernetes_version", "version",
  "region", "location", "zone", "availability_zone", "datacenter", "launch_type", "chart", "repository", "namespace",
  "port", "load_balancer_type", "internal", "fifo_queue", "billing_mode", "versioning", "storage_class", "family",
];

const NAME_KEYS = ["identifier", "name", "bucket", "cluster_name", "function_name", "cluster_id", "domain", "zone_name", "repository_name", "family", "app_name"];

const GENERIC_LABELS = new Set(["this", "main", "default", "primary", "self", "app", "resource", "example", "it", "instance", "cluster", "db", "bucket"]);

interface DirConfig {
  dir: string;
  files: string[];
  blocks: { file: string; block: HclBlock }[];
  variables: Map<string, string>; // name → literal default
  locals: Map<string, string>; // name → literal value
  providers: string[];
}

interface Instance {
  prefix: string; // "" or "module.db." (nested: "module.a.module.b.")
  moduleName?: string; // innermost module call name
  config: DirConfig;
  rootDir: string;
  inputs: Map<string, Set<string>>; // var name → referenced addresses (parent scope, resolved)
  inputValues: Map<string, string>; // var name → literal value passed by the caller
}

interface TfRes {
  addr: string; // full address with module prefix
  type: string;
  label: string;
  inst: Instance;
  file: string;
  block: HclBlock;
  cls: TfClass;
  remoteModule?: string; // module source for remote modules
}

function tfFiles(ctx: ScanContext): { files: string[]; truncated: boolean } {
  const all = ctx.fl.files.filter((f) => /\.tf(\.json)?$/.test(f) && !isFixturePath(f) && !/\.tfstate/.test(f));
  return { files: all.slice(0, MAX_TF_FILES), truncated: all.length > MAX_TF_FILES };
}

function loadDir(ctx: ScanContext, dir: string, files: string[], counter: { n: number }): DirConfig {
  const blocks: { file: string; block: HclBlock }[] = [];
  for (const file of files) {
    const text = readCached(ctx, file);
    counter.n++;
    if (text === null) continue;
    for (const block of file.endsWith(".json") ? parseHclJson(text) : parseHcl(text)) blocks.push({ file, block });
  }
  const variables = new Map<string, string>();
  const locals = new Map<string, string>();
  const providers: string[] = [];
  for (const { block } of blocks) {
    if (block.type === "variable" && block.labels[0] !== undefined) {
      const d = block.attrs.default?.value;
      if (d !== undefined) variables.set(block.labels[0], d);
    } else if (block.type === "locals") {
      for (const a of Object.values(block.attrs)) if (a.value !== undefined) locals.set(a.name, a.value);
    } else if (block.type === "provider" && block.labels[0] !== undefined) {
      providers.push(block.labels[0]);
    } else if (block.type === "terraform") {
      for (const rp of block.blocks.filter((b) => b.type === "required_providers")) providers.push(...Object.keys(rp.attrs));
    }
  }
  return { dir, files, blocks, variables, locals, providers: uniq(providers).sort() };
}

const REF_RE = /\b(module\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|var\.[A-Za-z0-9_-]+|data\.[a-z0-9]+_[a-z0-9_]+\.[A-Za-z0-9_-]+|[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*)/g;

export function detectTerraform(ctx: ScanContext, report: InfraReport): void {
  const { files, truncated } = tfFiles(ctx);
  if (files.length === 0) return;
  if (truncated) report.truncated = true;
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const d = dirname(f);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const counter = { n: 0 };
  const configs = new Map<string, DirConfig>();
  const config = (dir: string): DirConfig | undefined => {
    const fs = byDir.get(dir);
    if (fs === undefined) return undefined;
    let c = configs.get(dir);
    if (c === undefined) {
      c = loadDir(ctx, dir, fs, counter);
      configs.set(dir, c);
    }
    return c;
  };
  // Local module targets.
  const moduleTargets = new Set<string>();
  for (const dir of [...byDir.keys()].sort()) {
    const c = config(dir);
    for (const { block } of c?.blocks ?? []) {
      if (block.type !== "module") continue;
      const src = block.attrs.source?.value;
      if (src !== undefined && (src.startsWith("./") || src.startsWith("../"))) {
        const t = normJoin(dir, src);
        if (t !== null) moduleTargets.add(t);
      }
    }
  }
  const roots = [...byDir.keys()]
    .filter((d) => !moduleTargets.has(d) && !/(^|\/)modules(\/|$)/.test(d))
    .filter((d) => (config(d)?.blocks ?? []).some((b) => b.block.type === "resource" || b.block.type === "module"))
    .sort();
  report.filesRead += counter.n;

  for (const rootDir of roots) {
    const rootCfg = config(rootDir);
    if (rootCfg === undefined) continue;
    const resources: TfRes[] = [];
    const moduleCalls = new Map<string, { inst: Instance; block: HclBlock; file: string; child?: Instance }>(); // "prefix+module.x" → call
    const outputs = new Map<string, Set<string>>(); // "module.x.<output>" (full prefix) → addresses
    const noiseDetails: string[] = [];
    const instances: Instance[] = [];

    const refsOf = (inst: Instance, text: string): Set<string> => {
      const out = new Set<string>();
      for (const m of text.matchAll(REF_RE)) {
        const ref = m[1] ?? "";
        if (ref.startsWith("var.")) {
          for (const a of inst.inputs.get(ref.slice(4)) ?? []) out.add(a);
        } else if (ref.startsWith("data.")) {
          continue;
        } else if (ref.startsWith("module.")) {
          const parts = ref.split(".");
          out.add(`${inst.prefix}module.${parts[1]}${parts[2] !== undefined ? `.${parts[2]}` : ""}`);
        } else {
          out.add(`${inst.prefix}${ref}`);
        }
      }
      return out;
    };

    // A literal value: the attribute itself, or the variable / local it names (caller's value first).
    const literal = (inst: Instance, a: HclAttr | undefined): string | undefined => {
      if (a === undefined) return undefined;
      if (a.value !== undefined) return a.value;
      const v = /^var\.([A-Za-z0-9_-]+)$/.exec(a.raw);
      if (v !== null) return inst.inputValues.get(v[1] ?? "") ?? inst.config.variables.get(v[1] ?? "");
      const l = /^local\.([A-Za-z0-9_-]+)$/.exec(a.raw);
      if (l !== null) return inst.config.locals.get(l[1] ?? "");
      return undefined;
    };

    const instantiate = (cfg: DirConfig, prefix: string, moduleName: string | undefined, inputs: Map<string, Set<string>>, inputValues: Map<string, string>, depth: number, seen: Set<string>): Instance => {
      const inst: Instance = { prefix, config: cfg, rootDir, inputs, inputValues, ...(moduleName !== undefined ? { moduleName } : {}) };
      instances.push(inst);
      for (const { file, block } of cfg.blocks) {
        if (block.type === "resource" && block.labels.length >= 2) {
          const [type = "", label = ""] = block.labels;
          resources.push({ addr: `${prefix}${type}.${label}`, type, label, inst, file, block, cls: classify(type) });
        } else if (block.type === "module" && block.labels[0] !== undefined) {
          const name = block.labels[0];
          const src = block.attrs.source?.value ?? "";
          const call: { inst: Instance; block: HclBlock; file: string; child?: Instance } = { inst, block, file };
          moduleCalls.set(`${prefix}module.${name}`, call);
          const local = src.startsWith("./") || src.startsWith("../");
          const target = local ? normJoin(cfg.dir, src) : null;
          const childCfg = target !== null ? config(target) : undefined;
          if (childCfg !== undefined && depth < MAX_MODULE_DEPTH && !seen.has(childCfg.dir)) {
            const childInputs = new Map<string, Set<string>>();
            const childValues = new Map<string, string>();
            for (const a of Object.values(block.attrs)) {
              if (a.name === "source" || a.name === "version" || a.name === "providers") continue;
              childInputs.set(a.name, refsOf(inst, a.raw));
              const lv = literal(inst, a);
              if (lv !== undefined) childValues.set(a.name, lv);
            }
            call.child = instantiate(childCfg, `${prefix}module.${name}.`, name, childInputs, childValues, depth + 1, new Set([...seen, childCfg.dir]));
          } else if (!local && src !== "") {
            const cls = classifyModuleSource(src);
            resources.push({ addr: `${prefix}module.${name}`, type: "module", label: name, inst, file, block, cls, remoteModule: src });
          }
        } else if (block.type === "output" && block.labels[0] !== undefined && prefix !== "") {
          outputs.set(`${prefix.slice(0, -1)}.${block.labels[0]}`, refsOf(inst, blockText(block)));
        } else if (block.type === "data" && block.labels.length >= 2 && prefix === "") {
          noiseDetails.push(`reads data.${block.labels[0]}.${block.labels[1]}`);
        }
      }
      return inst;
    };
    instantiate(rootCfg, "", undefined, new Map(), new Map(), 0, new Set([rootDir]));
    if (resources.length === 0) continue;

    // Providers of this root: resource prefixes (+ declared ones for remote modules).
    const resByAddr = new Map(resources.map((r) => [r.addr, r]));
    const providerFor = (r: TfRes): string => {
      if (r.remoteModule !== undefined) return moduleSourceProvider(r.remoteModule) ?? r.inst.config.providers.find((p) => p !== "random" && p !== "null") ?? rootCfg.providers[0] ?? "terraform";
      return providerOf(r.type);
    };
    // Resolve a reference to resource addresses (module outputs → the resources behind them).
    const resolve = (ref: string, depth = 0): string[] => {
      if (resByAddr.has(ref)) return [ref];
      const withoutAttr = ref.replace(/\.[^.]+$/, "");
      if (resByAddr.has(withoutAttr)) return [withoutAttr];
      if (depth > 4) return [];
      const out = outputs.get(ref);
      if (out !== undefined) return [...out].flatMap((a) => resolve(a, depth + 1));
      const call = moduleCalls.get(ref) ?? moduleCalls.get(withoutAttr);
      if (call !== undefined) {
        const key = moduleCalls.get(ref) !== undefined ? ref : withoutAttr;
        const inside = resources.filter((r) => r.addr.startsWith(`${key}.`) && r.cls.category !== undefined).map((r) => r.addr);
        return inside.slice(0, 3);
      }
      return [];
    };

    const rawRefs = new Map<string, Set<string>>();
    for (const r of resources) {
      const set = new Set<string>();
      const text = r.remoteModule !== undefined ? Object.values(r.block.attrs).filter((a) => a.name !== "source").map((a) => a.raw).join("\n") : blockText(r.block);
      for (const ref of refsOf(r.inst, text)) for (const a of resolve(ref)) if (a !== r.addr) set.add(a);
      rawRefs.set(r.addr, set);
    }


    // Items.
    const groupKeys = new Map<string, InfraGroup>();
    const nodeRes = resources.filter((r) => r.cls.category !== undefined);
    const multiRoot = roots.length > 1;
    const groupFor = (provider: string): InfraGroup => {
      const key = `terraform:${rootDir}:${provider}`;
      let g = groupKeys.get(key);
      if (g === undefined) {
        const pretty = PROVIDER_NAMES[provider] ?? provider;
        g = {
          key,
          tool: "terraform",
          name: `Terraform: ${pretty}${multiRoot ? ` (${rootDir === "" ? "root" : rootDir})` : ""}`,
          kind: "provider",
          ...(rootDir !== "" ? { path: rootDir } : {}),
          files: [],
          settings: { root: rootDir === "" ? "." : rootDir, provider },
          details: [],
          hints: [],
        };
        groupKeys.set(key, g);
      }
      return g;
    };

    const itemKey = (addr: string): string => `tf:${rootDir}:${addr}`;
    const items = new Map<string, InfraItem>();
    for (const r of nodeRes) {
      const g = groupFor(providerFor(r));
      const inst = r.inst;
      const settings: Record<string, string> = {};
      for (const k of SETTING_KEYS) {
        const v = safeSetting(k, literal(inst, findAttr(r.block, k)));
        if (v !== undefined) settings[k] = v;
      }
      if (r.block.attrs.count !== undefined) settings.count = literal(inst, r.block.attrs.count) ?? "dynamic";
      if (r.block.attrs.for_each !== undefined) settings.for_each = "dynamic";
      if (r.remoteModule !== undefined) settings.source = r.remoteModule;
      const text = blockText(r.block);
      const images = uniq([...text.matchAll(/\bimage(?:_uri)?"?\s*[=:]\s*"([^"$\s]+)"/g)].map((m) => m[1] ?? "").filter((s) => s !== ""));
      if (images.length > 0 && settings.image === undefined) settings.image = images.join(", ");
      const nameTag = /\bName"?\s*=\s*"([^"$]+)"/.exec(findAttr(r.block, "tags", 1)?.raw ?? "")?.[1];
      let name: string | undefined;
      for (const k of NAME_KEYS) {
        const v = literal(inst, r.block.attrs[k] ?? r.block.blocks.find((b) => b.type === "metadata")?.attrs[k]);
        if (v !== undefined && v.length <= 63) {
          name = v;
          break;
        }
      }
      name ??= nameTag;
      if (name === undefined) {
        if (!GENERIC_LABELS.has(r.label)) name = r.label;
        else if (inst.moduleName !== undefined) name = inst.moduleName;
        else name = `${r.label}-${r.type.replace(/^[a-z0-9]+_/, "").replace(/_/g, "-")}`;
      }
      if (r.type === "helm_release" || r.remoteModule !== undefined) {
        const chart = settings.chart ?? r.remoteModule ?? "";
        const kind = INFRA_KINDS.find((k) => k.images.some((i) => chart.toLowerCase().includes(i)) || chart.toLowerCase().includes(k.key));
        if (kind !== undefined) {
          settings.product = kind.name;
        }
      }
      const kindKey = infraKindOf(r, settings);
      const tech = uniq([...(r.cls.tech !== undefined ? [r.cls.tech] : []), ...(settings.engine !== undefined ? [`${settings.engine}${settings.engine_version !== undefined ? ` ${settings.engine_version}` : ""}`] : [])]);
      const hints = uniq([r.addr, `${r.type}.${r.label}`, name, ...(nameTag !== undefined ? [nameTag] : [])]);
      items.set(r.addr, {
        key: itemKey(r.addr),
        group: g.key,
        tool: "terraform",
        kind: r.remoteModule !== undefined ? "module" : r.type,
        address: r.addr,
        name,
        category: r.cls.category ?? "other",
        file: r.file,
        line: r.block.line,
        settings,
        details: [],
        hints,
        images,
        tech: tech.length > 0 ? tech : [PROVIDER_NAMES[providerOf(r.type)] ?? "Terraform"],
        ...(kindKey !== undefined ? { infraKind: kindKey } : {}),
      });
      g.files = uniq([...g.files, r.file]);
    }

    // Folded resources: attach to the one item they reference, else to the group.
    const folded = resources.filter((r) => r.cls.category === undefined);
    const defaultGroup = (): InfraGroup => {
      const first = [...groupKeys.values()][0];
      return first ?? groupFor(rootCfg.providers.find((p) => p !== "random" && p !== "null") ?? "terraform");
    };
    for (const r of folded) {
      const label = `${r.addr}${r.cls.label !== undefined ? ` (${r.cls.label})` : ""}`;
      const targets = [...(rawRefs.get(r.addr) ?? [])].filter((a) => items.has(a));
      if (r.cls.fold === "glue") continue; // handled with its component below
      if (targets.length === 1) items.get(targets[0] ?? "")?.details.push(label);
      else (groupKeys.get(`terraform:${rootDir}:${providerOf(r.type)}`) ?? defaultGroup()).details.push(label);
    }
    const primary = defaultGroup();
    primary.details.push(...noiseDetails.slice(0, 20));
    const outs = rootCfg.blocks.filter((b) => b.block.type === "output").map((b) => b.block.labels[0] ?? "");
    if (outs.length > 0) primary.settings.outputs = outs.slice(0, 12).join(", ");
    for (const g of groupKeys.values()) if (rootCfg.providers.length > 0) g.settings.providers = rootCfg.providers.join(", ");

    // Links: direct references between items.
    const links: InfraLink[] = [];
    const ev = (r: TfRes): string => `${r.file}:${r.block.line}`;
    for (const r of nodeRes) {
      for (const a of rawRefs.get(r.addr) ?? []) {
        const to = items.get(a);
        if (to === undefined) continue;
        links.push({ from: { item: itemKey(r.addr) }, to: { item: to.key }, label: refLabel(items.get(r.addr)?.category, to.category), kind: edgeKind(to.category), evidence: [ev(r)] });
      }
    }
    // Glue components: union glue resources connected by references; connect the items around them front → back.
    const glue = folded.filter((r) => r.cls.fold === "glue");
    const parent = new Map(glue.map((r) => [r.addr, r.addr]));
    const find = (a: string): string => {
      let x = a;
      while (parent.get(x) !== x) x = parent.get(x) ?? x;
      return x;
    };
    for (const r of glue) for (const a of rawRefs.get(r.addr) ?? []) if (parent.has(a)) parent.set(find(r.addr), find(a));
    const components = new Map<string, { glue: TfRes[]; around: Set<string> }>();
    for (const r of glue) {
      const c = components.get(find(r.addr)) ?? { glue: [], around: new Set<string>() };
      c.glue.push(r);
      for (const a of rawRefs.get(r.addr) ?? []) if (items.has(a)) c.around.add(a);
      components.set(find(r.addr), c);
    }
    for (const r of nodeRes) for (const a of rawRefs.get(r.addr) ?? []) if (parent.has(a)) components.get(find(a))?.around.add(r.addr);
    for (const c of components.values()) {
      const around = [...c.around].map((a) => items.get(a)).filter((x): x is InfraItem => x !== undefined);
      const ranked = around.map((it) => ({ it, rank: FRONT_RANK[it.category] ?? 9 })).sort((a, b) => a.rank - b.rank || byString(a.it.key, b.it.key));
      const evidence = uniq(c.glue.map(ev)).sort().slice(0, 10);
      for (let i = 0; i < ranked.length; i++) {
        const from = ranked[i];
        if (from === undefined || from.rank >= 9) continue;
        const nextRank = ranked.find((x) => x.rank > from.rank)?.rank;
        if (nextRank === undefined) continue;
        for (const to of ranked.filter((x) => x.rank === nextRank)) {
          links.push({ from: { item: from.it.key }, to: { item: to.it.key }, label: from.it.category === "dns" ? "resolves" : "routes", kind: "sync", evidence });
        }
      }
      // Glue with a single item around it (records in a zone we do not manage, a lone listener) is a detail of that item.
      if (around.length === 1) around[0]?.details.push(...c.glue.map((g) => g.addr));
      else if (around.length === 0) defaultGroup().details.push(...c.glue.map((g) => g.addr));
    }
    // k8s Secrets / ConfigMaps managed by Terraform: their names carry the items they reference (for manifests' envFrom).
    for (const r of folded) {
      if (!/^kubernetes_(secret|config_map)(_v1)?$/.test(r.type)) continue;
      const name = literal(r.inst, r.block.blocks.find((b) => b.type === "metadata")?.attrs.name);
      if (name === undefined) continue;
      for (const a of rawRefs.get(r.addr) ?? []) {
        const to = items.get(a);
        if (to === undefined) continue;
        links.push({ from: { item: `k8sref:${r.type.startsWith("kubernetes_secret") ? "Secret" : "ConfigMap"}/${name}` }, to: { item: to.key }, label: refLabel(undefined, to.category), kind: edgeKind(to.category), evidence: [ev(r)] });
      }
    }
    // Code a function / app deploys from a local path (source_dir, filename, build context).
    for (const r of nodeRes) {
      for (const k of ["source_dir", "source", "filename", "context", "build_context", "path"]) {
        const a = findAttr(r.block, k, 2);
        if (a === undefined) continue;
        const raw = a.raw.replace(/\$\{path\.(module|root)\}\/?/g, "");
        const lit = /^"([^"$]*)"$/.exec(raw)?.[1];
        if (lit === undefined || lit === "" || /^(https?:|git::|s3::)/.test(lit)) continue;
        const dir = normJoin(r.inst.config.dir, lit.replace(/\.zip$/, ""));
        if (dir !== null) links.push({ from: { item: itemKey(r.addr) }, to: { codeDir: dir }, label: "runs", kind: "deploy", evidence: [`${r.file}:${a.line}`] });
      }
      const it = items.get(r.addr);
      for (const img of it?.images ?? []) links.push({ from: { item: itemKey(r.addr) }, to: { image: img }, label: "runs", kind: "deploy", evidence: [ev(r)] });
      if (it?.infraKind !== undefined) links.push({ from: { item: it.key }, to: { infraKind: it.infraKind }, label: "runs", kind: "deploy", evidence: [ev(r)] });
    }

    for (const g of groupKeys.values()) g.details = uniq(g.details).sort(byString);
    for (const it of items.values()) it.details = uniq(it.details).sort(byString);
    report.groups.push(...[...groupKeys.values()].sort((a, b) => byString(a.key, b.key)));
    report.items.push(...[...items.values()].sort((a, b) => byString(a.key, b.key)));
    report.links.push(...links);
  }
}

// Front-to-back order used to connect items around glue resources.
const FRONT_RANK: Partial<Record<InfraCategory, number>> = { dns: 0, cdn: 1, gateway: 2, loadbalancer: 3, compute: 4, workload: 4, function: 4, frontend: 4, release: 4 };

function refLabel(from: InfraCategory | undefined, to: InfraCategory): string {
  if (from === "dns") return "resolves";
  if (from === "loadbalancer" || from === "cdn" || from === "gateway") return "routes";
  switch (to) {
    case "database": case "search": return "sql";
    case "cache": return "cache";
    case "storage": return "objects";
    case "queue": return "messages";
    case "secret": return "reads secrets";
    case "registry": return "pulls images";
    case "cluster": return "runs on";
    case "workload": return "runs";
    default: return "uses";
  }
}

function edgeKind(to: InfraCategory): string {
  return to === "database" || to === "storage" || to === "search" ? "data" : to === "queue" || to === "cache" ? "async" : "sync";
}

function infraKindOf(r: TfRes, settings: Record<string, string>): string | undefined {
  const engine = (settings.engine ?? settings.database_version ?? settings.product ?? "").toLowerCase();
  if (r.cls.category === "database" || r.cls.category === "cache" || r.cls.category === "search" || r.cls.category === "queue" || r.cls.category === "release") {
    if (/postgres|aurora-postgresql|pg/.test(engine) || /postgres/.test(r.type)) return "postgres";
    if (/mysql|mariadb|aurora-mysql/.test(engine) || /mysql/.test(r.type)) return "mysql";
    if (/mongo/.test(engine) || /mongo|docdb/.test(r.type)) return "mongo";
    if (/redis|valkey/.test(engine) || /redis|elasticache/.test(r.type)) return "redis";
    if (/kafka/.test(engine) || /kafka|msk/.test(r.type)) return "kafka";
    if (/rabbit/.test(engine) || /mq_broker/.test(r.type)) return "rabbitmq";
    if (/opensearch|elasticsearch/.test(engine) || /(opensearch|elasticsearch)/.test(r.type)) return "elasticsearch";
    if (r.type === "aws_sqs_queue") return "sqs";
  }
  if (r.type === "aws_s3_bucket") return "s3";
  if (r.cls.category === "storage" && /minio|spaces|r2/.test(`${r.type} ${r.cls.tech ?? ""}`.toLowerCase())) return "minio";
  return undefined;
}
