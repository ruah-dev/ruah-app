// Per-repo status of a multi-repo system (CONTRACTS §12.2): git branch,
// upstream, ahead/behind, dirty count (`git status --porcelain=v2 --branch`,
// execFile with an args array, never a shell), plus what the last system
// build recorded (.ruah/system-scan.json) and the node count in the system
// map. Read-only; no daemon dependency.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import { defaultRunner, mapLimit, type Runner } from "../integrations/exec.js";
import type { LoadedSystem } from "./config.js";
import { readArchitectureFile, readScanState, SYSTEM_ARCHITECTURE_FILE } from "./manage.js";

export interface GitStatus {
  branch: string | null; // null = detached HEAD
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed, staged, unmerged and untracked entries. */
  dirty: number;
  /** Short commit id of HEAD (null in an empty repo). */
  head: string | null;
}

export interface RepoStatus {
  id: string;
  /** As written in ruah.system.json (relative to it). */
  path: string;
  /** Absolute folder. */
  root: string;
  exists: boolean;
  /** Null when the folder is not a git work tree (or git is missing: see gitError). */
  git: GitStatus | null;
  gitError?: string;
  /** When the repo was last scanned for the system map (ISO), null = never / unknown. */
  lastScanAt: string | null;
  /** Where the last build took the repo's map from. */
  scanSource: "architecture.json" | "scan" | "missing" | null;
  /** Repo type inferred by the last build (service, frontend, worker, …). */
  type: string | null;
  /** Elements of this repo in the system map (below its repo node). */
  nodes: number;
  warning?: string;
}

export interface SystemStatus {
  name: string;
  dir: string;
  file: string;
  builtAt: string | null;
  repos: RepoStatus[];
}

/** Parses `git status --porcelain=v2 --branch` output. */
export function parseGitStatus(out: string): GitStatus {
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, head: null };
  for (const line of out.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      status.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      status.head = oid === "(initial)" ? null : oid.slice(0, 12);
    } else if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m !== null) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (!line.startsWith("#")) {
      status.dirty += 1;
    }
  }
  return status;
}

/** Git status of one folder; `{ git: null }` when it is not a work tree. */
export async function repoGitStatus(root: string, runner: Runner = defaultRunner): Promise<{ git: GitStatus | null; error?: string }> {
  try {
    const r = await runner("git", ["-C", root, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
      return /not a git repository/i.test(msg) ? { git: null } : { git: null, error: msg.slice(0, 200) || `git exited ${r.code}` };
    }
    return { git: parseGitStatus(r.stdout) };
  } catch (err) {
    return { git: null, error: (err as Error).message };
  }
}

function countRepoNodes(arch: Architecture | null, id: string): number {
  if (arch === null) return 0;
  return arch.nodes.filter((n) => n.repo === id && n.id !== id).length;
}

/**
 * Status of every repo of a system. `architecture` is the system map to
 * count nodes in (default: the architecture.json next to ruah.system.json).
 */
export async function systemStatus(
  sys: LoadedSystem,
  opts: { runner?: Runner; architecture?: Architecture | null } = {},
): Promise<SystemStatus> {
  const arch = opts.architecture !== undefined ? opts.architecture : readArchitectureFile(path.join(sys.dir, SYSTEM_ARCHITECTURE_FILE));
  const scan = readScanState(sys.dir);
  const repos = await mapLimit(sys.repos, 4, async (r): Promise<RepoStatus> => {
    const exists = fs.existsSync(r.root) && fs.statSync(r.root).isDirectory();
    const git = exists ? await repoGitStatus(r.root, opts.runner) : { git: null };
    const s = scan?.repos[r.id];
    return {
      id: r.id,
      path: r.path,
      root: r.root,
      exists,
      git: git.git,
      ...(git.error !== undefined ? { gitError: git.error } : {}),
      lastScanAt: s?.scannedAt ?? null,
      scanSource: s?.source ?? null,
      type: s?.type ?? arch?.nodes.find((n) => n.id === r.id)?.type ?? null,
      nodes: countRepoNodes(arch, r.id),
      ...(s?.warning !== undefined ? { warning: s.warning } : {}),
    };
  });
  return { name: sys.name, dir: sys.dir, file: sys.file, builtAt: scan?.builtAt ?? arch?.generatedAt ?? null, repos };
}
