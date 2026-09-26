// src/projects/repo-files.ts — what Ruah may write into a user's repository
// (CONTRACTS §20.3). Only committable files, and only on an explicit user
// action: `.ruah/verify.json` (Sync criteria), `.ruah/cloud.json`,
// `.ruah/extensions.json`, `.ruah/preview.json`, `.ruah/links.json`. Caches
// and run outputs live in $RUAH_HOME/projects/<id>/cache instead. Whenever
// Ruah writes into a repo's `.ruah/`, it makes sure `.ruah/.gitignore`
// ignores caches (older Ruah versions kept them in `.ruah/.cache/`).
import * as fs from "node:fs";
import * as path from "node:path";
import { projectIdFor } from "./fs-util.js";

export const RUAH_GITIGNORE = path.join(".ruah", ".gitignore");
const GITIGNORE_TEXT = "# Written by Ruah: machine-local caches never belong in git.\n# The other files in .ruah/ are meant to be committed.\n.cache/\n";
const IGNORES_CACHE = /^\s*\/?\.cache(\/(\*\*?)?)?\s*$/m;

/**
 * Makes `<root>/.ruah/.gitignore` ignore `.cache/`: creates it, or appends
 * one line to a file that does not ignore it yet. Never throws (a read-only
 * repo keeps working); returns whether the file was written.
 */
export function ensureRuahGitignore(root: string): boolean {
  const file = path.join(root, RUAH_GITIGNORE);
  try {
    if (!fs.existsSync(path.dirname(file))) return false;
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== undefined && IGNORES_CACHE.test(current)) return false;
    const text = current === undefined ? GITIGNORE_TEXT : `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.cache/\n`;
    fs.writeFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

function realOr(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The per-project cache folder in Ruah's home:
 * `$RUAH_HOME/projects/<projectId>/cache` (the id of the real path, as the
 * daemon's project ids). Not created here.
 */
export function projectCacheDir(home: string, root: string): string {
  return path.join(home, "projects", projectIdFor(realOr(root)), "cache");
}
