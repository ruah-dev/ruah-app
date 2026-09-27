#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `ruah app — the Ruah desktop app (architecture map + coding agents) and its daemon

Usage:
  ruah app [<repo>]                 open the desktop app (on <repo>, e.g. \`ruah app .\`): an
                                   installed Ruah.app (/Applications or ~/Applications) opens
                                   the folder in its running window; else this checkout's
                                   Electron (RUAH_APP_DEV=1 forces that)
  ruah app serve [<repo>] [options] serve the viewer + agent daemon
                                   (no <repo>: start screen, open a project from the viewer)
  ruah app new <name> [--in <dir>] [--template <id>] [--no-git] [--gh private|public] [--json]
                                   create a project from a template (empty, web-vite-react,
                                   node-api-ts, static-site, pnpm-monorepo, infra-terraform):
                                   files, scanned map, git init + first commit; \`gh repo create\`
                                   only with --gh (\`ruah app new --help\` for all options)
  ruah app scan <repo> [options]    scan a repo into architecture.json
  ruah app infra <repo> [--json] [--kind <k>]...
                                   print the infrastructure as code the scan finds (resources,
                                   workloads, how it ships, links); writes nothing. <k>: terraform,
                                   k8s, helm, kustomize, ansible, compose, docker, ci (repeatable)
  ruah app system <cmd> ...         multi-repo system (ruah.system.json; no daemon needed;
                                   <system> = its folder, else --system <dir>, else cwd):
    init <folder> [--repo <path>|<id>=<path>]... [--name <n>] [--force]
                                            create ruah.system.json
    add [<system>] <path|<id>=<path>|gh:owner/name> [--id <id>] [--into <dir>]
                                            add a repo (gh: clones it with \`gh repo clone\`)
    remove <id>                             take a repo out (its files are untouched)
    rename <id> <new-id> [--offline]        rename a repo id (map, suggestions, links, chats);
                                            refused while a running daemon has a turn in it
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
  ruah app cloud <cmd> [options]    cloud resources + live status without the app (no daemon):
    providers                      each provider: connected / not logged in / not installed + fix
    list | status | watch          resources · health summary (exit 1 when down) · live changes
    scope [add|remove|reset|accounts]  the repo's resources and why each belongs to it; edit
                                   which resources and accounts are the repo's
                                   (\`ruah app cloud help\` for options)
  ruah app resume [<repo-or-id>] [--json]
                                   where you left off: last chat, focus, agent activity since
                                   you left, git state, ruah tasks (no argument: every recent
                                   project, most in need of attention first)
  ruah app activity [--since <dur>] [--json] [--project <repo-or-id>]
                                   what agents did across projects (default --since 24h),
                                   unread and waiting-for-permission counts
  ruah app design <cmd>             the app's design tokens (palettes, WCAG contrast check,
                                   generated CSS); \`ruah app design help\` for commands
  ruah app usage limits [--agent <id>] [--json] [--refresh]
                                   plan limits per coding agent: Claude windows, Cursor included
                                   usage + on-demand, Kiro credits, Grok / OpenCode local stats,
                                   and Ruah's own estimate (no daemon needed)
  ruah app usage settings [--read-app-logins on|off] [--json]
                                   whether Ruah may read the Cursor app's saved login to show
                                   Cursor's plan usage (off by default; shared with the app)
  ruah app ext <cmd> ...            skills, MCP servers, Kiro powers, plugins and rules for the
                                   agents (no daemon needed; \`ruah app ext help\` for all):
    list | featured | discover [--json]     installed (global + project) · catalog · agents' own config
    add <folder|git-url|featured:<id>> [--project] [--agent <id>]...   (nothing runs on add)
    enable | disable <id> [--agent <id>]... [--project]
    remove <id> [--project]                 also undoes "install into" writes
  ruah app preview [<repo>] [--detect] [--json] [--pick <id>] [--command <cmd>] [--remember | --save-to-repo] [--open]
                                   live preview: how the repo's dev server runs (--detect, --json) or
                                   run it in the foreground and print its URL (no daemon needed;
                                   \`ruah app preview --help\` for options)
  ruah app doctor [--json] [--no-login-shell]
                                   which agent / git / cloud CLIs Ruah finds on your login
                                   shell's PATH (what the desktop app uses), which variables
                                   the app takes from your shell profile, where it keeps its
                                   data and which Ruah.app \`ruah app\` opens
  ruah app app-update [--app <path>] [--ref main] [--no-install]
                                   build the checkout's branch (a clean worktree, only commits) and
                                   install it into the desktop app, restarting it; the installed app
                                   then keeps itself up to date by itself
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
  --no-infra               skip infrastructure as code (Terraform, Kubernetes, Helm, Ansible, CI)
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
  // Started by the desktop app (Finder / Dock / `open`: launchd's bare environment): take the login
  // shell's PATH and the variables its profile exports before any agent or CLI starts (CONTRACTS §19.2).
  if (process.env.RUAH_LOGIN_ENV === "1") {
    delete process.env.RUAH_LOGIN_ENV;
    const { applyLoginEnv } = await import("./desktop/login-env.js");
    await applyLoginEnv({ log: (line) => process.stderr.write(`[ruah] ${line}\n`) });
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
        "no-infra": { type: "boolean", default: false },
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
      infra: parsed.values["no-infra"] !== true,
    },
    pkg.version,
  );
}

async function infra(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: "boolean", default: false },
        kind: { type: "string", multiple: true, default: [] },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`ruah app infra: ${(err as Error).message}\n`);
    return 2;
  }
  const repo = parsed.positionals[0];
  if (repo === undefined) {
    process.stderr.write("ruah app infra: missing <repo> argument\n");
    return 2;
  }
  const kinds = (parsed.values.kind ?? []).flatMap((k) => k.split(",")).map((k) => k.trim()).filter((k) => k !== "");
  const { runInfra } = await import("./scan/iac/run-infra.js");
  return runInfra({ repo, json: parsed.values.json === true, kinds }, pkg.version);
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

/** Opens the desktop app: an installed Ruah.app via `open -a`, else this package's Electron (detached). */
async function openDesktop(repo: string | undefined): Promise<number> {
  const { planDesktopLaunch, runOpen } = await import("./desktop/launch.js");
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // dist/cli.js → package root
  const target = repo !== undefined ? resolve(repo) : undefined;
  const plan = planDesktopLaunch({
    ...(target !== undefined ? { repo: target } : {}),
    packageRoot: root,
    exists: existsSync,
    electron: () => {
      try {
        return require("electron") as string; // the electron package exports its binary path
      } catch {
        return undefined;
      }
    },
  });
  if (plan.kind === "error") {
    process.stderr.write(`ruah app: ${plan.message}\n`);
    return 1;
  }
  if (plan.kind === "bundle") {
    // `open -a` returns quickly; its exit status says whether the app really opened.
    const outcome = await runOpen(plan.command, plan.args);
    if (!outcome.ok) {
      process.stderr.write(`ruah app: could not open ${plan.bundle}: ${outcome.message}\n`);
      return 1;
    }
    process.stdout.write(`Opened Ruah${target !== undefined ? ` on ${target}` : ""} (${plan.bundle})\n`);
    return 0;
  }
  const child = spawn(plan.command, plan.args, { detached: true, stdio: "ignore" });
  child.on("error", (err) => process.stderr.write(`ruah app: ${err.message}\n`));
  child.unref();
  process.stdout.write(`Opening Ruah${target !== undefined ? ` on ${target}` : ""}…\n`);
  return 0;
}

type Handler = (rest: readonly string[]) => Promise<number>;

/**
 * Every subcommand, in one table: the dispatch below and the folder guard in
 * opensDesktop both read it, so a new command cannot open a same-named folder
 * in the desktop app instead of running (design/, preview/, extensions/ did).
 */
export const SUBCOMMANDS: Readonly<Record<string, Handler>> = {
  serve: (rest) => serve(rest),
  scan: (rest) => scan(rest),
  new: async (rest) => (await import("./projects/run-new.js")).runNew(rest, pkg.version),
  infra: (rest) => infra(rest),
  system: async (rest) => (await import("./system/run-system.js")).runSystem(rest, pkg.version),
  export: async (rest) => (await import("./export/run-export.js")).runExport(rest, pkg.version),
  mcp: (rest) => mcp(rest),
  doctor: async (rest) => (await import("./desktop/doctor.js")).runDoctor(rest, pkg.version, dirname(dirname(fileURLToPath(import.meta.url)))),
  cloud: async (rest) => (await import("./integrations/cloud-cli.js")).runCloud(rest),
  resume: async (rest) => (await import("./resume/run-resume.js")).runResume(rest),
  usage: async (rest) => (await import("./usage/run-usage.js")).runUsage(rest, pkg.version),
  activity: async (rest) => (await import("./activity/run-activity.js")).runActivity(rest),
  design: async (rest) => (await import("./design/run-design.js")).runDesign(rest),
  ext: async (rest) => (await import("./extensions/cli.js")).runExt(rest),
  extensions: async (rest) => (await import("./extensions/cli.js")).runExt(rest),
  preview: async (rest) => (await import("./preview/cli.js")).runPreview(rest, pkg.version),
  "app-update": async (rest) => (await import("./desktop/run-app-update.js")).runAppUpdate(rest),
};

/**
 * Whether argv[0] opens the desktop app: nothing, `open`, or a directory that
 * is not a subcommand's name (a `usage/` folder must not swallow `ruah app usage`;
 * such a folder opens as `open <dir>` or `./<dir>`).
 */
export function opensDesktop(cmd: string | undefined, isDir: (p: string) => boolean = isDirectory): boolean {
  if (cmd === undefined || cmd === "open") return true;
  if (cmd.startsWith("-") || Object.hasOwn(SUBCOMMANDS, cmd)) return false;
  return isDir(cmd);
}

/**
 * Subcommands without a help of their own: a help flag right after them (or
 * anywhere, for the ones that run on their own) prints the usage and runs nothing.
 */
export const NO_OWN_HELP = new Set(["serve", "scan", "infra", "export", "mcp", "doctor", "resume", "activity", "system"]);

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
  if (opensDesktop(cmd)) {
    const repo = cmd === "open" ? rest[0] : cmd;
    return await openDesktop(repo);
  }
  // `serve --help` used to start a daemon (and `scan --help` to scan): these commands have no
  // help of their own, so a help flag anywhere prints the usage and does nothing else.
  if (cmd !== undefined && NO_OWN_HELP.has(cmd) && (rest.some((a) => a === "--help" || a === "-h") || (cmd === "system" && rest[0] === "help"))) {
    process.stdout.write(USAGE);
    return 0;
  }
  const handler = cmd !== undefined && Object.hasOwn(SUBCOMMANDS, cmd) ? SUBCOMMANDS[cmd] : undefined;
  if (handler === undefined) {
    process.stdout.write(USAGE);
    return 2;
  }
  return await handler(rest);
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
