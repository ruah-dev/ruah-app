// Multi-repo system management (docs/MULTI-REPO.md, CONTRACTS §12): create a
// system, add / remove / rename repos, rebuild the system map, rescan one
// repo. A standalone library over the files on disk — `ruah.system.json`, the
// system `architecture.json` next to it and `.ruah/system-scan.json` — with no
// daemon dependency: the `ruah app system` CLI and the daemon's /api/system/*
// endpoints both call it. Nothing here deletes a repo's files: "remove" only
// takes the repo out of ruah.system.json.
//
// Rename (decision, CONTRACTS §12.4): allowed, and applied consistently to
// everything Ruah stores that names the repo's elements — ruah.system.json,
// the system architecture.json (ids `<old>:*`, the repo node, parents,
// `repo`, paths / files / evidence `<old>/*`, edges, workflows), the pending
// and rejected suggestions, `.ruah/links.json` (work items), and — when the
// caller passes the Ruah home — the chats (turn `nodeId`, `lastNodeId`) and
// the cloud links (`cloud.json`) of the system project. A rename to an id that
// is already a node of the map (e.g. the shared `postgres` node) is refused.
// Agent session transcripts are not rewritten (they are the agent's own
// history); old ids in them are plain text.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchEdge, ArchNode, Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { PRODUCT_FILE } from "../contracts/product.js";
import { writeScannedProduct } from "../product/screens-merge.js";
import { scanRepoWithScreens } from "../scan/index.js";
import { projectIdFor } from "../projects/fs-util.js";
import { ensureRuahGitignore } from "../projects/repo-files.js";
import {
  loadSystem,
  parseSystemFile,
  relativeRepoPath,
  REPO_ID_PATTERN,
  SYSTEM_FILE,
  SystemFileError,
  systemFilePath,
  toSystemFile,
  writeSystemFile,
  type LoadedSystem,
  type SystemFile,
  type SystemRepo,
} from "./config.js";
import { buildSystemArchitecture, type RepoReport, type SystemBuildResult } from "./build.js";
import { readSuggestionsFile, remapSuggestions, writeSuggestionsFile } from "./suggestions-store.js";

/** An error with a kind the HTTP layer maps to a status (invalid 400, not_found 404, conflict 409). */
export class SystemManageError extends Error {
  constructor(
    readonly kind: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "SystemManageError";
  }
}

export const SYSTEM_ARCHITECTURE_FILE = "architecture.json";
export const SCAN_STATE_FILE = path.join(".ruah", "system-scan.json");

export interface RepoInput {
  /** A repo directory (absolute, or relative to `cwd`, `~/` allowed). */
  path: string;
  /** Repo id; default: derived from the folder name, unique in the system. */
  id?: string | undefined;
}

// ---------------------------------------------------------------- helpers

function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

function realDir(p: string, cwd: string): string {
  const abs = path.resolve(cwd, expandHome(p.trim()));
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new SystemManageError("not_found", `folder not found: ${abs}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new SystemManageError("invalid", `not a folder: ${abs}`);
  return real;
}

function realish(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** A repo id from a folder name: lower-case, [a-z0-9-], unique among `taken` (web, web-2, …). */
export function deriveRepoId(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/-+$/, "")
    .slice(0, 56);
  if (base === "") base = "repo";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function readArchitectureFile(file: string): Architecture | null {
  const raw = readJson(file);
  if (raw === undefined) return null;
  const r = validateArchitecture(raw, null);
  return r.ok ? r.value : null;
}

function loadOrThrow(target: string): LoadedSystem {
  const file = systemFilePath(target);
  if (!fs.existsSync(file)) throw new SystemManageError("not_found", `no ${SYSTEM_FILE} in ${path.dirname(file)}`);
  try {
    return loadSystem(file);
  } catch (err) {
    throw new SystemManageError("invalid", (err as Error).message);
  }
}

function fileOf(sys: LoadedSystem): SystemFile {
  return toSystemFile(sys);
}

/**
 * Resolves repo inputs against a system folder: real directories, not the
 * system folder itself (its architecture.json is the system map), not already
 * in the system (same folder), ids valid and unique.
 */
function resolveRepos(
  systemDir: string,
  existing: readonly SystemRepo[],
  inputs: readonly RepoInput[],
  cwd: string,
  skipExisting = false,
): SystemRepo[] {
  const sysReal = realish(systemDir);
  const takenIds = new Set(existing.map((r) => r.id));
  const takenRoots = new Set(existing.map((r) => realish(path.resolve(systemDir, r.path))));
  const out: SystemRepo[] = [];
  for (const input of inputs) {
    const root = realDir(input.path, cwd);
    if (root === sysReal) {
      throw new SystemManageError("invalid", `${root} is the system folder itself; pick a separate folder for ruah.system.json`);
    }
    if (takenRoots.has(root)) {
      if (skipExisting) continue;
      throw new SystemManageError("conflict", `already in the system: ${root}`);
    }
    let id = input.id?.trim();
    if (id !== undefined && id !== "") {
      if (!REPO_ID_PATTERN.test(id)) throw new SystemManageError("invalid", `invalid repo id "${id}" (expected ^[a-z0-9][a-z0-9-]*$, <= 63 chars)`);
      if (takenIds.has(id)) throw new SystemManageError("conflict", `repo id already in the system: ${id}`);
    } else {
      id = deriveRepoId(path.basename(root), takenIds);
    }
    takenIds.add(id);
    takenRoots.add(root);
    out.push({ id, path: relativeRepoPath(systemDir, root) });
  }
  return out;
}

// ---------------------------------------------------------------- create / add / remove

export interface InitResult {
  system: LoadedSystem;
  /** True when ruah.system.json was written for the first time. */
  created: boolean;
  added: SystemRepo[];
}

/**
 * Creates `<dir>/ruah.system.json` (the folder is created when missing) with
 * `repos`. When the file exists: `merge` adds the repos that are not in it yet
 * (the "add to an existing system" flow), `force` overwrites it, otherwise a
 * conflict. A folder that already holds a single-repo map (architecture.json
 * without ruah.system.json) is refused: the system map would overwrite it.
 */
export function initSystem(
  dir: string,
  opts: { name?: string | undefined; repos?: readonly RepoInput[]; force?: boolean; merge?: boolean; cwd?: string } = {},
): InitResult {
  const cwd = opts.cwd ?? process.cwd();
  const target = path.resolve(cwd, expandHome(dir.trim()));
  if (dir.trim() === "") throw new SystemManageError("invalid", "folder is empty");
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new SystemManageError("invalid", `not a folder: ${target}`);
  const file = path.join(target, SYSTEM_FILE);
  const exists = fs.existsSync(file);
  if (exists && opts.merge === true && opts.force !== true) {
    const sys = loadOrThrow(file);
    const added = resolveRepos(sys.dir, sys.repos, opts.repos ?? [], cwd, true);
    const next = parseSystemFile({ ...fileOf(sys), repos: [...fileOf(sys).repos, ...added] });
    if (added.length > 0) writeSystemFile(file, next);
    return { system: loadSystem(file), created: false, added };
  }
  if (exists && opts.force !== true) {
    throw new SystemManageError("conflict", `${file} already exists (add repos to it instead)`);
  }
  if (!exists && fs.existsSync(path.join(target, SYSTEM_ARCHITECTURE_FILE))) {
    throw new SystemManageError(
      "conflict",
      `${target} already holds a single-repo map (architecture.json); pick an empty or new folder for the system`,
    );
  }
  fs.mkdirSync(target, { recursive: true });
  const name = opts.name?.trim() || path.basename(target);
  const repos = resolveRepos(target, [], opts.repos ?? [], cwd);
  let sys: SystemFile;
  try {
    sys = parseSystemFile({ version: 1, name, repos });
  } catch (err) {
    throw new SystemManageError("invalid", (err as Error).message);
  }
  writeSystemFile(file, sys);
  return { system: loadSystem(file), created: true, added: repos };
}

/** Appends repos to an existing system. */
export function addRepos(target: string, inputs: readonly RepoInput[], opts: { cwd?: string } = {}): { system: LoadedSystem; added: SystemRepo[] } {
  const sys = loadOrThrow(target);
  const added = resolveRepos(sys.dir, sys.repos, inputs, opts.cwd ?? process.cwd());
  const current = fileOf(sys);
  writeSystemFile(sys.file, parseSystemFile({ ...current, repos: [...current.repos, ...added] }));
  return { system: loadSystem(sys.file), added };
}

/** Takes a repo out of ruah.system.json. The repo's folder and files are never touched. */
export function removeRepo(target: string, id: string): { system: LoadedSystem; removed: SystemRepo } {
  const sys = loadOrThrow(target);
  const removed = sys.repos.find((r) => r.id === id);
  if (removed === undefined) throw new SystemManageError("not_found", `unknown repo: ${id}`);
  const current = fileOf(sys);
  writeSystemFile(sys.file, { ...current, repos: current.repos.filter((r) => r.id !== id) });
  // Pending suggestions that touch the repo are moot now.
  const stored = readSuggestionsFile(sys.dir);
  const pending = stored.pending.filter((s) => s.from !== id && s.to !== id);
  if (pending.length !== stored.pending.length) writeSuggestionsFile(sys.dir, { ...stored, pending });
  return { system: loadSystem(sys.file), removed: { id: removed.id, path: removed.path } };
}

// ---------------------------------------------------------------- rename

/** Maps an id / system path of repo `from` to repo `to`; anything else unchanged. */
export function repoRemapper(from: string, to: string): { id: (id: string) => string; path: (p: string) => string } {
  return {
    id: (id) => (id === from ? to : id.startsWith(`${from}:`) ? `${to}${id.slice(from.length)}` : id),
    path: (p) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p),
  };
}

export function renameInArchitecture(arch: Architecture, from: string, to: string): Architecture {
  const m = repoRemapper(from, to);
  const nodes: ArchNode[] = arch.nodes.map((n) => {
    const out: ArchNode = { ...n, id: m.id(n.id) };
    if (n.parent !== undefined) out.parent = m.id(n.parent);
    if (n.repo === from) out.repo = to;
    if (n.path !== undefined) out.path = m.path(n.path);
    if (n.files !== undefined) out.files = n.files.map(m.path);
    if (n.id === from && n.name === from) out.name = to;
    return out;
  });
  const edges: ArchEdge[] = arch.edges.map((e) => ({
    ...e,
    from: m.id(e.from),
    to: m.id(e.to),
    ...(e.evidence !== undefined ? { evidence: e.evidence.map(m.path) } : {}),
  }));
  const workflows = arch.workflows.map((w) => ({ ...w, id: m.id(w.id), steps: w.steps.map(m.id) }));
  return { ...arch, nodes, edges, workflows };
}

export interface RenameReport {
  system: LoadedSystem;
  from: string;
  to: string;
  architecture: boolean;
  suggestions: boolean;
  links: number;
  chats: number;
  cloudLinks: number;
}

function rewriteChats(home: string, projectId: string, remap: (id: string) => string): number {
  const dir = path.join(home, "projects", projectId, "chats");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  let changed = 0;
  for (const f of files) {
    const file = path.join(dir, f);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let dirty = false;
    const lines = raw.split("\n").map((line, i) => {
      if (line.trim() === "") return line;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const key = i === 0 ? "lastNodeId" : "nodeId";
        const id = value[key];
        if (typeof id !== "string") return line;
        const next = remap(id);
        if (next === id) return line;
        dirty = true;
        return JSON.stringify({ ...value, [key]: next });
      } catch {
        return line;
      }
    });
    if (dirty) {
      atomicWrite(file, lines.join("\n"));
      changed += 1;
    }
  }
  return changed;
}

function rewriteLinks(systemDir: string, remap: (id: string) => string): number {
  const file = path.join(systemDir, ".ruah", "links.json");
  const raw = readJson(file) as { version?: unknown; links?: { nodeId?: unknown }[] } | undefined;
  if (raw === undefined || !Array.isArray(raw.links)) return 0;
  let n = 0;
  const links = raw.links.map((l) => {
    if (typeof l.nodeId !== "string") return l;
    const next = remap(l.nodeId);
    if (next === l.nodeId) return l;
    n += 1;
    return { ...l, nodeId: next };
  });
  if (n > 0) atomicWrite(file, `${JSON.stringify({ ...raw, links }, null, 2)}\n`);
  return n;
}

function rewriteCloud(home: string, projectId: string, remap: (id: string) => string): number {
  const file = path.join(home, "projects", projectId, "cloud.json");
  const raw = readJson(file) as { manualLinks?: Record<string, unknown>; resources?: { linkedNodeId?: unknown }[] } | undefined;
  if (raw === undefined) return 0;
  let n = 0;
  const manualLinks: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.manualLinks ?? {})) {
    const next = typeof v === "string" ? remap(v) : v;
    if (next !== v) n += 1;
    manualLinks[k] = next;
  }
  const resources = (raw.resources ?? []).map((r) => {
    if (typeof r.linkedNodeId !== "string") return r;
    const next = remap(r.linkedNodeId);
    if (next === r.linkedNodeId) return r;
    n += 1;
    return { ...r, linkedNodeId: next };
  });
  if (n > 0) atomicWrite(file, `${JSON.stringify({ ...raw, manualLinks, resources }, null, 2)}\n`);
  return n;
}

/**
 * Renames repo `from` to `to` everywhere Ruah stores it (see the file
 * header). `home` (the Ruah home, ~/.ruah) enables the chat and cloud-link
 * rewrite. The system map is rewritten in place; callers rebuild afterwards
 * to refresh it from the repos.
 */
export function renameRepo(target: string, from: string, to: string, opts: { home?: string } = {}): RenameReport {
  const sys = loadOrThrow(target);
  if (!sys.repos.some((r) => r.id === from)) throw new SystemManageError("not_found", `unknown repo: ${from}`);
  if (!REPO_ID_PATTERN.test(to)) throw new SystemManageError("invalid", `invalid repo id "${to}" (expected ^[a-z0-9][a-z0-9-]*$, <= 63 chars)`);
  if (from === to) throw new SystemManageError("invalid", "the new id is the same as the old one");
  if (sys.repos.some((r) => r.id === to)) throw new SystemManageError("conflict", `repo id already in the system: ${to}`);
  const archFile = path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE);
  const arch = readArchitectureFile(archFile);
  if (arch !== null && arch.nodes.some((n) => n.id === to || n.id.startsWith(`${to}:`))) {
    throw new SystemManageError("conflict", `"${to}" is already an element of the system map; pick another id`);
  }
  const current = fileOf(sys);
  writeSystemFile(sys.file, { ...current, repos: current.repos.map((r) => (r.id === from ? { ...r, id: to } : r)) });
  const m = repoRemapper(from, to);
  let archDone = false;
  if (arch !== null) {
    const next = renameInArchitecture(arch, from, to);
    const checked = validateArchitecture(next, null);
    if (checked.ok) {
      atomicWrite(archFile, `${JSON.stringify(next, null, 2)}\n`);
      archDone = true;
    }
  }
  const stored = readSuggestionsFile(sys.dir);
  const remapped = remapSuggestions(stored, m.id, m.path);
  const suggestions = JSON.stringify(remapped) !== JSON.stringify(stored);
  if (suggestions) writeSuggestionsFile(sys.dir, remapped);
  const scan = readJson(path.join(sys.dir, SCAN_STATE_FILE)) as ScanState | undefined;
  if (scan?.repos?.[from] !== undefined) {
    const { [from]: moved, ...rest } = scan.repos;
    atomicWrite(path.join(sys.dir, SCAN_STATE_FILE), `${JSON.stringify({ ...scan, repos: { ...rest, [to]: moved } }, null, 2)}\n`);
  }
  const links = rewriteLinks(sys.dir, m.id);
  let chats = 0;
  let cloudLinks = 0;
  if (opts.home !== undefined) {
    const projectId = projectIdFor(realish(sys.dir));
    chats = rewriteChats(opts.home, projectId, m.id);
    cloudLinks = rewriteCloud(opts.home, projectId, m.id);
  }
  return { system: loadSystem(sys.file), from, to, architecture: archDone, suggestions, links, chats, cloudLinks };
}

// ---------------------------------------------------------------- build / rescan

export interface ScanState {
  version: 1;
  builtAt: string;
  repos: Record<string, { scannedAt: string | null; source: RepoReport["source"]; type: string; nodes: number; warning?: string }>;
}

export function readScanState(systemDir: string): ScanState | null {
  const raw = readJson(path.join(systemDir, SCAN_STATE_FILE)) as ScanState | undefined;
  return raw !== undefined && raw.version === 1 && typeof raw.repos === "object" && raw.repos !== null ? raw : null;
}

/** When a repo's own architecture.json was generated (its generatedAt, else the file's mtime). */
function repoArchitectureTime(root: string): string | null {
  const file = path.join(root, "architecture.json");
  const arch = readArchitectureFile(file);
  if (arch?.generatedAt !== undefined) return arch.generatedAt;
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export interface RebuildOptions {
  version?: string;
  now?: Date;
  useGit?: boolean;
  /** The map to merge hand edits from (default: the system architecture.json on disk). */
  previous?: Architecture | null;
  /**
   * Write architecture.json and the screens into product.json next to ruah.system.json
   * (default true). The daemon saves through its stores instead.
   */
  write?: boolean;
}

/**
 * Rebuilds the system map (buildSystemArchitecture, hand edits merged),
 * writes it to `<dir>/architecture.json` and the repos' screens to
 * `<dir>/product.json` (CONTRACTS §23.4; unless `write: false`) and records
 * per-repo scan facts in `.ruah/system-scan.json` (for status: last scan time,
 * node count, source).
 */
export function rebuildSystem(target: string | LoadedSystem, opts: RebuildOptions = {}): SystemBuildResult & { file: string } {
  const sys = typeof target === "string" ? loadOrThrow(target) : target;
  const out = path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE);
  const now = opts.now ?? new Date();
  const previous = opts.previous !== undefined ? opts.previous : readArchitectureFile(out);
  const result = buildSystemArchitecture(sys, {
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    now,
    ...(opts.useGit === false ? { useGit: false } : {}),
    previous,
    outFile: out,
  });
  const checked = validateArchitecture(result.architecture, null);
  if (!checked.ok) throw new SystemManageError("invalid", `system architecture failed validation: ${checked.errors[0] ?? ""}`);
  if (opts.write !== false) {
    atomicWrite(out, `${JSON.stringify(result.architecture, null, 2)}\n`);
    writeSystemProduct(sys.dir, result);
  }
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const state: ScanState = { version: 1, builtAt: stamp, repos: {} };
  for (const r of result.repos) {
    state.repos[r.id] = {
      scannedAt: r.source === "architecture.json" ? repoArchitectureTime(r.root) : r.source === "scan" ? stamp : null,
      source: r.source,
      type: r.type,
      nodes: r.nodes,
      ...(r.warning !== undefined ? { warning: r.warning } : {}),
    };
  }
  try {
    atomicWrite(path.join(sys.dir, SCAN_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    ensureRuahGitignore(sys.dir);
  } catch {
    // status then shows no scan time; never fails a build
  }
  return { ...result, file: out };
}

/**
 * Re-scans one repo. A repo with its own architecture.json gets it refreshed
 * (like `ruah app scan`, hand edits merged) so the system rebuild reuses the
 * new map; a repo without one is scanned in memory by the rebuild (no file is
 * created in it). Returns the rebuilt system.
 */
export function rescanRepo(target: string, id: string, opts: RebuildOptions = {}): SystemBuildResult & { file: string; wroteRepoArchitecture: boolean } {
  const sys = loadOrThrow(target);
  const repo = sys.repos.find((r) => r.id === id);
  if (repo === undefined) throw new SystemManageError("not_found", `unknown repo: ${id}`);
  if (!fs.existsSync(repo.root)) throw new SystemManageError("not_found", `repo ${id}: folder not found: ${repo.root}`);
  const own = path.join(repo.root, "architecture.json");
  let wrote = false;
  const previous = readArchitectureFile(own);
  if (previous !== null) {
    const { architecture: arch, screens } = scanRepoWithScreens(repo.root, {
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      now: opts.now ?? new Date(),
      previous,
      ...(opts.useGit === false ? { useGit: false } : {}),
    });
    if (validateArchitecture(arch, repo.root).ok) {
      atomicWrite(own, `${JSON.stringify(arch, null, 2)}\n`);
      wrote = true;
      // Like `ruah app scan`: the repo's own product.json follows its own map (§23.4).
      try {
        writeScannedProduct(path.join(repo.root, PRODUCT_FILE), screens);
      } catch {
        // best effort; the system rebuild below still runs
      }
    }
  }
  return { ...rebuildSystem(sys, opts), wroteRepoArchitecture: wrote };
}

/**
 * The system's product.json (next to ruah.system.json): every repo's screens, namespaced
 * (SystemBuildResult.screens), merged by the §23.4 rules. Returns its warnings; never throws.
 */
export function writeSystemProduct(systemDir: string, result: Pick<SystemBuildResult, "screens">, file?: string): string[] {
  try {
    return writeScannedProduct(file ?? path.join(systemDir, PRODUCT_FILE), result.screens).warnings;
  } catch (err) {
    return [`product.json not written: ${(err as Error).message}`];
  }
}

export { SystemFileError };
