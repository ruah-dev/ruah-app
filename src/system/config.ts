// `ruah.system.json`: the definition of a multi-repo system (docs/MULTI-REPO.md).
//
//   { "version": 1, "name": "acme-platform",
//     "repos": [{ "id": "web", "path": "../web-app" }, …] }
//
// Repo paths are relative to the file (it is meant to be committed and shared),
// POSIX separators. Ids are `^[a-z0-9][a-z0-9-]*$` (<= 63 chars) and unique;
// they become the namespace of every node of that repo (`<repoId>:<nodeId>`)
// and the first path segment of its files (`<repoId>/<path>`).
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export const SYSTEM_FILE = "ruah.system.json";
export const REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const SystemRepoSchema = z.object({
  id: z.string().regex(REPO_ID_PATTERN, "repo id must match ^[a-z0-9][a-z0-9-]*$ (<= 63 chars)"),
  path: z.string().min(1),
});

export const SystemFileSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    repos: z.array(SystemRepoSchema),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.repos.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repos", i, "id"], message: `duplicate repo id: ${r.id}` });
      seen.add(r.id);
    });
  });

export type SystemRepo = z.infer<typeof SystemRepoSchema>;
export type SystemFile = z.infer<typeof SystemFileSchema>;

export interface LoadedRepo extends SystemRepo {
  root: string; // absolute directory
}

export interface LoadedSystem {
  file: string; // absolute path of ruah.system.json
  dir: string; // its directory; the system architecture.json lives here
  name: string;
  repos: LoadedRepo[];
}

export class SystemFileError extends Error {}

// `target` is the system file itself or the directory holding it.
export function systemFilePath(target: string): string {
  const abs = path.resolve(target);
  try {
    if (fs.statSync(abs).isDirectory()) return path.join(abs, SYSTEM_FILE);
  } catch {
    // not there yet: a path ending in .json is the file, anything else a directory
  }
  return abs.endsWith(".json") ? abs : path.join(abs, SYSTEM_FILE);
}

export function parseSystemFile(input: unknown): SystemFile {
  const parsed = SystemFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new SystemFileError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export function loadSystem(target: string): LoadedSystem {
  const file = systemFilePath(target);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new SystemFileError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new SystemFileError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const sys = parseSystemFile(json);
  const dir = path.dirname(file);
  return {
    file,
    dir,
    name: sys.name,
    repos: sys.repos.map((r) => ({ ...r, root: path.resolve(dir, r.path) })),
  };
}

export function toSystemFile(sys: LoadedSystem): SystemFile {
  return { version: 1, name: sys.name, repos: sys.repos.map((r) => ({ id: r.id, path: r.path })) };
}

export function writeSystemFile(file: string, sys: SystemFile): void {
  parseSystemFile(sys);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(sys, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Repo path as stored in the file: relative to the file's directory, POSIX.
// Both sides are resolved through symlinks (macOS /var → /private/var), the
// system dir possibly not existing yet.
export function relativeRepoPath(systemDir: string, repoDir: string): string {
  const rel = path.relative(realish(systemDir), realish(repoDir)).split(path.sep).join("/");
  return rel === "" ? "." : rel;
}

function realish(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realish(parent), path.basename(abs));
  }
}

// Returns a new SystemFile with `repo` appended; throws on a duplicate id.
export function addRepo(sys: SystemFile, repo: SystemRepo): SystemFile {
  if (sys.repos.some((r) => r.id === repo.id)) throw new SystemFileError(`repo id already in the system: ${repo.id}`);
  const next: SystemFile = { ...sys, repos: [...sys.repos, repo] };
  return parseSystemFile(next);
}

export interface ResolvedSystemPath {
  repoId: string;
  root: string; // absolute repo root
  rel: string; // repo-relative path ("" = repo root)
  abs: string;
}

// Maps a system path (`<repoId>/<repo-relative path>`, as used in node paths,
// files and edge evidence) to the repo on disk. Null for an unknown repo or a
// path escaping the repo. A trailing `:line` is not stripped here.
export function resolveSystemPath(sys: LoadedSystem, sysPath: string): ResolvedSystemPath | null {
  const norm = path.posix.normalize(sysPath.replaceAll("\\", "/"));
  const slash = norm.indexOf("/");
  const repoId = slash === -1 ? norm : norm.slice(0, slash);
  const rel = slash === -1 ? "" : norm.slice(slash + 1);
  const repo = sys.repos.find((r) => r.id === repoId);
  if (repo === undefined) return null;
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
  const abs = path.resolve(repo.root, rel);
  if (abs !== repo.root && !abs.startsWith(`${repo.root}${path.sep}`)) return null;
  return { repoId, root: repo.root, rel, abs };
}
