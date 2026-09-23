// Repository walker for `ruah app scan` (PLAN.md Phase 2, task 2.1).
//
// Lists repo-relative POSIX file paths, sorted. Uses `git ls-files` when the
// root is a git work tree (respects every .gitignore), else a filesystem walk
// with a built-in ignore list plus the root .gitignore's simple patterns.
// Either way the built-in ignore list and hidden directories are filtered out,
// so the two modes agree on ordinary repos.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const IGNORED_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".output", "vendor", "target", "coverage",
  "__pycache__", "venv", "site-packages", "bower_components",
]);

export const MAX_WALK_FILES = 50_000;

export interface FileList {
  files: string[]; // sorted, repo-relative, POSIX separators
  fileSet: Set<string>;
  dirs: Set<string>; // every directory that contains at least one listed file ("" = root)
  truncated: boolean;
}

function segmentIgnored(seg: string): boolean {
  return IGNORED_DIRS.has(seg) || (seg.startsWith(".") && seg.length > 1);
}

export function isIgnoredPath(rel: string): boolean {
  const segs = rel.split("/");
  // Every directory segment (not the file name itself) is checked; dotfiles in
  // kept directories stay (e.g. `.env.example` is harmless, never read).
  for (let i = 0; i < segs.length - 1; i++) {
    if (segmentIgnored(segs[i] ?? "")) return true;
  }
  return false;
}

function gitFiles(root: string): string[] | null {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const res = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout.split("\0").filter((f) => f.length > 0);
}

// Converts one .gitignore line into a matcher over repo-relative paths.
// Supports `name`, `dir/`, `/anchored`, `*` and `**`. Negations are ignored.
function gitignoreMatcher(line: string): ((rel: string, isDir: boolean) => boolean) | null {
  let pat = line.trim();
  if (pat === "" || pat.startsWith("#") || pat.startsWith("!")) return null;
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith("/") || pat.slice(0, -1).includes("/");
  if (pat.startsWith("/")) pat = pat.slice(1);
  if (pat.startsWith("./")) pat = pat.slice(2);
  const re = new RegExp(`^${globToRegexSource(pat)}$`);
  return (rel, isDir) => {
    if (dirOnly && !isDir) return false;
    if (anchored) return re.test(rel);
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    return re.test(base);
  };
}

export function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function fsFiles(root: string): { files: string[]; truncated: boolean } {
  const matchers: ((rel: string, isDir: boolean) => boolean)[] = [];
  try {
    for (const line of fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/)) {
      const m = gitignoreMatcher(line);
      if (m !== null) matchers.push(m);
    }
  } catch {
    // no .gitignore
  }
  const ignored = (rel: string, isDir: boolean): boolean => matchers.some((m) => m(rel, isDir));
  const files: string[] = [];
  let truncated = false;
  const walk = (relDir: string): void => {
    if (files.length >= MAX_WALK_FILES) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (segmentIgnored(e.name) || ignored(rel, true)) continue;
        walk(rel);
      } else if (e.isFile()) {
        if (ignored(rel, false)) continue;
        if (files.length >= MAX_WALK_FILES) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
    }
  };
  walk("");
  return { files, truncated };
}

export function listFiles(root: string, opts: { useGit?: boolean } = {}): FileList {
  const fromGit = opts.useGit === false ? null : gitFiles(root);
  let files: string[];
  let truncated = false;
  if (fromGit !== null) {
    files = fromGit.map((f) => f.replaceAll("\\", "/")).filter((f) => !isIgnoredPath(f));
  } else {
    const r = fsFiles(root);
    files = r.files;
    truncated = r.truncated;
  }
  files = [...new Set(files)].sort();
  const dirs = new Set<string>([""]);
  for (const f of files) {
    let i = f.lastIndexOf("/");
    while (i > 0) {
      const d = f.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = d.lastIndexOf("/");
    }
  }
  return { files, fileSet: new Set(files), dirs, truncated };
}

export const MAX_READ_BYTES = 2 * 1024 * 1024;

// Reads a repo file as UTF-8, or null when missing, unreadable or over 2 MiB.
export function readText(root: string, rel: string): string | null {
  const abs = path.join(root, rel);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function dirname(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

export function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}
