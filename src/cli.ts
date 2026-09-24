#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `ruah app — the Ruah desktop app (architecture map + coding agents) and its daemon

Usage:
  ruah app [<repo>]                 open the desktop app (on <repo>, e.g. \`ruah app .\`)
  ruah app serve [<repo>] [options] serve the viewer + agent daemon
                                   (no <repo>: start screen, open a project from the viewer)
  ruah app scan <repo> [options]    scan a repo into architecture.json
  ruah app system <cmd> ...         multi-repo system (ruah.system.json; no daemon needed;
                                   <system> = its folder, else --system <dir>, else cwd):
    init <folder> [--repo <path>|<id>=<path>]... [--name <n>] [--force]
                                            create ruah.system.json
    add [<system>] <path|<id>=<path>|gh:owner/name> [--id <id>] [--into <dir>]
                                            add a repo (gh: clones it with \`gh repo clone\`)
    remove <id>                             take a repo out (its files are untouched)
    rename <id> <new-id>                    rename a repo id (map, suggestions, links, chats)
    status [<system>] [--json]              branch, ahead/behind, dirty, last scan, nodes
    signals [<system>] [--json]             deterministic cross-repo edges (zero tokens)
    scan [<system>] [--out <path>] [--dry-run]   write <system>/architecture.json
    rescan <id>                             re-scan one repo and rebuild the system map
    suggest [<system>] [--agent claude] [--model <m>] [--min-confidence <n>] [--json]
            [--print-prompt | --reply-file <file>]
                                            agent pass: proposes cross-repo edges (pending)
    suggest --list | --accept <n|id> | --reject <n|id> | --unreject <id>
                                            review proposals (accepted = source "suggested")
  ruah app export drawio <repo> [--out <file>]
                                   write the architecture as a draw.io file (pages per
                                   drill level + workflow + Specifications; --out - = stdout)
  ruah app resume [<repo-or-id>] [--json]
                                   where you left off: last chat, focus, agent activity since
                                   you left, git state, ruah tasks (no argument: every recent
                                   project, most in need of attention first)
  ruah app activity [--since <dur>] [--json] [--project <repo-or-id>]
                                   what agents did across projects (default --since 24h),
                                   unread and waiting-for-permission counts
  ruah app mcp --daemon <url>       stdio MCP server with the ruah_* map tools of a running
                                   daemon (token in RUAH_MCP_TOKEN or --token; started by
                                   the daemon for ACP agents)
  ruah app --version                print version
  ruah app help                     this text

  (\`ruah-app\` is the same command without the ruah toolkit.)

serve options:
  --file <path>            architecture file (default <repo>/architecture.json)
  --port <n>               port to listen on (default 4177)
  --host <addr>            bind address (default 127.0.0.1)
  --viewer <dir>           static viewer directory (default ./viewer)
  --agent <id>             initial coding agent (switchable from the viewer):
                           claude (Claude Code via the Claude Agent SDK, default),
                           cursor (cursor-agent acp), grok (grok agent stdio),
                           kiro (kiro-cli acp), opencode (opencode acp),
                           acp | claude-acp (Claude via claude-agent-acp)
  --mock                   run the scripted mock agent instead of Claude Code
  --allow-origin <glob>    extra allowed websocket origin (repeatable)
  --no-links               omit resource_link blocks from prompts
  --allow-remote-terminal  allow the integrated terminal when --host is not a loopback
                           address (anyone who can reach the port and the viewer gets a shell)
  --open                   open the viewer URL in the default browser

resume / activity options:
  --daemon <url>           add live counts from a running daemon (default
                           $RUAH_DAEMON_URL or http://127.0.0.1:4177; none is required)
  --offline                do not ask a daemon
  --limit <n>              resume: projects listed (20); activity: events (200)

scan options:
  --out <path>             output file (default <repo>/architecture.json)
  --dry-run                print the JSON to stdout instead of writing it
  --describe               ask the agent to write node descriptions (needs the agent bridge)
`;

async function serve(argv: readonly string[]): Promise<number> {
  // Pull the positional <repo> out first: parseArgs with strict:false mangles
  // a bare positional that follows a boolean flag. Values of string options
  // ("--port 4194") are not the repo; without a positional the daemon starts
  // in the launcher state.
  const stringOptions = new Set(["--file", "--port", "--host", "--viewer", "--agent", "--allow-origin"]);
  let repoIndex = -1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--")) {
      if (stringOptions.has(arg)) i += 1;
      continue;
    }
    repoIndex = i;
    break;
  }
  const repo = repoIndex === -1 ? undefined : argv[repoIndex];
  const rest = repoIndex === -1 ? [...argv] : argv.filter((_, i) => i !== repoIndex);
  const { values } = parseArgs({
    args: [...rest],
    options: {
      file: { type: "string" },
      port: { type: "string", default: "4177" },
      host: { type: "string", default: "127.0.0.1" },
      viewer: { type: "string", default: "viewer" },
      mock: { type: "boolean", default: false },
      agent: { type: "string" },
      "allow-origin": { type: "string", multiple: true, default: [] },
      links: { type: "boolean", default: true },
      open: { type: "boolean", default: false },
      "allow-remote-terminal": { type: "boolean", default: false },
    },
    strict: false,
  });
  const agent = values.agent as string | undefined;
  const { isAgentProvider } = await import("./acp/index.js");
  if (agent !== undefined && !isAgentProvider(agent)) {
    process.stderr.write(`ruah app serve: unknown --agent "${agent}" (expected claude, cursor, grok, kiro, opencode or acp)\n`);
    return 2;
  }
  const { runServe } = await import("./serve/run-serve.js");
  return runServe(
    {
      ...(repo !== undefined ? { repo } : {}),
      ...(typeof values.file === "string" ? { file: values.file } : {}),
      port: Number.parseInt(values.port as string, 10),
      host: values.host as string,
      viewer: values.viewer as string,
      mock: values.mock === true,
      ...(agent !== undefined && isAgentProvider(agent) ? { agent } : {}),
      allowOrigins: ((values["allow-origin"] as string[] | undefined) ?? []).filter(
        (o): o is string => typeof o === "string",
      ),
      links: values.links !== false,
      open: values.open === true,
      allowRemoteTerminal: values["allow-remote-terminal"] === true,
    },
    pkg.version,
  );
}

async function scan(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        out: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        describe: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`ruah app scan: ${(err as Error).message}\n`);
    return 2;
  }
  const repo = parsed.positionals[0];
  if (repo === undefined) {
    process.stderr.write("ruah app scan: missing <repo> argument\n");
    return 2;
  }
  const { runScan } = await import("./scan/run-scan.js");
  return runScan(
    {
      repo,
      ...(parsed.values.out !== undefined ? { out: parsed.values.out } : {}),
      dryRun: parsed.values["dry-run"] === true,
      describe: parsed.values.describe === true,
    },
    pkg.version,
  );
}

async function mcp(argv: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { daemon: { type: "string" }, token: { type: "string" } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(`ruah app mcp: ${(err as Error).message}\n`);
    return 2;
  }
  const daemon = values.daemon ?? process.env.RUAH_DAEMON_URL;
  const token = values.token ?? process.env.RUAH_MCP_TOKEN;
  if (daemon === undefined || token === undefined || token.length === 0) {
    process.stderr.write("ruah app mcp: needs --daemon <url> and a token (--token or RUAH_MCP_TOKEN)\n");
    return 2;
  }
  const { httpMapBackend, serveMcpStdio } = await import("./mcp/stdio-server.js");
  // stdout carries the protocol; logs go to stderr.
  return serveMcpStdio(httpMapBackend(daemon, token), {
    input: process.stdin,
    output: process.stdout,
    version: pkg.version,
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Launches the Electron app from this package (detached, so the terminal is free). */
function openDesktop(repo: string | undefined): number {
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // dist/cli.js → package root
  if (!existsSync(join(root, "viewer", "index.html"))) {
    process.stderr.write(`ruah app: the viewer is not built — run \`pnpm ui:build\` in ${root}\n`);
    return 1;
  }
  let electron: string;
  try {
    electron = require("electron") as string; // the electron package exports its binary path
  } catch {
    process.stderr.write(`ruah app: Electron is not installed — run \`pnpm install\` in ${root}\n`);
    return 1;
  }
  const args = [root, ...(repo !== undefined ? [resolve(repo)] : [])];
  const child = spawn(electron, args, { detached: true, stdio: "ignore" });
  child.unref();
  process.stdout.write(`Opening Ruah${repo !== undefined ? ` on ${resolve(repo)}` : ""}…\n`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(pkg.version);
    return 0;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  // `ruah app`, `ruah app open [<repo>]`, `ruah app <repo-dir>`: the desktop app.
  if (cmd === undefined || cmd === "open" || (!cmd.startsWith("-") && isDirectory(cmd))) {
    const repo = cmd === "open" ? rest[0] : cmd;
    return openDesktop(repo);
  }
  switch (cmd) {
    case "serve": {
      return await serve(rest);
    }
    case "scan": {
      return await scan(rest);
    }
    case "system": {
      const { runSystem } = await import("./system/run-system.js");
      return await runSystem(rest, pkg.version);
    }
    case "export": {
      const { runExport } = await import("./export/run-export.js");
      return await runExport(rest, pkg.version);
    }
    case "mcp": {
      return await mcp(rest);
    }
    case "resume": {
      const { runResume } = await import("./resume/run-resume.js");
      return await runResume(rest);
    }
    case "activity": {
      const { runActivity } = await import("./activity/run-activity.js");
      return await runActivity(rest);
    }
    default:
      process.stdout.write(USAGE);
      return 2;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isDirectRun) {
  void main(process.argv.slice(2)).then((code) => {
    // process.exit() drops output still queued for a pipe (pipes are async on
    // macOS: `ruah app scan --dry-run | jq` was cut at 64 KB), so flush first.
    const exit = (): void => process.exit(code);
    if (process.stdout.writableLength > 0) process.stdout.once("drain", exit);
    else exit();
  });
}

export { main };
