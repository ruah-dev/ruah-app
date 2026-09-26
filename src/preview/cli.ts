// `ruah app preview [<repo>]` — the live preview without the app or a daemon
// (CONTRACTS §18.7): prints how the repo's dev server runs (--detect, --json)
// or runs it in the foreground with the same detection, URL discovery and
// health check the app uses, printing the preview URL once it answers.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import type { PreviewCandidate, PreviewDetection, PreviewStatus } from "../contracts/preview.js";
import { terminalEnv } from "../terminal/env.js";
import { projectIdFor } from "../projects/fs-util.js";
import { ruahHome } from "../usage/log.js";
import { localPreviewFileOf, writeLocalPreviewChoice, writePreviewChoice } from "./config.js";
import { detectPreview } from "./detect.js";
import { PreviewError, PreviewManager } from "./manager.js";
import { ProcessRunner } from "./runner.js";

export const PREVIEW_USAGE = `ruah app preview — run a repo's dev server and show where it is (no daemon needed)

Usage:
  ruah app preview [<repo>]               run the detected dev server in the foreground
  ruah app preview [<repo>] --detect      print the candidates and what would run
  ruah app preview [<repo>] --json        the detection as JSON (implies --detect)

Options:
  --pick <id>        run this candidate (ids from --detect, e.g. apps/web#dev)
  --command <cmd>    run your own command instead ({port} = a free port)
  --dir <folder>     folder for --command (repo-relative, default .)
  --remember         remember --pick / --command for this repo on this computer ($RUAH_HOME)
  --save-to-repo     save it in <repo>/.ruah/preview.json instead (committable, shared)
  --open             open the URL in the default browser once it answers

Exit codes: 0 stopped cleanly (Ctrl+C) · 1 nothing found / crashed · 2 bad arguments or a pick is needed.
`;

function hmrLabel(c: PreviewCandidate): string {
  return c.hmr ? "hot reload" : "reload after edits";
}

export function formatDetection(d: PreviewDetection): string {
  const lines: string[] = [];
  const meta = [d.packageManager, d.monorepo ? "several apps" : undefined].filter((x) => x !== undefined).join(", ");
  lines.push(`Preview for ${d.root}${meta.length > 0 ? `  (${meta})` : ""}`);
  if (d.configError !== undefined) lines.push(`  ! ${d.configError}`);
  if (d.candidates.length === 0) {
    lines.push("  No dev server found. Run your own: ruah app preview --command \"<cmd>\" [--dir <folder>] [--remember]");
    return `${lines.join("\n")}\n`;
  }
  const idW = Math.min(28, Math.max(...d.candidates.map((c) => c.id.length)));
  const titleW = Math.min(22, Math.max(...d.candidates.map((c) => c.title.length)));
  for (const c of d.candidates) {
    const mark = c.id === d.selected ? "▸" : " ";
    const port = c.port !== undefined ? `:${c.port}` : "";
    const missing = c.available === false ? `   (${c.needs} not found${c.install !== undefined ? ` — ${c.install}` : ""})` : "";
    const setup = c.setup !== undefined ? `   (dependencies missing: ${c.setup})` : "";
    lines.push(`  ${mark} ${c.id.padEnd(idW)}  ${c.title.padEnd(titleW)}  ${c.command}  [${c.dir}${port}, ${hmrLabel(c)}]${missing}${setup}`);
  }
  if (d.selected !== null) {
    const saved = d.choice === null ? "" : d.choiceFrom === "local" ? " (remembered on this computer)" : " (saved in .ruah/preview.json)";
    lines.push(`Runs: ${d.selected}${saved}`);
  } else {
    lines.push("Several apps: pick one with --pick <id> (add --remember to keep the pick)");
  }
  return `${lines.join("\n")}\n`;
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener: the URL is printed */
  }
}

export async function runPreview(argv: readonly string[], version: string): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        detect: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        pick: { type: "string" },
        command: { type: "string" },
        dir: { type: "string" },
        remember: { type: "boolean", default: false },
        "save-to-repo": { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`ruah app preview: ${(err as Error).message}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(PREVIEW_USAGE);
    return 0;
  }
  if (positionals.length > 1) {
    process.stderr.write("ruah app preview: at most one <repo>\n");
    return 2;
  }
  if (values.pick !== undefined && values.command !== undefined) {
    process.stderr.write("ruah app preview: --pick and --command exclude each other\n");
    return 2;
  }
  const root = path.resolve(positionals[0] ?? ".");
  // The same project id (and so the same remembered choice) as the app's.
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    real = root;
  }
  const project = { id: projectIdFor(real), name: path.basename(root), root };
  const localChoice = localPreviewFileOf(ruahHome(), project.id);
  let detection: PreviewDetection;
  try {
    detection = detectPreview(root, { localChoiceFile: localChoice });
  } catch (err) {
    process.stderr.write(`ruah app preview: ${(err as Error).message}\n`);
    return 1;
  }
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(detection, null, 2)}\n`);
    return detection.candidates.length > 0 ? 0 : 1;
  }
  if (values.detect === true) {
    process.stdout.write(formatDetection(detection));
    return detection.candidates.length > 0 ? 0 : 1;
  }
  if (values.pick !== undefined && !detection.candidates.some((c) => c.id === values.pick)) {
    process.stderr.write(`ruah app preview: unknown candidate "${values.pick}"\n${formatDetection(detection)}`);
    return 2;
  }
  const toRepo = values["save-to-repo"] === true;
  if ((values.remember === true || toRepo) && (values.pick !== undefined || values.command !== undefined)) {
    const patch = values.pick !== undefined ? { candidate: values.pick } : { command: values.command ?? null, dir: values.dir ?? null };
    try {
      if (toRepo) {
        writePreviewChoice(root, patch);
        writeLocalPreviewChoice(localChoice, { candidate: null, command: null, url: null });
      } else {
        writeLocalPreviewChoice(localChoice, patch);
      }
    } catch (err) {
      process.stderr.write(`ruah app preview: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let announced = false;
  let finished: (status: PreviewStatus) => void = () => {};
  const done = new Promise<PreviewStatus>((resolve) => (finished = resolve));
  let started = false;
  const manager = new PreviewManager({
    version,
    project: () => project,
    sweep: false,
    runner: new ProcessRunner({ detached: false, tee: (text, stream) => (stream === "stdout" ? process.stdout : process.stderr).write(text) }),
    env: async () => ({ ...terminalEnv(process.env, { projectRoot: root, version }), BROWSER: "none" }),
    onStatus: (status) => {
      if (status.state === "running" && status.url !== null && !announced) {
        announced = true;
        process.stderr.write(`\n  ruah ▸ preview at ${status.url}${status.hmr ? "" : "  (no hot reload: refresh after edits)"}\n\n`);
        if (values.open === true) openInBrowser(status.url);
      }
      if (started && (status.state === "stopped" || status.state === "crashed")) finished(status);
    },
  });
  const stop = (): void => {
    void manager.stop().then((s) => {
      if (s !== null) finished(s);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let first: PreviewStatus;
  try {
    first = await manager.start({
      ...(values.pick !== undefined ? { candidate: values.pick } : {}),
      ...(values.command !== undefined ? { command: values.command, ...(values.dir !== undefined ? { dir: values.dir } : {}) } : {}),
    }, { allowCommand: true });
  } catch (err) {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (err instanceof PreviewError && err.detection !== undefined) {
      process.stderr.write(`ruah app preview: ${err.message}\n${formatDetection(err.detection)}`);
      return err.status === 409 && err.detection.candidates.length > 0 ? 2 : 1;
    }
    process.stderr.write(`ruah app preview: ${(err as Error).message}\n`);
    return 1;
  }
  started = true;
  process.stderr.write(`ruah ▸ ${first.command ?? ""}  (in ${first.cwd ?? root})\n`);
  if (first.state === "crashed" || first.state === "stopped") {
    process.stderr.write(`ruah app preview: ${first.error ?? "the dev server stopped"}\n`);
    return first.state === "crashed" ? 1 : 0;
  }
  const last = await done;
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (last.state === "crashed") {
    process.stderr.write(`ruah app preview: ${last.error ?? "the dev server crashed"}\n`);
    return 1;
  }
  return 0;
}
