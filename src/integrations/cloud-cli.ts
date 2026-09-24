// src/integrations/cloud-cli.ts — `ruah app cloud providers|list|status|watch`
// (CONTRACTS.md §9.6). Runs with no daemon and no project: it builds the same
// provider registry as the daemon (so every registered cloud adapter shows
// up), syncs through the pure cloud-sync helpers and prints tables or JSON.
// Read-only everywhere: provider CLIs only list, and no Ruah file is written
// (`--repo` only reads architecture.json and the project's manual links).
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { ArchNode } from "../contracts/architecture.js";
import type { CloudResource, IntegrationInfo, ProviderError } from "../contracts/integrations.js";
import { ruahHome } from "../usage/log.js";
import { diffResources, syncProviders, type ResourceChange } from "./cloud-sync.js";
import type { Runner } from "./exec.js";
import { formatSummary, isUnhealthy, summarizeHealth, type HealthSummary } from "./health.js";
import { IntegrationsService } from "./index.js";
import { linkResources } from "./linking.js";
import { isCloud, type CloudIntegration, type IntegrationRegistry } from "./registry.js";
import { CloudCacheStore } from "./store.js";
import { CloudWatcher, DEFAULT_WATCH_INTERVAL_MS } from "./watch.js";

export const CLOUD_USAGE = `ruah app cloud — cloud resources and their live status, without the app

Usage:
  ruah app cloud providers [--json]            each provider: connected / not logged in /
                                               not installed, with the command that fixes it
  ruah app cloud list   [options]              every resource (name, service, region, health)
  ruah app cloud status [options]              health summary; exit 1 when anything is down
  ruah app cloud watch  [options]              re-poll and print health changes (Ctrl-C stops)

Options:
  --provider <id>    only this provider (repeatable; ids as listed by "providers")
  --account <a>      team / organization / context / profile (needs exactly one --provider)
  --repo <path>      link resources to that repo's map elements (reads architecture.json)
  --interval <s>     watch: seconds between polls (default ${DEFAULT_WATCH_INTERVAL_MS / 1000}, minimum 5)
  --json             machine-readable output (watch: one JSON object per line)

Exit codes: 0 ok · 1 something is down (status) or a named provider is not usable ·
            2 usage error · 3 a provider could not be read / none is connected (status)
`;

export interface CloudCliDeps {
  /** $RUAH_HOME for provider selections (read only). */
  home?: string;
  /** Provider set; default: the daemon's registry (IntegrationsService). */
  registry?: IntegrationRegistry;
  runner?: Runner;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => Date;
  /** Stops `watch` (default: SIGINT / SIGTERM). */
  signal?: AbortSignal;
  /** Overrides --interval (tests). */
  intervalMs?: number;
}

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  now: () => Date;
}

const HEALTH_MARK: Record<string, string> = { healthy: "●", deploying: "◐", degraded: "▲", down: "✗", unknown: "○" };

export function stateLabel(info: IntegrationInfo): string {
  switch (info.status) {
    case "connected":
      return "connected";
    case "cli_missing":
      return "not installed";
    case "not_connected":
      return info.detail?.startsWith("disconnected in Ruah") === true ? "disconnected in Ruah" : "not logged in";
    default:
      return "error";
  }
}

function table(rows: string[][], widths?: number[]): string {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, i) => widths?.[i] ?? Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(w[i] ?? 0))).join("  ").trimEnd())
    .join("\n");
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function healthText(r: CloudResource): string {
  if (r.health === undefined) return r.status ?? "—";
  const detail = r.healthDetail ?? r.status;
  return `${HEALTH_MARK[r.health] ?? ""} ${r.health}${detail !== undefined ? ` · ${detail}` : ""}`;
}

function readNodes(repo: string): ArchNode[] {
  const file = path.join(repo, "architecture.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { nodes?: unknown };
    return Array.isArray(parsed.nodes)
      ? (parsed.nodes as unknown[]).filter((n): n is ArchNode => typeof (n as ArchNode)?.id === "string" && typeof (n as ArchNode)?.name === "string")
      : [];
  } catch {
    return [];
  }
}

interface Parsed {
  providers: string[];
  account?: string;
  repo?: string;
  intervalMs?: number;
  json: boolean;
}

class UsageError extends Error {}

function parse(argv: readonly string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: "string", multiple: true, default: [] },
      account: { type: "string" },
      repo: { type: "string" },
      interval: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
  const providers = (values.provider ?? []).filter((p): p is string => typeof p === "string");
  if (values.account !== undefined && providers.length !== 1) throw new UsageError("--account needs exactly one --provider");
  let intervalMs: number | undefined;
  if (values.interval !== undefined) {
    const s = Number(values.interval);
    if (!Number.isFinite(s) || s < 5) throw new UsageError("--interval must be a number of seconds ≥ 5");
    intervalMs = Math.round(s * 1000);
  }
  return {
    providers, json: values.json === true,
    ...(values.account !== undefined ? { account: values.account } : {}),
    ...(values.repo !== undefined ? { repo: values.repo } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };
}

interface Selection {
  providers: CloudIntegration[];
  infos: Map<string, IntegrationInfo>;
  /** Named providers that are not usable (message per provider). */
  unusable: string[];
  /** Enabled providers in the "error" state (e.g. cluster unreachable) when none were named: reported, not skipped silently. */
  broken: ProviderError[];
}

async function select(registry: IntegrationRegistry, wanted: readonly string[]): Promise<Selection> {
  const cloud = registry.cloud();
  for (const id of wanted) {
    const found = registry.get(id);
    if (found === undefined) throw new UsageError(`unknown provider "${id}" (known: ${cloud.map((c) => c.id).join(", ")})`);
    if (!isCloud(found)) throw new UsageError(`${id} is not a cloud provider`);
  }
  const candidates = wanted.length > 0 ? cloud.filter((c) => wanted.includes(c.id)) : cloud.filter((c) => c.enabled());
  const infos = new Map<string, IntegrationInfo>();
  await Promise.all(
    candidates.map(async (c) => {
      const info = await c.info(null).catch((e: unknown): IntegrationInfo => ({ id: c.id, family: "cloud", name: c.name, status: "error", detail: e instanceof Error ? e.message : String(e) }));
      infos.set(c.id, info);
    }),
  );
  const providers = candidates.filter((c) => infos.get(c.id)?.status === "connected");
  const unusable = wanted.length > 0
    ? candidates.filter((c) => !providers.includes(c)).map((c) => {
        const info = infos.get(c.id);
        return `${c.name}: ${info !== undefined ? stateLabel(info) : "unavailable"}${info?.setupHint !== undefined ? ` — fix: ${info.setupHint}` : info?.detail !== undefined ? ` — ${info.detail}` : ""}`;
      })
    : [];
  const broken = wanted.length === 0
    ? candidates.filter((c) => infos.get(c.id)?.status === "error").map((c) => ({ provider: c.id, message: infos.get(c.id)?.detail ?? "error" }))
    : [];
  return { providers, infos, unusable, broken };
}

async function snapshot(
  providers: readonly CloudIntegration[], opts: Parsed, home: string, now: Date, broken: readonly ProviderError[] = [],
): Promise<{ resources: CloudResource[]; errors: ProviderError[]; failed: string[] }> {
  const accounts = opts.account !== undefined && providers[0] !== undefined ? { [providers[0].id]: opts.account } : undefined;
  const synced = await syncProviders(providers, { accounts, now });
  const result = { ...synced, errors: [...broken, ...synced.errors], failed: [...broken.map((b) => b.provider), ...synced.failed] };
  let resources = result.resources;
  if (opts.repo !== undefined) {
    const root = path.resolve(opts.repo);
    resources = linkResources(resources, readNodes(root), new CloudCacheStore(home).read(root).manualLinks);
  }
  resources.sort((a, b) => a.provider.localeCompare(b.provider) || (a.region ?? "").localeCompare(b.region ?? "") || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { ...result, resources };
}

function nameOf(registry: IntegrationRegistry, id: string): string {
  return registry.get(id)?.name ?? id;
}

function printErrors(io: Io, registry: IntegrationRegistry, errors: readonly ProviderError[]): void {
  if (errors.length === 0) return;
  io.err(`Could not read:\n${errors.map((e) => `  ${nameOf(registry, e.provider)}: ${e.message}`).join("\n")}\n`);
}

// ---- commands ------------------------------------------------------------------

async function providersCommand(registry: IntegrationRegistry, opts: Parsed, io: Io): Promise<number> {
  const wanted = opts.providers;
  const list = registry.cloud().filter((c) => wanted.length === 0 || wanted.includes(c.id));
  for (const id of wanted) if (!list.some((c) => c.id === id)) throw new UsageError(`unknown cloud provider "${id}"`);
  const infos = await Promise.all(
    list.map((c) => c.info(null).catch((e: unknown): IntegrationInfo => ({ id: c.id, family: "cloud", name: c.name, status: "error", detail: e instanceof Error ? e.message : String(e) }))),
  );
  if (opts.json) {
    io.out(`${JSON.stringify({ providers: infos }, null, 2)}\n`);
    return 0;
  }
  const rows = [["PROVIDER", "ID", "STATE", "DETAIL"]];
  for (const info of infos) {
    const fix = info.status !== "connected" && info.setupHint !== undefined ? `fix: ${info.setupHint}` : "";
    // The fix is never clipped away; a long CLI message is.
    const detail = info.status === "cli_missing" ? fix : [clip(info.detail ?? "", 80), fix].filter((s) => s.length > 0).join(" — ");
    rows.push([info.name, info.id, stateLabel(info), detail]);
  }
  io.out(`${table(rows)}\n`);
  return 0;
}

function resourceRows(resources: readonly CloudResource[], nodes: Map<string, string> | undefined): string[][] {
  const rows = [["NAME", "SERVICE", "REGION", "HEALTH", ...(nodes !== undefined ? ["ELEMENT"] : [])]];
  for (const r of resources) {
    rows.push([
      clip(r.name, 40), r.service, clip(r.region ?? "global", 24), clip(healthText(r), 70),
      ...(nodes !== undefined ? [r.linkedNodeId !== undefined ? `→ ${nodes.get(r.linkedNodeId) ?? r.linkedNodeId}` : ""] : []),
    ]);
  }
  return rows;
}

async function listCommand(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string): Promise<number> {
  const sel = await select(registry, opts.providers);
  for (const line of sel.unusable) io.err(`${line}\n`);
  if (sel.providers.length === 0) {
    if (opts.json) io.out(`${JSON.stringify({ resources: [], syncedAt: null, errors: sel.broken }, null, 2)}\n`);
    else if (sel.broken.length > 0) printErrors(io, registry, sel.broken);
    else if (sel.unusable.length === 0) io.out("No cloud provider connected — see `ruah app cloud providers`.\n");
    return sel.unusable.length > 0 ? 1 : sel.broken.length > 0 ? 3 : 0;
  }
  const snap = await snapshot(sel.providers, opts, home, io.now(), sel.broken);
  if (opts.json) {
    io.out(`${JSON.stringify({ resources: snap.resources, syncedAt: io.now().toISOString(), errors: snap.errors }, null, 2)}\n`);
  } else {
    const nodes = opts.repo !== undefined ? new Map(readNodes(path.resolve(opts.repo)).map((n) => [n.id, n.name])) : undefined;
    for (const provider of sel.providers) {
      const own = snap.resources.filter((r) => r.provider === provider.id);
      io.out(`\n${provider.name} (${own.length}${own.some((r) => r.health !== undefined) ? ` · ${formatSummary(summarizeHealth(own))}` : ""})\n`);
      if (own.length > 0) io.out(`${table(resourceRows(own, nodes)).split("\n").map((l) => `  ${l}`).join("\n")}\n`);
    }
    printErrors(io, registry, snap.errors);
  }
  return sel.unusable.length > 0 ? 1 : snap.failed.length > 0 ? 3 : 0;
}

export function statusExitCode(summary: HealthSummary, failed: readonly string[], unusable: number): number {
  if (summary.down > 0 || unusable > 0) return 1;
  return failed.length > 0 ? 3 : 0;
}

async function statusCommand(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string): Promise<number> {
  const sel = await select(registry, opts.providers);
  for (const line of sel.unusable) io.err(`${line}\n`);
  if (sel.providers.length === 0) {
    if (opts.json) io.out(`${JSON.stringify({ summary: summarizeHealth([]), providers: [], unhealthy: [], errors: sel.broken, exitCode: sel.unusable.length > 0 ? 1 : 3 }, null, 2)}\n`);
    else if (sel.broken.length > 0) printErrors(io, registry, sel.broken);
    else if (sel.unusable.length === 0) io.err("No cloud provider connected — see `ruah app cloud providers`.\n");
    return sel.unusable.length > 0 ? 1 : 3;
  }
  const snap = await snapshot(sel.providers, opts, home, io.now(), sel.broken);
  const summary = summarizeHealth(snap.resources);
  const unhealthy = snap.resources.filter((r) => isUnhealthy(r.health) || r.health === "deploying");
  const code = statusExitCode(summary, snap.failed, sel.unusable.length);
  if (opts.json) {
    io.out(`${JSON.stringify({
      summary,
      providers: sel.providers.map((p) => ({ id: p.id, name: p.name, summary: summarizeHealth(snap.resources.filter((r) => r.provider === p.id)), failed: snap.failed.includes(p.id) })),
      unhealthy, errors: snap.errors, exitCode: code,
    }, null, 2)}\n`);
    return code;
  }
  io.out(`Cloud: ${formatSummary(summary)}\n`);
  io.out(`${table(sel.providers.map((p) => {
    const own = snap.resources.filter((r) => r.provider === p.id);
    return [`  ${p.name}`, snap.failed.includes(p.id) ? "could not be read" : own.length === 0 ? "no resources" : formatSummary(summarizeHealth(own))];
  }))}\n`);
  if (unhealthy.length > 0) {
    const order = { down: 0, degraded: 1, deploying: 2 } as Record<string, number>;
    io.out("Needs attention:\n");
    io.out(`${table(
      [...unhealthy].sort((a, b) => (order[a.health ?? ""] ?? 9) - (order[b.health ?? ""] ?? 9)).map((r) => [
        `  ${HEALTH_MARK[r.health ?? "unknown"] ?? ""} ${r.health ?? ""}`, nameOf(registry, r.provider), `${clip(r.region !== undefined ? `${r.region}/${r.name}` : r.name, 50)} (${r.service})`, clip(r.healthDetail ?? r.status ?? "", 80),
      ]),
    )}\n`);
  }
  printErrors(io, registry, snap.errors);
  return code;
}

function clock(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function describeChange(c: ResourceChange): string {
  const r = c.resource;
  const where = r.region !== undefined ? `${r.region}/${r.name}` : r.name;
  if (c.kind === "added") return `+ ${where} (${r.service}) ${healthText(r)}`;
  if (c.kind === "removed") return `- ${where} (${r.service}) gone`;
  const from = c.before?.health ?? c.before?.status ?? "—";
  const to = r.health ?? r.status ?? "—";
  const detail = r.healthDetail ?? (r.health !== undefined ? r.status : undefined);
  return `${HEALTH_MARK[r.health ?? ""] ?? "·"} ${where} (${r.service}) ${from} → ${to}${detail !== undefined && detail !== to ? ` · ${detail}` : ""}`;
}

async function watchCommand(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string, deps: CloudCliDeps): Promise<number> {
  const sel = await select(registry, opts.providers);
  for (const line of sel.unusable) io.err(`${line}\n`);
  if (!opts.json) printErrors(io, registry, sel.broken);
  if (sel.providers.length === 0) {
    if (sel.unusable.length === 0 && sel.broken.length === 0) io.err("No cloud provider connected — see `ruah app cloud providers`.\n");
    return sel.unusable.length > 0 ? 1 : 3;
  }
  const last = new Map<string, CloudResource[]>();
  const emit = (value: Record<string, unknown>, text: string): void => {
    io.out(opts.json ? `${JSON.stringify({ at: io.now().toISOString(), ...value })}\n` : `${clock(io.now())}  ${text}\n`);
  };
  const byId = new Map(sel.providers.map((p) => [p.id, p]));
  const watcher = new CloudWatcher({
    providers: () => [...byId.keys()],
    intervalMs: deps.intervalMs ?? opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
    now: () => io.now().getTime(),
    sync: async (id) => {
      const provider = byId.get(id);
      if (provider === undefined) return { ok: true };
      const snap = await snapshot([provider], opts, home, io.now());
      for (const e of snap.errors) emit({ type: "error", provider: id, message: e.message }, `${provider.name}: could not read — ${e.message}`);
      const failed = snap.failed.includes(id);
      if (!failed) {
        const before = last.get(id);
        last.set(id, snap.resources);
        if (before === undefined) {
          const summary = summarizeHealth(snap.resources);
          emit(
            { type: "snapshot", provider: id, summary, resources: snap.resources },
            `${provider.name}: ${snap.resources.length} resources · ${formatSummary(summary)}`,
          );
          for (const r of snap.resources.filter((x) => isUnhealthy(x.health))) {
            emit({ type: "unhealthy", provider: id, id: r.id, name: r.name, health: r.health, detail: r.healthDetail }, `  ${describeChange({ kind: "added", resource: r }).slice(2)}`);
          }
        } else {
          for (const c of diffResources(before, snap.resources)) {
            emit(
              {
                type: "change", provider: id, kind: c.kind, id: c.resource.id, name: c.resource.name, service: c.resource.service,
                from: c.before?.health ?? c.before?.status, to: c.resource.health ?? c.resource.status, detail: c.resource.healthDetail,
              },
              `${provider.name}  ${describeChange(c)}`,
            );
          }
        }
      }
      return { ok: !failed };
    },
  });

  const controller = new AbortController();
  const signal = deps.signal ?? controller.signal;
  const onSignal = (): void => controller.abort();
  if (deps.signal === undefined) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  if (!opts.json) io.err(`Watching ${sel.providers.map((p) => p.name).join(", ")} every ${Math.round((deps.intervalMs ?? opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS) / 1000)} s — Ctrl-C to stop\n`);
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
    watcher.watch("cli", true);
  });
  watcher.stop();
  if (deps.signal === undefined) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}

/** Entry point for `ruah app cloud <cmd> …`; returns the exit code. */
export async function runCloud(argv: readonly string[], deps: CloudCliDeps = {}): Promise<number> {
  const io: Io = {
    out: deps.out ?? ((t) => void process.stdout.write(t)),
    err: deps.err ?? ((t) => void process.stderr.write(t)),
    now: deps.now ?? (() => new Date()),
  };
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(CLOUD_USAGE);
    return cmd === undefined ? 2 : 0;
  }
  const home = deps.home ?? ruahHome();
  try {
    const opts = parse(rest);
    if (opts.repo !== undefined) {
      const root = path.resolve(opts.repo);
      if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`--repo: not a directory: ${opts.repo}`);
    }
    const registry = deps.registry ?? new IntegrationsService({ home, project: () => null, ...(deps.runner !== undefined ? { runner: deps.runner } : {}) }).registry;
    switch (cmd) {
      case "providers":
        return await providersCommand(registry, opts, io);
      case "list":
        return await listCommand(registry, opts, io, home);
      case "status":
        return await statusCommand(registry, opts, io, home);
      case "watch":
        return await watchCommand(registry, opts, io, home, deps);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String((err as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(`ruah app cloud: ${err.message}\n\n${CLOUD_USAGE}`);
      return 2;
    }
    io.err(`ruah app cloud: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}
