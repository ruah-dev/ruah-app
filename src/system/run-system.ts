// `archmap system <init|add|scan>` (docs/MULTI-REPO.md).
//
//   archmap system init <dir> --repo <id>=<path> … [--name <name>] [--force]
//   archmap system add  <dir> <id>=<path>
//   archmap system scan <dir> [--out <path>] [--dry-run]
//
// <dir> is the folder holding ruah.system.json (or the file itself). Repo
// paths on the command line resolve against the current directory and are
// stored relative to the system file. `scan` writes the system
// architecture.json next to ruah.system.json (merging hand edits from it).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import {
  addRepo,
  loadSystem,
  relativeRepoPath,
  REPO_ID_PATTERN,
  type SystemFile,
  SystemFileError,
  systemFilePath,
  type SystemRepo,
  writeSystemFile,
} from "./config.js";
import { buildSystemArchitecture } from "./build.js";

const err = (msg: string): void => void process.stderr.write(`archmap system: ${msg}\n`);

function parseRepoSpec(spec: string, systemDir: string): SystemRepo | string {
  const eq = spec.indexOf("=");
  if (eq <= 0) return `expected <id>=<path>, got "${spec}"`;
  const id = spec.slice(0, eq);
  const p = spec.slice(eq + 1);
  if (!REPO_ID_PATTERN.test(id)) return `invalid repo id "${id}" (expected ^[a-z0-9][a-z0-9-]*$)`;
  if (p === "") return `missing path for repo ${id}`;
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `repo ${id}: not a directory: ${p}`;
  return { id, path: relativeRepoPath(systemDir, abs) };
}

function init(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string", multiple: true, default: [] },
        name: { type: "string" },
        force: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const target = parsed.positionals[0];
  if (target === undefined) {
    err("init: missing <dir>");
    return 2;
  }
  const file = systemFilePath(target);
  if (fs.existsSync(file) && parsed.values.force !== true) {
    err(`init: ${file} already exists (use --force to overwrite, or 'archmap system add')`);
    return 2;
  }
  const dir = path.dirname(file);
  let sys: SystemFile = { version: 1, name: parsed.values.name ?? path.basename(dir), repos: [] };
  for (const spec of parsed.values.repo ?? []) {
    const r = parseRepoSpec(spec, dir);
    if (typeof r === "string") {
      err(`init: ${r}`);
      return 2;
    }
    try {
      sys = addRepo(sys, r);
    } catch (e) {
      err(`init: ${(e as Error).message}`);
      return 2;
    }
  }
  writeSystemFile(file, sys);
  process.stderr.write(`archmap system: wrote ${file} (${sys.repos.length} repo${sys.repos.length === 1 ? "" : "s"})\n`);
  return 0;
}

function add(argv: string[]): number {
  const [target, spec, ...extra] = argv;
  if (target === undefined || spec === undefined || extra.length > 0) {
    err("add: usage: archmap system add <dir> <id>=<path>");
    return 2;
  }
  let loaded;
  try {
    loaded = loadSystem(target);
  } catch (e) {
    err(`add: ${(e as Error).message}`);
    return e instanceof SystemFileError ? 2 : 1;
  }
  const r = parseRepoSpec(spec, loaded.dir);
  if (typeof r === "string") {
    err(`add: ${r}`);
    return 2;
  }
  try {
    const next = addRepo({ version: 1, name: loaded.name, repos: loaded.repos.map((x) => ({ id: x.id, path: x.path })) }, r);
    writeSystemFile(loaded.file, next);
  } catch (e) {
    err(`add: ${(e as Error).message}`);
    return 2;
  }
  process.stderr.write(`archmap system: added ${r.id} (${r.path}) to ${loaded.file}\n`);
  return 0;
}

function readPrevious(file: string): Architecture | null {
  if (!fs.existsSync(file)) return null;
  try {
    const r = validateArchitecture(JSON.parse(fs.readFileSync(file, "utf8")), null);
    if (r.ok) return r.value;
    err(`scan: existing ${file} is invalid; not merging hand edits (${r.errors[0] ?? ""})`);
  } catch (e) {
    err(`scan: cannot read existing ${file}: ${(e as Error).message}`);
  }
  return null;
}

function scan(argv: string[], version: string): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { out: { type: "string" }, "dry-run": { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const target = parsed.positionals[0];
  if (target === undefined) {
    err("scan: missing <dir>");
    return 2;
  }
  let sys;
  try {
    sys = loadSystem(target);
  } catch (e) {
    err(`scan: ${(e as Error).message}`);
    return 2;
  }
  const out = path.resolve(parsed.values.out ?? path.join(sys.dir, "architecture.json"));
  const started = Date.now();
  const result = buildSystemArchitecture(sys, { version, now: new Date(), previous: readPrevious(out), outFile: out });
  for (const r of result.repos) if (r.warning !== undefined) err(`warning: ${r.warning}`);
  const arch = result.architecture;
  const v = validateArchitecture(arch, null);
  if (!v.ok) {
    err(`scan: generated architecture failed validation:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  for (const w of v.warnings) err(`warning: ${w}`);
  const top = arch.nodes.filter((n) => n.parent === undefined);
  const topIds = new Set(top.map((n) => n.id));
  const cross = arch.edges.filter((e) => topIds.has(e.from) && topIds.has(e.to) && e.source === "scan");
  const line =
    `${arch.nodes.length} nodes (${top.length} top-level: ${sys.repos.length} repos, ${top.length - sys.repos.length} shared/other), ` +
    `${arch.edges.length} edges (${cross.length} top-level scan edges) in ${Date.now() - started} ms`;
  const json = `${JSON.stringify(arch, null, 2)}\n`;
  if (parsed.values["dry-run"] === true) {
    process.stdout.write(json);
    process.stderr.write(`archmap system: dry run, ${line}\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, out);
  for (const r of result.repos) process.stderr.write(`archmap system:   ${r.id}: ${r.type}, ${r.nodes} nodes from ${r.source}\n`);
  process.stderr.write(`archmap system: wrote ${out}: ${line}\n`);
  return 0;
}

export async function runSystem(argv: readonly string[], version: string): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "init":
      return init(rest);
    case "add":
      return add(rest);
    case "scan":
      return scan(rest, version);
    default:
      err(sub === undefined ? "missing subcommand (init | add | scan)" : `unknown subcommand "${sub}" (init | add | scan)`);
      return 2;
  }
}
