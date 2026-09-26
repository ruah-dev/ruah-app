// `ruah app system …` — multi-repo systems from the command line
// (docs/MULTI-REPO.md, CONTRACTS §12.7). Works without a daemon: every
// command calls the standalone library in src/system/* and reads / writes the
// files next to ruah.system.json (a running daemon picks the changes up
// through its file watcher).
//
//   init <folder> [--repo <path>|<id>=<path>]… [--name <n>] [--force]
//   add [<system>] <path | <id>=<path> | gh:owner/name> [--id <id>] [--into <dir>]
//   remove <id>                      take a repo out of the system (files untouched)
//   rename <id> <new-id> [--offline] rename a repo id everywhere Ruah stores it (refused while a
//                                    running daemon reports an agent turn in the system)
//   status [<system>] [--json]       branch, ahead/behind, dirty, last scan, nodes
//   signals [<system>] [--json]      deterministic cross-repo edges (zero tokens)
//   scan [<system>] [--out <path>] [--dry-run]   write <system>/architecture.json
//   rescan <id>                      re-scan one repo, rebuild the system map
//   suggest [<system>] [--agent claude] [--model <m>] [--reply-file <f>] [--print-prompt]
//           [--min-confidence <n>] [--json]      agent pass → pending proposals
//   suggest [--list] [--accept <n|id>]… [--reject <n|id>]… [--unreject <id>]…
//
// <system> is the folder holding ruah.system.json (or the file); commands
// without one take --system <dir>, default the current directory. Repo paths
// resolve against the current directory and are stored relative to the file.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { ArchEdge, Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { ruahHome } from "../usage/log.js";
import { projectIdFor } from "../projects/fs-util.js";
import { DEFAULT_DAEMON_URL, fetchLive } from "../resume/run-resume.js";
import { loadSystem, SystemFileError, type LoadedSystem } from "./config.js";
import { buildSystemArchitecture } from "./build.js";
import {
  addRepos,
  initSystem,
  readArchitectureFile,
  rebuildSystem,
  removeRepo,
  renameRepo,
  rescanRepo,
  SYSTEM_ARCHITECTURE_FILE,
  SystemManageError,
  type RepoInput,
} from "./manage.js";
import { systemStatus, type RepoStatus } from "./status.js";
import { cloneGithubRepo } from "./github.js";
import { crossRepoSignalEdges, runSuggestPass } from "./suggest-run.js";
import { buildSuggestPrompt } from "./suggest-prompt.js";
import { topLevelServices, type RunAgent } from "./suggest.js";
import {
  acceptPending,
  livePending,
  readSuggestionsFile,
  rejectPending,
  unreject,
  type StoredSuggestion,
} from "./suggestions-store.js";
import type { Runner } from "../integrations/exec.js";

const err = (msg: string): void => void process.stderr.write(`ruah app system: ${msg}\n`);
const out = (text: string): void => void process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

/** Injection points for tests (a fake `gh`, a scripted agent). */
export interface SystemCliHooks {
  ghRunner?: Runner;
  gitRunner?: Runner;
  agent?: (sys: LoadedSystem, opts: { model?: string }) => RunAgent;
}

class UsageError extends Error {}

/** `<id>=<path>` (no slash before the "="), else a plain path. */
function repoSpec(spec: string): RepoInput {
  const m = /^([^/=\\]+)=(.+)$/.exec(spec);
  return m !== null ? { id: m[1] ?? "", path: m[2] ?? "" } : { path: spec };
}

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

function parse(argv: string[], options: OptionsConfig): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const r = parseArgs({ args: argv, options: { system: { type: "string", short: "s" }, ...options }, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, unknown>, positionals: r.positionals };
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function systemDir(positional: string | undefined, flag: unknown): string {
  return typeof positional === "string" ? positional : typeof flag === "string" ? flag : process.cwd();
}

function load(target: string): LoadedSystem {
  try {
    return loadSystem(target);
  } catch (e) {
    throw new SystemManageError("invalid", (e as Error).message);
  }
}

function archOf(sys: LoadedSystem): Architecture {
  return readArchitectureFile(path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE)) ?? rebuildSystem(sys).architecture;
}

function writeArch(sys: LoadedSystem, arch: Architecture): void {
  const v = validateArchitecture(arch, null);
  if (!v.ok) throw new SystemManageError("invalid", `architecture failed validation: ${v.errors[0] ?? ""}`);
  const file = path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(arch, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function edgeLine(e: Pick<ArchEdge, "from" | "to" | "label" | "kind">): string {
  return `${e.from} -> ${e.to}${e.label !== undefined ? ` [${e.label}]` : ""}${e.kind !== undefined ? ` (${e.kind})` : ""}`;
}

// ---------------------------------------------------------------- commands

function init(argv: string[]): number {
  const p = parse(argv, {
    repo: { type: "string", multiple: true, default: [] },
    name: { type: "string" },
    force: { type: "boolean", default: false },
  });
  const target = p.positionals[0];
  if (target === undefined) throw new UsageError("init: missing <folder>");
  const repos = ((p.values.repo as string[] | undefined) ?? []).map(repoSpec);
  const r = initSystem(target, { name: p.values.name as string | undefined, repos, force: p.values.force === true });
  err(`wrote ${r.system.file} (${r.system.repos.length} repo${r.system.repos.length === 1 ? "" : "s"}: ${r.system.repos.map((x) => x.id).join(", ") || "none"})`);
  return 0;
}

async function add(argv: string[], hooks: SystemCliHooks): Promise<number> {
  const p = parse(argv, { id: { type: "string" }, into: { type: "string" } });
  const [a, b, ...extra] = p.positionals;
  if (a === undefined || extra.length > 0) throw new UsageError("add: usage: ruah app system add [<system>] <path | <id>=<path> | gh:owner/name> [--id <id>]");
  const target = b !== undefined ? a : systemDir(undefined, p.values.system);
  const spec = b ?? a;
  const sys = load(target);
  let input = repoSpec(spec);
  if (spec.startsWith("gh:")) {
    const into = typeof p.values.into === "string" ? p.values.into : path.dirname(sys.dir);
    err(`cloning ${spec.slice(3)} into ${into} …`);
    input = { path: await cloneGithubRepo(spec, into, hooks.ghRunner !== undefined ? { runner: hooks.ghRunner } : {}) };
  }
  if (typeof p.values.id === "string") input = { ...input, id: p.values.id };
  const r = addRepos(sys.file, [input]);
  for (const x of r.added) err(`added ${x.id} (${x.path}) to ${r.system.file}`);
  return 0;
}

function remove(argv: string[]): number {
  const p = parse(argv, {});
  const [id, ...extra] = p.positionals;
  if (id === undefined || extra.length > 0) throw new UsageError("remove: usage: ruah app system remove <id> [--system <dir>]");
  const r = removeRepo(systemDir(undefined, p.values.system), id);
  err(`removed ${r.removed.id} (${r.removed.path}) from ${r.system.file}; its folder is untouched`);
  return 0;
}

async function rename(argv: string[]): Promise<number> {
  const p = parse(argv, { offline: { type: "boolean", default: false }, daemon: { type: "string" } });
  const [from, to, ...extra] = p.positionals;
  if (from === undefined || to === undefined || extra.length > 0) throw new UsageError("rename: usage: ruah app system rename <id> <new-id> [--system <dir>] [--offline]");
  const dir = systemDir(undefined, p.values.system);
  // A daemon's running turn in this system stores its (old) element ids when it finishes, after
  // the rename rewrote the chats: ask a running daemon first (CONTRACTS §12.4).
  if (p.values.offline !== true) {
    const url = typeof p.values.daemon === "string" ? p.values.daemon : (process.env.RUAH_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL);
    const live = await fetchLive(url);
    const system = load(dir);
    let real = system.dir;
    try {
      real = fs.realpathSync(system.dir);
    } catch {
      // keep the resolved path
    }
    const counts = live?.get(projectIdFor(real));
    if (counts !== undefined && counts.running > 0) {
      throw new SystemManageError(
        "conflict",
        `an agent turn is running in this system (daemon at ${url}); rename when it has finished — it would save the old ids back into its chat`,
      );
    }
  }
  const r = renameRepo(dir, from, to, { home: ruahHome() });
  err(
    `renamed ${from} -> ${to} in ${r.system.file}` +
      `${r.architecture ? ", the system map" : ""}${r.suggestions ? ", suggestions" : ""}` +
      `${r.links > 0 ? `, ${r.links} work-item link(s)` : ""}${r.chats > 0 ? `, ${r.chats} chat(s)` : ""}${r.cloudLinks > 0 ? `, ${r.cloudLinks} cloud link(s)` : ""}`,
  );
  return 0;
}

function fmtTime(iso: string | null): string {
  if (iso === null) return "never";
  return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "Z");
}

function gitCell(r: RepoStatus): { branch: string; ab: string; dirty: string } {
  if (!r.exists) return { branch: "(missing)", ab: "", dirty: "" };
  if (r.git === null) return { branch: r.gitError !== undefined ? "(git error)" : "(no git)", ab: "", dirty: "" };
  return {
    branch: r.git.branch ?? `(detached ${r.git.head ?? ""})`,
    ab: r.git.upstream === null ? "-" : `+${r.git.ahead} -${r.git.behind}`,
    dirty: String(r.git.dirty),
  };
}

async function status(argv: string[], hooks: SystemCliHooks): Promise<number> {
  const p = parse(argv, { json: { type: "boolean", default: false } });
  const sys = load(systemDir(p.positionals[0], p.values.system));
  const s = await systemStatus(sys, hooks.gitRunner !== undefined ? { runner: hooks.gitRunner } : {});
  if (p.values.json === true) {
    out(JSON.stringify(s, null, 2));
    return 0;
  }
  out(`${s.name}  ${s.file}  (map built ${fmtTime(s.builtAt)})`);
  const rows = [["ID", "BRANCH", "AHEAD/BEHIND", "DIRTY", "NODES", "LAST SCAN", "PATH"]];
  for (const r of s.repos) {
    const g = gitCell(r);
    rows.push([r.id, g.branch, g.ab, g.dirty, String(r.nodes), fmtTime(r.lastScanAt), r.path]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  for (const row of rows) out(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  "));
  return 0;
}

function signals(argv: string[]): number {
  const p = parse(argv, { json: { type: "boolean", default: false } });
  const sys = load(systemDir(p.positionals[0], p.values.system));
  const arch = buildSystemArchitecture(sys).architecture;
  const edges = crossRepoSignalEdges(arch);
  if (p.values.json === true) {
    out(JSON.stringify({ edges }, null, 2));
    return 0;
  }
  if (edges.length === 0) out("no cross-repo signals found");
  for (const e of edges) {
    out(edgeLine(e));
    for (const ev of e.evidence ?? []) out(`    ${ev}`);
  }
  err(`${edges.length} cross-repo edge${edges.length === 1 ? "" : "s"} from deterministic signals (no agent, zero tokens)`);
  return 0;
}

function scan(argv: string[], version: string): number {
  const p = parse(argv, { out: { type: "string" }, "dry-run": { type: "boolean", default: false } });
  const sys = load(systemDir(p.positionals[0], p.values.system));
  const started = Date.now();
  const defaultOut = path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE);
  const outFile = path.resolve(typeof p.values.out === "string" ? p.values.out : defaultOut);
  const dry = p.values["dry-run"] === true;
  let result;
  if (outFile === defaultOut && !dry) {
    result = rebuildSystem(sys, { version });
  } else {
    const previous = readArchitectureFile(outFile);
    result = buildSystemArchitecture(sys, { version, now: new Date(), previous, outFile });
  }
  for (const r of result.repos) if (r.warning !== undefined) err(`warning: ${r.warning}`);
  const arch = result.architecture;
  const v = validateArchitecture(arch, null);
  if (!v.ok) {
    err(`scan: generated architecture failed validation:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  const top = arch.nodes.filter((n) => n.parent === undefined);
  const cross = crossRepoSignalEdges(arch);
  const line =
    `${arch.nodes.length} nodes (${top.length} top-level: ${sys.repos.length} repos, ${top.length - sys.repos.length} shared/other), ` +
    `${arch.edges.length} edges (${cross.length} top-level scan edges) in ${Date.now() - started} ms`;
  const json = `${JSON.stringify(arch, null, 2)}\n`;
  if (dry) {
    process.stdout.write(json);
    err(`dry run, ${line}`);
    return 0;
  }
  if (outFile !== defaultOut) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmp = `${outFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, outFile);
  }
  for (const r of result.repos) err(`  ${r.id}: ${r.type}, ${r.nodes} nodes from ${r.source}`);
  err(`wrote ${outFile}: ${line}`);
  return 0;
}

function rescan(argv: string[], version: string): number {
  const p = parse(argv, {});
  const [id, ...extra] = p.positionals;
  if (id === undefined || extra.length > 0) throw new UsageError("rescan: usage: ruah app system rescan <id> [--system <dir>]");
  const r = rescanRepo(systemDir(undefined, p.values.system), id, { version });
  err(`rescanned ${id}${r.wroteRepoArchitecture ? " (its architecture.json refreshed)" : ""}; wrote ${r.file}`);
  return 0;
}

function printSuggestions(pending: StoredSuggestion[]): void {
  if (pending.length === 0) {
    out("no pending suggestions");
    return;
  }
  pending.forEach((s, i) => {
    out(`${i + 1}. ${s.id}  ${edgeLine(s)}  confidence ${s.confidence.toFixed(2)}`);
    if (s.reason !== undefined) out(`     ${s.reason}`);
    out(`     evidence: ${s.evidence.join(", ")}`);
  });
}

async function suggest(argv: string[], version: string, hooks: SystemCliHooks): Promise<number> {
  const p = parse(argv, {
    agent: { type: "string" },
    model: { type: "string" },
    "reply-file": { type: "string" },
    "print-prompt": { type: "boolean", default: false },
    "min-confidence": { type: "string" },
    list: { type: "boolean", default: false },
    accept: { type: "string", multiple: true, default: [] },
    reject: { type: "string", multiple: true, default: [] },
    unreject: { type: "string", multiple: true, default: [] },
    json: { type: "boolean", default: false },
  });
  const sys = load(systemDir(p.positionals[0], p.values.system));
  const accepts = (p.values.accept as string[] | undefined) ?? [];
  const rejects = (p.values.reject as string[] | undefined) ?? [];
  const unrejects = (p.values.unreject as string[] | undefined) ?? [];
  const review = accepts.length > 0 || rejects.length > 0 || unrejects.length > 0 || p.values.list === true;

  if (review) {
    // Resolve positions against the list as shown before any change.
    const shown = livePending(readSuggestionsFile(sys.dir), readArchitectureFile(path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE)));
    const resolve = (ref: string): string => (/^\d+$/.test(ref) ? (shown[Number(ref) - 1]?.id ?? `#${ref}`) : ref);
    const acceptIds = accepts.map(resolve);
    const rejectIds = rejects.map(resolve);
    if (acceptIds.length > 0) {
      let arch = archOf(sys);
      for (const id of acceptIds) {
        try {
          const r = acceptPending(sys.dir, arch, id);
          arch = r.architecture;
          err(`accepted ${edgeLine(r.edge)} (source "suggested")`);
        } catch (e) {
          throw new SystemManageError("not_found", (e as Error).message);
        }
      }
      writeArch(sys, arch);
    }
    for (const id of rejectIds) {
      try {
        const r = rejectPending(sys.dir, id);
        err(`rejected ${edgeLine(r)}; it will not be proposed again`);
      } catch (e) {
        throw new SystemManageError("not_found", (e as Error).message);
      }
    }
    for (const id of unrejects) {
      if (!unreject(sys.dir, id)) throw new SystemManageError("not_found", `not rejected: ${id}`);
      err(`forgot the rejection ${id}`);
    }
    const file = readSuggestionsFile(sys.dir);
    const pending = livePending(file, readArchitectureFile(path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE)));
    if (p.values.json === true) out(JSON.stringify({ pending, rejected: file.rejected, lastRun: file.lastRun ?? null }, null, 2));
    else if (p.values.list === true || accepts.length + rejects.length > 0) printSuggestions(pending);
    return 0;
  }

  const minRaw = p.values["min-confidence"];
  const minConfidence = typeof minRaw === "string" ? Number(minRaw) : undefined;
  if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) throw new UsageError("--min-confidence must be a number from 0 to 1");
  if (sys.repos.length < 2) throw new SystemManageError("invalid", "add at least two repos before suggesting connections");

  if (p.values["print-prompt"] === true) {
    const arch = archOf(sys);
    const services = topLevelServices(arch);
    const ids = new Set(services.map((s) => s.id));
    const stored = readSuggestionsFile(sys.dir);
    out(
      buildSuggestPrompt({
        systemName: sys.name,
        services,
        existingEdges: arch.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
        repos: sys.repos.map((r) => ({ id: r.id, path: r.root })),
        ...(stored.rejected.length > 0 ? { rejectedEdges: stored.rejected } : {}),
      }),
    );
    return 0;
  }

  let runAgent: RunAgent;
  let agentId: string;
  const replyFile = p.values["reply-file"];
  const model = typeof p.values.model === "string" ? p.values.model : undefined;
  if (typeof replyFile === "string") {
    agentId = "reply-file";
    runAgent = async () => fs.readFileSync(replyFile === "-" ? 0 : replyFile, "utf8");
  } else {
    const agent = typeof p.values.agent === "string" ? p.values.agent : "claude";
    if (agent !== "claude") throw new UsageError(`unknown --agent "${agent}" (claude; or run any agent on --print-prompt and pass --reply-file)`);
    agentId = "claude";
    if (hooks.agent !== undefined) runAgent = hooks.agent(sys, model !== undefined ? { model } : {});
    else {
      const { claudeRunAgent } = await import("./agent-claude.js");
      runAgent = claudeRunAgent({
        cwd: sys.dir,
        additionalDirectories: sys.repos.map((r) => r.root),
        ...(model !== undefined ? { model } : {}),
        onProgress: (line) => err(line),
      });
    }
    err(`asking ${agentId} for connections between ${sys.repos.length} repos (read-only) …`);
  }
  const r = await runSuggestPass(sys, runAgent, {
    agentId,
    version,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
  });
  const pending = livePending(r.file, archOf(sys));
  if (p.values.json === true) {
    out(JSON.stringify({ pending, added: r.added, rejected: r.result.rejected, droppedRejected: r.droppedRejected }, null, 2));
    return 0;
  }
  err(
    `${r.result.suggestions.length} valid proposal(s), ${r.added.length} new, ${r.droppedRejected} previously rejected, ` +
      `${r.result.rejected.length} dropped by validation`,
  );
  printSuggestions(pending);
  if (pending.length > 0) err("review: ruah app system suggest --accept <n|id> / --reject <n|id>");
  return 0;
}

const SUBCOMMANDS = "init | add | remove | rename | status | signals | scan | rescan | suggest";

export async function runSystem(argv: readonly string[], version: string, hooks: SystemCliHooks = {}): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "init":
        return init(rest);
      case "add":
        return await add(rest, hooks);
      case "remove":
        return remove(rest);
      case "rename":
        return await rename(rest);
      case "status":
        return await status(rest, hooks);
      case "signals":
        return signals(rest);
      case "scan":
        return scan(rest, version);
      case "rescan":
        return rescan(rest, version);
      case "suggest":
        return await suggest(rest, version, hooks);
      default:
        err(sub === undefined ? `missing subcommand (${SUBCOMMANDS})` : `unknown subcommand "${sub}" (${SUBCOMMANDS})`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof SystemManageError || e instanceof SystemFileError) {
      err(`${sub ?? ""}: ${e.message}`);
      return 2;
    }
    err(`${sub ?? ""}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
