// Drift (CONTRACTS §23.9, JOURNEYS.md §5.4): a journey someone marked reviewed whose code changed
// since — a commit after `reviewedAt` touching a file behind one of its steps (the elements,
// files and symbols it touches, its screens' files), or uncommitted changes there. Read-only git
// (`log -1 --since`, `status --porcelain`), no shell, with a timeout.
import { execFile } from "node:child_process";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import type { ProductFile } from "../contracts/product.js";
import { searchPath } from "../integrations/exec.js";
import { withoutDaemonPlumbing } from "../desktop/child-env.js";

export interface JourneyDrift {
  journey: string;
  reviewedAt: string;
  /** The newest commit since the review that touched the journey's code. */
  commit: { sha: string; date: string; subject: string } | null;
  /** Files of the journey with uncommitted changes. */
  uncommitted: number;
  /** A few of the paths involved (repo-relative, or "<repoId>/<path>" in systems). */
  paths: string[];
}

const TIMEOUT_MS = 4000;
const MAX_PATHS = 60;

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: root,
        timeout: TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: { ...withoutDaemonPlumbing(process.env), PATH: searchPath(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });
}

/** Repo paths behind a journey: touched elements' paths, expanded file ids, its screens' files. */
export function journeyPaths(product: ProductFile, journeyId: string, arch: Architecture | null): string[] {
  const journey = product.journeys.find((j) => j.id === journeyId);
  if (journey === undefined) return [];
  const nodes = arch?.nodes ?? [];
  const out = new Set<string>();
  for (const step of journey.steps) {
    const screen = step.screen !== undefined ? product.screens.find((s) => s.id === step.screen) : undefined;
    if (screen?.path !== undefined) out.add(screen.path);
    for (const ref of step.touches ?? []) {
      const exact = nodes.find((n) => n.id === ref);
      if (exact !== undefined) {
        if (exact.path !== undefined) out.add(exact.path);
        continue;
      }
      // "<elementId>/<rest>[#symbol]" → "<element path>/<rest>"
      const owner = nodes
        .filter((n) => n.path !== undefined && (ref.startsWith(`${n.id}/`) || ref.startsWith(`${n.id}#`)))
        .sort((a, b) => b.id.length - a.id.length)[0];
      if (owner?.path === undefined) continue;
      const rest = ref.slice(owner.id.length).split("#")[0]!.replace(/^\/+/, "");
      out.add(rest === "" ? owner.path : path.posix.join(owner.path, rest));
    }
  }
  return [...out].slice(0, MAX_PATHS);
}

export interface DriftOptions {
  root: string;
  /** Multi-repo systems: "<repoId>/<path>" → the file and the repo it lives in. */
  resolvePath?: (rel: string) => { abs: string; root: string } | null;
}

/** Drifted journeys (reviewed ones whose code changed since); journeys never reviewed are skipped. */
export async function productDrift(product: ProductFile, arch: Architecture | null, options: DriftOptions): Promise<JourneyDrift[]> {
  const out: JourneyDrift[] = [];
  for (const journey of product.journeys) {
    if (journey.reviewedAt === undefined || Number.isNaN(Date.parse(journey.reviewedAt))) continue;
    const paths = journeyPaths(product, journey.id, arch);
    if (paths.length === 0) continue;
    // Group by the repo each path lives in.
    const byRepo = new Map<string, string[]>();
    for (const p of paths) {
      if (options.resolvePath !== undefined) {
        const hit = options.resolvePath(p);
        if (hit === null) continue;
        const rel = path.relative(hit.root, hit.abs);
        byRepo.set(hit.root, [...(byRepo.get(hit.root) ?? []), rel === "" ? "." : rel]);
      } else {
        byRepo.set(options.root, [...(byRepo.get(options.root) ?? []), p]);
      }
    }
    let commit: JourneyDrift["commit"] = null;
    let uncommitted = 0;
    for (const [root, rels] of byRepo) {
      const log = await git(root, ["log", "-1", "--format=%H%x00%cI%x00%s", `--since=${journey.reviewedAt}`, "--", ...rels]);
      if (log !== null && log.trim() !== "") {
        const [sha, date, subject] = log.trim().split("\u0000");
        if (sha !== undefined && date !== undefined && (commit === null || date > commit.date)) commit = { sha: sha.slice(0, 12), date, subject: subject ?? "" };
      }
      const status = await git(root, ["status", "--porcelain", "--", ...rels]);
      if (status !== null) uncommitted += status.split("\n").filter((l) => l.trim() !== "").length;
    }
    if (commit !== null || uncommitted > 0) out.push({ journey: journey.id, reviewedAt: journey.reviewedAt, commit, uncommitted, paths: paths.slice(0, 5) });
  }
  return out;
}
