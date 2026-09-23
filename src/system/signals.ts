// Deterministic cross-repo signals for a multi-repo system (docs/MULTI-REPO.md).
//
// Every signal is evidence-backed (`<repoId>/<path>:<line>`) and comes from
// plain text rules, no AI:
//   1. deploy manifests — docker-compose services (build context, image,
//      name), k8s manifests (image, metadata.name) and terraform (`image =`)
//      that name another repo: `<owner> -> <repo> [deploys]`; compose
//      `depends_on` between mapped services.
//   2. env / config / source URLs and `*_URL`, `*_HOST`, `*_ADDR`, … values
//      whose host is another repo's service name (or a shared infra host).
//      Lines inside a compose service block or a k8s document are attributed
//      to the repo that service/document deploys, not to the file's repo.
//   3. queue/topic names published in one repo and consumed in another
//      (kafkajs, amqplib, bullmq, SQS/SNS, NATS, Google Pub/Sub call shapes).
//   4. internal packages: a package.json / go.mod / pyproject / Cargo name
//      declared in one repo and depended on by another.
//
// Bounded: at most MAX_SIGNAL_FILES files and MAX_REPO_BYTES per repo, files
// over MAX_SIGNAL_FILE_BYTES and lines over MAX_LINE skipped, tests and
// fixtures skipped, the scanner's ignore list (node_modules, dist, …) applies.
import * as path from "node:path";
import { EXTERNAL_KINDS, INFRA_KINDS, infraFromImage } from "../scan/detectors/compose.js";
import { isTestFile } from "../scan/detectors/entrypoints.js";
import { SOURCE_EXT } from "../scan/detectors/imports.js";
import { readManifest } from "../scan/detectors/manifests.js";
import { parseYaml, yamlGet, yamlKeys, yamlStrings, type YamlValue } from "../scan/mini-yaml.js";
import type { DepRef, ScanContext } from "../scan/types.js";
import { dirname, type FileList, readText } from "../scan/walk.js";

export const MAX_SIGNAL_FILES = 5_000;
export const MAX_SIGNAL_FILE_BYTES = 512 * 1024;
export const MAX_REPO_BYTES = 48 * 1024 * 1024;
export const MAX_LINE = 2_000;
export const MAX_EVIDENCE = 10;

export interface SignalRepo {
  id: string;
  root: string; // absolute
  fl: FileList;
}

// A shared infrastructure kind (datastore, queue, gateway, external).
export interface SharedKind {
  key: string;
  name: string;
  type: string;
  label: string; // edge label from a user
}

export type Endpoint = { repo: string } | { shared: string };

export interface CrossSignal {
  from: Endpoint;
  to: Endpoint;
  label: string;
  kind: string;
  evidence: string[]; // sorted, unique, <= MAX_EVIDENCE
}

export interface SignalResult {
  signals: CrossSignal[];
  sharedKinds: Map<string, SharedKind>; // every shared key a signal points at
  repoTypes: Map<string, { consumesTopics: boolean; publishesTopics: boolean; deployFiles: number }>;
  packageNames: Map<string, string[]>; // repo id → package names it declares
}

// ---------------------------------------------------------------- kinds

export function sharedKindFromInfraKey(key: string): SharedKind | undefined {
  const k = INFRA_KINDS.find((i) => i.key === key);
  if (k !== undefined) return { key: k.key, name: k.name, type: k.type, label: k.label };
  const e = EXTERNAL_KINDS.find((x) => x.key === key);
  if (e !== undefined) return { key: e.key, name: e.name, type: "external", label: "API" };
  return undefined;
}

export function edgeKindFor(type: string): string {
  return type === "datastore" ? "data" : type === "queue" ? "async" : "sync";
}

// ---------------------------------------------------------------- files

type FileClass = "env" | "compose" | "yaml" | "json" | "tf" | "config" | "source";

const COMPOSE_RE = /(^|\/)(docker-)?compose([.-][\w-]+)*\.ya?ml$/;
const JSON_SKIP_RE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|composer\.lock|tsconfig[^/]*\.json|jsconfig[^/]*\.json|[^/]*\.lock\.json|\.?eslintrc[^/]*|biome\.json|turbo\.json|components\.json)$/;

export function classifyFile(rel: string): FileClass | null {
  if (isTestFile(rel) || /(^|\/)(fixtures?|__fixtures__|testdata|mocks?|examples?)\//.test(rel)) return null;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (/^\.env(\..+)?$/.test(base) || /\.env$/.test(base)) return /\.local$/.test(base) ? null : "env";
  if (COMPOSE_RE.test(rel)) return "compose";
  if (/\.ya?ml$/.test(base)) return base === "pnpm-lock.yaml" ? null : "yaml";
  if (/\.json5?$/.test(base)) return JSON_SKIP_RE.test(rel) ? null : "json";
  if (/\.(tf|tfvars)$/.test(base)) return "tf";
  if (/\.(toml|properties|ini|conf|cfg)$/.test(base)) return base === "Cargo.toml" || base === "pyproject.toml" ? null : "config";
  if (SOURCE_EXT.test(base) && !/\.d\.[cm]?ts$/.test(base) && !/\.min\.js$/.test(base)) return "source";
  return null;
}

interface RepoFile {
  rel: string;
  cls: FileClass;
  lines: string[];
}

function readRepoFiles(repo: SignalRepo): RepoFile[] {
  const out: RepoFile[] = [];
  let bytes = 0;
  for (const rel of repo.fl.files) {
    if (out.length >= MAX_SIGNAL_FILES || bytes >= MAX_REPO_BYTES) break;
    const cls = classifyFile(rel);
    if (cls === null) continue;
    const text = readText(repo.root, rel);
    if (text === null || text.length > MAX_SIGNAL_FILE_BYTES) continue;
    bytes += text.length;
    out.push({ rel, cls, lines: text.split(/\r?\n/) });
  }
  return out;
}

// ---------------------------------------------------------------- aliases

function normHost(h: string): string {
  return h.toLowerCase().replaceAll("_", "-");
}

function unscoped(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

// Host name → endpoint. Repo aliases win over shared-infra aliases; an alias
// claimed by two repos is ambiguous and dropped.
class AliasIndex {
  private repo = new Map<string, string>();
  private ambiguous = new Set<string>();
  private shared = new Map<string, string>();

  addRepo(alias: string, repoId: string): void {
    const a = normHost(alias);
    if (a === "" || this.ambiguous.has(a)) return;
    const prev = this.repo.get(a);
    if (prev === undefined) this.repo.set(a, repoId);
    else if (prev !== repoId) {
      this.repo.delete(a);
      this.ambiguous.add(a);
    }
  }

  addShared(alias: string, key: string): void {
    const a = normHost(alias);
    if (a !== "" && !this.shared.has(a)) this.shared.set(a, key);
  }

  get(alias: string): Endpoint | undefined {
    const a = normHost(alias);
    const r = this.repo.get(a);
    if (r !== undefined) return { repo: r };
    const s = this.shared.get(a);
    return s !== undefined ? { shared: s } : undefined;
  }

  repoOf(alias: string): string | undefined {
    return this.repo.get(normHost(alias));
  }
}

// Hostname → the alias to look up: the full host, or its first DNS label for
// cluster-internal names (`invoices-api.default.svc.cluster.local`,
// `billing.internal`, `api.local`).
function hostCandidates(host: string): string[] {
  const h = host.toLowerCase().replace(/\.$/, "");
  const out = [h];
  if (/\.(svc(\.cluster\.local)?|cluster\.local|internal|local|localhost|lan|consul|docker)$/.test(h)) {
    const first = h.split(".")[0] ?? "";
    if (first !== "" && first !== h) out.push(first);
  }
  return out;
}

function imageBase(image: string): string {
  const noDigest = image.split("@")[0] ?? image;
  const noTag = noDigest.replace(/:[^/]*$/, "");
  return noTag.slice(noTag.lastIndexOf("/") + 1).toLowerCase();
}

// ---------------------------------------------------------------- collector

class Collector {
  private byKey = new Map<string, CrossSignal & { ev: Set<string> }>();

  add(from: Endpoint, to: Endpoint, label: string, kind: string, evidence: string | string[]): void {
    if (epKey(from) === epKey(to)) return;
    const lbl = label.length > 40 ? `${label.slice(0, 39)}…` : label;
    const key = `${epKey(from)}\u0000${epKey(to)}\u0000${lbl}`;
    let s = this.byKey.get(key);
    if (s === undefined) {
      s = { from, to, label: lbl, kind, evidence: [], ev: new Set() };
      this.byKey.set(key, s);
    }
    for (const e of Array.isArray(evidence) ? evidence : [evidence]) s.ev.add(e);
  }

  result(): CrossSignal[] {
    const generic = new Set(["calls"]);
    const specific = new Set(["HTTP", "gRPC", "WebSocket"]);
    const all = [...this.byKey.values()];
    // Fold generic "calls" evidence into a specific runtime edge of the same pair.
    for (const s of all) {
      if (!generic.has(s.label)) continue;
      const target = all.find(
        (o) => o !== s && specific.has(o.label) && epKey(o.from) === epKey(s.from) && epKey(o.to) === epKey(s.to),
      );
      if (target !== undefined) {
        for (const e of s.ev) target.ev.add(e);
        s.ev.clear();
      }
    }
    return all
      .filter((s) => s.ev.size > 0)
      .map((s) => ({
        from: s.from,
        to: s.to,
        label: s.label,
        kind: s.kind,
        evidence: sortEvidence([...s.ev]).slice(0, MAX_EVIDENCE),
      }))
      .sort((a, b) => cmp(epKey(a.from), epKey(b.from)) || cmp(epKey(a.to), epKey(b.to)) || cmp(a.label, b.label));
  }
}

export function epKey(e: Endpoint): string {
  return "repo" in e ? `repo:${e.repo}` : `shared:${e.shared}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortEvidence(ev: string[]): string[] {
  const parse = (e: string): [string, number] => {
    const m = /^(.*):(\d+)(?:-\d+)?$/.exec(e);
    return m !== null ? [m[1] ?? e, Number(m[2])] : [e, 0];
  };
  return [...new Set(ev)].sort((a, b) => {
    const [fa, la] = parse(a);
    const [fb, lb] = parse(b);
    return cmp(fa, fb) || la - lb;
  });
}

// ---------------------------------------------------------------- deploy manifests

interface Block {
  start: number; // 0-based line index, inclusive
  end: number; // inclusive
  target?: Endpoint;
}

interface ComposeService {
  name: string;
  line: number; // 0-based key line
  block: Block;
  image?: string;
  imageLine?: number;
  buildAbs?: string;
  aliases: string[]; // container_name, hostname
  dependsOn: string[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

const YAML_KEY_RE = /^\s*("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:(\s|$)/;

// Child-key blocks of the top-level `services:` mapping.
function composeBlocks(lines: string[]): { name: string; line: number; start: number; end: number }[] {
  const top = lines.findIndex((l) => /^services\s*:\s*(#.*)?$/.test(l));
  if (top === -1) return [];
  const out: { name: string; line: number; start: number; end: number }[] = [];
  let childIndent = -1;
  let i = top + 1;
  for (; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (isBlank(l)) continue;
    const ind = indentOf(l);
    if (ind === 0) break;
    if (childIndent === -1) childIndent = ind;
    if (ind < childIndent) break;
    if (ind === childIndent) {
      const m = YAML_KEY_RE.exec(l);
      if (m === null) continue;
      const prev = out[out.length - 1];
      if (prev !== undefined) prev.end = i - 1;
      out.push({ name: m[2] ?? m[3] ?? m[4] ?? "", line: i, start: i, end: i });
    }
  }
  const last = out[out.length - 1];
  if (last !== undefined) last.end = i - 1;
  return out;
}

function findLine(lines: string[], from: number, to: number, re: RegExp): number | undefined {
  for (let i = from; i <= to && i < lines.length; i++) if (re.test(lines[i] ?? "")) return i;
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseComposeFile(file: RepoFile, repoRoot: string): ComposeService[] {
  const text = file.lines.join("\n");
  const services = yamlGet(parseYaml(text), "services");
  const blocks = composeBlocks(file.lines);
  const out: ComposeService[] = [];
  for (const b of blocks) {
    const svc: YamlValue | undefined = yamlGet(services, b.name);
    const imageV = yamlGet(svc, "image");
    const image = typeof imageV === "string" ? imageV : undefined;
    const build = yamlGet(svc, "build");
    const ctxPath = typeof build === "string" ? build : yamlStrings(yamlGet(build, "context"))[0];
    const dependsV = yamlGet(svc, "depends_on");
    const dependsOn = (Array.isArray(dependsV) ? yamlStrings(dependsV) : yamlKeys(dependsV)).sort();
    const aliases = [yamlGet(svc, "container_name"), yamlGet(svc, "hostname")].filter((v): v is string => typeof v === "string");
    const imageLine = image !== undefined ? findLine(file.lines, b.start, b.end, /^\s*image\s*:/) : undefined;
    out.push({
      name: b.name,
      line: b.line,
      block: { start: b.start, end: b.end },
      ...(image !== undefined ? { image } : {}),
      ...(imageLine !== undefined ? { imageLine } : {}),
      ...(ctxPath !== undefined && ctxPath !== "" ? { buildAbs: path.resolve(repoRoot, dirname(file.rel), ctxPath) } : {}),
      aliases,
      dependsOn,
    });
  }
  return out;
}

interface K8sDoc {
  start: number;
  end: number;
  name?: string;
  kind?: string;
  images: { image: string; line: number }[];
  target?: Endpoint;
}

function parseK8sDocs(lines: string[]): K8sDoc[] {
  const docs: K8sDoc[] = [];
  let start = 0;
  const flush = (end: number): void => {
    if (end < start) return;
    const chunk = lines.slice(start, end + 1);
    const text = chunk.join("\n");
    if (!/^kind\s*:/m.test(text) || !/^apiVersion\s*:/m.test(text)) return;
    const doc = parseYaml(text);
    const kindV = yamlGet(doc, "kind");
    const nameV = yamlGet(yamlGet(doc, "metadata"), "name");
    const images: { image: string; line: number }[] = [];
    chunk.forEach((l, i) => {
      const m = /^\s*-?\s*image\s*:\s*["']?([^\s"'#]+)/.exec(l);
      if (m !== null) images.push({ image: m[1] ?? "", line: start + i });
    });
    docs.push({
      start,
      end,
      ...(typeof nameV === "string" ? { name: nameV } : {}),
      ...(typeof kindV === "string" ? { kind: kindV } : {}),
      images,
    });
  };
  lines.forEach((l, i) => {
    if (/^---(\s|$)/.test(l)) {
      flush(i - 1);
      start = i + 1;
    }
  });
  flush(lines.length - 1);
  return docs;
}

// ---------------------------------------------------------------- line rules

const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^\s/@'"`<>]*@)?([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const ENV_HOST_RE =
  /\b([A-Z][A-Z0-9_]*_(?:URL|URI|URLS|HOST|HOSTNAME|HOSTS|ADDR|ADDRESS|ENDPOINT|BROKER|BROKERS|SERVER|SERVERS|DSN|SERVICE))\b["']?\s*[:=]\s*["']?([^\s"'#,}]+(?:,[^\s"'#,}]+)*)/g;
const SERVICE_HOST_RE = /\b([A-Z][A-Z0-9_]*)_SERVICE_HOST\b/g;

function schemeLabel(scheme: string): string {
  const s = scheme.toLowerCase();
  if (s === "http" || s === "https") return "HTTP";
  if (s === "ws" || s === "wss") return "WebSocket";
  if (s === "grpc" || s === "grpcs") return "gRPC";
  return "calls";
}

// ---------------------------------------------------------------- topics

const MESSAGING_DEPS = [
  "kafkajs", "@confluentinc/kafka-javascript", "node-rdkafka", "amqplib", "amqp-connection-manager", "bullmq", "bull",
  "bee-queue", "@aws-sdk/client-sqs", "@aws-sdk/client-sns", "aws-sdk", "sqs-consumer", "sqs-producer", "nats",
  "@nats-io/", "@google-cloud/pubsub", "ioredis", "redis", "kafka-python", "confluent-kafka", "aiokafka", "pika",
  "aio-pika", "nats-py", "google-cloud-pubsub", "boto3", "github.com/segmentio/kafka-go", "github.com/nats-io/nats.go",
  "cloud.google.com/go/pubsub", "github.com/rabbitmq/amqp091-go", "github.com/ibm/sarama", "github.com/shopify/sarama",
];

const TOPIC_STOP = new Set([
  "message", "messages", "data", "error", "close", "open", "connect", "disconnect", "change", "update", "event", "events",
  "ready", "end", "test", "default", "",
]);

const Q = "(['\"`])";
const NAME = "([^'\"`\\s$]{1,200})";
const CALL_PUB_RE = new RegExp(`\\b(?:publish|sendToQueue|produce|publishMessage|publishJSON)\\s*\\(\\s*${Q}${NAME}\\1`, "g");
const AMQP_PUB_RE = new RegExp(`\\bpublish\\s*\\(\\s*${Q}([^'"\`]*)\\1\\s*,\\s*${Q}${NAME}\\3`, "g");
const CALL_SUB_RE = new RegExp(`\\b(?:subscribe|consume|KafkaConsumer)\\s*\\(\\s*${Q}${NAME}\\1`, "g");
const BIND_SUB_RE = new RegExp(`\\bbindQueue\\s*\\([^,]+,\\s*${Q}${NAME}\\1(?:\\s*,\\s*${Q}${NAME}\\3)?`, "g");
const NEW_PUB_RE = new RegExp(`\\bnew\\s+(?:Queue|FlowProducer)\\s*\\(\\s*${Q}${NAME}\\1`, "g");
const NEW_SUB_RE = new RegExp(`\\bnew\\s+(?:Worker|QueueEvents)\\s*\\(\\s*${Q}${NAME}\\1`, "g");
const GTOPIC_RE = new RegExp(`\\btopic\\s*\\(\\s*${Q}${NAME}\\1\\s*\\)\\s*\\.\\s*(publish|publishMessage|publishJSON|subscription|createSubscription)\\b`, "g");
const PROP_RE = new RegExp(`\\b(?:topic|TopicArn|QueueUrl|QueueName|TopicName|queue|subject)\\s*:\\s*${Q}${NAME}\\1`, "g");
const TOPICS_ARRAY_RE = /\btopics\s*:\s*\[([^\]]*)\]/g;
const PUB_WORD_RE = /\b(send|sendBatch|publish|produce|producer|sendMessage|SendMessageCommand|SendMessageBatchCommand|PublishCommand|PublishBatchCommand)\b/g;
const SUB_WORD_RE = /\b(subscribe|consume|consumer|ReceiveMessageCommand|KafkaConsumer)\b/g;

function topicName(raw: string): string {
  // SQS queue URLs and SNS ARNs: the last segment is the queue/topic name.
  if (/^https?:\/\//.test(raw)) return raw.slice(raw.lastIndexOf("/") + 1);
  if (raw.startsWith("arn:")) return raw.slice(raw.lastIndexOf(":") + 1);
  return raw;
}

function lastIndex(re: RegExp, text: string): number {
  let idx = -1;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) idx = m.index;
  return idx;
}

function topicMatches(pub: string, sub: string): boolean {
  if (pub === sub) return true;
  if (!sub.includes("*") && !sub.includes(">")) return false;
  // NATS-style wildcards: `*` = one token, `>` = the rest.
  const re = new RegExp(`^${sub.split(".").map((t) => (t === "*" ? "[^.]+" : t === ">" ? ".+" : escapeRe(t))).join("\\.")}$`);
  return re.test(pub);
}

interface TopicUse {
  pubs: Map<string, string[]>;
  subs: Map<string, string[]>;
}

function scanTopics(repoId: string, files: RepoFile[]): TopicUse {
  const pubs = new Map<string, string[]>();
  const subs = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, raw: string, ev: string): void => {
    const name = topicName(raw);
    if (TOPIC_STOP.has(name.toLowerCase()) || name.length < 2) return;
    const list = m.get(name) ?? [];
    if (!list.includes(ev)) list.push(ev);
    m.set(name, list);
  };
  for (const f of files) {
    if (f.cls !== "source") continue;
    f.lines.forEach((line, i) => {
      if (line.length > MAX_LINE) return;
      const ev = `${repoId}/${f.rel}:${i + 1}`;
      for (const m of line.matchAll(AMQP_PUB_RE)) {
        if ((m[2] ?? "") !== "") add(pubs, m[2] ?? "", ev);
        add(pubs, m[4] ?? "", ev);
      }
      for (const m of line.matchAll(CALL_PUB_RE)) add(pubs, m[2] ?? "", ev);
      for (const m of line.matchAll(NEW_PUB_RE)) add(pubs, m[2] ?? "", ev);
      for (const m of line.matchAll(CALL_SUB_RE)) add(subs, m[2] ?? "", ev);
      for (const m of line.matchAll(NEW_SUB_RE)) add(subs, m[2] ?? "", ev);
      for (const m of line.matchAll(BIND_SUB_RE)) {
        add(subs, m[2] ?? "", ev);
        if (m[4] !== undefined) add(subs, m[4], ev);
      }
      for (const m of line.matchAll(GTOPIC_RE)) {
        add(/^publish/.test(m[3] ?? "") ? pubs : subs, m[2] ?? "", ev);
      }
      const props: { name: string; index: number }[] = [];
      for (const m of line.matchAll(PROP_RE)) props.push({ name: m[2] ?? "", index: m.index });
      for (const m of line.matchAll(TOPICS_ARRAY_RE)) {
        for (const q of (m[1] ?? "").matchAll(/(['"`])([^'"`\s$]{1,200})\1/g)) props.push({ name: q[2] ?? "", index: m.index });
      }
      if (props.length === 0) return;
      // Property form (`producer.send({ topic: "x" })`): the closest call
      // keyword in the preceding lines decides publish vs consume.
      const window = f.lines.slice(Math.max(0, i - 6), i).join("\n");
      for (const p of props) {
        const text = `${window}\n${line.slice(0, p.index)}`;
        const pi = lastIndex(PUB_WORD_RE, text);
        const si = lastIndex(SUB_WORD_RE, text);
        if (pi === -1 && si === -1) continue;
        add(pi > si ? pubs : subs, p.name, ev);
      }
    });
  }
  return { pubs, subs };
}

// ---------------------------------------------------------------- packages

interface RepoPackage {
  name: string;
  manifest: string; // repo-relative
  deps: DepRef[];
  goModule?: string;
}

const MANIFEST_NAMES = ["package.json", "go.mod", "pyproject.toml", "Cargo.toml"];
const MAX_MANIFESTS = 300;

function repoPackages(repo: SignalRepo): RepoPackage[] {
  const ctx: ScanContext = { root: repo.root, fl: repo.fl };
  const dirs = new Set<string>();
  for (const f of repo.fl.files) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (MANIFEST_NAMES.includes(base) && !isTestFile(f) && !/(^|\/)(fixtures?|examples?)\//.test(f)) dirs.add(dirname(f));
    if (dirs.size >= MAX_MANIFESTS) break;
  }
  const out: RepoPackage[] = [];
  for (const dir of [...dirs].sort()) {
    const info = readManifest(ctx, dir);
    if (info === null || info.manifest === null) continue;
    let name: string | null = info.name;
    // Only declared names are published: package.json without "name" falls
    // back to the directory name in readManifest.
    if (info.manifest.endsWith("package.json")) {
      try {
        const pj = JSON.parse(readText(repo.root, info.manifest) ?? "{}") as { name?: unknown };
        name = typeof pj.name === "string" && pj.name !== "" ? pj.name : null;
      } catch {
        name = null;
      }
    }
    if (info.manifest.endsWith("requirements.txt")) name = null;
    out.push({
      name: name ?? "",
      manifest: info.manifest,
      deps: info.deps,
      ...(info.goModule !== undefined ? { goModule: info.goModule } : {}),
    });
  }
  return out;
}

function manifestLine(repo: SignalRepo, manifest: string, dep: string): number {
  const text = readText(repo.root, manifest);
  if (text === null) return 1;
  const lines = text.split(/\r?\n/);
  const quoted = new RegExp(`["']${escapeRe(dep)}["']`);
  const bare = new RegExp(`(^|[\\s"'=])${escapeRe(dep)}($|[\\s"'=<>~!\\[;@])`);
  const i = lines.findIndex((l) => quoted.test(l));
  if (i !== -1) return i + 1;
  const j = lines.findIndex((l) => bare.test(l));
  return j === -1 ? 1 : j + 1;
}

function depMatches(dep: string, names: string[]): boolean {
  return names.some((n) => (n.endsWith("/") ? dep.startsWith(n) : dep === n));
}

// ---------------------------------------------------------------- main

export function detectCrossRepoSignals(repos: SignalRepo[]): SignalResult {
  const aliases = new AliasIndex();
  const sharedKinds = new Map<string, SharedKind>();
  const useShared = (key: string): void => {
    const k = sharedKindFromInfraKey(key);
    if (k !== undefined && !sharedKinds.has(key)) sharedKinds.set(key, k);
  };
  for (const k of INFRA_KINDS) {
    aliases.addShared(k.key, k.key);
    for (const img of k.images) aliases.addShared(img, k.key);
  }
  aliases.addShared("postgresql", "postgres");
  aliases.addShared("mongodb", "mongo");

  // Repo aliases: id, declared package names (unscoped too).
  const packages = new Map<string, RepoPackage[]>();
  const packageNames = new Map<string, string[]>();
  for (const r of repos) {
    aliases.addRepo(r.id, r.id);
    const pkgs = repoPackages(r);
    packages.set(r.id, pkgs);
    const names = pkgs.map((p) => p.name).filter((n) => n !== "");
    packageNames.set(r.id, names);
  }
  for (const r of repos) {
    for (const n of packageNames.get(r.id) ?? []) {
      aliases.addRepo(n, r.id);
      aliases.addRepo(unscoped(n), r.id);
    }
  }

  const files = new Map<string, RepoFile[]>();
  for (const r of repos) files.set(r.id, readRepoFiles(r));

  const repoOfDir = (abs: string): string | undefined => {
    let best: SignalRepo | undefined;
    for (const r of repos) {
      if (abs === r.root || abs.startsWith(`${r.root}${path.sep}`)) {
        if (best === undefined || r.root.length > best.root.length) best = r;
      }
    }
    return best?.id;
  };

  // ---- Phase 1: deploy manifests → service-name aliases ----
  interface ComposeFile {
    owner: string;
    file: RepoFile;
    services: ComposeService[];
  }
  interface K8sFile {
    owner: string;
    file: RepoFile;
    docs: K8sDoc[];
  }
  const composeFiles: ComposeFile[] = [];
  const k8sFiles: K8sFile[] = [];
  const deployCount = new Map<string, number>();
  const bump = (id: string): void => void deployCount.set(id, (deployCount.get(id) ?? 0) + 1);
  for (const r of repos) {
    for (const f of files.get(r.id) ?? []) {
      if (f.cls === "compose") {
        const services = parseComposeFile(f, r.root);
        if (services.length > 0) {
          composeFiles.push({ owner: r.id, file: f, services });
          bump(r.id);
        }
      } else if (f.cls === "yaml") {
        const docs = parseK8sDocs(f.lines);
        if (docs.length > 0) {
          k8sFiles.push({ owner: r.id, file: f, docs });
          bump(r.id);
        }
      } else if (f.cls === "tf") bump(r.id);
    }
  }
  const imageTarget = (image: string): Endpoint | undefined => {
    const base = imageBase(image);
    const repo = aliases.repoOf(base);
    if (repo !== undefined) return { repo };
    const kind = infraFromImage(image);
    return kind !== undefined ? { shared: kind.key } : undefined;
  };
  // Two rounds so names learned from one manifest (a k8s Deployment mapped by
  // image) resolve services named in another.
  for (let round = 0; round < 2; round++) {
    for (const cf of composeFiles) {
      for (const s of cf.services) {
        let target: Endpoint | undefined;
        if (s.buildAbs !== undefined) {
          const repo = repoOfDir(s.buildAbs);
          if (repo !== undefined) target = { repo };
        }
        if (target === undefined && s.image !== undefined) target = imageTarget(s.image);
        if (target === undefined) target = aliases.get(s.name);
        if (target === undefined) continue;
        s.block.target = target;
        for (const a of [s.name, ...s.aliases]) {
          if ("repo" in target) aliases.addRepo(a, target.repo);
          else aliases.addShared(a, target.shared);
        }
      }
    }
    for (const kf of k8sFiles) {
      for (const d of kf.docs) {
        let target: Endpoint | undefined;
        for (const im of d.images) {
          target = imageTarget(im.image);
          if (target !== undefined) break;
        }
        if (target === undefined && d.name !== undefined) target = aliases.get(d.name);
        if (target === undefined) continue;
        d.target = target;
        if (d.name !== undefined) {
          if ("repo" in target) aliases.addRepo(d.name, target.repo);
          else aliases.addShared(d.name, target.shared);
        }
      }
    }
  }

  const out = new Collector();
  const addTo = (from: Endpoint, to: Endpoint, repoLabel: string, ev: string): void => {
    if ("shared" in to) {
      useShared(to.shared);
      const k = sharedKinds.get(to.shared);
      out.add(from, to, k?.label ?? repoLabel, edgeKindFor(k?.type ?? ""), ev);
    } else {
      out.add(from, to, repoLabel, "sync", ev);
    }
  };

  // ---- Phase 2a: deploys + depends_on ----
  for (const cf of composeFiles) {
    const owner: Endpoint = { repo: cf.owner };
    const byName = new Map(cf.services.map((s) => [s.name, s]));
    for (const s of cf.services) {
      const t = s.block.target;
      if (t === undefined) continue;
      const ev = `${cf.owner}/${cf.file.rel}:${(s.imageLine ?? s.line) + 1}`;
      if ("shared" in t) useShared(t.shared);
      out.add(owner, t, "deploys", "deploy", ev);
      for (const dep of s.dependsOn) {
        const dt = byName.get(dep)?.block.target;
        if (dt === undefined) continue;
        const line = findLine(cf.file.lines, s.block.start, s.block.end, new RegExp(`(^|[\\s\\[,'"-])${escapeRe(dep)}([\\s\\]:,'"]|$)`));
        const depEv = `${cf.owner}/${cf.file.rel}:${(line ?? s.line) + 1}`;
        if ("repo" in t) addTo(t, dt, "calls", depEv);
        else if ("shared" in dt) {
          useShared(dt.shared);
          out.add(t, dt, "depends on", "sync", depEv);
        }
      }
    }
  }
  for (const kf of k8sFiles) {
    for (const d of kf.docs) {
      if (d.target === undefined) continue;
      const line = d.images[0]?.line ?? d.start;
      if ("shared" in d.target) useShared(d.target.shared);
      out.add({ repo: kf.owner }, d.target, "deploys", "deploy", `${kf.owner}/${kf.file.rel}:${line + 1}`);
    }
  }
  for (const r of repos) {
    for (const f of files.get(r.id) ?? []) {
      if (f.cls !== "tf") continue;
      f.lines.forEach((l, i) => {
        const m = /\bimage"?\s*[=:]\s*"([^"$]+)"/.exec(l);
        if (m === null) return;
        const t = imageTarget(m[1] ?? "");
        if (t === undefined) return;
        if ("shared" in t) useShared(t.shared);
        out.add({ repo: r.id }, t, "deploys", "deploy", `${r.id}/${f.rel}:${i + 1}`);
      });
    }
  }

  // ---- Phase 2b: URLs and host-valued settings ----
  for (const r of repos) {
    for (const f of files.get(r.id) ?? []) {
      const blocks: Block[] =
        f.cls === "compose"
          ? (composeFiles.find((c) => c.file === f)?.services.map((s) => s.block) ?? [])
          : f.cls === "yaml"
            ? (k8sFiles.find((k) => k.file === f)?.docs.map((d) => ({ start: d.start, end: d.end, ...(d.target !== undefined ? { target: d.target } : {}) })) ?? [])
            : [];
      f.lines.forEach((line, i) => {
        if (line.length > MAX_LINE || (!line.includes("://") && !/[A-Z]_[A-Z]/.test(line))) return;
        const block = blocks.find((b) => i >= b.start && i <= b.end);
        let from: Endpoint = { repo: r.id };
        if (block !== undefined && block.target !== undefined) {
          if (!("repo" in block.target)) return; // an infra container's own settings
          from = block.target;
        }
        const ev = `${r.id}/${f.rel}:${i + 1}`;
        const hit = (host: string, label: string): void => {
          for (const c of hostCandidates(host)) {
            const t = aliases.get(c);
            if (t !== undefined) {
              addTo(from, t, label, ev);
              return;
            }
          }
        };
        for (const m of line.matchAll(URL_RE)) hit(m[2] ?? "", schemeLabel(m[1] ?? ""));
        for (const m of line.matchAll(ENV_HOST_RE)) {
          const value = m[2] ?? "";
          if (value.includes("://")) continue;
          for (const part of value.split(",")) {
            const host = part.split(":")[0] ?? "";
            if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(host)) hit(host, "calls");
          }
        }
        for (const m of line.matchAll(SERVICE_HOST_RE)) hit(m[1] ?? "", "calls");
      });
    }
  }

  // ---- Phase 2c: topics ----
  const topicUse = new Map<string, TopicUse>();
  const repoTypes: SignalResult["repoTypes"] = new Map();
  for (const r of repos) {
    const deps = (packages.get(r.id) ?? []).flatMap((p) => p.deps.filter((d) => !d.dev).map((d) => d.name));
    const messaging = deps.some((d) => depMatches(d, MESSAGING_DEPS));
    const use = messaging ? scanTopics(r.id, files.get(r.id) ?? []) : { pubs: new Map(), subs: new Map() };
    topicUse.set(r.id, use);
    repoTypes.set(r.id, { consumesTopics: use.subs.size > 0, publishesTopics: use.pubs.size > 0, deployFiles: deployCount.get(r.id) ?? 0 });
  }
  for (const p of repos) {
    const pu = topicUse.get(p.id);
    if (pu === undefined) continue;
    for (const [topic, pubEv] of [...pu.pubs.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      for (const c of repos) {
        if (c.id === p.id) continue;
        const cu = topicUse.get(c.id);
        if (cu === undefined) continue;
        for (const [sub, subEv] of cu.subs) {
          if (!topicMatches(topic, sub)) continue;
          out.add({ repo: p.id }, { repo: c.id }, topic, "event", [...pubEv.slice(0, 3), ...subEv.slice(0, 3)]);
        }
      }
    }
  }

  // ---- Phase 2d: internal packages + infra/external client libraries ----
  const publishedBy = new Map<string, string[]>();
  for (const r of repos) {
    for (const p of packages.get(r.id) ?? []) {
      for (const n of [p.name, p.goModule ?? ""]) {
        if (n === "") continue;
        const list = publishedBy.get(n) ?? [];
        if (!list.includes(r.id)) list.push(r.id);
        publishedBy.set(n, list);
      }
    }
  }
  for (const r of repos) {
    for (const p of packages.get(r.id) ?? []) {
      for (const d of p.deps) {
        let owners = publishedBy.get(d.name);
        if (owners === undefined) {
          // go: a dependency on a sub-package of another repo's module.
          const mod = [...publishedBy.keys()].find((m) => m.includes("/") && d.name.startsWith(`${m}/`));
          owners = mod !== undefined ? publishedBy.get(mod) : undefined;
        }
        if (owners === undefined || owners.length !== 1 || owners[0] === r.id) continue;
        const ev = `${r.id}/${p.manifest}:${manifestLine(r, p.manifest, d.name)}`;
        out.add({ repo: r.id }, { repo: owners[0] ?? "" }, d.dev ? "dev dependency" : "depends on", "sync", ev);
      }
      for (const d of p.deps) {
        if (d.dev) continue;
        const ev = (): string => `${r.id}/${p.manifest}:${manifestLine(r, p.manifest, d.name)}`;
        for (const k of INFRA_KINDS) {
          if (k.deps.length > 0 && depMatches(d.name, k.deps)) addTo({ repo: r.id }, { shared: k.key }, k.label, ev());
        }
        for (const e of EXTERNAL_KINDS) {
          if (depMatches(d.name, e.deps)) addTo({ repo: r.id }, { shared: e.key }, "API", ev());
        }
      }
    }
  }

  return { signals: out.result(), sharedKinds, repoTypes, packageNames };
}
