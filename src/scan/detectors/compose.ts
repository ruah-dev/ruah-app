// docker-compose + infrastructure detector (PLAN.md Phase 2, task 2.2).
//
// Compose `services` become nodes by image: postgres/mysql/mongo/… →
// datastore; redis/kafka/rabbitmq/nats/sqs → queue; nginx/traefik/envoy/… →
// gateway; anything else → service. `depends_on` becomes edges. Services with a
// local `build` context are reported with that context so the scanner can map
// them onto the package node living there.
//
// Also maps well-known client libraries in manifests onto the same infra kinds
// (`pg` → postgres, `ioredis` → redis, …) and onto third-party externals
// (`stripe` → Stripe), so a repo without a compose file still shows its stores.
import type { NodeType } from "../../contracts/architecture.js";
import { parseYaml, yamlGet, yamlKeys, yamlStrings, type YamlValue } from "../mini-yaml.js";
import type { DepRef, ScanContext } from "../types.js";
import { dirname, joinRel, readText } from "../walk.js";

export interface InfraKind {
  key: string; // canonical id: "postgres", "redis", …
  name: string; // display: "Postgres"
  type: NodeType;
  images: string[]; // image name fragments (last path segment, before the tag)
  deps: string[]; // client libraries (exact, or prefix when ending in "/")
  label: string; // edge label from a client
}

export const INFRA_KINDS: InfraKind[] = [
  { key: "postgres", name: "Postgres", type: "datastore", images: ["postgres", "postgis", "timescaledb", "pgvector", "supabase-postgres"], deps: ["pg", "postgres", "pg-promise", "@neondatabase/serverless", "@vercel/postgres", "@effect/sql-pg", "psycopg", "psycopg2", "psycopg2-binary", "asyncpg", "github.com/lib/pq", "github.com/jackc/pgx/v5", "github.com/jackc/pgx/v4", "tokio-postgres", "postgresql"], label: "sql" },
  { key: "mysql", name: "MySQL", type: "datastore", images: ["mysql", "mariadb", "percona"], deps: ["mysql", "mysql2", "@effect/sql-mysql2", "@planetscale/database", "pymysql", "mysqlclient", "github.com/go-sql-driver/mysql", "mysql-connector-j"], label: "sql" },
  { key: "mongo", name: "MongoDB", type: "datastore", images: ["mongo", "mongodb"], deps: ["mongodb", "mongoose", "pymongo", "motor", "go.mongodb.org/mongo-driver"], label: "queries" },
  { key: "sqlite", name: "SQLite", type: "datastore", images: [], deps: ["better-sqlite3", "sqlite3", "sqlite", "@effect/sql-sqlite-node", "@effect/sql-sqlite-bun", "libsql", "@libsql/client", "rusqlite", "github.com/mattn/go-sqlite3", "modernc.org/sqlite"], label: "sql" },
  { key: "elasticsearch", name: "Elasticsearch", type: "datastore", images: ["elasticsearch", "opensearch"], deps: ["@elastic/elasticsearch", "elasticsearch", "@opensearch-project/opensearch"], label: "search" },
  { key: "clickhouse", name: "ClickHouse", type: "datastore", images: ["clickhouse-server", "clickhouse"], deps: ["@clickhouse/client", "clickhouse-connect"], label: "sql" },
  { key: "minio", name: "S3 / MinIO", type: "datastore", images: ["minio"], deps: [], label: "objects" },
  { key: "redis", name: "Redis", type: "queue", images: ["redis", "valkey", "keydb", "redis-stack"], deps: ["redis", "ioredis", "@upstash/redis", "bullmq", "bull", "github.com/redis/go-redis/v9", "github.com/go-redis/redis/v8"], label: "cache" },
  { key: "kafka", name: "Kafka", type: "queue", images: ["kafka", "cp-kafka", "redpanda"], deps: ["kafkajs", "@confluentinc/kafka-javascript", "confluent-kafka", "aiokafka", "github.com/segmentio/kafka-go", "rdkafka"], label: "events" },
  { key: "rabbitmq", name: "RabbitMQ", type: "queue", images: ["rabbitmq"], deps: ["amqplib", "amqp-connection-manager", "pika", "aio-pika", "lapin"], label: "messages" },
  { key: "nats", name: "NATS", type: "queue", images: ["nats"], deps: ["nats", "github.com/nats-io/nats.go", "nats-py"], label: "messages" },
  { key: "sqs", name: "SQS", type: "queue", images: ["localstack"], deps: ["@aws-sdk/client-sqs"], label: "messages" },
  { key: "zookeeper", name: "ZooKeeper", type: "service", images: ["zookeeper", "cp-zookeeper"], deps: [], label: "coordination" },
  { key: "nginx", name: "nginx", type: "gateway", images: ["nginx", "openresty"], deps: [], label: "proxy" },
  { key: "traefik", name: "Traefik", type: "gateway", images: ["traefik"], deps: [], label: "proxy" },
  { key: "envoy", name: "Envoy", type: "gateway", images: ["envoy"], deps: [], label: "proxy" },
  { key: "caddy", name: "Caddy", type: "gateway", images: ["caddy"], deps: [], label: "proxy" },
  { key: "kong", name: "Kong", type: "gateway", images: ["kong"], deps: [], label: "proxy" },
];

export interface ExternalKind {
  key: string;
  name: string;
  deps: string[];
}

export const EXTERNAL_KINDS: ExternalKind[] = [
  { key: "stripe", name: "Stripe", deps: ["stripe", "@stripe/stripe-js"] },
  { key: "openai", name: "OpenAI", deps: ["openai"] },
  { key: "anthropic", name: "Anthropic", deps: ["@anthropic-ai/sdk", "anthropic", "@anthropic-ai/claude-agent-sdk"] },
  { key: "clerk", name: "Clerk", deps: ["@clerk/"] },
  { key: "auth0", name: "Auth0", deps: ["@auth0/", "auth0"] },
  { key: "supabase", name: "Supabase", deps: ["@supabase/supabase-js", "supabase"] },
  { key: "firebase", name: "Firebase", deps: ["firebase", "firebase-admin"] },
  { key: "sentry", name: "Sentry", deps: ["@sentry/", "sentry-sdk"] },
  { key: "resend", name: "Resend", deps: ["resend"] },
  { key: "sendgrid", name: "SendGrid", deps: ["@sendgrid/mail", "sendgrid"] },
  { key: "twilio", name: "Twilio", deps: ["twilio"] },
  { key: "s3", name: "AWS S3", deps: ["@aws-sdk/client-s3", "boto3"] },
  { key: "posthog", name: "PostHog", deps: ["posthog-js", "posthog-node", "posthog"] },
];

function depMatches(dep: DepRef, names: string[]): boolean {
  return names.some((n) => (n.endsWith("/") ? dep.name.startsWith(n) : dep.name === n));
}

export function infraFromDeps(deps: DepRef[]): InfraKind[] {
  const runtime = deps.filter((d) => !d.dev);
  return INFRA_KINDS.filter((k) => runtime.some((d) => depMatches(d, k.deps)));
}

export function externalsFromDeps(deps: DepRef[]): ExternalKind[] {
  const runtime = deps.filter((d) => !d.dev);
  return EXTERNAL_KINDS.filter((k) => runtime.some((d) => depMatches(d, k.deps)));
}

export function infraFromImage(image: string): InfraKind | undefined {
  const noTag = image.split("@")[0]?.replace(/:[^/]*$/, "") ?? image;
  const last = noTag.slice(noTag.lastIndexOf("/") + 1).toLowerCase();
  return INFRA_KINDS.find((k) => k.images.some((i) => last === i || last.startsWith(`${i}-`)));
}

export interface ComposeService {
  name: string; // compose service name
  file: string; // repo-relative compose file
  image?: string;
  buildContext?: string; // repo-relative directory ("" = repo root)
  dependsOn: string[];
  kind?: InfraKind;
  version?: string; // image tag major, e.g. "16"
}

const COMPOSE_NAMES = [
  "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
  "docker-compose.dev.yml", "docker-compose.dev.yaml", "docker-compose.override.yml",
];
const COMPOSE_DIRS = ["", "docker", "infra", "deploy", "deployment", ".docker", "ops"];

function normJoin(dir: string, p: string): string | null {
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

// Compose files at the root, in docker/ infra/ deploy/, and in `extraDirs`
// (package directories). Services are merged by name; first file wins.
export function detectCompose(ctx: ScanContext, extraDirs: string[] = []): ComposeService[] {
  const files: string[] = [];
  for (const d of [...COMPOSE_DIRS, ...extraDirs]) {
    for (const n of COMPOSE_NAMES) {
      const f = joinRel(d, n);
      if (ctx.fl.fileSet.has(f) && !files.includes(f)) files.push(f);
    }
  }
  const byName = new Map<string, ComposeService>();
  for (const file of files) {
    const text = readText(ctx.root, file);
    if (text === null) continue;
    const services = yamlGet(parseYaml(text), "services");
    for (const name of yamlKeys(services).sort()) {
      if (byName.has(name)) continue;
      const svc = yamlGet(services, name);
      const imageV = yamlGet(svc, "image");
      const image = typeof imageV === "string" ? imageV : undefined;
      const build: YamlValue | undefined = yamlGet(svc, "build");
      const ctxPath = typeof build === "string" ? build : (yamlStrings(yamlGet(build, "context"))[0] ?? undefined);
      const dependsV = yamlGet(svc, "depends_on");
      const dependsOn = (Array.isArray(dependsV) ? yamlStrings(dependsV) : yamlKeys(dependsV)).sort();
      const kind = image !== undefined ? infraFromImage(image) : undefined;
      const tag = image !== undefined ? /:(v?\d+)/.exec(image.split("@")[0] ?? "")?.[1]?.replace(/^v/, "") : undefined;
      const buildContext = ctxPath !== undefined ? normJoin(dirname(file), ctxPath) : null;
      byName.set(name, {
        name,
        file,
        ...(image !== undefined ? { image } : {}),
        ...(buildContext !== null && ctxPath !== undefined ? { buildContext } : {}),
        dependsOn,
        ...(kind !== undefined ? { kind } : {}),
        ...(tag !== undefined ? { version: tag } : {}),
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
