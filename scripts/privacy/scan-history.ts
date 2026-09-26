// scripts/privacy/scan-history.ts — scans EVERY object reachable from any ref of a
// repository (all branches, tags, stashes, notes: file contents, file and folder names,
// commit and tag messages, ref names) for the maintainer's private terms, home folders and
// secret-shaped strings. Run it before a repository goes public, and again on the clone
// that `git filter-repo` rewrote. docs/CONTRACTS.md §22.6.
//
//   pnpm privacy:scan [--repo <dir>] [--terms <file>] [--expect-hits]
//
// --terms defaults to $RUAH_PRIVATE_TERMS_FILE (see scripts/privacy/patterns.ts for the
// format). Reports name the terms file's line, never the term, and hide a path or ref name
// that contains one. --expect-hits is the positive control, run on the ORIGINAL history:
// it passes only when the scan finds something (a private term, when a terms file is given).
//
// Exit codes: 0 nothing found (with --expect-hits: something found); 1 something found
// (with --expect-hits: nothing found); 2 usage error, unreadable or empty terms file, not a
// git repository, or no file contents scanned (a broken scan must never look clean).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type PrivateTerm, homeFolderHits, loadPrivateTerms, privateTermMatcher, secretShapeHits } from "./patterns.js";

export type ObjectKind = "blob" | "tree" | "commit" | "tag" | "ref";

export interface ScanHit {
  kind: ObjectKind;
  /** Short object id. */
  id: string;
  /** Path (blob, tree), ref name or `commit <id> message`; hidden when it names a private term or a home folder. */
  where: string;
}

export interface HistoryScan {
  counts: { commits: number; trees: number; blobs: number; tags: number; refs: number; bytes: number };
  /** Check label → hits. Private terms are labelled `private term on line <n>`. */
  hits: Map<string, ScanHit[]>;
}

const MAX_BUFFER = 1024 * 1024 * 1024;
const BATCH = 500;

function git(repo: string, args: string[], input?: string | Buffer): Buffer {
  return execFileSync("git", ["-C", repo, ...args], {
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  });
}

/** `git cat-file --batch` output → objects, in order. Throws on a `missing` object. */
export function parseCatFileBatch(out: Buffer): Array<{ id: string; type: string; body: Buffer }> {
  const objects: Array<{ id: string; type: string; body: Buffer }> = [];
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) throw new Error("scan-history: truncated `git cat-file --batch` output");
    const header = out.subarray(at, nl).toString("latin1");
    const [id = "", type = "", size = ""] = header.split(" ");
    if (type === "missing" || !/^\d+$/.test(size)) throw new Error(`scan-history: git cannot read object ${id} (${header})`);
    const start = nl + 1;
    const end = start + Number(size);
    objects.push({ id, type, body: out.subarray(start, end) });
    at = end + 1; // the newline after each object's contents
  }
  return objects;
}

/** Entry names of a raw tree object (`<mode> <name>\0<binary id>`), one per line. */
export function treeEntryNames(body: Buffer, idBytes: number): string {
  const names: string[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const nul = body.indexOf(0x00, space);
    if (space < 0 || nul < 0) break;
    names.push(body.subarray(space + 1, nul).toString("latin1"));
    at = nul + 1 + idBytes;
  }
  return names.join("\n");
}

/** A commit's or annotated tag's message (after the headers). */
function messageOf(body: Buffer): string {
  const split = body.indexOf("\n\n", 0, "latin1");
  return split < 0 ? "" : body.subarray(split + 2).toString("latin1");
}

/** Terms as latin1 strings, so they match file contents read byte for byte (binary-safe). */
function asBytes(terms: readonly PrivateTerm[]): PrivateTerm[] {
  return terms.map((t) => ({ term: Buffer.from(t.term, "utf8").toString("latin1"), line: t.line }));
}

export function scanHistory(repoDir: string, terms: readonly PrivateTerm[] = []): HistoryScan {
  const repo = resolve(repoDir);
  const matchTerms = privateTermMatcher(asBytes(terms));
  const counts = { commits: 0, trees: 0, blobs: 0, tags: 0, refs: 0, bytes: 0 };
  const hits = new Map<string, ScanHit[]>();

  const hidden = (where: string): string =>
    matchTerms(where).length > 0 || homeFolderHits(where).length > 0 ? "(name hidden: it contains a private term or a home folder)" : where;
  const record = (labels: string[], hit: ScanHit): void => {
    for (const label of new Set(labels)) {
      const list = hits.get(label) ?? [];
      list.push({ ...hit, where: hidden(hit.where) });
      hits.set(label, list);
    }
  };
  const check = (text: string, withSecrets: boolean): string[] => [
    ...matchTerms(text).map((line) => `private term on line ${line}`),
    ...homeFolderHits(text),
    ...(withSecrets ? secretShapeHits(text) : []),
  ];

  // Refs: every branch, tag, stash and note — what a `git push --mirror` would publish.
  const refs = git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]).toString("utf8").split("\n").filter(Boolean);
  for (const line of refs) {
    const [id = "", ...name] = line.split(" ");
    counts.refs++;
    const refname = name.join(" ");
    record(check(Buffer.from(refname, "utf8").toString("latin1"), false), { kind: "ref", id: id.slice(0, 10), where: refname });
  }

  // Every object reachable from those refs, with the first path it was seen at.
  // `rev-list --objects` prints `<id> <path>`: only the id goes to cat-file.
  const paths = new Map<string, string>();
  const ids: string[] = [];
  for (const line of git(repo, ["rev-list", "--objects", "--all"]).toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    const space = line.indexOf(" ");
    const id = space < 0 ? line : line.slice(0, space);
    if (paths.has(id)) continue;
    ids.push(id);
    paths.set(id, space < 0 ? "" : line.slice(space + 1));
  }
  const idBytes = ids[0] !== undefined && ids[0].length === 64 ? 32 : 20;

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const objects = parseCatFileBatch(git(repo, ["cat-file", "--batch"], `${chunk.join("\n")}\n`));
    if (objects.length !== chunk.length) throw new Error(`scan-history: asked git for ${chunk.length} objects, read ${objects.length}`);
    for (const { id, type, body } of objects) {
      const short = id.slice(0, 10);
      const path = paths.get(id) ?? "";
      if (type === "blob") {
        counts.blobs++;
        counts.bytes += body.length;
        record(check(body.toString("latin1"), true), { kind: "blob", id: short, where: path || `(blob ${short})` });
      } else if (type === "tree") {
        counts.trees++;
        record(check(treeEntryNames(body, idBytes), false), { kind: "tree", id: short, where: `${path || "(root)"}/` });
      } else if (type === "commit" || type === "tag") {
        if (type === "commit") counts.commits++;
        else counts.tags++;
        record(check(messageOf(body), true), { kind: type, id: short, where: `${type} ${short} message` });
      }
    }
  }
  return { counts, hits };
}

const KIND_ORDER: readonly ObjectKind[] = ["blob", "tree", "commit", "tag", "ref"];

/** Human-readable report (never prints a term). */
export function formatScan(repo: string, scan: HistoryScan, termsChecked: number): string {
  const { counts } = scan;
  const mib = (counts.bytes / (1024 * 1024)).toFixed(1);
  const lines = [
    `Scanned ${repo}: ${counts.refs} refs, ${counts.commits} commits, ${counts.tags} annotated tags, ${counts.trees} folders, ${counts.blobs} files (${mib} MiB).`,
    termsChecked > 0 ? `Checks: ${termsChecked} private terms, home folders, secret shapes.` : "Checks: home folders, secret shapes (no private-terms file given: --terms or RUAH_PRIVATE_TERMS_FILE).",
  ];
  if (scan.hits.size === 0) {
    lines.push("Nothing found.");
    return lines.join("\n");
  }
  const labels = [...scan.hits.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const label of labels) {
    const list = scan.hits.get(label) ?? [];
    const summary = KIND_ORDER.map((k) => [k, list.filter((h) => h.kind === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`)
      .join(", ");
    lines.push("", `FOUND ${label}: ${summary}`);
    for (const h of list.slice(0, 8)) lines.push(`  ${h.kind.padEnd(6)} ${h.id}  ${h.where}`);
    if (list.length > 8) lines.push(`  … ${list.length - 8} more`);
  }
  return lines.join("\n");
}

interface CliOptions {
  repo: string;
  termsFile: string | undefined;
  expectHits: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { repo: ".", termsFile: process.env.RUAH_PRIVATE_TERMS_FILE, expectHits: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo" || arg === "--terms") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--repo") opts.repo = value;
      else opts.termsFile = value;
    } else if (arg === "--expect-hits") opts.expectHits = true;
    else if (arg === "--help" || arg === "-h") throw new Error("help");
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = "usage: pnpm privacy:scan [--repo <dir>] [--terms <file>] [--expect-hits]";

/** The CLI; returns the exit code. */
export function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): number {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    out((err as Error).message === "help" ? USAGE : `${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    // Set but unreadable or empty (a typo, an unexpanded `~`) is an error, never "no terms".
    const terms = opts.termsFile !== undefined ? loadPrivateTerms(opts.termsFile) : [];
    const repo = resolve(opts.repo);
    try {
      git(repo, ["rev-parse", "--git-dir"]);
    } catch {
      out(`scan-history: ${repo} is not a git repository`);
      return 2;
    }
    const scan = scanHistory(repo, terms);
    out(formatScan(repo, scan, terms.length));
    if (scan.counts.commits > 0 && scan.counts.blobs === 0) {
      out("scan-history: the history has commits but no file contents were read; the scan is broken.");
      return 2;
    }
    const termHits = [...scan.hits.keys()].filter((k) => k.startsWith("private term")).length;
    const found = terms.length > 0 && opts.expectHits ? termHits > 0 : scan.hits.size > 0;
    if (opts.expectHits) {
      out(
        found
          ? "Positive control passed: this scan finds what the terms describe. Now rewrite, then scan the rewritten clone without --expect-hits."
          : "Positive control FAILED: nothing found. Check the terms file and the repository before trusting a clean result elsewhere.",
      );
      return found ? 0 : 1;
    }
    return found ? 1 : 0;
  } catch (err) {
    out(`scan-history: ${(err as Error).message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
