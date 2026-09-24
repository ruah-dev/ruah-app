// src/integrations/cloud-cli.ts — `ruah app cloud providers|list|status|watch|scope`
// (CONTRACTS.md §9.6, §14). Runs with no daemon: it builds the same provider
// registry as the daemon (so every registered cloud adapter shows up), syncs
// through the pure cloud-sync helpers and prints tables or JSON. list / status
// / watch are scoped to a repo (`--repo`, default: the repo the current
// directory is in) — only its accounts are read and only its resources shown;
// `--all` shows the whole account. Read-only everywhere: provider CLIs only
// list; the one Ruah file ever written is the repo's `.ruah/cloud.json`, and
// only by `ruah app cloud scope add|remove|reset|accounts add|remove`.
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { ArchNode } from "../contracts/architecture.js";
import type { CloudResource, IntegrationInfo, ProviderError, ScopeAccount } from "../contracts/integrations.js";
import { ruahHome } from "../usage/log.js";
import { diffResources, syncProviders, type ResourceChange } from "./cloud-sync.js";
import type { Runner } from "./exec.js";
import { formatSummary, isUnhealthy, summarizeHealth, type HealthSummary } from "./health.js";
import { IntegrationsService } from "./index.js";
import { linkResources } from "./linking.js";
import { isCloud, type CloudIntegration, type IntegrationRegistry } from "./registry.js";
import {
  applyResourceAction,
  applyScope,
  loadScopeUnits,
  ownUnit,
  ScopeFileError,
  scopeSummary,
  syncAccountPlan,
  updateScopeFile,
  type LoadedUnit,
} from "./scope/index.js";
import { CloudCacheStore } from "./store.js";
import { CloudWatcher, DEFAULT_WATCH_INTERVAL_MS } from "./watch.js";

export const CLOUD_USAGE = `ruah app cloud — cloud resources and their live status, without the app

Usage:
  ruah app cloud providers [--json]            each provider: connected / not logged in /
                                               not installed, with the command that fixes it
  ruah app cloud list   [options]              the repo's resources (name, service, region, health, why)
  ruah app cloud status [options]              health summary; exit 1 when anything is down
  ruah app cloud watch  [options]              re-poll and print health changes (Ctrl-C stops)
  ruah app cloud scope  [--repo <path>] [--json]
                                               the repo's accounts, its resources with the reason
                                               each belongs to it, and what looks related
  ruah app cloud scope add|remove|reset <resource-id>…
                                               add to / remove from the repo, or back to the evidence
  ruah app cloud scope accounts [add|remove <provider> [<account>] [--whole]]
                                               the accounts the repo lives in (only they are read)

Options:
  --repo <path>      the project (default: the repo the current directory is in)
  --all              every resource the connected accounts can see, not only the repo's
  --provider <id>    only this provider (repeatable; ids as listed by "providers")
  --account <a>      team / organization / context / profile (needs exactly one --provider)
  --interval <s>     watch: seconds between polls (default ${DEFAULT_WATCH_INTERVAL_MS / 1000}, minimum 5)
  --json             machine-readable output (watch: one JSON object per line)

Exit codes: 0 ok · 1 something of the repo is down (status) or a named provider is not usable ·
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
  /** Where "the repo the current directory is in" is looked up (default: process.cwd()). */
  cwd?: string;
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
  /** The project, resolved: `--repo`, else the repo around the current directory (absent = none). */
  repo?: string;
  /** `--repo` was given (element links are shown even with --all). */
  explicitRepo: boolean;
  /** Whole account: no scope filter, no account limit. */
  all: boolean;
  intervalMs?: number;
  json: boolean;
  whole: boolean;
  positionals: string[];
}

class UsageError extends Error {}

/** The nearest folder at or above `dir` that is a repo (`.git`) or a multi-repo system. */
export function findRepoRoot(dir: string): string | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git")) || existsSync(path.join(cur, "ruah.system.json"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

function parse(argv: readonly string[], cwd: string, allowPositionals = false): Parsed {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: "string", multiple: true, default: [] },
      account: { type: "string" },
      repo: { type: "string" },
      all: { type: "boolean", default: false },
      interval: { type: "string" },
      json: { type: "boolean", default: false },
      whole: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (!allowPositionals && positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
  if (!allowPositionals && values.whole === true) throw new UsageError("--whole belongs to `scope accounts add`");
  const providers = (values.provider ?? []).filter((p): p is string => typeof p === "string");
  if (values.account !== undefined && providers.length !== 1) throw new UsageError("--account needs exactly one --provider");
  let intervalMs: number | undefined;
  if (values.interval !== undefined) {
    const s = Number(values.interval);
    if (!Number.isFinite(s) || s < 5) throw new UsageError("--interval must be a number of seconds ≥ 5");
    intervalMs = Math.round(s * 1000);
  }
  let repo: string | undefined;
  if (values.repo !== undefined) {
    repo = path.resolve(cwd, values.repo);
    if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new UsageError(`--repo: not a directory: ${values.repo}`);
  } else {
    repo = findRepoRoot(cwd);
  }
  return {
    providers, json: values.json === true, all: values.all === true, whole: values.whole === true, explicitRepo: values.repo !== undefined,
    positionals,
    ...(values.account !== undefined ? { account: values.account } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };
}

/** A repo-scoped run (list / status / watch without --all, and scope). */
interface ScopeCtx {
  root: string;
  units: LoadedUnit[];
  /** Accounts to read per provider; null = no account listed (every connected account, as before). */
  plan: Map<string, (string | undefined)[]> | null;
}

function scopeCtx(opts: Parsed): ScopeCtx | undefined {
  if (opts.repo === undefined || opts.all) return undefined;
  const units = loadScopeUnits(opts.repo);
  return { root: opts.repo, units, plan: opts.account !== undefined ? null : syncAccountPlan(units) };
}

interface Selection {
  providers: CloudIntegration[];
  infos: Map<string, IntegrationInfo>;
  /** Named providers that are not usable (message per provider). */
  unusable: string[];
  /** Enabled providers in the "error" state (e.g. cluster unreachable) when none were named: reported, not skipped silently. */
  broken: ProviderError[];
}

async function select(registry: IntegrationRegistry, wanted: readonly string[], scope?: ScopeCtx): Promise<Selection> {
  const cloud = registry.cloud();
  for (const id of wanted) {
    const found = registry.get(id);
    if (found === undefined) throw new UsageError(`unknown provider "${id}" (known: ${cloud.map((c) => c.id).join(", ")})`);
    if (!isCloud(found)) throw new UsageError(`${id} is not a cloud provider`);
  }
  // §14: a repo whose scope lists accounts reads only those providers.
  const plan = scope?.plan ?? null;
  const candidates = wanted.length > 0 ? cloud.filter((c) => wanted.includes(c.id)) : cloud.filter((c) => c.enabled() && (plan === null || plan.has(c.id)));
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

interface Snapshot {
  /** In scope only when scoped (every resource with --all / without a repo). */
  resources: CloudResource[];
  /** Every resource read, with its `scope` when a repo is known. */
  everything: CloudResource[];
  errors: ProviderError[];
  failed: string[];
}

async function snapshot(
  providers: readonly CloudIntegration[], opts: Parsed, home: string, now: Date, broken: readonly ProviderError[] = [], scope?: ScopeCtx,
): Promise<Snapshot> {
  const accounts = opts.account !== undefined && providers[0] !== undefined ? { [providers[0].id]: opts.account } : undefined;
  const synced = await syncProviders(providers, {
    accounts, accountLists: scope?.plan ?? null, now, ...(opts.repo !== undefined ? { project: { root: opts.repo } } : {}),
  });
  const result = { ...synced, errors: [...broken, ...synced.errors], failed: [...broken.map((b) => b.provider), ...synced.failed] };
  let everything = result.resources;
  if (opts.repo !== undefined && (scope !== undefined || opts.explicitRepo)) {
    const root = opts.repo;
    const nodes = readNodes(root);
    const manualLinks = new CloudCacheStore(home).read(root).manualLinks;
    everything = applyScope({ units: scope?.units ?? loadScopeUnits(root), resources: linkResources(everything, nodes, manualLinks), nodes, manualLinks });
  }
  everything.sort((a, b) => a.provider.localeCompare(b.provider) || (a.region ?? "").localeCompare(b.region ?? "") || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const resources = scope !== undefined ? everything.filter((r) => r.scope?.in === true) : everything;
  return { ...result, resources, everything };
}

/** "Scope: web — 3 of 40 resources · 2 look related (ruah app cloud scope) · --all for everything". */
function scopeLine(snap: Snapshot, scope: ScopeCtx): string {
  const suggestions = snap.everything.filter((r) => r.scope?.in === false && r.scope.confidence === "weak").length;
  const accounts = scopeSummary(scope.units).accounts;
  const where = accounts.length > 0 ? ` · accounts ${accounts.map((a) => `${a.provider}${a.account !== undefined ? `/${a.account}` : ""}`).join(", ")}` : "";
  return `Scope: ${path.basename(scope.root)} — ${snap.resources.length} of ${snap.everything.length} resources${where}${suggestions > 0 ? ` · ${suggestions} look related (ruah app cloud scope)` : ""} · --all for everything\n`;
}

function emptyScopeHint(scope: ScopeCtx): string {
  return `Nothing is known to belong to ${path.basename(scope.root)} yet. Tell Ruah where it runs:\n` +
    "  ruah app cloud scope                                    what the repo says and what looks related\n" +
    "  ruah app cloud scope accounts add <provider> <account>  read only that account (--whole: all of it is this repo's)\n" +
    "  ruah app cloud scope add <resource-id>                  add one resource\n";
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

function resourceRows(resources: readonly CloudResource[], nodes: Map<string, string> | undefined, why: boolean): string[][] {
  const rows = [["NAME", "SERVICE", "REGION", "HEALTH", ...(nodes !== undefined ? ["ELEMENT"] : []), ...(why ? ["WHY"] : [])]];
  for (const r of resources) {
    rows.push([
      clip(r.name, 40), r.service, clip(r.region ?? "global", 24), clip(healthText(r), 70),
      ...(nodes !== undefined ? [r.linkedNodeId !== undefined ? `→ ${nodes.get(r.linkedNodeId) ?? r.linkedNodeId}` : ""] : []),
      ...(why ? [clip(r.scope?.reasons[0] ?? "", 60)] : []),
    ]);
  }
  return rows;
}

async function listCommand(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string): Promise<number> {
  const scope = scopeCtx(opts);
  const sel = await select(registry, opts.providers, scope);
  for (const line of sel.unusable) io.err(`${line}\n`);
  if (sel.providers.length === 0) {
    if (opts.json) io.out(`${JSON.stringify({ resources: [], syncedAt: null, errors: sel.broken }, null, 2)}\n`);
    else if (sel.broken.length > 0) printErrors(io, registry, sel.broken);
    else if (sel.unusable.length === 0) io.out("No cloud provider connected — see `ruah app cloud providers`.\n");
    return sel.unusable.length > 0 ? 1 : sel.broken.length > 0 ? 3 : 0;
  }
  const snap = await snapshot(sel.providers, opts, home, io.now(), sel.broken, scope);
  if (opts.json) {
    io.out(`${JSON.stringify({
      resources: snap.resources, syncedAt: io.now().toISOString(), errors: snap.errors,
      ...(scope !== undefined ? { scope: { repo: scope.root, ...scopeSummary(scope.units), total: snap.everything.length } } : {}),
    }, null, 2)}\n`);
  } else {
    const nodes = opts.repo !== undefined && (scope !== undefined || opts.explicitRepo) ? new Map(readNodes(opts.repo).map((n) => [n.id, n.name])) : undefined;
    if (scope !== undefined) io.out(scopeLine(snap, scope));
    for (const provider of sel.providers) {
      const own = snap.resources.filter((r) => r.provider === provider.id);
      if (scope !== undefined && own.length === 0) continue;
      io.out(`\n${provider.name} (${own.length}${own.some((r) => r.health !== undefined) ? ` · ${formatSummary(summarizeHealth(own))}` : ""})\n`);
      if (own.length > 0) io.out(`${table(resourceRows(own, nodes, scope !== undefined)).split("\n").map((l) => `  ${l}`).join("\n")}\n`);
    }
    if (scope !== undefined && snap.resources.length === 0 && snap.failed.length < sel.providers.length) io.out(`\n${emptyScopeHint(scope)}`);
    printErrors(io, registry, snap.errors);
  }
  return sel.unusable.length > 0 ? 1 : snap.failed.length > 0 ? 3 : 0;
}

export function statusExitCode(summary: HealthSummary, failed: readonly string[], unusable: number): number {
  if (summary.down > 0 || unusable > 0) return 1;
  return failed.length > 0 ? 3 : 0;
}

async function statusCommand(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string): Promise<number> {
  const scope = scopeCtx(opts);
  const sel = await select(registry, opts.providers, scope);
  for (const line of sel.unusable) io.err(`${line}\n`);
  if (sel.providers.length === 0) {
    if (opts.json) io.out(`${JSON.stringify({ summary: summarizeHealth([]), providers: [], unhealthy: [], errors: sel.broken, exitCode: sel.unusable.length > 0 ? 1 : 3 }, null, 2)}\n`);
    else if (sel.broken.length > 0) printErrors(io, registry, sel.broken);
    else if (sel.unusable.length === 0) io.err("No cloud provider connected — see `ruah app cloud providers`.\n");
    return sel.unusable.length > 0 ? 1 : 3;
  }
  const snap = await snapshot(sel.providers, opts, home, io.now(), sel.broken, scope);
  const summary = summarizeHealth(snap.resources);
  const unhealthy = snap.resources.filter((r) => isUnhealthy(r.health) || r.health === "deploying");
  const code = statusExitCode(summary, snap.failed, sel.unusable.length);
  if (opts.json) {
    io.out(`${JSON.stringify({
      summary,
      providers: sel.providers.map((p) => ({ id: p.id, name: p.name, summary: summarizeHealth(snap.resources.filter((r) => r.provider === p.id)), failed: snap.failed.includes(p.id) })),
      unhealthy, errors: snap.errors, exitCode: code,
      ...(scope !== undefined ? { scope: { repo: scope.root, inScope: snap.resources.length, total: snap.everything.length } } : {}),
    }, null, 2)}\n`);
    return code;
  }
  if (scope !== undefined) io.out(scopeLine(snap, scope));
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
  const scope = scopeCtx(opts);
  const sel = await select(registry, opts.providers, scope);
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
      const snap = await snapshot([provider], opts, home, io.now(), [], scope);
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
    const opts = parse(rest, deps.cwd ?? process.cwd(), cmd === "scope");
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
      case "scope":
        return await scopeCommand(registry, opts, io, home);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String((err as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(`ruah app cloud: ${err.message}\n\n${CLOUD_USAGE}`);
      return 2;
    }
    if (err instanceof ScopeFileError) {
      io.err(`ruah app cloud: ${err.message}\n`);
      return 1;
    }
    io.err(`ruah app cloud: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}

// ---- scope (§14) -----------------------------------------------------------------

const ACCOUNT_ARG_RE = /^[A-Za-z0-9_.@:/+=][A-Za-z0-9_.@:/+=,-]{0,199}$/;

function accountLabel(a: ScopeAccount & { repo?: string | undefined }): string {
  return `${a.provider}${a.account !== undefined ? ` ${a.account}` : " (selected account)"}${a.whole === true ? " — whole account" : ""}${a.repo !== undefined ? ` [${a.repo}]` : ""}`;
}

async function scopeCommand(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string): Promise<number> {
  if (opts.repo === undefined) throw new UsageError("not inside a repo — pass --repo <path>");
  const [sub, ...args] = opts.positionals;
  const root = opts.repo;
  if (sub === undefined || sub === "show") return scopeShow(registry, opts, io, home);
  if (sub === "add" || sub === "remove" || sub === "reset") {
    if (args.length === 0) throw new UsageError(`scope ${sub} needs at least one resource id`);
    const action = sub === "add" ? "include" : sub === "remove" ? "exclude" : "reset";
    const cached = new CloudCacheStore(home).read(root).resources;
    const own = ownUnit(loadScopeUnits(root))!;
    updateScopeFile(own.root, (c) => args.reduce((acc, id) => {
      const known = cached.find((r) => r.id === id);
      return applyResourceAction(acc, { id, ...(known !== undefined ? { provider: known.provider, name: known.name } : {}) }, action);
    }, c));
    io.out(`${sub === "add" ? "Added to" : sub === "remove" ? "Removed from" : "Back to the evidence in"} ${path.basename(root)}: ${args.join(", ")} (${path.relative(process.cwd(), own.file.path) || own.file.path})\n`);
    return 0;
  }
  if (sub === "accounts") {
    const [verb, provider, account] = args;
    const own = ownUnit(loadScopeUnits(root))!;
    if (verb === undefined || verb === "list") {
      const summary = scopeSummary(loadScopeUnits(root));
      if (opts.json) io.out(`${JSON.stringify({ repo: root, accounts: summary.accounts, files: summary.files }, null, 2)}\n`);
      else io.out(summary.accounts.length > 0 ? `${summary.accounts.map((a) => `  ${accountLabel(a)}`).join("\n")}\n` : "No accounts listed: every connected account is read.\n");
      return 0;
    }
    if (verb !== "add" && verb !== "remove") throw new UsageError(`unknown scope accounts command "${verb}"`);
    if (provider === undefined) throw new UsageError(`scope accounts ${verb} needs a provider id`);
    const found = registry.get(provider);
    if (found === undefined || !isCloud(found)) throw new UsageError(`unknown cloud provider "${provider}" (known: ${registry.cloud().map((c) => c.id).join(", ")})`);
    if (account !== undefined && (!ACCOUNT_ARG_RE.test(account) || account.startsWith("-"))) throw new UsageError("invalid account name");
    const next = updateScopeFile(own.root, (c) => {
      const rest = c.accounts.filter((a) => !(a.provider === provider && a.account === account));
      return { ...c, accounts: verb === "add" ? [...rest, { provider, ...(account !== undefined ? { account } : {}), ...(opts.whole ? { whole: true } : {}) }] : rest };
    });
    io.out(`${verb === "add" ? "Added" : "Removed"} ${provider}${account !== undefined ? ` ${account}` : ""}. Accounts: ${next.accounts.length > 0 ? next.accounts.map(accountLabel).join(", ") : "(none — every connected account is read)"}\n`);
    return 0;
  }
  throw new UsageError(`unknown scope command "${sub}"`);
}

async function scopeShow(registry: IntegrationRegistry, opts: Parsed, io: Io, home: string): Promise<number> {
  const root = opts.repo!;
  const units = loadScopeUnits(root);
  const scope: ScopeCtx = { root, units, plan: opts.all || opts.account !== undefined ? null : syncAccountPlan(units) };
  const summary = scopeSummary(units);
  const sel = await select(registry, opts.providers, scope);
  for (const line of sel.unusable) io.err(`${line}\n`);
  const snap = sel.providers.length > 0 ? await snapshot(sel.providers, opts, home, io.now(), sel.broken, scope) : { resources: [], everything: [], errors: sel.broken, failed: [] };
  const members = snap.everything.filter((r) => r.scope?.in === true);
  const suggestions = snap.everything.filter((r) => r.scope?.in === false && r.scope.confidence === "weak");
  const excluded = snap.everything.filter((r) => r.scope?.excluded === true);
  const pick = (r: CloudResource): Record<string, unknown> => ({
    id: r.id, provider: r.provider, service: r.service, name: r.name, ...(r.account !== undefined ? { account: r.account } : {}),
    ...(r.region !== undefined ? { region: r.region } : {}), confidence: r.scope?.confidence, reasons: r.scope?.reasons ?? [],
  });
  const evidence = units.map((u) => ({
    ...(u.repo !== undefined ? { repo: u.repo } : {}), root: u.root, files: u.signals.files,
    hosts: u.signals.hosts.map((h) => h.host), names: u.signals.names, accountHints: u.signals.accountHints,
  }));
  if (opts.json) {
    io.out(`${JSON.stringify({
      repo: root, scope: summary, evidence,
      members: members.map(pick), suggestions: suggestions.map(pick), excluded: excluded.map(pick),
      counts: { in: members.length, suggestions: suggestions.length, excluded: excluded.length, total: snap.everything.length },
      providers: sel.providers.map((p) => p.id), errors: snap.errors,
    }, null, 2)}\n`);
    return sel.unusable.length > 0 ? 1 : snap.failed.length > 0 ? 3 : 0;
  }
  io.out(`Cloud scope of ${path.basename(root)} (${root})\n`);
  for (const f of summary.files) {
    io.out(`  ${f.repo !== undefined ? `${f.repo}: ` : ""}${f.error !== undefined ? `${f.path} is INVALID (${f.error}) — ignored until fixed` : f.exists ? f.path : `${f.path} (not created yet)`}\n`);
  }
  io.out(`Accounts: ${summary.accounts.length > 0 ? summary.accounts.map(accountLabel).join(", ") : "none listed — every connected account is read"}\n`);
  for (const e of evidence) {
    const files = e.files.filter((f) => f !== "package.json");
    io.out(`Repo${e.repo !== undefined ? ` ${e.repo}` : ""} says: ${files.length > 0 ? files.join(", ") : "no provider link files"}${e.hosts.length > 0 ? ` · hosts ${e.hosts.slice(0, 6).join(", ")}${e.hosts.length > 6 ? ", …" : ""}` : ""}\n`);
  }
  const rows = (list: CloudResource[]): string => table(list.map((r) => [
    `  ${nameOf(registry, r.provider)}`, clip(r.name, 40), r.service, r.scope?.confidence ?? "", clip((r.scope?.reasons ?? []).join("; "), 90),
  ]));
  io.out(`\nIn this project (${members.length} of ${snap.everything.length}):\n${members.length > 0 ? `${rows(members)}\n` : "  (none)\n"}`);
  if (suggestions.length > 0) {
    io.out(`\nLooks related (${suggestions.length}) — add with: ruah app cloud scope add <id>\n`);
    io.out(`${table(suggestions.map((r) => [`  ${nameOf(registry, r.provider)}`, clip(r.name, 40), r.service, clip(r.scope?.reasons[0] ?? "", 50), r.id]))}\n`);
  }
  if (excluded.length > 0) io.out(`\nRemoved by you (${excluded.length}): ${excluded.map((r) => r.name).join(", ")}\n`);
  if (members.length === 0 && summary.accounts.length === 0) io.out(`\n${emptyScopeHint(scope)}`);
  printErrors(io, registry, snap.errors);
  return sel.unusable.length > 0 ? 1 : snap.failed.length > 0 ? 3 : 0;
}
