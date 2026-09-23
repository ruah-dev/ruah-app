import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `archmap — architecture map daemon

Usage:
  archmap serve [<repo>] [options] serve the viewer + agent daemon
                                   (no <repo>: start screen, open a project from the viewer)
  archmap scan <repo> [options]    scan a repo into architecture.json
  archmap system <cmd> <dir> ...   multi-repo system (ruah.system.json in <dir>):
    init <dir> --repo <id>=<path> ... [--name <n>] [--force]   create ruah.system.json
    add <dir> <id>=<path>                                      add a repo
    scan <dir> [--out <path>] [--dry-run]                      write <dir>/architecture.json
  archmap export drawio <repo> [--out <file>]
                                   write the architecture as a draw.io file (pages per
                                   drill level + workflow + Specifications; --out - = stdout)
  archmap mcp <repo>               stdio MCP server
  archmap --version                print version
  archmap help                     this text

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
  --open                   open the viewer URL in the default browser

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
      agent: { type: "string", default: "claude" },
      "allow-origin": { type: "string", multiple: true, default: [] },
      links: { type: "boolean", default: true },
      open: { type: "boolean", default: false },
    },
    strict: false,
  });
  const agent = values.agent as string;
  const { isAgentProvider } = await import("./acp/index.js");
  if (!isAgentProvider(agent)) {
    process.stderr.write(`archmap serve: unknown --agent "${agent}" (expected claude, cursor, grok, kiro, opencode or acp)\n`);
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
      agent,
      allowOrigins: ((values["allow-origin"] as string[] | undefined) ?? []).filter(
        (o): o is string => typeof o === "string",
      ),
      links: values.links !== false,
      open: values.open === true,
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
    process.stderr.write(`archmap scan: ${(err as Error).message}\n`);
    return 2;
  }
  const repo = parsed.positionals[0];
  if (repo === undefined) {
    process.stderr.write("archmap scan: missing <repo> argument\n");
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

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(pkg.version);
    return 0;
  }
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return cmd === undefined ? 2 : 0;
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
      parseArgs({ args: rest, strict: false });
      console.log("not implemented");
      return 2;
    }
    default:
      process.stdout.write(USAGE);
      return 2;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isDirectRun) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main };
