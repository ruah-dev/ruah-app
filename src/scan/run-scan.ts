// `ruah app scan <repo> [--out <path>] [--dry-run] [--describe]` (PLAN.md Phase 2).
//
// Scans, merges hand edits from the existing output file (see merge.ts),
// validates against CONTRACTS.md §1.2, then writes the file (or prints it with
// --dry-run) and a one-line summary on stderr.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { describeArchitecture } from "./describe.js";
import { scanRepo, summarize } from "./index.js";

export interface RunScanOptions {
  repo: string;
  out?: string;
  dryRun: boolean;
  describe: boolean;
}

function readPrevious(file: string, root: string): Architecture | null {
  if (!fs.existsSync(file)) return null;
  try {
    const result = validateArchitecture(JSON.parse(fs.readFileSync(file, "utf8")), root);
    if (result.ok) return result.value;
    process.stderr.write(`ruah app scan: existing ${file} is invalid; not merging hand edits (${result.errors[0] ?? ""})\n`);
  } catch (err) {
    process.stderr.write(`ruah app scan: cannot read existing ${file}: ${(err as Error).message}\n`);
  }
  return null;
}

export async function runScan(opts: RunScanOptions, version: string): Promise<number> {
  const root = path.resolve(opts.repo);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`ruah app scan: not a directory: ${opts.repo}\n`);
    return 2;
  }
  const out = path.resolve(opts.out ?? path.join(root, "architecture.json"));
  const started = Date.now();
  let arch = scanRepo(root, { version, now: new Date(), previous: readPrevious(out, root) });
  if (opts.describe) {
    const d = await describeArchitecture(arch, root);
    arch = d.architecture;
    process.stderr.write(`ruah app scan: ${d.message}\n`);
  }
  const result = validateArchitecture(arch, root);
  if (!result.ok) {
    process.stderr.write(`ruah app scan: generated architecture failed validation:\n  ${result.errors.join("\n  ")}\n`);
    return 1;
  }
  for (const w of result.warnings) process.stderr.write(`ruah app scan: warning: ${w}\n`);
  const json = `${JSON.stringify(arch, null, 2)}\n`;
  const s = summarize(arch);
  const ms = Date.now() - started;
  const line = `${s.nodes} nodes (${s.topLevel} top-level), ${s.edges} edges, ${s.layers.length} layers [${s.layers.join(", ")}] in ${ms} ms`;
  if (opts.dryRun) {
    process.stdout.write(json);
    process.stderr.write(`ruah app scan: dry run, ${line}\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, out);
  process.stderr.write(`ruah app scan: wrote ${out}: ${line}\n`);
  return 0;
}
